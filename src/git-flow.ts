/**
 * Git state detection and the read-only side of the git-flow convention.
 *
 * SCOPE, and the reason this file exists at all: nothing in `src/` writes to
 * git. `WorktreeManager` (`src/worktree.ts`) shells out to `git worktree
 * add/remove`, and that is the only git the orchestrator does today. The
 * convention layer is REPORTING: it looks, and it tells the agent what it saw.
 * There is deliberately no `git commit`, no `git push` and no `git merge` in
 * this file, and adding one would be the single most consequential change the
 * package could make — a plugin that runs `git commit` in the user's own
 * repository is a trust step, not a convenience.
 *
 * WHY A NEW FILE, and not more of `orchestrator.ts`: the parallel
 * memory-retrieval work lands in `orchestrator.ts` in the same branch. Keeping
 * detection, the conventional-commit matcher, the per-repo decision store and
 * the check's report builder in one self-contained module means this feature's
 * footprint in that file is a constructor seed, one gate call, and a handful of
 * tool registrations — instead of several hundred interleaved lines.
 *
 * ARGV, NOT A SHELL STRING. Every spawn here passes an argument array with no
 * shell, so a repository path, a branch name or a remote URL containing shell
 * metacharacters is data and can never be executed. `src/worktree.ts:36` builds
 * `git worktree add "${path}" -b "${branch}"` by string interpolation, and
 * this repository shipped a command-injection bug in exactly that shape
 * (`src/notifications.ts`). The pattern next door is the counterexample, not
 * the model.
 *
 * EVERY CALL IS BOUNDED AND NON-THROWING. Each spawn carries a timeout, and
 * `runGit` returns `null` on any failure — ENOENT (no `git` on PATH), a
 * timeout, a non-zero exit, a broken repository. Detection degrades to
 * "unknown", it never aborts the task that happened to trigger it. A
 * convention layer that can throw during plugin load is a convention layer that
 * gets disabled.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { NexusGitFlowConfig } from "./config"

/** Wall-clock bound on a single `git` spawn. */
const GIT_TIMEOUT_MS = 2_000

/**
 * Largest number of commit subjects any single read will pull.
 *
 * A check that walks 5,000 commits to report on 3 is a check nobody runs. The
 * cap makes the cost of `nexus.git.check` bounded and reportable, and it is
 * stated in the report itself when it bites, so a truncated reading is never
 * presented as a whole one.
 */
const MAX_COMMITS_READ = 50

/**
 * The cap, re-exported for the test that asserts the bound exists.
 *
 * Exporting a constant to test that it has not changed is not a test of
 * behaviour — but the alternative is a bound that can be raised silently, and
 * this bound is a documented cost of the check rather than an implementation
 * detail. Naming it in the test makes a change to it a visible diff.
 */
export const MAX_COMMITS_READ_FOR_TESTS = MAX_COMMITS_READ

/**
 * One non-throwing `git` invocation.
 *
 * `shell` is left off (Node's default is `false`) and the command is an argv
 * array, so no argument is ever parsed as shell syntax. The timeout covers a
 * hung `git` — a network-backed credential helper on `rev-parse` is the
 * realistic hang — and `stdio` is piped so a chatty git cannot write to the
 * user's terminal.
 *
 * @returns trimmed stdout on success, or `null` for ANY failure. Callers treat
 *   `null` as "unknown", never as an error to raise.
 */
function runGit(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): string | null {
  try {
    const result = spawnSync("git", [...args], {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
    // `error` covers ENOENT and the timeout kill; `status !== 0` covers "not a
    // repository" and a detached-HEAD `@{upstream}` probe. Neither is worth
    // distinguishing: both mean this question is unanswerable here.
    if (result.error || result.status !== 0) return null
    return typeof result.stdout === "string" ? result.stdout.trim() : null
  } catch {
    // `spawnSync` can throw synchronously on a malformed cwd (an ENOENT that
    // surfaces during exec rather than as `error`). Same answer: unknown.
    return null
  }
}

/**
 * What is knowable about the git checkout at a path, and — as importantly —
 * what is not.
 *
 * `known: false` is a first-class outcome, not a failure. A missing `git`, a
 * directory that is not a repository, a `cwd` that does not exist: all of them
 * produce a `GitState` the callers can report and none of them can throw.
 */
export interface GitState {
  /**
   * Whether a git work tree was detected around `cwd`.
   *
   * `git rev-parse --is-inside-work-tree` rather than an `existsSync` on `.git`:
   * a linked worktree (this very checkout) has a `.git` FILE pointing at the
   * real dir, and a repository whose `.git` is several levels up — or one where
   * `GIT_DIR` points elsewhere entirely — has no local `.git` at all. Git is
   * the authority on whether it is in a work tree, and asking it costs the same
   * spawn the rest of the questions cost.
   */
  isRepo: boolean
  /** Absolute top level of the work tree, or `null` when not in one. */
  repoRoot: string | null
  /**
   * Stable identity of the REPOSITORY, for the per-repo decision key.
   *
   * DISTINCT FROM `repoRoot`, and the distinction is load-bearing. A LINKED
   * WORKTREE is its own work tree with its own top level: `git rev-parse
   * --show-toplevel` inside one returns the worktree's path, not the main
   * repository's. Keying the "ask once per repo" decision on `repoRoot` would
   * therefore re-ask a user who had already answered, once per worktree — the
   * exact failure the once-per-repo promise exists to prevent, and invisible
   * unless you happen to test from two worktrees at once.
   *
   * `git rev-parse --git-common-dir` is the shared git directory: the main
   * repository's `.git` for a worktree, and `.git` for a normal checkout. This
   * module keys on that. It costs nothing — the flag is batched into the same
   * `rev-parse` spawn as the other five questions.
   *
   * A BARE repository reports `.` here, so its id is the parent of the bare
   * directory. Not special-cased: nothing in this feature branches or commits in
   * a bare clone, and inventing a rule for it would be a knob nothing reads.
   */
  repoId: string | null
  /**
   * Current branch name, or `null`.
   *
   * `null` for BOTH "not in a repository" and "HEAD is detached" — check
   * `detached` to tell them apart. A branch name is never invented from a
   * detached HEAD's commit sha.
   */
  branch: string | null
  /** True when HEAD is detached (a checkout of a commit, or a tag). */
  detached: boolean
  /** Whether at least one remote is configured. Does NOT mean it is reachable. */
  hasRemote: boolean
  /** First configured remote name, or `null`. */
  remote: string | null
  /** False when detection could not complete, so every field is unverified. */
  known: boolean
}

/**
 * `realpathSync` that returns its input when the path cannot be resolved.
 *
 * Needed because the two platforms disagree about what a repository path IS:
 * on darwin a temp directory is `/var/folders/...` and its realpath is
 * `/private/var/folders/...`, and git reports one in one call and the other in
 * another. Anything that keys on a repository path has to normalise, or the
 * same repository produces two identities depending on which worktree you are
 * standing in. `ubuntu-latest` has no second `/var`, so a comparison that
 * passes there can still be wrong on a contributor's machine.
 */
function realpathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The answer when nothing could be determined. */
const UNKNOWN_GIT_STATE: GitState = {
  isRepo: false,
  repoRoot: null,
  repoId: null,
  branch: null,
  detached: false,
  hasRemote: false,
  remote: null,
  known: false,
}

/**
 * Detect git state for `cwd`.
 *
 * COST: two `git` processes, and they are batched as far as git allows.
 *
 * `rev-parse --is-inside-work-tree --show-toplevel --abbrev-ref HEAD` answers
 * three of the six questions in ONE spawn, verified to emit its results in
 * argument order and to fail as a whole (exit 128, no output) when `cwd` is not
 * a repository — which is what makes the not-a-repo case fall out for free
 * instead of costing a probe. A second spawn reads the remote list.
 *
 * Measured on the development machine (`darwin`, 100 iterations): ~39 ms per
 * `spawnSync`. That figure is process creation, not git: `git --version` — which
 * touches no repository at all — costs 39.6 ms in the same harness, and the
 * repository-backed calls come in marginally UNDER it. On an unsandboxed host
 * spawn is closer to 3-8 ms, so treat 40 ms as this environment's floor.
 * Detection is called ONCE per plugin load and the result is memoised by the
 * caller, so ~80 ms here lands once in a process that runs for hours; it is not
 * on a per-task path. It would NOT be acceptable per spawn, which is the other
 * half of why the questions are batched.
 */
export function detectGitState(cwd: string): GitState {
  const combined = runGit(
    ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"],
    cwd,
  )
  if (combined === null) {
    // Either not a repository, or git is missing/broken. Distinguish only the
    // case worth acting on: a missing binary is worth one stderr-free probe,
    // and `git --version` is the cheapest possible one.
    const version = runGit(["--version"], cwd, 500)
    return { ...UNKNOWN_GIT_STATE, known: version !== null }
  }

  const [isInside, repoRoot, commonDir, head] = combined.split("\n")
  if (isInside !== "true" || !repoRoot) return { ...UNKNOWN_GIT_STATE, known: true }

  // `--abbrev-ref HEAD` prints the literal string `HEAD` when detached. That is
  // the documented signal, and it is why `branch` is null rather than "HEAD":
  // a branch literally named `HEAD` is not something to guess at.
  const detached = head === "HEAD" || !head

  const remotes = runGit(["remote"], cwd)
  const remoteList = remotes ? remotes.split("\n").filter(Boolean) : []

  // `commonDir` is RELATIVE for a normal checkout (`.git`) and ABSOLUTE — and
  // already a realpath — for a linked worktree. On macOS that asymmetry is
  // fatal to the whole idea of a stable per-repository key: the OS temp root is
  // `/var/folders/...`, reachable through a `/var -> /private/var` symlink, so
  // the main checkout would report `/var/...` and a worktree of the very same
  // repository would report `/private/var/...` — two different keys, two
  // different decisions, and the user asked twice. `realpathSync` collapses them.
  //
  // It can throw (a bare repository has no `.git`, a directory can vanish
  // between the rev-parse and this call), and a fallback to the unresolved
  // path is strictly better than failing detection over a key.
  const resolvedCommonDir = realpathOf(resolve(cwd, commonDir ?? '.git'))

  return {
    isRepo: true,
    repoRoot: resolve(repoRoot),
    repoId: dirname(resolvedCommonDir),
    branch: detached ? null : (head ?? null),
    detached,
    hasRemote: remoteList.length > 0,
    remote: remoteList[0] ?? null,
    known: true,
  }
}

/**
 * Conventional Commits, as a SUBJECT-line matcher.
 *
 * The type allowlist is the specification's own set of examples, not a free
 * noun: a matcher that accepts any `word: text` reports "conventional" for
 * `banana: fix the thing`, which is a check that never fails and therefore a
 * check that teaches the agent nothing. `BREAKING CHANGE` is a FOOTER, not a
 * subject, so it is out of scope here — only the subject line is read, and a
 * `!` before the colon is accepted for the breaking-change form.
 */
const CONVENTIONAL_COMMIT = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)\r\n]+\))?!?: .+/i

/** The allowlist as data, so the report can tell the reader what was allowed. */
export const CONVENTIONAL_COMMIT_TYPES: readonly string[] = [
  "build", "chore", "ci", "docs", "feat", "fix",
  "perf", "refactor", "revert", "style", "test",
]

/**
 * Whether one commit subject matches the convention.
 *
 * Exported for the check, and for a test that can assert the matcher without
 * building a repository — the matcher is pure and has no git dependency, so it
 * is the one part of this file that is cheap to test exhaustively.
 */
export function isConventionalCommitSubject(subject: string): boolean {
  return CONVENTIONAL_COMMIT.test(subject.trim())
}

/** How a single commit subject was judged. */
export interface CommitVerdict {
  sha: string
  subject: string
  conventional: boolean
}

/** The base a branch's commits are counted against, and why that base. */
export interface CommitScope {
  /** The ref the range was taken against, e.g. `origin/main`. */
  base: string
  /** How it was chosen — reported, because the base decides the verdict. */
  baseSource: 'upstream' | 'remote-default' | 'local-default' | 'none'
  /** True when the read hit `MAX_COMMITS_READ` and older commits were skipped. */
  truncated: boolean
}

/** The result of one read-only `nexus.git.check`. */
export interface GitCheckReport {
  /** Whether detection completed at all. */
  detected: boolean
  /** One-line verdict for a human reading a log. */
  summary: string
  /** Whether HEAD is on a branch rather than detached, and which. */
  onFeatureBranch: boolean
  branch: string | null
  detached: boolean
  /** Every subject read, with its verdict. Empty when no base was found. */
  commits: CommitVerdict[]
  /** How many of `commits` matched. */
  conventionalCount: number
  /** The scope the commit list was read over. */
  scope: CommitScope
  /**
   * Whether the branch is published — the local proxy for "a PR can exist".
   *
   * This is NOT "a PR is open". Whether a pull request is OPEN cannot be
   * determined from a local checkout without querying the forge, and the
   * orchestrator does not shell out to `gh` or hit a network on a status call.
   * So the report says what it can prove locally and names the limit.
   */
  branchPublished: boolean
  /** Uncommitted files, as reported by `git status --porcelain`. */
  uncommitted: string[]
  /** What this check explicitly did NOT do. */
  didNot: readonly string[]
  /** Whether the per-repo convention decision has been recorded yet. */
  decision: GitFlowDecision | null
}

/** The two answers to "should nexus follow the git convention in this repo". */
export type GitFlowDecision = 'on' | 'off'

/**
 * Where the per-repo decision is persisted.
 *
 * `~/.config/opencode/nexus-gitflow.json` — the same global directory the global
 * `nexus.jsonc` (`nexusGlobalConfigPath()`) and the generated agent files
 * (`join(homedir(), '.config', 'opencode', 'agents')`) already live in, for the
 * same reason: it is nexus's own, and it is not the user's repository.
 *
 * NOT in the repository. A `.nexus/` file in the user's working tree is a file
 * a contributor trips over, a `git status` noise line, and a thing to remember
 * to gitignore — and it would be a write into the user's repo, which is exactly
 * what this feature refuses to do.
 *
 * NOT in `nexus.jsonc`. That file is ONE document about ONE project; a map from
 * repository path to answer is a different shape of thing, and putting it there
 * would make a config file grow a block that no single project can describe.
 */
export function gitFlowDecisionPath(): string {
  return resolve(join(homedir(), ".config", "opencode", "nexus-gitflow.json"))
}

/** On-disk shape of the decision store. */
interface GitFlowDecisionFile {
  decisions: Record<string, GitFlowDecision>
}

/**
 * Read the per-repo decision store.
 *
 * A missing file, an unparseable file, or a file of the wrong shape all read as
 * "no decision recorded" rather than throwing: the answer being absent is the
 * normal state for every repo the user has not been asked about yet, and a
 * corrupt cache must not be able to stop a check.
 */
export function readGitFlowDecisions(): Record<string, GitFlowDecision> {
  try {
    const raw = readFileSync(gitFlowDecisionPath(), "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const decisions = (parsed as GitFlowDecisionFile).decisions
    if (decisions === null || typeof decisions !== "object" || Array.isArray(decisions)) return {}
    // Narrow rather than cast: a hand-edited file can hold anything, and only
    // the two documented values may be believed.
    const valid: Record<string, GitFlowDecision> = {}
    for (const [key, value] of Object.entries(decisions)) {
      if (value === 'on' || value === 'off') valid[key] = value
    }
    return valid
  } catch {
    return {}
  }
}

/**
 * Record the decision for one repository root and return what is now stored.
 *
 * Writes the whole store back, so concurrent additions from two sessions could
 * lose one another; that is accepted rather than solved with a lock file. The
 * window is a single read-modify-write of a two-field JSON file, the lost update
 * costs one repeat question, and a lock file in the user's config directory is
 * a worse artefact than a re-ask.
 *
 * @throws only on an unwritable path. There is no safe way to "record nothing"
 *   and report success, and a silent failure here would mean the user is asked
 *   the same question on every load forever — so the failure is surfaced.
 */
export function writeGitFlowDecision(repoRoot: string, decision: GitFlowDecision): GitFlowDecision {
  const path = gitFlowDecisionPath()
  const next: GitFlowDecisionFile = { decisions: { ...readGitFlowDecisions(), [repoRoot]: decision } }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8")
  return decision
}

/** The effective convention for one repository, after config AND the per-repo answer. */
export interface ResolvedGitFlow {
  /** The config block, already merged across every precedence level. */
  config: NexusGitFlowConfig
  /**
   * Whether the convention applies here.
   *
   * `config.enabled` is necessary but not sufficient: an OFF decision for this
   * repo wins, because it is the more specific statement. A repo whose user
   * answered `off` is not steered by an `enabled: true` default.
   */
  active: boolean
  /** Why it is on or off, in words a report can print. */
  reason: string
  /** The recorded answer, or `null` when this repo has never been asked. */
  decision: GitFlowDecision | null
}

/**
 * THE GATE. Every consumer of the convention calls this and nothing else.
 *
 * There is one of these on purpose. `dashboard.enabled` and
 * `notifications.enabled` each have exactly one reader, and that is what stopped
 * them being dead knobs in the first place — a setting read from two places has
 * no defined precedence between them, and the drift is how `enabled` ended up
 * readable from neither. A third place reading the block would repeat the
 * defect, so the rule is: the markdown injection, `nexus.git.check` and the
 * ask-once path all resolve through here.
 *
 * The default when a repo has never been asked is ON, and the reasoning is the
 * brief's own: the convention VALIDATES rather than blocks, and nothing in this
 * file writes to git. The worst outcome of guessing wrong is a report that says
 * `conventional: false` about three commits — a sentence a reader ignores. The
 * worst outcome of defaulting off is that the feature is inert for every user
 * who does not answer, which is indistinguishable from not having built it.
 * An environment that genuinely cannot branch (detached HEAD, a CI checkout)
 * does not fail hard either: it has no branch, so the report says so and
 * nothing is enforced.
 */
export function resolveGitFlow(
  config: NexusGitFlowConfig,
  state: GitState,
  decisions: Record<string, GitFlowDecision> = readGitFlowDecisions(),
): ResolvedGitFlow {
  const decision = state.repoId ? decisions[state.repoId] ?? null : null
  if (!config.enabled) {
    return { config, active: false, reason: '`gitFlow.enabled` is false in nexus.jsonc.', decision }
  }
  if (decision === 'off') {
    return {
      config,
      active: false,
      reason: `The git convention was turned off for this repository (${state.repoId ?? 'unknown repository'}).`,
      decision,
    }
  }
  if (decision === 'on') {
    return { config, active: true, reason: `The git convention was turned on for this repository (${state.repoId ?? 'unknown repository'}).`, decision }
  }
  return {
    config,
    active: true,
    reason: state.isRepo
      ? `The git convention is on by default and no decision has been recorded for this repository (${state.repoId}).`
      : "The git convention is on by default, but this directory is not inside a git work tree, so there is nothing to apply it to.",
    decision,
  }
}

/**
 * Find the ref this branch's commits should be counted against.
 *
 * Tried in order, and the winner is REPORTED rather than assumed, because the
 * base decides the verdict and a silent choice of base is how a check comes to
 * disagree with a reviewer:
 *
 *  1. the branch's own upstream — the exact thing a PR would be opened against;
 *  2. `<remote>/main` or `<remote>/master` — the common unpushed case;
 *  3. the local `main` or `master` — a clone with no remote at all;
 *  4. nothing. Returned as `base: null` and the report says so, rather than
 *     silently falling back to "the last 50 commits", which on a mature
 *     repository would report on a colleague's history.
 */
function resolveCommitBase(cwd: string, state: GitState): { base: string; source: CommitScope["baseSource"] } | null {
  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd)
  // An upstream equal to the current branch is NOT a base. For a pushed
  // feature branch, `@{upstream}` resolves to that same branch, and counting
  // commits against it yields an empty range — which reports "no commits on this
  // branch" for a branch that has three. That is the check reporting a clean
  // bill of health for work it never looked at, so the self-reference is
  // rejected here and resolution falls through to the real base below.
  if (upstream && upstream !== state.branch && upstream !== `HEAD`) {
    return { base: upstream, source: 'upstream' }
  }

  const defaultBranch = state.remote
    ? runGit(["rev-parse", "--verify", "--quiet", `${state.remote}/main`], cwd) ? "main"
      : runGit(["rev-parse", "--verify", "--quiet", `${state.remote}/master`], cwd) ? "master"
        : null
    : null
  if (state.remote && defaultBranch) {
    return { base: `${state.remote}/${defaultBranch}`, source: 'remote-default' }
  }

  for (const candidate of ["main", "master"]) {
    if (runGit(["rev-parse", "--verify", "--quiet", candidate], cwd)) {
      return { base: candidate, source: 'local-default' }
    }
  }
  return null
}

/**
 * Build the read-only report behind `nexus.git.check`.
 *
 * NEVER writes. Every spawn below is a query — `rev-parse`, `log`, `status`,
 * `for-each-ref` — and none of them can alter a work tree, a ref or an index.
 * That is the whole contract of this function, and the `didNot` list it returns
 * is the user-facing statement of it, because a report that says what it did
 * not do is the only evidence a reader has that it was safe to run.
 */
export function buildGitCheckReport(state: GitState, config: NexusGitFlowConfig): GitCheckReport {
  const didNot: readonly string[] = [
    "did not run `git commit`, `git push` or `git merge`",
    "did not modify any file, ref, index or work tree",
    "did not query the forge, so whether a pull request is OPEN is not knowable from here",
  ]

  const decisions = readGitFlowDecisions()
  const resolved = resolveGitFlow(config, state, decisions)

  if (!state.known) {
    return {
      detected: false,
      summary: "Git state could not be determined — `git` is missing, or this path is not inside a work tree. Nothing was checked.",
      onFeatureBranch: false,
      branch: null,
      detached: false,
      commits: [],
      conventionalCount: 0,
      scope: { base: "(none)", baseSource: 'none', truncated: false },
      branchPublished: false,
      uncommitted: [],
      didNot,
      decision: null,
    }
  }

  if (!state.isRepo) {
    return {
      detected: true,
      summary: "This directory is not inside a git work tree, so there is no branch, no commit history and nothing for the convention to apply to.",
      onFeatureBranch: false,
      branch: null,
      detached: false,
      commits: [],
      conventionalCount: 0,
      scope: { base: "(none)", baseSource: 'none', truncated: false },
      branchPublished: false,
      uncommitted: [],
      didNot,
      decision: null,
    }
  }

  const cwd = state.repoRoot ?? process.cwd()

  // SCOPE: this branch's commits since it diverged from its base, capped at
  // MAX_COMMITS_READ. Not "the whole history" (5,000 commits to report on 3
  // is a check nobody runs) and not "uncommitted work only" (which would report
  // a clean tree as perfect while a branch of three non-conventional commits sat
  // right there). The base is the same set a PR would contain, which is the
  // question the reader is actually asking.
  const resolvedBase = resolveCommitBase(cwd, state)
  const rangeArgs = resolvedBase ? [`${resolvedBase.base}..HEAD`] : ['HEAD']
  const requested = MAX_COMMITS_READ + 1
  const raw = runGit(
    ["log", `--max-count=${requested}`, "--format=%H%x1f%s", ...rangeArgs],
    cwd,
  )
  const lines = raw ? raw.split("\n").filter(Boolean) : []
  const truncated = lines.length > MAX_COMMITS_READ
  const commits: CommitVerdict[] = lines.slice(0, MAX_COMMITS_READ).map(line => {
    // US (unit separator), not a space and not a newline: git is free to put
    // either inside a subject, and a subject that split a record in two would
    // report a commit that does not exist.
    const separator = line.indexOf("\u001f")
    const sha = separator === -1 ? line : line.slice(0, separator)
    const subject = separator === -1 ? "" : line.slice(separator + 1)
    return { sha: sha ?? "", subject, conventional: isConventionalCommitSubject(subject) }
  })

  // Whether the branch exists on a remote is a LOCAL question (`for-each-ref`
  // over `refs/remotes`), not a network one, so it is a real signal rather than
  // a guess. It is NOT the same claim as "a PR is open" and the report says so.
  const branchPublished = state.branch
    ? runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${state.remote ?? "origin"}/${state.branch}`], cwd) !== null
    : false

  const status = runGit(["status", "--porcelain"], cwd)
  const uncommitted = status ? status.split("\n").filter(Boolean) : []

  const conventionalCount = commits.filter(c => c.conventional).length
  const scope: CommitScope = {
    base: resolvedBase?.base ?? "(no base ref found — the last commits on this branch were read instead)",
    baseSource: resolvedBase?.source ?? 'none',
    truncated,
  }

  const nonConventional = commits.length - conventionalCount
  const parts: string[] = []
  parts.push(state.detached
    ? "HEAD is DETACHED, so there is no branch to hold a change and nothing was enforced."
    : `On branch \`${state.branch}\`.`)
  if (!config.requireBranch && !state.detached) {
    parts.push("(`gitFlow.requireBranch` is off, so being on a branch is not required here.)")
  }
  if (commits.length === 0) {
    parts.push("No commits on this branch beyond its base.")
  } else {
    parts.push(
      `${conventionalCount}/${commits.length} commit subject(s) match Conventional Commits`
      + (nonConventional > 0 ? `; ${nonConventional} do not.` : ".")
    )
  }
  if (truncated) parts.push(`Read the most recent ${MAX_COMMITS_READ} commits only — older ones were not read.`)
  if (uncommitted.length > 0) parts.push(`${uncommitted.length} path(s) have uncommitted changes.`)
  parts.push(branchPublished
    ? "This branch exists on the remote, so a pull request can be opened for it — whether one is open is not knowable from a local checkout."
    : "This branch is not published, so there is no pull request for it yet.")
  parts.push(resolved.decision
    ? `Convention decision recorded: ${resolved.decision}.`
    : "No convention decision recorded for this repository yet.")

  return {
    detected: true,
    summary: parts.join(" "),
    onFeatureBranch: !state.detached,
    branch: state.branch,
    detached: state.detached,
    commits,
    conventionalCount,
    scope,
    branchPublished,
    uncommitted,
    didNot,
    decision: resolved.decision,
  }
}
