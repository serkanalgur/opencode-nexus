import { describe, it, expect, afterAll, beforeEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `nexus.git.check` END TO END, through the real plugin.
 *
 * The unit tests in `test/git-flow.test.ts` cover detection, the config block
 * and the report. What only a booted plugin can show is the two behaviours that
 * are the POINT of this feature and are invisible below the tool boundary:
 *
 *  - the ASK. A subagent cannot prompt a human — it is driven by tool calls and
 *    has no other channel — so the ask has to travel out through a tool result
 *    the agent is already reading. Asserted on the text, because "did the tool
 *    tell the agent to ask" is a claim about a STRING, not about a return value.
 *  - the ONCE. That a recorded decision silences the ask on every later run.
 *    Asserted by running the tool twice, because a store that records and is
 *    never re-read looks identical to a store that is never consulted.
 *
 * SANDBOXING, and why it is not optional here: the decision store is a real file
 * in a real global config directory. `os.homedir()` does not follow
 * `process.env.HOME` under `bun test`, so the module is mocked before the
 * modules under test load — the pattern in `test/config-reload.test.ts`. Without
 * it these tests would write the developer's real
 * `~/.config/opencode/nexus-gitflow.json`, and a decision they recorded here
 * would decide a developer's next real run.
 *
 * CROSS-PLATFORM: every repository is a real `git init` in a temp directory, and
 * no assertion reads macOS-specific output. `bun test` runs this file on
 * `ubuntu-latest` in CI, where the temp root has no `/var -> /private/var`
 * symlink, so any path compared here goes through `realpathSync` on both sides.
 */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-gitcheck-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { default: plugin } = await import('../src/index')
const { gitFlowDecisionPath } = await import('../src/git-flow')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function existingTempDir(prefix: string): string {
  const dir = tempDir(prefix)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Real git, argv form. Asserts on failure so setup errors read as such. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  if (result.error) throw new Error(`git unavailable: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

function makeRepo(): string {
  const dir = tempDir('nexus-gitcheck-repo-')
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Nexus Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'file.txt'), 'initial\n', 'utf-8')
  git(dir, 'add', 'file.txt')
  git(dir, 'commit', '-m', 'chore: initial import')
  return dir
}

function commit(repo: string, subject: string): void {
  writeFileSync(join(repo, 'file.txt'), `${subject}\n`, 'utf-8')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-m', subject)
}

/** A directory that is genuinely not inside a repository, verified not assumed. */
function makeNonRepo(): string {
  const dir = tempDir('nexus-gitcheck-norepo-')
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf-8' })
  if (probe.status === 0) throw new Error(`temp dir ${dir} is inside a work tree; the assertions below would be vacuous`)
  return dir
}

/**
 * Boot the real plugin against a project directory and hand back its registered
 * tools. Shaped after the fake context in `test/config-reload.test.ts`, which is
 * the established way this repository exercises a registered tool.
 */
async function bootPlugin(projectDir: string) {
  const tools = new Map<string, { execute: (input: unknown) => Promise<{ content: string }> }>()
  const ctx = {
    location: { directory: projectDir },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }) },
    storage: { set: () => Promise.resolve(), get: () => Promise.resolve(null) },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          namespace: () => {},
          add: (tool: { name: string; execute: (input: unknown) => Promise<{ content: string }> }) => tools.set(tool.name, tool),
        })
      },
      list: () => Promise.resolve([]),
    },
    session: {
      create: () => Promise.resolve({ id: 'ses_x' }),
      prompt: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      context: () => Promise.resolve([]),
      background: () => Promise.resolve(),
      hook: () => Promise.resolve(),
    },
  }
  const cleanup = await plugin.setup(ctx as never)
  return { tools, cleanup: cleanup as () => void }
}

/** Call `nexus.git.check` and return its text result. */
async function check(booted: Awaited<ReturnType<typeof bootPlugin>>, input: Record<string, unknown> = {}): Promise<string> {
  const tool = booted.tools.get('git.check')
  // Narrowed by hand rather than by a non-null assertion: a missing tool is a
  // real failure, and `as` would silence the one error that matters here.
  if (!tool) throw new Error('nexus.git.check is not registered')
  const result = await tool.execute(input)
  return result.content
}

// A FRESH decision store per test. They share one sandboxed file, so without
// this a decision recorded in one test would silence the ask in the next and
// the "asks" assertions would fail for a reason that has nothing to do with
// what they are testing.
beforeEach(() => {
  rmSync(gitFlowDecisionPath(), { force: true })
})

describe('nexus.git.check registration', () => {
  it('registers exactly once, alongside the worktree tools it sits next to', async () => {
    const booted = await bootPlugin(tempDir('nexus-gitcheck-boot-'))
    try {
      expect(booted.tools.get('git.check')).toBeDefined()
      // Named with the same `git.` prefix family the existing worktree tools
      // use, so the tools table groups it with the rest of the git surface.
      expect([...booted.tools.keys()].filter(n => n.startsWith('git.'))).toEqual(['git.check'])
    } finally {
      booted.cleanup()
    }
  })
})

describe('nexus.git.check reports without blocking', () => {
  it('reports a non-conventional subject and does not refuse', async () => {
    const repo = makeRepo()
    git(repo, 'checkout', '-b', 'feat/messy')
    commit(repo, 'did the thing')

    const booted = await bootPlugin(repo)
    try {
      const output = await check(booted, { cwd: repo })
      expect(output).toContain('did the thing')
      expect(output).toContain('❌')
      expect(output).toContain('1 do not')
    } finally {
      booted.cleanup()
    }
  })

  it('names the scope it read, and what it refused to do', async () => {
    const repo = makeRepo()
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')

    const booted = await bootPlugin(repo)
    try {
      const output = await check(booted, { cwd: repo })
      expect(output).toContain('Scope: commits on this branch since `main`')
      expect(output).toContain('did not run `git commit`, `git push` or `git merge`')
      expect(output).toContain('not knowable')
    } finally {
      booted.cleanup()
    }
  })

  it('performs no git write on the user\'s repository', async () => {
    // The contract, asserted against the repository rather than by reading the
    // code for the absence of a call. This is the test that would fail first if
    // someone ever added a `git commit` to the check.
    const repo = makeRepo()
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')
    const headBefore = git(repo, 'rev-parse', 'HEAD')
    const statusBefore = git(repo, 'status', '--porcelain')
    const branchesBefore = git(repo, 'branch', '--format=%(refname)')

    const booted = await bootPlugin(repo)
    try {
      await check(booted, { cwd: repo })
    } finally {
      booted.cleanup()
    }

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(repo, 'branch', '--format=%(refname)')).toBe(branchesBefore)
  })

  it('reports rather than throws outside a repository', async () => {
    const dir = makeNonRepo()
    const booted = await bootPlugin(dir)
    try {
      const output = await check(booted, { cwd: dir })
      expect(output).toContain('not inside a git work tree')
    } finally {
      booted.cleanup()
    }
  })

  it('refuses to record a decision outside a repository, in plain text', async () => {
    const dir = makeNonRepo()
    const booted = await bootPlugin(dir)
    try {
      // An exception here would be for the agent to interpret; a sentence it can
      // relay to the user is the better shape. Asserted as text AND as a
      // non-throw, because the non-throw is the actual contract.
      const output = await check(booted, { cwd: dir, decision: 'on' })
      expect(output).toContain('Not inside a git work tree')
      expect(existsSync(gitFlowDecisionPath())).toBe(false)
    } finally {
      booted.cleanup()
    }
  })
})

describe('nexus.git.check asks once per repository', () => {
  it('tells the agent to ask the user when no decision is recorded', async () => {
    // THE ASK. There is no other channel: a subagent is driven by tool calls,
    // so the only way to reach a human is for the tool result to instruct the
    // agent to ask, and for the agent to carry it to the user. If this text
    // goes away, the feature silently never gets an answer.
    const repo = makeRepo()
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')

    const booted = await bootPlugin(repo)
    try {
      const output = await check(booted, { cwd: repo })
      expect(output).toContain('ACTION FOR YOU, NOT FOR A TOOL')
      expect(output).toContain('Ask the user ONCE')
      expect(output).toContain('decision: "on"')
      expect(output).toContain('decision: "off"')
      // And it states that the tool itself will not block, so an agent reading
      // it does not treat the report as a failure it must resolve.
      expect(output).toContain('never refuses')
    } finally {
      booted.cleanup()
    }
  })

  it('records the answer, and a second run does not ask again', async () => {
    const repo = makeRepo()
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')

    const booted = await bootPlugin(repo)
    try {
      const before = await check(booted, { cwd: repo })
      expect(before).toContain('ACTION FOR YOU')

      const recorded = await check(booted, { cwd: repo, decision: 'off' })
      expect(recorded).toContain('Recorded the git convention decision for this repository: off')

      // A SECOND run in the same repo, as a later session would do. The ask
      // instruction must be gone.
      const second = await check(booted, { cwd: repo })
      // The ask instruction is gone AND the report names the recorded answer, so
      // silence is explained rather than merely absent — a report that said
      // nothing would look like a check that had stopped working.
      expect(second).not.toContain('ACTION FOR YOU')
      expect(second).not.toContain('No convention decision recorded')
      expect(second).toContain('Convention decision recorded: off')
    } finally {
      booted.cleanup()
    }
  })

  it('records nothing in the user\'s repository when it records the answer', async () => {
    // The trust boundary. Recording a decision is a WRITE, and it has to land in
    // nexus's own global config directory — never a file in the user's tree that
    // they would have to gitignore.
    const repo = makeRepo()
    const statusBefore = git(repo, 'status', '--porcelain')

    const booted = await bootPlugin(repo)
    try {
      await check(booted, { cwd: repo, decision: 'on' })
    } finally {
      booted.cleanup()
    }

    expect(gitFlowDecisionPath().startsWith(SANDBOX_HOME)).toBe(true)
    expect(existsSync(gitFlowDecisionPath())).toBe(true)
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore)
  })

  it('re-reads a decision recorded by an EARLIER plugin load', async () => {
    // The store is a FILE, so the promise has to survive a restart, not just
    // hold in one process. A second `bootPlugin` is the closest honest stand-in
    // for a restart short of spawning a process.
    const repo = makeRepo()
    git(repo, 'checkout', '-b', 'feat/x')
    commit(repo, 'feat: work')

    const first = await bootPlugin(repo)
    try {
      await check(first, { cwd: repo, decision: 'off' })
    } finally {
      first.cleanup()
    }

    const second = await bootPlugin(repo)
    try {
      const output = await check(second, { cwd: repo })
      expect(output).not.toContain('ACTION FOR YOU')
      expect(output).toContain('Convention decision recorded: off')
    } finally {
      second.cleanup()
    }
  })

  it('keeps two repositories\' decisions apart', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const booted = await bootPlugin(tempDir('nexus-gitcheck-boot2-'))
    try {
      await check(booted, { cwd: repoA, decision: 'off' })
      // B has no answer yet, so B still asks. One repository's answer must not
      // silence another's.
      const outputB = await check(booted, { cwd: repoB })
      expect(outputB).toContain('ACTION FOR YOU')
    } finally {
      booted.cleanup()
    }
  })
})
