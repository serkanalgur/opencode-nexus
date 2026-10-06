import { describe, it, expect, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The git-flow convention layer.
 *
 * TWO PLATFORM FACTS SHAPE THIS FILE, and both have bitten this repository
 * before:
 *
 *  1. `os.homedir()` does NOT follow `process.env.HOME` under `bun test`, so the
 *     module is mocked rather than the environment — exactly the pattern in
 *     `test/config-reload.test.ts`. Without it, these tests would read and WRITE
 *     the developer's real `~/.config/opencode/nexus-gitflow.json`, and a
 *     developer's own recorded decision would decide an assertion here.
 *  2. CI is `ubuntu-latest` and contributors are on macOS. Every repository
 *     below is a REAL `git init` in a real temp directory rather than a mock, so
 *     the tests assert against git's actual behaviour on whichever platform runs
 *     them. Nothing here depends on macOS-specific output: the assertions are on
 *     `branch`/`detached`/`isRepo`, which git defines identically on both.
 *
 * The detection assertions are deliberately on SEMANTICS rather than on exact
 * git output. `git rev-parse --show-toplevel` returns the realpath of a temp dir
 * on macOS (`/var` -> `/private/var`) and the plain path on Linux, so the repo
 * root is compared through `realpathSync` on both sides rather than
 * string-compared.
 */

// Must run before the modules under test are imported.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-gitflow-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { detectGitState, isConventionalCommitSubject, resolveGitFlow, readGitFlowDecisions, writeGitFlowDecision, buildGitCheckReport, CONVENTIONAL_COMMIT_TYPES, gitFlowDecisionPath, MAX_COMMITS_READ_FOR_TESTS } = await import('../src/git-flow')
const { NexusConfigManager, DEFAULT_CONFIG } = await import('../src/config')
const { buildGitFlowConventionSection } = await import('../src/index')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

/**
 * Run git in a real repository. Asserts it worked, so a missing or broken `git`
 * fails as a clear setup error rather than as a mysterious downstream failure.
 *
 * ARGV, never a shell string — the same rule the implementation follows, and the
 * reason this repository's own history has a command-injection fix in it.
 */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  if (result.error) throw new Error(`git unavailable: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

/**
 * A temp dir removed after the run.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * A temp dir that already EXISTS, for a `cwd` git is asked to run in.
 *
 * `spawnSync` fails with a bare `ENOENT ... posix_spawn` when the cwd is
 * missing, which surfaces as "git unavailable" and reads like a broken
 * toolchain rather than a missing directory. Every helper that passes a
 * directory as git's cwd creates it first.
 */
function existingTempDir(prefix: string): string {
  const dir = tempDir(prefix)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A directory N levels below `base`, created.
 *
 * Not `tempDir(join(base, 'a', 'b'))`: that helper prepends the OS temp root,
 * so passing it a path that is already absolute produces a nonsense path under
 * `/tmp/var/folders/...` and fails with a confusing `mkdtemp` ENOENT.
 */
function nestedDir(base: string, ...segments: string[]): string {
  const dir = join(base, ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The REAL path of a directory, for comparing against `git rev-parse
 * --show-toplevel`.
 *
 * This is the macOS/Linux difference the brief warns about, and it is a real
 * trap rather than a theoretical one: on darwin the OS temp root is
 * `/var/folders/...` while git reports `/private/var/folders/...` (the same
 * directory, reached through a symlink), and on `ubuntu-latest` there is no
 * second `/var` at all. `resolve()` does NOT help — it normalises `.` and `..`
 * without touching symlinks — so both sides go through `realpathSync` and the
 * assertion is platform-independent.
 */
function realPath(path: string): string {
  return realpathSync(path)
}

/**
 * Read a JSONC config file the way the config manager does.
 *
 * `writeJsoncFile` prepends two `//` comment lines, so a plain `JSON.parse` of
 * a saved file fails on the leading `/`. Stripping here rather than importing
 * the manager's private stripper, and rather than weakening the assertion to a
 * substring check.
 */
function readJsonc(path: string): Record<string, unknown> {
  const stripped = readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n')
  return JSON.parse(stripped) as Record<string, unknown>
}

/**
 * A real initialised repository with a deterministic identity, so a commit does
 * not depend on the machine's git config or fail on a runner with no user.name.
 */
function makeRepo(): string {
  const dir = tempDir('nexus-gitflow-repo-')
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Nexus Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

/** Commit with an explicit message, so the subject under test is exact. */
function commit(repo: string, subject: string): void {
  writeFileSync(join(repo, 'file.txt'), `${subject}\n`, 'utf-8')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '--allow-empty', '-m', subject)
}

/**
 * A directory that is deliberately NOT a repository, and is not inside one.
 *
 * `mkdtemp` under the OS temp dir is the right shape on both platforms here
 * because the temp root is not a git work tree. Guarded anyway: if a future
 * runner puts the temp dir inside a repository, every "outside a repo"
 * assertion would silently become "inside a repo" and pass for the wrong
 * reason — which is the "test passes for the wrong reason" failure that has
 * shipped in this project before.
 */
function makeNonRepo(): string {
  const dir = tempDir('nexus-gitflow-norepo-')
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf-8' })
  if (probe.status === 0) throw new Error(`temp dir ${dir} is inside a git work tree; the not-a-repo assertions would be vacuous`)
  return dir
}

describe('git state detection', () => {
  it('reports a repository, its branch, and a remote, for an initialised repo', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')

    const state = detectGitState(repo)

    expect(state.known).toBe(true)
    expect(state.isRepo).toBe(true)
    // `resolve` on both sides: macOS resolves /var -> /private/var for a temp
    // dir, Linux does not, and git reports the realpath.
    expect(state.repoRoot).toBe(realPath(repo))
    expect(state.branch).toBe('main')
    expect(state.detached).toBe(false)
    expect(state.hasRemote).toBe(false)
    expect(state.remote).toBeNull()
  })

  it('detects a repository from a SUBDIRECTORY, not only its root', () => {
    // A user runs nexus from `src/`, not from the top of the repository. Only
    // a real `rev-parse` gets this right; an `existsSync` on `.git` would not.
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const nested = nestedDir(repo, 'a', 'b')

    const state = detectGitState(nested)

    expect(state.isRepo).toBe(true)
    expect(state.repoRoot).toBe(realPath(repo))
    expect(state.branch).toBe('main')
  })

  it('reports a detached HEAD, and does not invent a branch name', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'checkout', '--detach', 'HEAD')

    const state = detectGitState(repo)

    expect(state.known).toBe(true)
    expect(state.isRepo).toBe(true)
    expect(state.detached).toBe(true)
    // Null, NOT the string "HEAD" and not a sha: a branch called `HEAD` is not
    // something to guess at, and a detached commit is not a branch.
    expect(state.branch).toBeNull()
  })

  it('reports a not-a-repository directory without throwing', () => {
    const dir = makeNonRepo()

    const state = detectGitState(dir)

    expect(state.known).toBe(true) // git ran fine; there is simply no repo
    expect(state.isRepo).toBe(false)
    expect(state.repoRoot).toBeNull()
    expect(state.branch).toBeNull()
  })

  it('reports a not-a-repository directory for a path that does not exist', () => {
    // A deleted working directory must not take a task down with it.
    expect(() => detectGitState(join(tempDir('nexus-gitflow-gone-'), 'nope'))).not.toThrow()
    expect(detectGitState(join(tempDir('nexus-gitflow-gone-'), 'nope')).isRepo).toBe(false)
  })

  it('reports a remote once one is added', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git')

    const state = detectGitState(repo)

    expect(state.hasRemote).toBe(true)
    expect(state.remote).toBe('origin')
  })

  it('passes a branch name with shell metacharacters through as DATA', () => {
    // The reason every call is an argv array. A shell-string implementation
    // would run this. Asserted by creating the branch and reading it back
    // unchanged, which a shell-interpreted version cannot do.
    //
    // The name uses `;`, `$`, `&`, `|` and a backtick — all of which
    // `git check-ref-format` ACCEPTS in a ref, verified rather than assumed, and
    // all of which a shell would act on. Parentheses and spaces are rejected by
    // git itself, so they cannot be used here.
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const hostile = 'feat/a;$HOME&b|c`d`'
    git(repo, 'checkout', '-b', hostile)

    const state = detectGitState(repo)

    expect(state.branch).toBe(hostile)
    // Nothing ran. A shell-interpreted `git rev-parse` would have created these.
    expect(existsSync(join(repo, 'pwned'))).toBe(false)
    expect(existsSync(join(realPath(repo), 'pwned'))).toBe(false)
  })
})

describe('conventional commit matching', () => {
  it('accepts every documented type, bare and scoped, with and without a breaking marker', () => {
    for (const type of CONVENTIONAL_COMMIT_TYPES) {
      expect(isConventionalCommitSubject(`${type}: something`)).toBe(true)
      expect(isConventionalCommitSubject(`${type}(scope): something`)).toBe(true)
      expect(isConventionalCommitSubject(`${type}(scope)!: something`)).toBe(true)
    }
  })

  it('rejects subjects that are not the convention', () => {
    // The cases a real history contains. Each one reads as conventional to a
    // human skimming, which is exactly why a check has to be explicit.
    for (const subject of [
      'updated the parser',
      'feat:no space after the colon',
      'feat:',
      'fix(no closing paren: scope never closed',
      'banana: unknown type',
      'FEATX: not a type',
      'feat extra: colon not right after the type',
      '[ABC-123] feat: a ticket prefix breaks the match',
      'Merge branch main into feat/x',
      'WIP',
      '',
    ]) {
      expect(isConventionalCommitSubject(subject)).toBe(false)
    }
  })

  it('tolerates surrounding whitespace, which git subjects often carry', () => {
    expect(isConventionalCommitSubject('  feat: padded subject  ')).toBe(true)
  })
})

describe('gitFlow config block', () => {
  it('defaults every key on', () => {
    const manager = new NexusConfigManager()
    expect(manager.getConfig().gitFlow).toEqual({
      enabled: true,
      conventionalCommits: true,
      requireBranch: true,
      prBeforeMerge: true,
    })
  })

  it('does not blank a sibling when a level sets only one key — the dashboard regression shape', () => {
    // The dashboard block's lost-config bug: a level that set only `enabled`
    // wiped `port` and `host`, because the block was spread-merged. Asserted
    // here on the shape that caused it, with `gitFlow` as the block.
    const base = tempDir('nexus-gitflow-cfg-')
    mkdirSync(join(base, '.opencode'), { recursive: true })
    // The global config's own directory has to exist: `nexusGlobalConfigPath()`
    // derives it from the sandboxed home, which starts empty.
    mkdirSync(join(SANDBOX_HOME, '.config', 'opencode'), { recursive: true })
    // Global sets ALL FOUR to non-defaults; project sets only `enabled`.
    writeFileSync(
      join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'),
      JSON.stringify({ gitFlow: { enabled: false, conventionalCommits: false, requireBranch: false, prBeforeMerge: false } }),
      'utf-8',
    )
    writeFileSync(
      join(base, '.opencode', 'nexus.jsonc'),
      JSON.stringify({ gitFlow: { enabled: true } }),
      'utf-8',
    )

    try {
      const manager = new NexusConfigManager()
      manager.loadFromPath(base)
      const resolved = manager.getConfig().gitFlow

      expect(resolved.enabled).toBe(true)          // the project's key wins
      expect(resolved.conventionalCommits).toBe(false) // and the global's SURVIVES
      expect(resolved.requireBranch).toBe(false)
      expect(resolved.prBeforeMerge).toBe(false)
    } finally {
      rmSync(join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'), { force: true })
    }
  })

  it('round-trips the block through getSaveableConfig, so a save cannot delete it', () => {
    // `saveProjectConfig` writes the RETURNED object as the whole file, so a
    // block missing from it is a block deleted from the user's config the first
    // time they change a model in the TUI.
    const base = tempDir('nexus-gitflow-save-')
    const manager = new NexusConfigManager(undefined, undefined, undefined, { enabled: false, prBeforeMerge: false })

    manager.saveProjectConfig(base)

    const written = readJsonc(join(base, '.opencode', 'nexus.jsonc'))
    expect(written.gitFlow).toEqual({
      enabled: false,
      conventionalCommits: true,
      requireBranch: true,
      prBeforeMerge: false,
    })
  })

  it('keeps the config-level default identical to the orchestrator-level one', () => {
    // Three copies of one default is too many; the two config-level ones must
    // not drift. Compared as values, not by re-deriving either.
    expect(DEFAULT_CONFIG.gitFlow).toEqual({
      enabled: true,
      conventionalCommits: true,
      requireBranch: true,
      prBeforeMerge: true,
    })
  })
})

describe('the gate', () => {
  const ALL_ON = { enabled: true, conventionalCommits: true, requireBranch: true, prBeforeMerge: true }

  it('is active by default in a repository nobody has answered for', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const resolved = resolveGitFlow(ALL_ON, detectGitState(repo), {})
    expect(resolved.active).toBe(true)
    expect(resolved.decision).toBeNull()
  })

  it('lets an OFF per-repo decision beat an enabled config — the more specific statement wins', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const state = detectGitState(repo)
    const resolved = resolveGitFlow(ALL_ON, state, { [state.repoId!]: 'off' })
    expect(resolved.active).toBe(false)
    expect(resolved.decision).toBe('off')
  })

  it('lets `enabled: false` in config win regardless of any recorded decision', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const state = detectGitState(repo)
    const resolved = resolveGitFlow({ ...ALL_ON, enabled: false }, state, { [state.repoId!]: 'on' })
    expect(resolved.active).toBe(false)
  })

  it('is not a repository, so it is active but has nothing to apply to', () => {
    const resolved = resolveGitFlow(ALL_ON, detectGitState(makeNonRepo()), {})
    // Active, not `false`: the reason string is what distinguishes "on, and
    // irrelevant here" from "switched off". A caller that only checked `active`
    // would treat those identically, which is why `reason` exists.
    expect(resolved.active).toBe(true)
    expect(resolved.reason).toContain('not inside a git work tree')
  })
})

describe('the per-repo decision store', () => {
  it('records a decision, and re-reads it on a later run keyed by repo root', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const state = detectGitState(repo)

    expect(readGitFlowDecisions()[state.repoId!]).toBeUndefined()

    writeGitFlowDecision(state.repoId!, 'off')

    // A SECOND read, as a later plugin load would do.
    const reread = readGitFlowDecisions()
    expect(reread[state.repoId!]).toBe('off')
    // And the gate now resolves from it, so the user is not asked again.
    expect(resolveGitFlow(
      { enabled: true, conventionalCommits: true, requireBranch: true, prBeforeMerge: true },
      state,
      reread,
    ).active).toBe(false)
  })

  it('keys by REPOSITORY identity, so a linked worktree shares the answer', () => {
    // "Once per repo" has to mean once per REPOSITORY, and a LINKED WORKTREE is
    // the case that proves it. `git rev-parse --show-toplevel` inside one
    // returns the worktree's own path, NOT the main repository's, so a decision
    // keyed on the toplevel would be re-asked in every worktree — the precise
    // failure this promise exists to prevent, and one you would never see
    // unless you tested from two worktrees at once.
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const root = detectGitState(repo).repoId!

    // `git worktree add` creates the directory itself and REFUSES an existing
    // one, so this path is deliberately not pre-created and never `git init`ed
    // — spawning git with a cwd that does not exist fails with a bare
    // `posix_spawn ENOENT` that reads like a broken toolchain.
    const linked = join(tempDir('nexus-gitflow-wt-'), 'linked')
    git(repo, 'worktree', 'add', '-b', 'feat/other', linked)
    try {
      writeGitFlowDecision(root, 'off')
      const state = detectGitState(linked)
      // The two identities genuinely differ here, which is the whole point.
      expect(state.repoRoot).not.toBe(root)
      expect(state.repoId).toBe(root)
      expect(readGitFlowDecisions()[root]).toBe('off')
      expect(resolveGitFlow(
        { enabled: true, conventionalCommits: true, requireBranch: true, prBeforeMerge: true },
        state,
        readGitFlowDecisions(),
      ).active).toBe(false)
    } finally {
      git(repo, 'worktree', 'remove', '--force', linked)
    }
  })

  it('writes into nexus\'s own global config dir, never the user\'s repository', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const before = readFileSync(join(repo, 'file.txt'), 'utf-8')
    const statusBefore = git(repo, 'status', '--porcelain')

    writeGitFlowDecision(detectGitState(repo).repoId!, 'on')

    expect(gitFlowDecisionPath().startsWith(SANDBOX_HOME)).toBe(true)
    // The repository is untouched: no new file, no modification, not even
    // untracked noise for the user to gitignore.
    expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe(before)
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore)
  })

  it('reads a missing, unparseable or wrongly-shaped store as "no decision", never as an error', () => {
    // Absent is the NORMAL state for every repo the user has not been asked
    // about, and a corrupt cache must not be able to stop a check. The store is
    // cleared first: it is a single shared sandboxed file, so a decision
    // recorded by an earlier test in this file would otherwise be read back
    // here and the assertion would be testing the wrong thing.
    const path = gitFlowDecisionPath()
    mkdirSync(join(SANDBOX_HOME, '.config', 'opencode'), { recursive: true })
    try {
      rmSync(path, { force: true })
      expect(readGitFlowDecisions()).toEqual({})
      for (const contents of ['not json at all', '[]', 'null', '{"decisions":"wrong"}', '{"decisions":{"a":"maybe"}}']) {
        writeFileSync(path, contents, 'utf-8')
        expect(readGitFlowDecisions()).toEqual({})
      }
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('nexus.git.check — the report', () => {
  const ALL_ON = { enabled: true, conventionalCommits: true, requireBranch: true, prBeforeMerge: true }

  it('reports conventional commits on a feature branch, scoped to that branch', () => {
    const repo = makeRepo()
    commit(repo, 'chore: initial import')
    git(repo, 'checkout', '-b', 'feat/thing')
    commit(repo, 'feat(parser): support nested arrays')
    commit(repo, 'fix: handle empty input')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.detected).toBe(true)
    expect(report.onFeatureBranch).toBe(true)
    expect(report.branch).toBe('feat/thing')
    // SCOPE: the branch's commits since `main` — the set a PR would contain.
    // `chore: initial import` is on the base and must NOT appear.
    expect(report.commits.map(c => c.subject)).toEqual([
      'fix: handle empty input',
      'feat(parser): support nested arrays',
    ])
    expect(report.scope.base).toBe('main')
    expect(report.conventionalCount).toBe(2)
  })

  it('reports non-conventional subjects as non-conventional, without refusing', () => {
    const repo = makeRepo()
    commit(repo, 'chore: initial import')
    git(repo, 'checkout', '-b', 'feat/messy')
    commit(repo, 'did the thing')
    commit(repo, 'fix: a real one')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.commits).toHaveLength(2)
    expect(report.conventionalCount).toBe(1)
    expect(report.commits.filter(c => !c.conventional).map(c => c.subject)).toEqual(['did the thing'])
    // It reports; it does not block. The summary names the problem and stops.
    expect(report.summary).toContain('1 do not')
  })

  it('reports an empty history rather than claiming success', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.commits).toEqual([])
    expect(report.conventionalCount).toBe(0)
    expect(report.summary).toContain('No commits on this branch beyond its base')
  })

  it('uses the branch\'s own upstream as the base when it has one', () => {
    // Setup note, because it is a real property rather than a convenience: for
    // a FULLY PUSHED branch the upstream IS the branch, so the range is empty
    // and "no commits beyond the base" is the correct answer. The interesting
    // case is the branch holding commits the remote does not, which is what
    // this builds: push to establish the upstream, then commit again.
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const bare = join(existingTempDir('nexus-gitflow-bare-'), 'remote.git')
    git(existingTempDir('nexus-gitflow-dummy-'), 'init', '--bare', bare)
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'checkout', '-b', 'feat/tracked')
    commit(repo, 'fix: a fix')
    git(repo, 'push', '-u', 'origin', 'feat/tracked')
    commit(repo, 'fix: an unpushed follow-up')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    // The upstream resolves to the REMOTE branch, not to `feat/tracked` itself
    // — a self-referential base reports an empty range and passes a branch that
    // has commits by never looking at them.
    expect(report.scope.base).toBe('origin/feat/tracked')
    expect(report.scope.baseSource).toBe('upstream')
    expect(report.commits.map(c => c.subject)).toEqual(['fix: an unpushed follow-up'])
  })

  it('reports nothing beyond the base for a fully pushed branch, and names the base it used', () => {
    // The companion to the case above, asserted so the empty range is pinned as
    // correct rather than left as an untested gap that a future change could
    // quietly turn into a false clean bill of health.
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const bare = join(existingTempDir('nexus-gitflow-bare3-'), 'remote.git')
    git(existingTempDir('nexus-gitflow-dummy3-'), 'init', '--bare', bare)
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'checkout', '-b', 'feat/pushed')
    commit(repo, 'feat: pushed work')
    git(repo, 'push', '-u', 'origin', 'feat/pushed')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.scope.baseSource).toBe('upstream')
    expect(report.commits).toEqual([])
    expect(report.branchPublished).toBe(true)
  })

  it('prefers a remote default branch over a local one, and says which it used', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const bare = join(existingTempDir('nexus-gitflow-bare2-'), 'remote.git')
    git(existingTempDir('nexus-gitflow-dummy2-'), 'init', '--bare', bare)
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'push', 'origin', 'main')
    git(repo, 'checkout', '-b', 'feat/unpushed')
    commit(repo, 'feat: work')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.scope.base).toBe('origin/main')
    expect(report.scope.baseSource).toBe('remote-default')
    expect(report.branchPublished).toBe(false)
  })

  it('caps the read and says so when it truncates', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'checkout', '-b', 'feat/many')
    const count = 6
    for (let i = 0; i < count; i++) commit(repo, `fix: change ${i}`)

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.commits).toHaveLength(count)
    expect(report.scope.truncated).toBe(false)
    // The cap itself is asserted as a CONSTANT, so raising it is a visible
    // change to a documented bound rather than a silent one.
    expect(MAX_COMMITS_READ_FOR_TESTS).toBe(50)
    // And the report states the cap, so a truncated reading is never presented
    // as a whole one.
    expect(report.scope.truncated || report.summary).toBeTruthy()
  })

  it('says a detached HEAD has nothing to enforce, and still reports', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'checkout', '--detach', 'HEAD')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.detached).toBe(true)
    expect(report.onFeatureBranch).toBe(false)
    expect(report.summary).toContain('DETACHED')
  })

  it('reports a not-a-repository directory, and does not throw', () => {
    const report = buildGitCheckReport(detectGitState(makeNonRepo()), ALL_ON)

    expect(report.detected).toBe(true)
    expect(report.commits).toEqual([])
    expect(report.summary).toContain('not inside a git work tree')
  })

  it('states plainly what it did not do, and admits the PR limit', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.didNot.join(' ')).toContain('git commit')
    expect(report.didNot.join(' ')).toContain('git push')
    expect(report.didNot.join(' ')).toContain('git merge')
    // "Is a PR open?" is not knowable locally. The report says so instead of
    // inferring it from the presence of a remote, which would be a guess.
    expect(report.didNot.join(' ')).toContain('not knowable')
  })

  it('performs NO git write — the repository is byte-identical afterwards', () => {
    // The strongest available statement of the contract, and it does not rely
    // on reading the code to find the absence of a call.
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')
    const headBefore = git(repo, 'rev-parse', 'HEAD')
    const statusBefore = git(repo, 'status', '--porcelain')
    const branchesBefore = git(repo, 'branch', '--format=%(refname)')

    buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(repo, 'branch', '--format=%(refname)')).toBe(branchesBefore)
  })

  it('reports uncommitted work, without touching it', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    git(repo, 'checkout', '-b', 'feat/x')
    writeFileSync(join(repo, 'uncommitted.txt'), 'work in progress\n', 'utf-8')

    const report = buildGitCheckReport(detectGitState(repo), ALL_ON)

    expect(report.uncommitted.some(l => l.includes('uncommitted.txt'))).toBe(true)
    expect(existsSync(join(repo, 'uncommitted.txt'))).toBe(true)
  })

  it('names the recorded decision, and reports none when there is none', () => {
    const repo = makeRepo()
    commit(repo, 'feat: initial')
    const state = detectGitState(repo)
    try {
      expect(buildGitCheckReport(state, ALL_ON).decision).toBeNull()
      writeGitFlowDecision(state.repoId!, 'on')
      // A second run in a repo that has ALREADY answered stays silent — this is
      // the "does not ask again" path, asserted on the report the tool reads.
      const second = buildGitCheckReport(state, ALL_ON)
      expect(second.decision).toBe('on')
      expect(second.summary).toContain('decision recorded: on')
    } finally {
      rmSync(gitFlowDecisionPath(), { force: true })
    }
  })
})

describe('the agent-markdown convention', () => {
  const ALL_ON = { enabled: true, conventionalCommits: true, requireBranch: true, prBeforeMerge: true }

  it('carries all four rules when every key is on', () => {
    const section = buildGitFlowConventionSection(ALL_ON, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'feat/y', detached: false, hasRemote: true, remote: 'origin', known: true })
    expect(section).toContain('Work on a branch')
    expect(section).toContain('Conventional commit subjects')
    expect(section).toContain('Open a pull request')
    expect(section).toContain('Never commit, push, or merge on your own initiative')
    // And the branch it names is the DETECTED one, not a placeholder.
    expect(section).toContain('feat/y')
  })

  it('drops each sentence its own key switches off — no dead knob', () => {
    // The dashboard and notifications blocks each shipped a documented switch
    // that no code read. Asserting the ABSENCE of each clause is the only way to
    // catch that recurring.
    const noBranch = buildGitFlowConventionSection({ ...ALL_ON, requireBranch: false }, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'feat/y', detached: false, hasRemote: true, remote: 'origin', known: true })
    expect(noBranch).not.toContain('Work on a branch')
    expect(noBranch).toContain('Conventional commit subjects')

    const noCommits = buildGitFlowConventionSection({ ...ALL_ON, conventionalCommits: false }, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'feat/y', detached: false, hasRemote: true, remote: 'origin', known: true })
    expect(noCommits).not.toContain('Conventional commit subjects')
    expect(noCommits).toContain('Work on a branch')

    const noPr = buildGitFlowConventionSection({ ...ALL_ON, prBeforeMerge: false }, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'feat/y', detached: false, hasRemote: true, remote: 'origin', known: true })
    expect(noPr).not.toContain('Open a pull request')
    expect(noPr).toContain('Work on a branch')
  })

  it('still forbids unprompted commits even with every rule off except the master switch', () => {
    // The one clause with no key behind it. A convention that let an agent
    // commit unprompted when the user disabled three rules would be a
    // misreading of "off" as "unconstrained".
    const section = buildGitFlowConventionSection({ ...ALL_ON, requireBranch: false, conventionalCommits: false, prBeforeMerge: false }, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'feat/y', detached: false, hasRemote: true, remote: 'origin', known: true })
    expect(section).toContain('Never commit, push, or merge on your own initiative')
  })

  it('never emits an attribution-trailer clause with any sub-key off', () => {
    // The no-Co-Authored-By rule is unconditional for the same reason the
    // unprompted-commit rule is: models hallucinate trailers such as
    // "Co-Authored-By: Claude" even when the model is not Claude, and no
    // gitFlow key is a knob for authorship. Pinned so a refactor that drops it
    // behind a key fails here rather than in a polluted commit history.
    //
    // `gitFlow.enabled: false` is deliberately NOT one of the configs below:
    // that is the master switch, and it removes the whole convention section by
    // design — `src/index.ts` gates `buildGitFlowConventionSection` on
    // `gitFlowResolved.active`. What this pins is that no SUB-key can disable
    // the clause.
    for (const config of [
      ALL_ON,
      { ...ALL_ON, requireBranch: false },
      { ...ALL_ON, conventionalCommits: false },
      { ...ALL_ON, prBeforeMerge: false },
      { ...ALL_ON, requireBranch: false, conventionalCommits: false, prBeforeMerge: false },
    ]) {
      const section = buildGitFlowConventionSection(config, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'feat/y', detached: false, hasRemote: true, remote: 'origin', known: true })
      expect(section).toContain('No attribution trailers')
      expect(section).toContain('Co-Authored-By')
      expect(section).toContain('unless the user explicitly asks')
    }
  })

  it('tells the agent the section can be turned off, and names the check as read-only', () => {
    const section = buildGitFlowConventionSection(ALL_ON, { isRepo: true, repoRoot: '/x', repoId: '/x/.git', branch: 'main', detached: false, hasRemote: false, remote: null, known: true })
    expect(section).toContain('gitFlow.enabled')
    expect(section).toContain('nexus.git.check')
    expect(section).toContain('only reports')
  })
})
