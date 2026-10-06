# Contributing to OpenCode Nexus

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.4.0 — **this is what runs the code.** `src/memory-store.ts`
  imports `bun:sqlite`, so the built bundle cannot be loaded by Node at all:
  `node -e "import('./dist/index.js')"` fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- [Node.js](https://nodejs.org) >= 22.0.0 — required, but only for the **toolchain**,
  not the runtime. `node_modules/.bin/tsc` and `node_modules/.bin/biome` are
  `#!/usr/bin/env node` shims, so `bun run typecheck` and `bun run lint` need
  Node on `PATH`. Nothing in `src/` executes under it. CI installs Node 22 and 24
  (`.github/workflows/ci.yml`) for exactly this reason.
- [Git](https://git-scm.com)

### Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/serkanalgur/opencode-nexus.git
cd opencode-nexus
```

2. **Install dependencies**

```bash
bun install
```

3. **Watch the entry point** (optional)

```bash
bun run dev
```

`dev` is `bun run --watch src/index.ts`. `src/index.ts` is a *plugin entry
point* — its default export is `Plugin.define({...})` and nothing calls
`setup()` — so running it standalone prints nothing and exits 0. The watch loop
is a convenience for noticing that the entry stops loading; it is not a
development server, and there is nothing to interact with. To see the plugin
actually run, install it into OpenCode as the README's Installation section
describes.

4. **Run the checks** (see "Gates" below)

```bash
bun test
```

## 📁 Project Structure

```
opencode-nexus/
├── src/                    # 32 files, no subdirectories
│   ├── index.ts            # Plugin entry: tool registration, agent-file
│   │                       # generation, config watch. See "Adding a New Tool".
│   ├── orchestrator.ts     # Core: spawn/cost/escalation/lifecycle. ~4,200 lines.
│   ├── types.ts            # Shared type definitions
│   ├── tui.tsx             # TUI plugin (sidebar)
│   │
│   ├── config.ts           # NexusConfigManager, presets, config file paths
│   ├── dashboard.ts        # Bun.serve() HTTP + WebSocket dashboard server
│   ├── dag.ts              # DAG construction, cycle detection, execution order
│   ├── modules.ts          # ModuleRegistry + the NexusModule extension interface
│   ├── broadcast.ts        # BROADCAST_EVENTS catalogue + StateBroadcaster
│   │
│   ├── forecast.ts         # Cost forecaster, pricing tables, provenance types
│   ├── history.ts          # ExecutionHistory
│   ├── performance.ts      # PerformanceTracker (per-role model scores)
│   ├── learning.ts         # LearningModule (patterns from past runs)
│   ├── security.ts         # SecurityScanner
│   ├── notifications.ts    # OS notifications (osascript / notify-send / powershell)
│   ├── health.ts           # HealthMonitor
│   ├── memory-store.ts     # PersistentMemoryStore (bun:sqlite)
│   ├── memory-recall.ts    # Injects relevant notes into a task prompt
│   ├── message-store.ts    # MessageStore + MessageRouter (JSONL)
│   ├── fanout.ts           # Fan-out routing between agents
│   │
│   ├── model-ref.ts        # The single model-reference grammar (provider/model#variant)
│   ├── model-groups.ts     # Provider grouping + price formatting for model lists
│   ├── skills-install.ts   # Writes the bundled skills to ~/.config/opencode/skills
│   │
│   ├── custom-roles.ts     # CustomRoleManager
│   ├── todo.ts             # TodoEnforcer
│   ├── goal.ts             # GoalManager
│   ├── team.ts             # TeamManager
│   ├── templates.ts        # Task templates
│   ├── worktree.ts         # WorktreeManager (git worktrees)
│   ├── config-flow.ts      # The config dialog flow (pure; the TUI adapts it)
│   ├── git-flow.ts         # Branch/commit convention detection
│   └── astgrep.ts          # AstGrep wrapper
│
├── skills/                 # SKILL.md files written to ~/.config/opencode/skills.
│   │                       # Must be listed in package.json "files" or it does not ship.
│   ├── nexus-design-taste/ #     Convergence catalogue the designer draws on
│   ├── nexus-interface-a11y/ #   WCAG figures with their SC and level
│   └── nexus-design-review/ #   Audits an existing UI; never edits it
│   └── ask-if-clarify/     #     Repo document — NOT installed and NOT in NEXUS_SKILL_NAMES
│
├── test/                   # The suite, one *.test.ts per subsystem
│   └── helpers/            # Shared test harnesses (dashboard DOM, page parsing)
├── dashboard/index.html    # The dashboard page: plain JS, no build step
├── docs/                   # API.md (by class), COMPATIBILITY.md
├── examples/               # Runnable example scripts
├── skills/                 # Bundled agent skills
├── assets/
│   ├── banner.svg
│   └── agents/             # nexus-*.md agent definitions, written to ~/.config/opencode/agents
├── biome.jsonc             # Biome config — lint only, formatter disabled
├── package.json
├── tsconfig.json           # strict; includes src/ AND test/
├── README.md
├── TECHNICAL_DESIGN.md
└── dist/                   # Build output. Generated by `bun run build`, gitignored.
```

There is no `src/modules/` directory and no `src/tools/` directory. `src/modules.ts`
is a *file* — the module registry — and tools are registered inline in
`src/index.ts`. See "Adding a New Module" and "Adding a New Tool" below.

## 🔧 Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:

- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Adding tests

Example: `feat/add-cost-dashboard`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add real-time cost tracking
fix: resolve agent timeout issue
docs: update API reference
refactor: simplify DAG executor
test: add unit tests for cost router
```

Do not add `Co-Authored-By` or any attribution trailer to commits or PRs unless a maintainer explicitly asks for it. Do not infer authorship from the model you are using.

### Code Style

- TypeScript strict mode — `tsconfig.json` sets `"strict": true`
- Follow the existing style of the file you are editing
- Comments explain **why**, not what. The bar in this repo is high; read
  `src/notifications.ts` or `src/orchestrator.ts` before writing a new one
- **There is no `format` script, and its absence is deliberate.** The Biome
  *formatter* is switched off in `biome.jsonc` (`"formatter": { "enabled": false }`)
  because the existing tree is not Biome-formatted — enabling it would reformat
  every file and fail `biome check` on layout alone. The `format` script was
  **removed** rather than left pointing at a disabled formatter, because a script
  that exits 0 while doing nothing is exactly the false green the removal fixed.
  Match the surrounding file by hand. The comment in `biome.jsonc` says precisely
  what to re-add when a repo-wide reformat lands.
- Run `bun run lint` before pushing — see "Gates" below

### Gates

Three commands, all of which must pass before you push:

```bash
bun test            # the full suite
bun run typecheck   # tsc --noEmit, over src/ AND test/
bun run lint        # a chain of three legs — see below
```

`bun run lint` is three legs joined with `&&`:

1. `biome check src/ test/` — lint only, formatter off.
2. `tsc --noEmit` — the same thing `bun run typecheck` runs. Redundant on
   purpose: `tsc` is the only leg that sees `test/`, and `test/` is inside the
   tsconfig `include`, so a type error in a test is a real failure and this is
   what keeps it honest.
3. an inline `bun -e` script that extracts every inline `<script>` from
   `dashboard/index.html` and passes each to `new Function`, so the page's script
   is proven to parse. It prints how many scripts it checked.

**`bun run lint` exits 0 while printing findings.** On the current tree it prints
`Found 3 infos` and exits 0, because Biome reports those at `info` severity.
"Lint passes" (exit 0) and "lint prints nothing" are different claims — do not
read a clean exit as a clean report.

**`dashboard/index.html` is plain JavaScript and nothing type-checks it.** It is
outside the tsconfig `include` and outside Biome's `files.includes`
(`src/**`, `test/**` only). What covers it instead is
`test/dashboard-page-execution.test.ts`, which *loads and runs* the page against
a DOM harness (`test/helpers/dashboard-dom.ts`) and asserts on the failure
markers the page itself prints — plus `test/dashboard-page-contract.test.ts`,
which asserts what its source says. Leg 3 above only proves the script parses.

### Testing

- Write tests for new features, and check they actually fail when the feature
  is broken (see "Mutation testing" below)
- `bun test` and `bun run lint` must pass before you open a PR

```bash
bun test                    # the whole suite
bun test test/goal.test.ts  # one file, by path
bun test --coverage         # the same run, plus a per-file % table on stdout
```

`--coverage` prints the table and nothing else: it writes no report file and
creates no `coverage/` directory. There is no HTML or lcov output in this project.

#### CI runs on Linux; your laptop probably does not

Every job in `.github/workflows/ci.yml` runs on `ubuntu-latest`. A test that
passes on macOS can fail there, and this repo has hit it: a notification test
patched the **global** `setTimeout` and counted every timer in the process, so
what it measured was the environment, not the notifier. It was green on darwin
and red on both ubuntu legs, with nothing about the notifier having changed. The
fix was to inject the timer functions instead — `TimerFunctions` in
`src/notifications.ts` — so a test sees only the timers the code under test
created.

Two rules follow, and both are load-bearing:

- **Do not assert on ambient process state.** Global timers, module-level
  counters, and reading all of `process.env` into an assertion surface all pick
  up whatever else the host runtime is doing.
- **Spoofing `process.platform` is not a substitute for running on the
  platform.** Overwriting `process.platform` reports green while exercising none
  of the platform-specific behaviour. The platform-dependent tests here avoid
  the need for it by being *index-free*: `textChannels()` in
  `test/notification-integration.test.ts` searches the entire text surface of a
  recorded spawn (argv plus the Windows-notifier env vars) rather than
  `args[4]`, so one predicate is a real assertion on darwin, linux and win32
  instead of an `undefined` that passes vacuously. When a change is genuinely
  platform-dependent, run the suite on Linux — a container, or a push — and say
  in the PR that you did.

#### Mutation testing

Before you trust a new test, break the implementation on purpose and confirm the
test goes red. A test that has never been seen to fail is not evidence of
anything, and this repo's best fixes came from finding that its checks were
vacuous. If a mutation you tried is *not* caught, that is a finding too — say so
in the PR rather than quietly keeping the weaker test. The repo records these
checks in comments; `test/task-cost.test.ts` (~line 1690) and
`test/dashboard-page-execution.test.ts` (~line 466) are worked examples of a test
documenting which of its guards is actually load-bearing and which mutation
proves it.

#### Verify from the packed tarball, not just the working tree

`package.json`'s `files` ships `dist/`, `README.md` and `LICENSE` and nothing
else. Anything the plugin reads from disk at runtime therefore resolves against
the *consumer's* working directory, not yours — which is how the dashboard used
to read `dashboard/index.html` off disk and fail on every install while every
test passed. The fix was to inline the page into the bundle
(`src/dashboard.ts`), but the lesson is the general one: for a change that
touches packaging, what the working tree tells you is not what consumers get.

```bash
bun run build
bun pm pack --dry-run   # lists exactly what would ship
bun pm pack             # writes a .tgz (gitignored)
```

Today `--dry-run` reports 5 files: `package.json`, `LICENSE`, `README.md`,
`dist/index.js`, `dist/tui.js`.

Install that tarball into a scratch project and exercise the feature there. It is
also worth re-reading `package.json`'s `files` list whenever you add a file the
runtime needs.

## 🎯 Contributing Guidelines

### Adding a New Module

There is no `src/modules/` directory. A new module is a new file in `src/` that
exports a class named after the file, following the existing shape — there is no
base class and no interface to implement:

1. Create `src/<name>.ts` and export the class. One class per file, named after
   the file: `HealthMonitor` in `health.ts`, `ExecutionHistory` in `history.ts`,
   `CustomRoleManager` in `custom-roles.ts`, `WorktreeManager` in `worktree.ts`.
2. Hold it as a public field on `NexusOrchestrator`, declared alongside the other
   subsystem fields near the top of `src/orchestrator.ts`.
3. Construct it in the `NexusOrchestrator` constructor (`src/orchestrator.ts:927`).
4. Wire it up where the behaviour belongs. Anything needed on plugin start goes in
   `initialize()` (`src/orchestrator.ts:973`) — `loadModelCosts()`,
   `syncCustomRoles()` and `initBroadcaster()` are all called from there —
   and anything needed on shutdown goes in `shutdown()`.
5. Add a tool for it if it needs one — see "Adding a New Tool".
6. Add `test/<name>.test.ts`, importing from `'../src/<name>'`.
7. Document it in `docs/API.md`, which is organised as one `###` section per
   class.

If you mean a *user-supplied* extension rather than a built-in, that is a
different mechanism: implement the `NexusModule` interface in `src/modules.ts`
and call `orchestrator.moduleRegistry.register({ ... })`. `initialize()` calls
`setupAll()` over whatever is registered and `shutdown()` calls `teardownAll()`.
`examples/custom-module.ts` shows the shape.

### Adding a New Tool

There is no `src/tools/` directory. Every tool is registered inline in
`src/index.ts`, inside the single `await ctx.tool.transform((editor) => { ... })`
block that starts around line 1132.

1. **Put the behaviour in an exported function, not in the `execute` closure.**
   An inline closure is only reachable by standing up a whole plugin host, so it
   cannot be unit tested. `runDashboardStart`, `runDashboardStop` and
   `runNotificationsTest` in `src/index.ts` are the pattern: each takes the
   orchestrator and returns the text, and the inline `execute` is a one-liner
   that calls it. Give it a named error path — see the comment above
   `runDashboardStart` for why a failed port bind is *reported* rather than
   thrown.
2. **Export the description as a constant** if the wording matters. A model's
   decision to call a tool is made from its description and nothing else, so the
   text is a contract and is pinned by tests: `DASHBOARD_START_DESCRIPTION` and
   `NOTIFICATIONS_TEST_DESCRIPTION` are both asserted in
   `test/dashboard-entrypoints.test.ts`.
3. **Register it** with an `editor.add({ ... })` call giving `name`, `description`,
   a JSON-Schema `input` object with `additionalProperties: false`,
   `options: { codemode: true }`, and an `execute` returning `{ content: string }`.
4. **Test the exported function directly**, and extend whichever existing test
   file already pins that tool's name and description rather than starting a new
   one — a duplicate contract test is a second thing to rot.
5. **Document it**: add a row to the `## Tools` table in `README.md`, and a
   section in `docs/API.md` if it is part of the public API.
6. **If the tool exposes a new public API type**, note the addition in that type's
   own doc comment — not only in the changelog or the PR. `CostProvenance` in
   `src/types.ts` is the worked example: its doc comment says why it lives in
   the leaf type module rather than in `orchestrator.ts`, and that the
   re-export keeps the public surface unchanged. A note that exists only in a diff
   is gone by the next release.

### Switching a Biome rule off

`biome.jsonc` carries a block comment listing every rule that is currently
switched off, each with its occurrence count and location. That block makes one
promise: **the config matches the measured state of the tree.** If you turn a
rule off, add its count to that list. An unlisted "off" breaks the promise
silently, because the count is the only part anyone ever checks.

### Bug Reports

When filing an issue, please include:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)
- Relevant logs or error messages

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Add/update tests
4. Update documentation if needed
5. Submit PR with clear description

## 📝 Documentation

- Update README.md for user-facing changes
- Update docs/API.md for API changes (it lives in `docs/`, not at the root)
- Add inline comments for complex logic
- Include examples for new features

## 🧪 Testing

### Unit Tests

Test individual functions and classes:

```typescript
import { describe, it, expect, mock } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'

// `initialize` reads `ctx.location.directory` and drives the session API, so
// both have to be present. This is the same shape `test/orchestrator.test.ts`
// uses.
const mockCtx = {
  location: { directory: process.cwd() },
  session: {
    create: mock(() => Promise.resolve({ id: 'session-mock-123' })),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([])),
    switchAgent: mock(() => Promise.resolve()),
    switchModel: mock(() => Promise.resolve()),
  },
  storage: {
    set: mock(() => Promise.resolve()),
    get: mock(() => Promise.resolve(null)),
  },
}

describe('NexusOrchestrator', () => {
  it('spawns an agent that has a real session behind it', async () => {
    // All three constructor parameters are optional, so the defaults are fine.
    const orchestrator = new NexusOrchestrator()

    // `await` this: `initialize` is async, and while `spawnAgent` happens to
    // find `ctx` set synchronously today, an un-awaited initialize is a race.
    // The `as never` is the mock's escape from the full Plugin.Context type.
    await orchestrator.initialize(mockCtx as never)

    const agent = await orchestrator.spawnAgent({ role: 'coder' })

    expect(agent.role).toBe('coder')
    expect(agent.sessionID).toBe('session-mock-123')
  })
})
```

This snippet is a real test file: it passes `bun test`, `bun run typecheck` and
`biome check` as written. Copy it, do not paraphrase it — a partial mock is the
usual reason an orchestrator test fails for a reason that has nothing to do with
what it is testing.

### Integration Tests

Test module interactions. The existing examples are `test/task-cost.test.ts`
(cost accounting across a task's whole lifecycle) and
`test/dag-model-selection.test.ts` (model choice inside DAG execution) — read
one before writing a new cross-module test.

## 🎨 Design Principles

1. **Modularity** - Keep modules independent and composable
2. **Type Safety** - Leverage TypeScript's type system
3. **Error Handling** - Graceful degradation and recovery
4. **Performance** - Optimize for real-time operations
5. **Documentation** - Clear and comprehensive docs

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 💬 Questions?

Feel free to open an issue for questions or discussions!
