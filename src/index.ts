import { Plugin } from "@opencode/plugin"
import { NexusOrchestrator, lastAssistantText, type NexusModelCost, type SpawnedAgent } from "./orchestrator"
import { PRESETS, nexusProjectConfigPath, nexusGlobalConfigPath, type NexusConfigReloadTrigger } from "./config"
import { TEMPLATES, instantiateTemplate, listTemplates } from "./templates"
import { GoalManager } from "./goal"
import { TeamManager } from "./team"
import { AstGrep } from "./astgrep"
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs"
import { join, resolve, basename, dirname } from "node:path"
import { homedir } from "node:os"

/**
 * Filesystem watchers fire several times for a single editor save (write,
 * truncate, rename-into-place, plus the editor's own atomic-save dance). Wait
 * for the burst to settle so one save causes one reload.
 */
export const CONFIG_RELOAD_DEBOUNCE_MS = 150

/**
 * How often the config files are stat-ed for changes.
 *
 * This is the *guaranteed* trigger. `filesystem.changed` is only a fast path:
 * OpenCode enumerates the specific paths it watches, and `nexus.jsonc` is
 * Nexus's own filename, so there is no reason to expect an event for it. A live
 * probe against a real server delivered zero such events, so a feature whose
 * whole purpose is eliminating silent staleness cannot depend on that event.
 */
export const CONFIG_POLL_INTERVAL_MS = 2000

/**
 * The slice of the plugin context the config watcher needs. `event` is
 * optional so the watcher degrades to a no-op on contexts that do not expose
 * an event stream, instead of throwing during setup.
 */
type ConfigWatchContext = Pick<Plugin.Context, 'location'> & {
  event?: Pick<Plugin.Context['event'], 'subscribe'>
}

/**
 * True when a changed file is one of the two config files the config manager
 * reads.
 *
 * The primary test is the resolved absolute path. The shape-based fallback
 * exists for when normalisation is unreliable — a symlinked home, or a
 * `location.directory` that is not the same string the loader saw — and
 * recognises the `<...>/.opencode/nexus.jsonc` shape itself. It is narrowed by
 * the event's own `location.directory` when the host supplies one: a nested
 * package in a monorepo ships its own `.opencode/nexus.jsonc`, and this project
 * does not read that file, so matching on shape alone would reload needlessly.
 */
function isNexusConfigFile(
  file: string,
  eventDirectory: string | undefined,
  projectDirectory: string,
  projectPath: string,
  globalPath: string,
): boolean {
  const resolved = resolve(file)
  if (resolved === projectPath || resolved === globalPath) return true

  if (eventDirectory !== undefined && resolve(eventDirectory) !== projectDirectory) return false

  return basename(resolved) === 'nexus.jsonc' && basename(dirname(resolved)) === '.opencode'
}

/**
 * Contexts that already have a live config subscription. `setup` is not
 * re-entered today, but two live watchers would mean two poll intervals and two
 * reloads per save, silently.
 */
const watchedContexts = new WeakSet<ConfigWatchContext>()

/**
 * Upper bound on how long the debounce may defer a reload.
 *
 * Without it, `scheduleReload` is a pure trailing-edge debounce: anything
 * arriving faster than `debounceMs` resets the timer forever and the reload
 * never runs. A file-sync client or `git checkout` loop rewriting
 * `nexus.jsonc` at more than ~7Hz is enough. An unbounded debounce here is
 * silent, permanent staleness — the exact defect this feature exists to remove.
 */
export const MAX_RELOAD_WAIT_MS = 1000

/**
 * Floor for the injected intervals. `watchConfigFiles` is exported, and
 * `setInterval(fn, 0)` would be a hot loop stat-ing continuously. The only
 * production caller passes the defaults, so this is defence in depth; the floor
 * is kept low enough that a test can drive the poller quickly.
 */
const MIN_INTERVAL_MS = 25

const clampInterval = (ms: number, fallback: number): number =>
  Number.isFinite(ms) && ms >= MIN_INTERVAL_MS ? ms : fallback

/**
 * Reload the Nexus config whenever one of the files the config manager reads
 * changes, so a `nexus.jsonc` edit takes effect without restarting the service.
 *
 * Two triggers feed one bounded-debounced reload, so there is a single code
 * path and a single set of semantics:
 *
 *  - `filesystem.changed` — the fast path. Handles all three kinds: `change`
 *    (edited), `add` (created) and `unlink` (deleted, which falls back to the
 *    next level rather than keeping the deleted file's values), because a
 *    reload re-reads every level, so the deleted level stops contributing.
 *  - mtime/size polling — the guarantee. It stat-s exactly the two files the
 *    loader reads, so unlike the event it needs no shape heuristics and cannot
 *    be scoped to (or missed because of) another project's config. Polling is
 *    installed unconditionally: it must not depend on the event stream, since
 *    the event is the trigger we cannot demonstrate.
 *
 * `config.init` writes these exact two files, so running it produces a second
 * load ~150ms later. That re-read is idempotent and harmless; the extra log
 * line is expected, not a bug.
 *
 * The returned disposer clears the poll interval, aborts the subscription and
 * clears a pending debounce timer, so neither mechanism can fire after plugin
 * unload.
 */
export function watchConfigFiles(
  ctx: ConfigWatchContext,
  orchestrator: NexusOrchestrator,
  debounceMs: number = CONFIG_RELOAD_DEBOUNCE_MS,
  pollMs: number = CONFIG_POLL_INTERVAL_MS,
): () => void {
  if (watchedContexts.has(ctx)) return () => {}
  watchedContexts.add(ctx)

  const debounce = clampInterval(debounceMs, CONFIG_RELOAD_DEBOUNCE_MS)
  const pollEvery = clampInterval(pollMs, CONFIG_POLL_INTERVAL_MS)

  const projectDirectory = resolve(ctx.location.directory)
  const projectPath = nexusProjectConfigPath(ctx.location.directory)
  const globalPath = nexusGlobalConfigPath()
  const watchedPaths = [projectPath, globalPath]

  const controller = new AbortController()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let firstScheduledAt = 0

  const clearPendingReload = (): void => {
    if (debounceTimer === null) return
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  /**
   * Cheap change signature for one path. Both mtime and size are compared so a
   * same-tick edit that changes length is still caught. Any failure — missing
   * file, permission denied, a directory in the way — reads as 'absent', which
   * is stable, so an unreadable path can never spin the poller. A throw here
   * would kill the interval and silently stop the guarantee.
   *
   * Synchronous `statSync`, and it assumes a local filesystem: on a hung
   * NFS/WSL/sshfs mount this blocks the event loop for the duration. That is
   * accepted deliberately — a `stat` every 2s on a path that may be a network
   * mount is the one cost of making reload guaranteed, and the alternative
   * (an async stamp, and the interleaving that comes with it) is more moving
   * parts than the risk justifies. A hung stat stalls the loop, it does not
   * corrupt state, and `MAX_RELOAD_WAIT_MS` bounds the consequence.
   */
  const stampOf = (filePath: string): string => {
    try {
      const stats = statSync(filePath)
      if (!stats.isFile()) return 'absent'
      return `${stats.mtimeMs}:${stats.size}`
    } catch {
      return 'absent'
    }
  }

  // Record the starting state, so the first poll cannot fire a spurious reload
  // for a file that has not moved since the last load.
  const lastSeen = new Map<string, string>(watchedPaths.map(p => [p, stampOf(p)]))

  /**
   * The reload body, shared by the debounce timer and the bounded-wait escape.
   *
   * The try/catch is required, not defensive decoration. This runs unguarded
   * inside an unattended timer for the plugin's lifetime, and it fans out to
   * `orchestrator.emit`, which invokes every `on(...)` handler with no
   * per-handler isolation. `orchestrator.on` is a public callable, so a
   * third-party or LLM-registered handler that throws would otherwise become an
   * uncaught exception in a timer callback — which can take down the host
   * process, triggered by nothing more than a user editing a config file.
   */
  const runReload = (trigger: NexusConfigReloadTrigger): void => {
    // Re-stamp BEFORE reloading. Stamping afterwards could miss an edit that
    // lands mid-reload, and a missed edit is the exact failure this feature
    // exists to prevent; a redundant reload is merely wasteful.
    for (const filePath of watchedPaths) lastSeen.set(filePath, stampOf(filePath))
    try {
      orchestrator.reloadConfigFromDisk(trigger)
    } catch (err) {
      console.warn(`[nexus] config reload failed (${trigger}): ${String(err)}`)
    }
  }

  /**
   * The one path both triggers go through. Bounded wait: the first arrival in
   * any window always gets its reload, so a sustained stream cannot starve it.
   */
  const scheduleReload = (trigger: NexusConfigReloadTrigger): void => {
    // How long the *pending* reload has already been deferred, measured from
    // when this window opened. With nothing pending there is no accumulated
    // wait, so this is a fresh window and the normal debounce applies —
    // treating "nothing pending" as an infinite wait would run every isolated
    // event immediately and defeat the debounce.
    const pending = debounceTimer !== null
    const waited = pending ? Date.now() - firstScheduledAt : 0
    clearPendingReload()
    if (pending && waited >= MAX_RELOAD_WAIT_MS) {
      runReload(trigger)
      return
    }
    // Set only when the window opens. Re-stamping on every reset would keep
    // `waited` pinned near zero and the cap would never fire — the starvation
    // this is here to prevent.
    if (!pending) firstScheduledAt = Date.now()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      runReload(trigger)
    }, debounce)
  }

  const poll = (): void => {
    let changed = false
    for (const filePath of watchedPaths) {
      const current = stampOf(filePath)
      if (lastSeen.get(filePath) === current) continue
      lastSeen.set(filePath, current)
      changed = true
    }
    // At most one reload per tick, however many paths moved.
    if (changed) scheduleReload('poll')
  }

  // `unref()` so a purely background watcher cannot hold the process open. It is
  // not unit of work that must complete — the config already in effect stays in
  // effect — so nothing is lost by letting the process exit without it. The
  // disposer below owns the interval and clears it explicitly.
  const pollTimer = setInterval(poll, pollEvery)
  pollTimer.unref()

  // N1: the event stream is the *optional* fast path, so it must not gate the
  // poller. A context without one still gets guaranteed reloads. This is
  // declared after the poller on purpose — the poller above is unconditional.
  const eventDomain = ctx.event
  if (typeof eventDomain?.subscribe !== 'function') {
    console.warn('[nexus] no config event stream on this context; polling is the only config reload trigger')
    return () => {
      clearInterval(pollTimer)
      clearPendingReload()
      controller.abort()
    }
  }

  const consume = async (): Promise<void> => {
    try {
      for await (const event of eventDomain.subscribe({ signal: controller.signal })) {
        if (event.type !== 'filesystem.changed') continue
        // A malformed event must not kill the fast path for the whole session.
        const file: unknown = event.data?.file
        if (typeof file !== 'string') continue
        if (!isNexusConfigFile(file, event.location?.directory, projectDirectory, projectPath, globalPath)) continue
        scheduleReload('event')
      }
      // Reaching here without an abort means the stream ended on its own —
      // a dropped connection, most likely. Say so: a silent end makes that
      // indistinguishable from "the host does not deliver events for these
      // files", which is the question the trigger attribution exists to answer.
      if (!controller.signal.aborted) {
        console.warn('[nexus] config event stream ended; polling remains the only config reload trigger')
      }
    } catch (err) {
      console.warn(`[nexus] config event stream failed; polling remains the only config reload trigger: ${String(err)}`)
    }
  }

  void consume()

  return () => {
    clearInterval(pollTimer)
    clearPendingReload()
    controller.abort()
  }
}

const NEXUS_AGENT_CONTENT = `---
description: Nexus multi-agent orchestrator — decomposes tasks and delegates to specialized sub-agents
mode: primary
permissions:
  - action: subagent
    resource: "nexus-*"
    effect: allow
  - action: subagent
    resource: "nexus-architect"
    effect: allow
  - action: subagent
    resource: "nexus-coder"
    effect: allow
  - action: subagent
    resource: "nexus-reviewer"
    effect: allow
  - action: subagent
    resource: "nexus-tester"
    effect: allow
  - action: subagent
    resource: "nexus-explorer"
    effect: allow
  - action: subagent
    resource: "nexus-documenter"
    effect: allow
---

# Nexus Orchestrator

You are a task orchestrator. Your ONLY job is to analyze requests, create plans, and delegate to sub-agents. You NEVER do the work yourself.

## How You Work

1. **Analyze** — Understand what the user wants
2. **Plan** — Break into tasks, assign to agents, show the plan
3. **Wait** — Get user approval before doing anything
4. **Execute** — Spawn agents for each task after approval
5. **Report** — Summarize results

## Rules

### You NEVER do these yourself:
- Read source files → use nexus.spawn(role="explorer")
- Write code → use nexus.spawn(role="coder")
- Review code → use nexus.spawn(role="reviewer")
- Write tests → use nexus.spawn(role="tester")
- Explore codebase → use nexus.spawn(role="explorer")
- Write docs → use nexus.spawn(role="documenter")

### You ALWAYS use nexus.spawn or nexus.delegate:
- NEVER use OpenCode's built-in subagent tool
- NEVER read files to "understand the codebase" yourself
- NEVER write a single line of code yourself

### Your workflow for EVERY request:

1. Read the user's request carefully
2. (Optional) Spawn an explorer agent to understand the codebase if needed
3. Create a plan listing:
   - Each task with its role (explorer, coder, reviewer, tester, documenter)
   - Dependencies between tasks (what must finish before what)
   - Which tasks can run in parallel
4. Present the plan to the user: "Here's my plan: [tasks]. Should I proceed?"
5. **Wait for user approval** — NEVER start executing without approval
6. After approval, spawn agents using nexus.spawn() or nexus.delegate()
7. Monitor progress and report when done

## Task Plan Format

When presenting a plan, use this format:

\`\`\`
Plan:

1. [explorer] Analyze the current implementation
   → Needed before: nothing (runs first)

2. [coder] Implement feature X
   → Depends on: task 1
   → Can run in parallel with: nothing

3. [tester] Write tests for feature X
   → Depends on: task 2
   → Can run in parallel with: task 4

4. [coder] Implement feature Y
   → Depends on: task 1
   → Can run in parallel with: task 3

5. [reviewer] Review all changes
   → Depends on: tasks 3, 4
   → Final step

Should I proceed?
\`\`\`

## Spawning Agents

After user approval, spawn agents:

\`\`\`
# Sequential (wait for result)
nexus.delegate(role="explorer", task="Analyze the auth module structure")

# Parallel (don't wait)
nexus.spawn(role="coder", task="Implement JWT auth", wait=false)
nexus.spawn(role="coder", task="Implement refresh tokens", wait=false)
\`\`\`

## Available Roles
- **explorer** — Read-only codebase analysis, architecture understanding
- **coder** — Write and modify code
- **reviewer** — Review code for bugs, security, quality (read-only)
- **tester** — Write and run tests
- **documenter** — Write documentation
- **architect** — Design system architecture (read-only)

## Cost & Config
- Models configured in nexus.jsonc or ~/.config/opencode/nexus.jsonc
- Use nexus.forecast() to estimate costs before spawning
- Use nexus.costs() to check budget
- Use nexus.performance.best(role) to pick best model for a role

## Git Workflow

When code changes are needed, follow this workflow:

### 1. Pre-Flight
- Detect git status (clean? on which branch?)
- Check for CI/CD config (.github/, .gitlab-ci.yml)
- Verify git identity is set (user.name, user.email)

### 2. Branching
- NEVER commit directly to main
- Create feature branch: feat/description, fix/description, chore/description
- Use conventional branch naming

### 3. Commits
- Use conventional commits: feat:, fix:, docs:, chore:, refactor:, test:
- One logical change per commit
- Imperative mood in commit message
- Reference issues if applicable

### 4. Pull Request
- Create PR with descriptive title and body
- Include: what changed, why, how to test
- Link related issues
- Request review

### 5. Merge
- Squash merge for clean history
- Delete feature branch after merge
- Never force push to shared branches

## Delegation Standard

When spawning a sub-agent, provide:
1. TASK — Atomic, specific goal
2. EXPECTED OUTCOME — Concrete success criteria
3. MUST DO — Exhaustive requirements
4. MUST NOT DO — Forbidden actions
5. REQUIRED TOOLS — What tools to use
6. CONTEXT — File paths, patterns, constraints

## Quality Gates

Before marking a task complete:
1. Code compiles/builds without errors
2. Tests pass
3. No security vulnerabilities (use nexus.security.scan)
4. Follows project conventions
5. Has appropriate test coverage
`

/** Result body every `preset` tool invocation returns. */
interface PresetToolResult {
  content: string
}

/**
 * `preset` with mode 'clear': drop the session-scoped preset override so the
 * disk config is in control again.
 *
 * Goes through `resetToDefaults()` rather than touching `storageConfig`, so
 * the TUI and this tool share one definition of "hand control back to disk".
 * The resolved map is read *after* the clear, so the caller can confirm the
 * outcome instead of taking it on trust — and when there was no override to
 * drop, that is stated rather than dressed up as a successful change.
 */
function clearPresetOverride(orchestrator: NexusOrchestrator): PresetToolResult {
  const configManager = orchestrator.configManager
  const hadOverride = configManager.resetToDefaults()
  const models = configManager.getResolvedModels()
  const resolved = Object.entries(models)
    .map(([role, model]) => `${role}=${model}`)
    .join(' ')

  return {
    content: hadOverride
      ? `Cleared the session preset override. nexus.jsonc is in control again — no config file was modified.\n`
        + `Resolved models now: ${resolved}\n`
        + `sessionOverride: false`
      : `No session preset override was set, so nothing was cleared — nexus.jsonc was already in control. No config file was modified.\n`
        + `Resolved models now: ${resolved}\n`
        + `sessionOverride: false`
  }
}

export default Plugin.define({
  id: "nexus",
  async setup(ctx) {
    // Auto-create nexus-orchestrator agent if it doesn't exist
    try {
      const agentDir = join(homedir(), '.config', 'opencode', 'agents')
      mkdirSync(agentDir, { recursive: true })
      
      // Create primary orchestrator agent — always update to latest version
      const orchestratorFile = join(agentDir, 'nexus-orchestrator.md')
      writeFileSync(orchestratorFile, NEXUS_AGENT_CONTENT, 'utf-8')

      // Create subagent files for Nexus roles — always update to latest version
      const subagents: Record<string, string> = {
        'nexus-architect.md': `---
description: Nexus Architect agent — designs system architecture with cost-aware model selection
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Architect Agent

You are a senior software architect. You design systems that are scalable, resilient, and secure.

## Core Principles
- **Bounded Contexts**: Decompose by business capability, not technical layer
- **Dependency Inversion**: Depend on abstractions, not concretions
- **Single Responsibility**: Each module does one thing well
- **Interface Segregation**: Small, focused interfaces over large monolithic ones
- **Open/Closed**: Open for extension, closed for modification

## Your Process
1. **Understand Requirements** — Parse functional and non-functional requirements
2. **Identify Boundaries** — Find service boundaries, data ownership, trust zones
3. **Design APIs** — REST for CRUD, GraphQL for complex queries, gRPC for internal services
4. **Plan Data Flow** — Event-driven where decoupling matters, sync where latency matters
5. **Address Cross-Cutting** — Auth, logging, monitoring, rate limiting, caching

## Output Format
- Architecture diagram (text-based or Mermaid)
- Component responsibilities and interfaces
- Data model with relationships
- API contracts (OpenAPI/GraphQL schema)
- Deployment topology
- Risk assessment with mitigation strategies

## Anti-Patterns to Avoid
- God objects/modules that do everything
- Circular dependencies between services
- Shared databases across service boundaries
- Synchronous chains that create tight coupling
- Over-engineering simple problems (YAGNI)`,

        'nexus-coder.md': `---
description: Nexus Coder agent — implements code following SOLID, DRY, KISS, YAGNI
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Coder Agent

You are a senior software engineer who writes clean, maintainable, production-ready code.

## Non-Negotiable Principles
- **SOLID**: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
- **DRY**: Don't Repeat Yourself — extract shared logic into reusable abstractions
- **KISS**: Keep It Simple, Stupid — the simplest solution that works is the best
- **YAGNI**: You Aren't Gonna Need It — don't build for hypothetical future requirements

## Code Quality Standards
- **Type Safety**: Use TypeScript strict mode, avoid \`any\`, prefer \`unknown\` with type guards
- **Error Handling**: Never swallow errors; always propagate meaningful context. Use custom error classes.
- **Immutability**: Prefer \`const\`, \`readonly\`, immutable data structures. Mutate only when performance demands it.
- **Pure Functions**: Side effects are explicit and isolated. Pure logic is testable by default.
- **Naming**: Variables describe content, functions describe action, types describe shape. No abbreviations.

## Security-First Development
- Input validation at every boundary (API, CLI, file, env)
- Parameterized queries — never string concatenation for SQL/NoSQL
- No hardcoded secrets — use env vars, vaults, or secret managers
- Sanitize output to prevent XSS/injection
- Use established crypto libraries, never roll your own

## Implementation Process
1. **Read Before Write** — Understand existing patterns before adding new code
2. **Plan the Interface** — Define types and contracts before implementation
3. **Implement Minimum Viable** — Ship the smallest working version, then iterate
4. **Test Alongside** — Write tests for each function/module as you build
5. **Refactor When Done** — Clean up, extract shared logic, improve naming

## Output
- Clean, well-structured code following existing project patterns
- Type definitions for all public interfaces
- Error handling with meaningful messages
- Tests covering happy path, edge cases, and error paths
- Brief inline comments for complex logic (why, not what)`,

        'nexus-explorer.md': `---
description: Nexus Explorer agent — explores codebases and provides architecture analysis
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

# Nexus Explorer Agent

You are a code archaeologist. You navigate unknown codebases efficiently and build accurate architectural understanding.

## Exploration Strategy
1. **Entry Points First** — Find main files, index files, config files, README
2. **Dependency Graph** — Map imports/exports, identify module boundaries
3. **Data Flow** — Trace how data moves through the system (input → processing → output)
4. **Design Patterns** — Identify GoF, architectural, or domain-specific patterns
5. **Cross-Cutting Concerns** — Find auth, logging, error handling, caching patterns

## Discovery Techniques
- **Config-Driven**: Read package.json, tsconfig, docker-compose, CI configs
- **Import Analysis**: Follow import chains to understand module relationships
- **Type Exploration**: Use TypeScript types to understand data shapes and contracts
- **API Surface**: Find route handlers, CLI entry points, exposed interfaces
- **Test Coverage**: Tests reveal intended behavior and edge cases

## Output Format
- Module map with responsibilities
- Dependency graph (text-based or Mermaid)
- Key data structures and their relationships
- API surface (endpoints, CLI commands, events)
- Architecture pattern identification
- Potential issues or technical debt

## Rules
- Read-only exploration — never modify files
- Be thorough but efficient — follow the most important paths first
- Report uncertainty explicitly — don't guess about unexamined code
- Cite specific file paths and line numbers for all findings`,

        'nexus-tester.md': `---
description: Nexus Tester agent — writes meaningful tests that catch real bugs
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Tester Agent

You are a QA engineer who writes tests that catch real bugs, not just increase coverage numbers.

## Test Strategy
- **60% Behavioral Unit Tests** — Test what the code does, not how it does it
- **25% Integration Tests** — Test module interactions and data flow
- **15% Edge Cases** — Boundary values, error paths, concurrency, time-dependent behavior

## Test Quality Criteria
- Each test has a clear, specific assertion — not just "it doesn't crash"
- Tests are independent — no shared state between tests
- Tests are deterministic — same input always produces same result
- Tests are fast — unit tests in milliseconds, integration in seconds
- Tests are maintainable — clear names, minimal setup, obvious intent

## Coverage Priorities
1. **Happy Path** — The expected behavior works
2. **Error Paths** — Invalid input, missing data, network failures
3. **Boundary Values** — Empty arrays, max length, zero values, overflow
4. **State Transitions** — State machine edges, lifecycle events
5. **Concurrency** — Race conditions, parallel execution, timing issues
6. **Regression** — Previously found bugs don't reappear

## What NOT to Test
- Implementation details (private methods, internal state)
- Third-party libraries (trust their own tests)
- Trivial getters/setters
- Tests that always pass regardless of implementation

## Output
- Test file following project conventions
- Clear test names that describe the scenario
- Arrange-Act-Assert structure
- Edge case coverage alongside happy path
- Mock/stub strategy that doesn't hide real bugs`,

        'nexus-reviewer.md': `---
description: Nexus Reviewer agent — reviews code for correctness, security, and quality
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

# Nexus Reviewer Agent

You are a senior code reviewer. You are brutally honest — you do not praise code, you find problems.

## 3-Tier Review Process

### Tier 1: Correctness
- Does the code do what it claims to do?
- Are edge cases handled (null, empty, overflow, timeout)?
- Is error handling comprehensive and meaningful?
- Are race conditions and concurrency issues addressed?
- Does the code follow existing project patterns?

### Tier 2: Security (OWASP Top 10)
- **Injection**: SQL, NoSQL, command, XSS, template injection
- **Authentication**: Broken auth, session fixation, credential stuffing
- **Authorization**: IDOR, privilege escalation, missing access control
- **Secrets**: Hardcoded keys, tokens, passwords in code
- **Crypto**: Weak algorithms, static IVs, improper key management
- **Data Exposure**: PII leaks, verbose errors, debug mode in production
- **Dependencies**: Known vulnerabilities in imported packages

### Tier 3: Performance & Maintainability
- Algorithmic complexity (O(n²) on large datasets?)
- Memory allocation patterns (unnecessary copies, leaks)
- Database query efficiency (N+1 queries, missing indexes)
- Code duplication (DRY violations)
- Naming clarity (can you understand intent from the name?)
- Documentation gaps (why is non-obvious logic there?)

## Output Format
For each finding:
- **Severity**: Critical / High / Medium / Low / Info
- **Location**: File path + line number
- **Issue**: What's wrong and why it matters
- **Fix**: Concrete suggestion with code example
- **Test**: How to verify the fix works

## Rules
- Be specific — reference exact lines, not vague areas
- Be constructive — every problem comes with a suggested fix
- Be honest — if code is good, say nothing. No empty praise.
- Be thorough — check for issues the author might have missed
- Prioritize — Critical/High issues first, then Medium/Low`,

        'nexus-documenter.md': `---
description: Nexus Documenter agent — writes clear, comprehensive technical documentation
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Documenter Agent

You are a technical writer who creates documentation that developers actually want to read.

## Documentation Types

### API Documentation
- Every public function/class/type has a doc comment
- Include: purpose, parameters (with types), return value, exceptions, examples
- Document side effects, thread safety, performance characteristics

### README Files
- What it does (one sentence)
- Quick start (copy-paste commands)
- Installation (multiple methods)
- Configuration (with examples)
- API reference (link to detailed docs)
- Contributing guidelines

### Architecture Docs
- System overview with diagram
- Component responsibilities
- Data flow through the system
- Design decisions and trade-offs (ADRs)
- Deployment and scaling considerations

## Writing Principles
- **Clear**: No jargon without explanation, no ambiguity
- **Concise**: Say it once, say it well. No repetition.
- **Complete**: Cover edge cases, error states, limitations
- **Current**: Documentation that's wrong is worse than none
- **Scannable**: Headers, bullet points, code blocks, tables

## Code Documentation
- Comments explain WHY, not WHAT (code explains what)
- Complex algorithms get a brief explanation of the approach
- TODO/FIXME/HACK comments are tracked and explained
- Changelog follows semantic versioning with clear descriptions`
      }

      for (const [filename, content] of Object.entries(subagents)) {
        const filepath = join(agentDir, filename)
        writeFileSync(filepath, content, 'utf-8')
      }
    } catch {
      // Agent creation is best-effort
    }

    // Auto-enable LSP if not configured
    try {
      const configPath = join(homedir(), '.config', 'opencode', 'opencode.jsonc')
      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, 'utf-8')
        // Check if LSP is already configured
        if (!configContent.includes('"lsp"')) {
          // Add lsp: true before the closing brace
          const updated = configContent.replace(
            /\}(\s*)$/,
            ',\n  "lsp": true\n}$1'
          )
          writeFileSync(configPath, updated, 'utf-8')
        }
      }
    } catch {
      // LSP enablement is best-effort
    }

    const orchestrator = new NexusOrchestrator()
    const goalManager = new GoalManager()

    // Initialize orchestrator with OpenCode context for real session API access
    await orchestrator.initialize(ctx, () => {
      // State change callback - persist to storage for TUI consumption
      const state = orchestrator.getState()
      ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state))).catch(() => {}
      )
      // Also persist sidebar-specific state for the TUI plugin
      const sidebarState = {
        agents: state.agents,
        totalCost: state.totalSpent,
        budgetRemaining: state.budgetRemaining
      }
      ctx.storage.set("nexus-sidebar-state", JSON.parse(JSON.stringify(sidebarState))).catch(() => {})
    })

    // Persist initial state
    await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
    // Persist initial sidebar state for TUI plugin
    const initialState = orchestrator.getState()
    await ctx.storage.set("nexus-sidebar-state", JSON.parse(JSON.stringify({
      agents: initialState.agents,
      totalCost: initialState.totalSpent,
      budgetRemaining: initialState.budgetRemaining
    })))

    /**
     * Create a child session and make sure the task reaches it exactly once.
     * Shared by the `spawn` and `delegate` tools.
     *
     * The parent session is taken from the calling tool's own execution context:
     * it is what OpenCode links the child session to (parentID), and it is passed
     * explicitly rather than latched on the orchestrator, which would let
     * internal spawns reuse a foreign parent session. On the subagent-tool path
     * the tool itself delivers the task, so the manual `session.prompt` below
     * only runs on the `session.create` fallback.
     */
    const spawnAndDeliver = async (
      opts: { role: string; task: string; model?: string },
      toolCtx: any,
    ): Promise<SpawnedAgent> => {
      const agent = await orchestrator.spawnAgent({ role: opts.role, model: opts.model }, {
        toolContext: {
          sessionID: toolCtx?.sessionID || '',
          agent: toolCtx?.agent,
          messageID: toolCtx?.messageID,
          callID: toolCtx?.id,
          signal: toolCtx?.signal,
        },
        task: opts.task,
      })

      if (agent.spawnPath !== 'subagent-tool') {
        await ctx.session.prompt({
          sessionID: agent.sessionID!,
          text: opts.task
        })
      }

      return agent
    }

    // Register tools
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "nexus",
        description: "Adaptive multi-agent orchestration tools"
      })

      editor.add({
        name: "status",
        description: "Get orchestrator status, metrics, and the config files currently in effect (paths consulted, which existed, resolved role -> model map)",
        input: {
          type: "object",
          properties: {
            detailed: { type: "boolean", description: "Include detailed metrics" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { detailed } = input as { detailed?: boolean }
          const status = orchestrator.getStatus(detailed)
          // Persist after reading
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
          return { content: status }
        }
      })

      editor.add({
        name: "agents",
        description: "List all active agents",
        input: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by status" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { filter } = input as { filter?: string }
          return { content: orchestrator.listAgents(filter) }
        }
      })

      editor.add({
        name: "costs",
        description: "Get cost report and budget status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: orchestrator.getCostReport() }
        }
      })

      editor.add({
        name: "dashboard",
        description: "Get full orchestrator state for dashboard display",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const state = orchestrator.getState()
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state)))
          return { content: JSON.stringify(state, null, 2) }
        }
      })

      editor.add({
        name: "queue",
        description: "Show current task queue with priorities",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const state = orchestrator.getState()
          const tasks = state.tasks || []
          return { content: JSON.stringify(tasks, null, 2) }
        }
      })

      editor.add({
        name: "config.save",
        description: "Save Nexus config to disk (project or global)",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global"], description: "Config level to save" },
            basePath: { type: "string", description: "Project root (for project-level, defaults to cwd)" }
          },
          required: ["level"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global'; basePath?: string }
          orchestrator.configManager.saveConfig(level, basePath || process.cwd())
          const location = level === 'project'
            ? `${basePath || process.cwd()}/.opencode/nexus.jsonc`
            : '~/.config/opencode/nexus.jsonc'
          return { content: `Config saved to ${level} level at ${location}` }
        }
      })

      editor.add({
        name: "config.init",
        description: "Initialize default config files for project and/or global",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global", "both"], description: "Which config to initialize" },
            basePath: { type: "string", description: "Project root" }
          },
          required: ["level"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global' | 'both'; basePath?: string }
          const path = basePath || process.cwd()
          const locations: string[] = []
          if (level === 'project' || level === 'both') {
            orchestrator.configManager.initProjectConfig(path)
            locations.push(`${path}/.opencode/nexus.jsonc`)
          }
          if (level === 'global' || level === 'both') {
            orchestrator.configManager.initGlobalConfig()
            locations.push('~/.config/opencode/nexus.jsonc')
          }
          return { content: `Config initialized at ${level} level(s): ${locations.join(', ')}` }
        }
      })

      editor.add({
        name: "preset",
        description: "Apply a session preset (model/budget selection), or clear it with mode 'clear' to hand control back to nexus.jsonc. A preset shadows the config file's models, so call mode 'clear' if the user edited nexus.jsonc but no model changed.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["apply", "clear"],
              description: "'apply' (default) applies the named preset for this session. 'clear' drops the session preset override so nexus.jsonc is in control again — use it whenever edits to nexus.jsonc appear to have no effect."
            },
            name: {
              type: "string",
              description: "Preset name (minimal, balanced, enterprise, cost-optimized). Required for mode 'apply'; ignored by 'clear'."
            }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { mode, name } = input as { mode?: 'apply' | 'clear'; name?: string }

          if (mode === 'clear') return clearPresetOverride(orchestrator)

          if (!name) {
            // Do not silently do nothing: a missing name is a mistake, and the
            // fix is either a valid preset name or mode 'clear'.
            return { content: `Error: mode 'apply' needs a \`name\` (${orchestrator.configManager.listPresets().join(', ')}). To hand control back to nexus.jsonc instead, call preset with mode: 'clear'.` }
          }
          try {
            orchestrator.configManager.applyPreset(name)
            // A preset replaces the whole models level, so it now shadows
            // nexus.jsonc. Say that here, at the moment the user is told the
            // preset was applied — otherwise a later edit that does nothing is
            // the same silent surprise as a missing reload.
            return {
              content: `Applied preset: ${PRESETS[name]?.name || name}\n`
                + `⚠️ This preset now overrides the \`models\` section of nexus.jsonc. `
                + `Edits to models in the config file will NOT take effect until the preset is cleared. `
                + `Clear it with this tool (mode: 'clear'), or from the TUI (config manager), to hand control back to disk. `
                + `Budget and self-healing values from the file still apply.`,
            }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "dashboard.start",
        description: "Start the web dashboard server",
        input: {
          type: "object",
          properties: {
            port: { type: "number", description: "Port (default: 4747)" },
            host: { type: "string", description: "Host (default: 127.0.0.1)" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { port, host } = input as { port?: number; host?: string }
          orchestrator.startDashboard(port, host)
          return { content: `Dashboard started at http://${host || '127.0.0.1'}:${port || 4747}` }
        }
      })

      editor.add({
        name: "dashboard.stop",
        description: "Stop the web dashboard server",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          orchestrator.stopDashboard()
          return { content: "Dashboard stopped" }
        }
      })

      editor.add({
        name: "model.costs",
        description: "Show real model pricing from OpenCode, or set custom costs. All prices are USD per 1K tokens.",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "Model to show cost for, as 'provider/id' or a bare 'id' (optional, shows all if omitted)" },
            setInput: { type: "number", description: "Set input cost in USD per 1K tokens for a model (e.g. 0.003 for $3 per million tokens)" },
            setOutput: { type: "number", description: "Set output cost in USD per 1K tokens for a model (e.g. 0.015 for $15 per million tokens)" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { model, setInput, setOutput } = input as { model?: string; setInput?: number; setOutput?: number }

          // Every price `modelCosts` holds is USD per 1K tokens.
          const per1k = (v: number) => `$${v}/1K tokens`

          // A tiered price list, rendered one line per row. `tiers` is ordered
          // untiered-base-first by `loadModelCosts` / `setModelCosts`, and a
          // context tier is labelled with the prompt size it applies ABOVE.
          const renderTiers = (cost: NexusModelCost): string =>
            cost.tiers
              .map(t => (t.threshold === undefined
                ? `base: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`
                : `over ${t.threshold} prompt tokens: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`))
              .join('\n            ')

          if (model && setInput !== undefined && setOutput !== undefined) {
            // Set custom cost
            orchestrator.setModelCosts({ [model]: { input: setInput, output: setOutput } })
            return { content: `Set ${model}: input=${per1k(setInput)}, output=${per1k(setOutput)}` }
          }

          if (model) {
            // Show specific model cost. `modelCosts` is keyed by
            // "providerID/id" but users type either that or a bare id, so
            // `getModelCost` resolves both.
            const cost = orchestrator.getModelCost(model)
            if (cost) {
              return { content: `${model} (real pricing, from OpenCode):\n            ${renderTiers(cost)}` }
            }
            // No real pricing. Source this from the forecaster so the number
            // carries the rate AND the table it came from: the old
            // `estimateModelCost` printed a bare `estimated $X/1K tokens` whose
            // X was not a price at all but the mean of a real rate and a
            // hand-tuned relative table entry. A number with no unit and no
            // provenance is the one output this tool must never produce.
            const { pricing, source } = orchestrator.forecaster.priceFor(model)
            const label = source === 'model-costs'
              ? 'real pricing'
              : source === 'fallback-table'
                ? 'ESTIMATE (fallback table, not provider pricing)'
                : 'ESTIMATE (unknown model — no table knows this rate)'
            return { content: `${model}: no real pricing data.\n            ${label}: in=${per1k(pricing.input)}, out=${per1k(pricing.output)}, cache_read=${per1k(pricing.cacheRead)}, cache_write=${per1k(pricing.cacheWrite)}` }
          }

          // Show all loaded costs
          if (orchestrator.modelCosts.size > 0) {
            const lines = ['📊 Model Pricing (from OpenCode, per 1K tokens):']
            for (const [id, cost] of orchestrator.modelCosts) {
              lines.push(`  ${id}: ${renderTiers(cost)}`)
            }
            return { content: lines.join('\n') }
          }
          return { content: 'No real pricing data loaded. Using labelled fallback estimates.' }
        }
      })

      editor.add({
        name: "spawn",
        description: "Spawn a sub-agent for a task. Use wait=true to wait for completion.",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter)" },
            task: { type: "string", description: "Task description" },
            model: { type: "string", description: "Model override (optional, e.g. 'anthropic/claude-sonnet-4-6')" },
            wait: { type: "boolean", description: "Wait for completion (default: false)" },
            timeout: { type: "number", description: "Timeout in ms when waiting (default: 120000)" }
          },
          required: ["role", "task"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown, toolCtx: any) => {
          const { role, task, model, wait, timeout } = input as { role: string; task: string; model?: string; wait?: boolean; timeout?: number }
          try {
            const agent = await spawnAndDeliver({ role, task, model }, toolCtx)

            agent.status = 'working'
            orchestrator.notifyStateChange()

            // If wait is requested, block until completion or timeout
            if (wait) {
              const waitTimeout = timeout || 120000
              const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timed out after ${waitTimeout}ms`)), waitTimeout)
              )

              try {
                await Promise.race([waitPromise, timeoutPromise])
              } catch (waitError: any) {
                // Timeout or cancellation — agent may still be running
                agent.status = 'working'
                orchestrator.notifyStateChange()

                // Try to get whatever results are available
                try {
                  const messages = await ctx.session.context({ sessionID: agent.sessionID! })
                  const partialText = lastAssistantText(messages)
                  if (partialText) {
                    agent.status = 'completed'
                    await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
                    const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
                    return {
                      content: [
                        `${agent.name}`,
                        `📋 Task: ${taskPreview}`,
                        `⏱️ Status: ${waitError.message || 'timeout'}`,
                        `📎 Session: ${agent.sessionID}`,
                        `\n--- Partial Result ---`,
                        partialText
                      ].join('\n')
                    }
                  }
                } catch {
                  // Context read also failed
                }

                return {
                  content: [
                    `${agent.name}`,
                    `📋 Task: ${task.length > 80 ? task.substring(0, 77) + '...' : task}`,
                    `⏱️ Status: ${waitError.message || 'timeout'}`,
                    `📎 Session: ${agent.sessionID}`,
                    `💡 Use nexus.result(sessionID="${agent.sessionID}") to check later`
                  ].join('\n')
                }
              }

              // Wait completed — get final results
              try {
                const messages = await ctx.session.context({ sessionID: agent.sessionID! })
                const result = lastAssistantText(messages) || 'Task completed (no output captured)'

                agent.status = 'completed'
                await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

                const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
                return {
                  content: [
                    `${agent.name}`,
                    `📋 Task: ${taskPreview}`,
                    `✅ Status: completed`,
                    `📎 Session: ${agent.sessionID}`,
                    `\n--- Result ---`,
                    typeof result === 'string' ? result : JSON.stringify(result)
                  ].join('\n')
                }
              } catch {
                // Context read failed after successful wait
                agent.status = 'completed'
                await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
                return {
                  content: [
                    `${agent.name}`,
                    `✅ Status: completed`,
                    `📎 Session: ${agent.sessionID}`,
                    `⚠️ Could not read result output`
                  ].join('\n')
                }
              }
            }

            // Non-wait: return spawn info with complexity analysis
            const complexity = orchestrator.analyzeComplexity({
              id: `spawn-${Date.now()}`,
              name: task,
              description: task,
              files: { include: [] },
              dependencies: [],
              requiredRole: role,
              complexity: { overall: 0, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } },
              priority: 'normal',
              status: 'running'
            })
            agent.complexity = complexity

            const modelSelection = orchestrator.selectModel(role, complexity)

            await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
            const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
            const output = [
              `${agent.name}`,
              `📋 Task: ${taskPreview}`,
              `📊 Complexity: ${complexity.overall}/100 (${complexity.factors.riskLevel} risk)`,
              `🤖 Model reasoning: ${modelSelection.reasoning}`,
              `📎 Session: ${agent.sessionID}`,
              `💡 Use wait=true to wait for completion, or nexus.result() to fetch later`
            ].join('\n')
            return { content: output }
          } catch (error: any) {
            return { content: `Failed to spawn agent: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "delegate",
        description: "Delegate a task to a sub-agent and wait for result (convenience wrapper around spawn+wait)",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter)" },
            task: { type: "string", description: "Task description" },
            model: { type: "string", description: "Model override (optional)" },
            timeout: { type: "number", description: "Timeout in ms (default: 120000)" }
          },
          required: ["role", "task"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown, toolCtx: any) => {
          const { role, task, model, timeout } = input as { role: string; task: string; model?: string; timeout?: number }
          try {
            const agent = await spawnAndDeliver({ role, task, model }, toolCtx)

            agent.status = 'working'
            orchestrator.notifyStateChange()

            const waitTimeout = timeout || 120000
            const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
            const timeoutPromise = new Promise<'timeout'>((resolve) =>
              setTimeout(() => resolve('timeout'), waitTimeout)
            )

            const outcome = await Promise.race([waitPromise.then(() => 'completed' as const), timeoutPromise])

            // Get the result regardless of outcome
            try {
              const messages = await ctx.session.context({ sessionID: agent.sessionID! })
              const resultContent = lastAssistantText(messages) || (outcome === 'timeout' ? 'Timed out — agent may still be running' : 'Completed with no output')

              agent.status = outcome === 'timeout' ? 'working' : 'completed'
              orchestrator.notifyStateChange()
              await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

              const statusIcon = outcome === 'timeout' ? '⏱️' : '✅'
              return {
                content: [
                  `${agent.name}`,
                  `📋 Task: ${task.length > 80 ? task.substring(0, 77) + '...' : task}`,
                  `${statusIcon} Status: ${outcome}`,
                  `📎 Session: ${agent.sessionID}`,
                  `\n--- Result ---`,
                  typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent)
                ].join('\n')
              }
            } catch {
              agent.status = outcome === 'timeout' ? 'working' : 'completed'
              orchestrator.notifyStateChange()
              return {
                content: [
                  `${agent.name}`,
                  `${outcome === 'timeout' ? '⏱️' : '✅'} Status: ${outcome}`,
                  `📎 Session: ${agent.sessionID}`,
                  `⚠️ Could not read result output`
                ].join('\n')
              }
            }
          } catch (error: any) {
            return { content: `Delegate failed: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "template",
        description: "List or instantiate task templates",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Template name to instantiate (or 'list' to show all)" },
            baseDir: { type: "string", description: "Base directory for file paths" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { name, baseDir } = input as { name?: string; baseDir?: string }
          if (!name || name === 'list') {
            const templates = listTemplates()
            return { content: templates.map(t => `${t}: ${TEMPLATES[t].description}`).join('\n') }
          }
          try {
            const tasks = instantiateTemplate(name, baseDir || process.cwd())
            return { content: JSON.stringify(tasks, null, 2) }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "performance.scores",
        description: "Show agent performance scores by model and role",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const scores = orchestrator.performanceTracker.getScores()
          if (scores.length === 0) return { content: "No performance data yet. Scores build up as tasks are executed." }
          const lines = scores.map(s => `${s.role}/${s.model}: score=${s.overallScore.toFixed(1)} success=${(s.successRate*100).toFixed(0)}% avg=$${s.avgCost.toFixed(4)} (${s.totalTasks} tasks)`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "performance.best",
        description: "Get best model for a specific role",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role to find best model for" }
          },
          required: ["role"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { role } = input as { role: string }
          const best = orchestrator.performanceTracker.getBestModel(role)
          if (!best) return { content: `No performance data for role '${role}' yet.` }
          return { content: `Best for ${role}: ${best.model} (score: ${best.overallScore.toFixed(1)}, success: ${(best.successRate*100).toFixed(0)}%, avg cost: $${best.avgCost.toFixed(4)})` }
        }
      })

      editor.add({
        name: "security.scan",
        description: "Scan content for security issues",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "Code content to scan" },
            filename: { type: "string", description: "Filename for context" }
          },
          required: ["content"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { content, filename } = input as { content: string; filename?: string }
          const issues = orchestrator.securityScanner.scanContent(content, filename || 'unknown')
          const result = orchestrator.securityScanner.getResult()
          return { content: JSON.stringify({ issues: issues.length, score: result.score, details: issues }, null, 2) }
        }
      })

      editor.add({
        name: "history.list",
        description: "List execution history",
        input: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of recent entries" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { count } = input as { count?: number }
          const records = count ? orchestrator.executionHistory.getRecent(count) : orchestrator.executionHistory.getAll()
          if (records.length === 0) return { content: "No execution history yet." }
          const lines = records.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.taskName} (${r.role}) — $${r.cost.toFixed(4)} — ${r.duration}ms`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "history.stats",
        description: "Show execution statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const stats = orchestrator.executionHistory.getStats()
          return { content: `Total: ${stats.total} | Success: ${(stats.successRate * 100).toFixed(1)}% | Cost: $${stats.totalCost.toFixed(4)} | Avg: ${stats.avgDuration.toFixed(0)}ms\nBy role: ${JSON.stringify(stats.byRole)}` }
        }
      })

      editor.add({
        name: "roles.list",
        description: "List all custom agent roles",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const roles = orchestrator.customRoles.list()
          if (roles.length === 0) return { content: "No custom roles defined. Add them in .opencode/nexus.jsonc under 'customRoles'." }
          const lines = roles.map(r => `${r.emoji} ${r.displayName} (${r.name}): ${r.prompt.substring(0, 60)}...`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "roles.add",
        description: "Add a custom agent role",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Role identifier (lowercase, no spaces)" },
            displayName: { type: "string", description: "Display name" },
            emoji: { type: "string", description: "Emoji for the role" },
            prompt: { type: "string", description: "System prompt for this role" },
            model: { type: "string", description: "Default model (optional)" }
          },
          required: ["name", "displayName", "prompt"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { name, displayName, emoji, prompt, model } = input as any
          orchestrator.customRoles.register({ name, displayName, emoji: emoji || '🤖', prompt, model })
          return { content: `Custom role '${displayName}' registered` }
        }
      })

      editor.add({
        name: "forecast",
        description: "Estimate cost before executing tasks",
        input: {
          type: "object",
          properties: {
            tasks: { type: "string", description: "JSON array of tasks with role, model, and complexity" }
          },
          required: ["tasks"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { tasks } = input as { tasks: string }
          const taskList = JSON.parse(tasks)
          const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent

          // Support both formats: full Task objects or simple {role, model, complexity}
          const normalizedTasks = taskList.map((t: any) => ({
            task: t.task || {
              id: `forecast-${Date.now()}`,
              name: t.name || `${t.role} task`,
              description: t.description || '',
              files: { include: [] },
              dependencies: [],
              requiredRole: t.role,
              complexity: typeof t.complexity === 'number'
                ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
                : { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } },
              priority: 'normal' as const,
              status: 'pending' as const
            },
            role: t.role,
            model: t.model,
            complexity: typeof t.complexity === 'number'
              ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
              : t.complexity || { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
          }))

          const result = orchestrator.forecaster.forecastAll(normalizedTasks, remaining)
          const lines = result.estimates.map(e => `${e.taskName}: ~$${e.estimatedCost.toFixed(4)} (${e.model})`)
          lines.push(`\nTotal: ~$${result.totalEstimatedCost.toFixed(4)}`)
          lines.push(`Budget remaining: $${remaining.toFixed(2)}`)
          lines.push(`Within budget: ${result.withinBudget ? '✅' : '❌'}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "worktree.enable",
        description: "Enable git worktree isolation for agents",
        input: { type: "object", properties: { repoRoot: { type: "string", description: "Repository root (defaults to cwd)" } } },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { repoRoot } = input as { repoRoot?: string }
          orchestrator.enableWorktrees(repoRoot || process.cwd())
          return { content: "Git worktree isolation enabled." }
        }
      })

      editor.add({
        name: "worktree.list",
        description: "List active agent worktrees",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          if (!orchestrator.worktreeManager) return { content: "Worktree isolation not enabled." }
          const wts = orchestrator.worktreeManager.list()
          if (wts.length === 0) return { content: "No active worktrees." }
          return { content: wts.map(w => `${w.agentId}: ${w.path}`).join('\n') }
        }
      })

      editor.add({
        name: "worktree.disable",
        description: "Disable worktree isolation and clean up",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          if (orchestrator.worktreeManager) {
            orchestrator.worktreeManager.cleanupAll()
            orchestrator.worktreeManager = null
          }
          return { content: "Worktree isolation disabled." }
        }
      })

      editor.add({
        name: "sessions",
        description: "List all active Nexus agent sessions",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const agents = orchestrator.getState().agents
          if (agents.length === 0) return { content: "No active agent sessions." }
          const lines = agents.map((a: any) => {
            const statusIcon = a.status === 'working' ? '🔄' : a.status === 'idle' ? '⏸️' : a.status === 'completed' ? '✅' : '❌'
            return `${statusIcon} ${a.name} (${a.role}) — Session: ${a.sessionID}`
          })
          return { content: `Active Sessions (${agents.length}):\n${lines.join('\n')}` }
        }
      })

      editor.add({
        name: "background",
        description: "Move running agents to background (detach from current session)",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          // Nothing to do comes first: with no agents running, "No running
          // agents" is the truthful answer even on a build that lacks
          // `session.background`.
          const agents = orchestrator.getState().agents.filter((a: any) => a.status === 'working' || a.status === 'idle')
          if (agents.length === 0) return { content: "No running agents to move to background." }

          // `background` exists on the underlying client `SessionApi` but the
          // plugin context's `SessionDomain` is a `Pick` that omits it, so it
          // cannot be typed directly and is feature-detected through a narrow
          // structural lookup instead of assumed to be there.
          const background = (ctx.session as { background?: (input: { sessionID: string }) => Promise<void> }).background
          if (!background) {
            return { content: "This OpenCode version does not expose session.background on the plugin context — nothing was detached." }
          }

          let detached = 0
          for (const agent of agents) {
            if (!agent.sessionID) continue
            try {
              await background.call(ctx.session, { sessionID: agent.sessionID })
              detached++
            } catch {
              // Background may not be supported in all contexts
            }
          }
          return { content: `${detached} agent(s) moved to background. You can continue working while they run.` }
        }
      })

      editor.add({
        name: "result",
        description: "Get the result of a completed agent session",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID of the agent" }
          },
          required: ["sessionID"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { sessionID } = input as { sessionID: string }
          try {
            const messages = await ctx.session.context({ sessionID })
            const text = lastAssistantText(messages)
            if (text) {
              return { content: `Session ${sessionID} result:\n${text}` }
            }
            return { content: `Session ${sessionID} has no assistant messages yet.` }
          } catch (error: any) {
            return { content: `Failed to get result: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "clarify",
        description: "Ask clarifying question before proceeding with ambiguous task",
        input: {
          type: "object",
          properties: {
            question: { type: "string", description: "The clarifying question to ask" },
            options: { type: "string", description: "Comma-separated options to present" },
            assumption: { type: "string", description: "Default assumption if no response" }
          },
          required: ["question"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { question, options, assumption } = input as { question: string; options?: string; assumption?: string }
          const optionList = options ? options.split(',').map(o => o.trim()) : []
          let response = `❓ ${question}`
          if (optionList.length > 0) {
            response += `\nOptions: ${optionList.map((o, i) => `${i+1}. ${o}`).join(', ')}`
          }
          if (assumption) {
            response += `\n💡 Default: ${assumption}`
          }
          return { content: response }
        }
      })

      // === Todo Enforcer Tools ===

      editor.add({
        name: "todo.add",
        description: "Add a todo item to track work",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Todo description" },
            assignedTo: { type: "string", description: "Agent or role to assign (optional)" }
          },
          required: ["description"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { description, assignedTo } = input as { description: string; assignedTo?: string }
          const item = orchestrator.todoEnforcer.add(description, assignedTo)
          return { content: `📝 Todo added: ${item.id}: ${item.description} (${item.status})` }
        }
      })

      editor.add({
        name: "todo.list",
        description: "List all todo items",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: orchestrator.todoEnforcer.formatAll() }
        }
      })

      editor.add({
        name: "todo.complete",
        description: "Mark a todo item as completed",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Todo item ID" }
          },
          required: ["id"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { id } = input as { id: string }
          const item = orchestrator.todoEnforcer.get(id)
          if (!item) return { content: `❌ Todo ${id} not found.` }
          orchestrator.todoEnforcer.complete(id)
          return { content: `✅ Todo completed: ${id}: ${item.description}` }
        }
      })

      editor.add({
        name: "todo.stats",
        description: "Get todo statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const stats = orchestrator.todoEnforcer.getStats()
          return {
            content: `📊 Todo Statistics:\n  Total: ${stats.total}\n  ⏳ Pending: ${stats.pending}\n  🔄 In Progress: ${stats.inProgress}\n  ✅ Completed: ${stats.completed}\n  🚫 Blocked: ${stats.blocked}`
          }
        }
      })

      // === Goal Tracking Tools ===
      editor.add({
        name: "goal.set",
        description: "Set a new persistent objective",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Goal description" },
            autoContinue: { type: "boolean", description: "Auto-continue (default: true)" }
          },
          required: ["description"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { description, autoContinue } = input as { description: string; autoContinue?: boolean }
          const goal = goalManager.set(description, autoContinue ?? true)
          return { content: `🎯 Goal set: ${goal.description}` }
        }
      })

      editor.add({
        name: "goal.status",
        description: "Show current goal status",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const goal = goalManager.getActive()
          if (!goal) return { content: "No active goal. Use nexus.goal.set() to create one." }
          return { content: `🎯 ${goal.description}\nStatus: ${goal.status}\nTasks: ${goal.tasks.length}` }
        }
      })

      editor.add({
        name: "goal.complete",
        description: "Complete current goal",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const goal = goalManager.getActive()
          if (!goal) return { content: "No active goal." }
          goalManager.complete(goal.id)
          return { content: `✅ Goal completed: ${goal.description}` }
        }
      })

      editor.add({
        name: "goal.list",
        description: "List all goals",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const goals = goalManager.getAll()
          if (goals.length === 0) return { content: "No goals yet." }
          const lines = goals.map(g => `${g.status === 'active' ? '🎯' : '✅'} ${g.description}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "goal.status",
        description: "Show current active goal status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const active = goalManager.getActive()
          if (!active) return { content: "No active goal. Use nexus.goal.set() to set one." }
          return {
            content: [
              `🎯 Active Goal: ${active.description}`,
              `📋 ID: ${active.id}`,
              `🔄 Auto-continue: ${active.autoContinue ? 'enabled' : 'disabled'}`,
              `📊 Status: ${active.status}`,
              `📎 Tasks: ${active.tasks.length > 0 ? active.tasks.join(', ') : 'none yet'}`,
              `📅 Created: ${active.createdAt.toISOString()}`,
              `⏱️ Should continue: ${goalManager.shouldContinue() ? 'yes' : 'no'}`
            ].join('\n')
          }
        }
      })

      editor.add({
        name: "goal.complete",
        description: "Mark current active goal as completed",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const active = goalManager.getActive()
          if (!active) return { content: "No active goal to complete." }
          goalManager.complete(active.id)
          await ctx.storage.set("nexus-goal", JSON.parse(JSON.stringify(goalManager.getAll())))
          return {
            content: [
              `✅ Goal completed: ${active.description}`,
              `📋 ID: ${active.id}`,
              `📎 Tasks tracked: ${active.tasks.length}`
            ].join('\n')
          }
        }
      })

      editor.add({
        name: "goal.list",
        description: "List all goals",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const goals = goalManager.getAll()
          if (goals.length === 0) return { content: "No goals set yet. Use nexus.goal.set() to create one." }
          const lines = goals.map(g => {
            const icon = g.status === 'active' ? '🎯' : g.status === 'completed' ? '✅' : g.status === 'paused' ? '⏸️' : '❌'
            return `${icon} [${g.status}] ${g.description} (tasks: ${g.tasks.length})`
          })
          return { content: `Goals (${goals.length}):\n${lines.join('\n')}` }
        }
      })

      // Team management tools
      const teamManager = new TeamManager()
      const astGrep = new AstGrep()

    editor.add({
      name: "team.create",
      description: "Create a new team with a lead role",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name" },
          leadRole: { type: "string", description: "Role of the team lead" }
        },
        required: ["name", "leadRole"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { name, leadRole } = input as { name: string; leadRole: string }
        const team = teamManager.create(name, leadRole)
        return { content: `Team '${team.name}' created with ID: ${team.id}\nLead: ${leadRole}\nStatus: ${team.status}\n\nAdd members with nexus.team.addMember(teamId="${team.id}", role="...", model="...")` }
      }
    })

    editor.add({
      name: "team.addMember",
      description: "Add a member to a team",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          role: { type: "string", description: "Role for this member" },
          model: { type: "string", description: "Model for this member" }
        },
        required: ["teamId", "role", "model"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId, role, model } = input as { teamId: string; role: string; model: string }
        const member = teamManager.addMember(teamId, role, model)
        if (!member) {
          return { content: `Team ${teamId} not found.` }
        }
        const team = teamManager.get(teamId)
        return { content: `Member added to team '${team?.name}':\nID: ${member.id}\nRole: ${member.role}\nModel: ${member.model}\nStatus: ${member.status}\n\nTotal members: ${team?.members.length || 0}` }
      }
    })

    editor.add({
      name: "team.status",
      description: "Show team status",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID (optional, shows all if omitted)" }
        },
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId } = input as { teamId?: string }
        
        if (teamId) {
          const team = teamManager.get(teamId)
          if (!team) {
            return { content: `Team ${teamId} not found.` }
          }
          const memberLines = team.members.map(m => `  - ${m.role} (${m.model}): ${m.status}`).join('\n')
          return { content: `Team: ${team.name} (${team.id})\nLead: ${team.lead}\nStatus: ${team.status}\nCreated: ${team.createdAt.toISOString()}\nMembers (${team.members.length}):\n${memberLines || '  No members yet'}` }
        }

        const teams = teamManager.getAll()
        if (teams.length === 0) {
          return { content: "No teams created yet." }
        }
        const lines = teams.map(t => `${t.status === 'active' ? '🟢' : t.status === 'completed' ? '✅' : '🔵'} ${t.name} (${t.id}) - Lead: ${t.lead} - Members: ${t.members.length}`)
        return { content: `Teams (${teams.length}):\n${lines.join('\n')}` }
      }
    })

    editor.add({
      name: "team.activate",
      description: "Activate a team to start execution",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" }
        },
        required: ["teamId"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId } = input as { teamId: string }
        const team = teamManager.get(teamId)
        if (!team) {
          return { content: `Team ${teamId} not found.` }
        }
        if (team.members.length === 0) {
          return { content: `Team '${team.name}' has no members. Add members before activating.` }
        }
        teamManager.activate(teamId)
        return { content: `Team '${team.name}' activated!\n\nTeam is now ready for parallel execution with ${team.members.length} members:\n${team.members.map(m => `  - ${m.role}: ${m.model}`).join('\n')}` }
      }
    })

      // AST-Grep tools
      editor.add({
        name: "astgrep.search",
        description: "Search for AST patterns in codebase",
        input: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "AST pattern to search for" },
            language: { type: "string", description: "Programming language (typescript, python, etc.)" },
            directory: { type: "string", description: "Directory to search in" }
          },
          required: ["pattern", "language", "directory"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { pattern, language, directory } = input as { pattern: string; language: string; directory: string }
          const results = astGrep.search(pattern, language, directory)
          if (results.length === 0) return { content: `No matches found for "${pattern}" in ${language}` }
          const lines = results.map(r => `${r.file}:${r.line} — ${r.match}`)
          return { content: `Found ${results.length} matches:\n${lines.join('\n')}` }
        }
      })

      editor.add({
        name: "astgrep.status",
        description: "Check if ast-grep is installed",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const available = astGrep.isAvailable()
          return { content: available ? "✅ ast-grep is installed" : "❌ ast-grep is not installed. Install with: cargo install ast-grep" }
        }
      })
    })

    // Register session hook for /nexus commands
    await ctx.session.hook("prompt", (event) => {
      if (event.prompt.text.startsWith("/nexus")) {
        const result = orchestrator.handleCommand(event.prompt.text)
        // The result goes to the session as tool output context
        event.metadata = { ...event.metadata, nexusResult: result }
      }
    })

    // Watch the two config files the config manager reads and reload on change.
    // Started here, immediately before the return, so the disposer returned
    // below is reachable from the first line of setup's tail. Anywhere earlier
    // and a rejection in one of the awaits between here and the return would
    // strand a live poll interval with no way to stop it.
    const stopConfigWatch = watchConfigFiles(ctx, orchestrator)

    return () => {
      stopConfigWatch()
      orchestrator.shutdown()
    }
  }
})

export { NexusOrchestrator } from "./orchestrator"
export { StateBroadcaster } from "./broadcast"
export { NexusConfigManager, DEFAULT_CONFIG, PRESETS } from "./config"
export type { NexusModelConfig, NexusFullConfig, NexusPreset } from "./config"
export { detectCycles } from "./dag"
export { MessageStore } from "./message-store"
export type { MessageStoreConfig } from "./message-store"
export { PersistentMemoryStore } from "./memory-store"
export type { MemoryStoreConfig } from "./memory-store"
export { MessageRouter } from "./fanout"
export type { FanOutRouter } from "./fanout"
export { HealthMonitor } from "./health"
export type { HealthCheck, HealthConfig } from "./health"
export { LearningModule } from "./learning"
export type { LearningEntry, PatternMatch } from "./learning"
export type { Agent, Task, DAG, ExecutionRequest, ExecutionResult } from "./types"
export { TEMPLATES, instantiateTemplate, listTemplates, getTemplate } from "./templates"
export type { TaskTemplate, TaskTemplateStep } from "./templates"
export { ModuleRegistry } from "./modules"
export type { NexusModule, ModuleContext, ModuleTool, ModuleHook } from "./modules"
export { SecurityScanner } from "./security"
export type { SecurityIssue, SecurityScanResult, SecurityConfig } from "./security"
export { PerformanceTracker } from "./performance"
export type { PerformanceEntry, PerformanceScore } from "./performance"
export { CustomRoleManager } from "./custom-roles"
export type { CustomRole } from "./custom-roles"
export { CostForecaster } from "./forecast"
export type { CostEstimate, ForecastResult } from "./forecast"
export { WorktreeManager } from "./worktree"
export type { AgentWorktree } from "./worktree"
export { TodoEnforcer } from "./todo"
export type { TodoItem } from "./todo"
export { GoalManager } from "./goal"
export type { Goal } from "./goal"
export { TeamManager } from "./team"
export type { Team, TeamMember } from "./team"
export { AstGrep } from "./astgrep"
export type { AstGrepPattern, AstGrepResult } from "./astgrep"
