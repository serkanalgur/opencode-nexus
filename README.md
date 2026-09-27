<div align="center">

<img src="./assets/banner.svg" alt="OpenCode Nexus" width="100%" />

[![npm version](https://img.shields.io/npm/v/@serkanalgur/opencode-nexus?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@serkanalgur/opencode-nexus)
[![npm downloads](https://img.shields.io/npm/dw/@serkanalgur/opencode-nexus?style=flat-square&color=22c55e)](https://www.npmjs.com/package/@serkanalgur/opencode-nexus)
[![stars](https://img.shields.io/github/stars/serkanalgur/opencode-nexus?style=flat-square&color=f59e0b)](https://github.com/serkanalgur/opencode-nexus/stargazers)
[![license](https://img.shields.io/npm/l/@serkanalgur/opencode-nexus?style=flat-square&color=8b5cf6)](https://github.com/serkanalgur/opencode-nexus/blob/main/LICENSE)
[![Socket Badge](https://badge.socket.dev/npm/package/@serkanalgur/opencode-nexus/latest)](https://socket.dev/npm/package/@serkanalgur/opencode-nexus/overview)
[![opencode](https://img.shields.io/badge/OpenCode-V2-6366f1?style=flat-square)](https://opencode.ai)
[![typescript](https://img.shields.io/badge/TypeScript-5.5+-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=github)](https://github.com/sponsors/serkanalgur)

**Adaptive Multi-Agent Orchestration with Cost Intelligence**

[Installation](#installation) • [Quick Start](#quick-start) • [Features](#features) • [Agents](#agents) • [Tools](#tools) • [Configuration](#configuration) • [Development](#development)

</div>

---

## What is OpenCode Nexus?

OpenCode Nexus is an agent orchestration plugin for [OpenCode V2](https://opencode.ai) that spawns **real sub-agent sessions** with **cost-aware routing**, **DAG-based task execution**, **self-healing**, and a **TUI/web dashboard**.

### Key Capabilities

| Capability | Description |
|------------|-------------|
| **Real Sessions** | Each agent runs in its own OpenCode session. The preferred path dispatches through OpenCode's built-in `subagent` tool so the child is parent-linked; `ctx.session.create()` is the fallback when no parent tool context is available, and the spawn is logged as degraded |
| **Role-Based Agents** | Architect, Coder, Reviewer, Tester, Explorer, Documenter — each with specialized prompts |
| **Custom Roles** | Your own roles, from `.opencode/nexus.jsonc` or `nexus.roles.add` for the session |
| **DAG Execution** | Tasks are parallelized based on dependency graphs with priority queuing |
| **Cost-Aware Routing** | Scores models by quality and cost, selects optimal per task complexity. A speed score is computed and reported but does not affect selection |
| **Self-Healing** | Retries with exponential backoff, context transfer, then an escalation policy. The retry counts are configurable; the fallback model list is a hardcoded default, not file-configurable |
| **Config Hot-Reload** | Edits to `nexus.jsonc` take effect without a restart — a `filesystem.changed` fast path plus a 2s poll of the two config files, debounced 150ms |
| **Web Dashboard** | A live view of sessions, agents, tasks, costs and config, served over HTTP + WebSocket (default port 4747) — started on request from `/nexus-dashboard` or the agent, never automatically |
| **TUI Dashboard** | Monitor agents, budget, and config from the terminal |
| **Team Mode** | Lead agent orchestrates specialist agents in parallel |
| **Todo & Goal Tracking** | Enforce task completion, persist objectives across sessions |
| **Persistent Memory** | SQLite store, three tools, and automatic retrieval of notes keyed to a task's files. **Nothing is ever written automatically** — a miss injects silence, never a guess |
| **Learning Module** | Pattern recognition from failures, confidence scoring |
| **JSONC Config** | Read/write project and global config files with comments |
| **OpenCode LSP opt-in** | On startup, inserts `"lsp": true` into your global `opencode.jsonc` if it isn't already there. That is the whole of it — Nexus does not read LSP state, manage servers, or report anything about them |
| **AST-Grep** | Pattern-aware code search |
| **Security Scanning** | Regex detection of hardcoded secrets and known-dangerous constructs |
| **Slash Commands** | `/nexus`, `/nexus-dashboard`, `/nexus-web`, `/nexus-overview`, `/nexus-config`, `/nexus-model`, `/nexus-status`, `/nexus-reset` |

---

## Installation

```bash
# Install the plugin and add it to your global OpenCode config
opencode plugin add @serkanalgur/opencode-nexus
```

This package is an OpenCode plugin, not a command-line tool: it declares no
`bin`, so there is nothing for a global install to put on your `$PATH` and no
CLI to invoke afterwards. `opencode plugin` takes a subcommand (`list`, `add`,
`check`, `update`, `remove`) and has no `--global` flag.

Or manually add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["@serkanalgur/opencode-nexus"]
}
```

### Auto-Setup

On every plugin load, Nexus:
- Writes `nexus-orchestrator` to `~/.config/opencode/agents/nexus-orchestrator.md`
- Writes the six subagent files: `nexus-coder`, `nexus-explorer`, `nexus-reviewer`, `nexus-tester`, `nexus-architect`, `nexus-documenter`
- Reads role→model mappings from `.opencode/nexus.jsonc` (and the global config) and resolves them per spawn; the generated agent files carry no model pin
- Best-effort: if `~/.config/opencode/opencode.jsonc` already exists and does not already mention `"lsp"`, inserts `"lsp": true`; silently does nothing if the file is absent

**The agent files are rewritten on every load, not created once.** Any hand-edit
to them is lost the next time OpenCode starts. Edit `nexus.jsonc` for models and
budget, or `nexus.roles.add` for an extra role; do not edit the generated agent
files.

---

## Quick Start

### 1. Configure Agent Models

Press **Ctrl+N** or type `/nexus` to open the configuration dialog. Select where to save (project or global).

### 2. Use the Nexus Orchestrator

Select `nexus-orchestrator` as your primary agent, then:

```
# Spawn agents for tasks
Use nexus.spawn with role="coder" and task="Implement JWT auth"

# Wait for completion and get results
Use nexus.spawn with role="reviewer" and task="Review the implementation" and wait=true

# Delegate (convenience wrapper)
Use nexus.delegate with role="tester" and task="Write tests for auth module"

# Check progress
Use nexus.sessions

# Track goals
Use nexus.goal.set with description="Build complete auth system"
```

### 3. Use Slash Commands

```
/nexus              # Open full configuration dialog
/nexus dashboard    # Start the web dashboard and open it in your browser
/nexus status       # Show the config summary
/nexus model coder  # Pick the model for a role
/nexus reset        # Reset configuration to defaults
```

---

## Features

### Cost-Aware Model Selection

Models are configured per role in `.opencode/nexus.jsonc`. Nexus scores models by quality and cost, then picks the optimal one. A speed score is computed and reported alongside, but it is not a term in the overall score, so it never affects which model is selected.

Example (the model ids below are illustrative — use whatever your provider offers):

```jsonc
{
  "models": {
    "architect": "opencode/muse-spark-1.3-contributor-free",
    "coder": "opencode/mimo-v2.6-flash-free",
    "reviewer": "opencode/muse-spark-1.2-contributor-free",
    "tester": "opencode-go/mimo-v2.5",
    "explorer": "opencode/big-pickle",
    "documenter": "opencode/big-pickle"
  }
}
```

When you call `nexus.spawn(role="coder")`, the coder model from config is used automatically.

`nexus.model.costs` with no arguments lists every loaded model, grouped under one
heading per provider — `Anthropic`, `OpenCode Go` — so a multi-provider install
reads as sections instead of one flat run of `providerID/modelID` keys. The
heading is the provider's display name, and a provider OpenCode has not published
a name for falls back to its raw id. Groups are ordered by display name and
models by id within their group, and a model priced by hand under a bare id goes
into a `No provider (bare model id)` bucket rather than being dropped or filed
under a provider it does not belong to. A long catalogue is cut at 12 providers,
and the closing line states how many groups and models were left out.

Each row shows its input and output price in USD per 1K tokens, in the same
format the TUI model picker uses — the two surfaces share one formatter, so they
cannot print different numbers for the same model. The list prints **one rate
pair per model**: it is a catalogue, and a four-rate-per-tier block per model is
unreadable in a list column. Cache rates and every tier above the first are
therefore **not in the list** — pass `model=<provider/id>` and you get that one
model in full, every tier, with `cache_read` and `cache_write`. The threshold a
row names is where its displayed rate stops applying; the rate that takes over is
in the per-model view.

Provider names come from a single snapshot the server loads at startup, and the
dashboard and this tool both read it — so the two can never print different
headings for the same models. The cost of one snapshot is that a provider added,
renamed or removed mid-session keeps its boot-time label (or its raw id, if it
had none) until the server restarts; the TUI model picker memoises names per
project directory for the same reason. A stale name is a wrong *label* on rows
that are otherwise correct — never a missing model and never a wrong price.

### Self-Healing with Escalation

Failed tasks follow a 4-step escalation chain:

1. **Retry** — Exponential backoff (1s, 2s, 4s...)
2. **Respawn** — Collect context, spawn new agent with transferred state
3. **Fallback Model** — Try a cheaper alternative model. The fallback list (`google/gemini-2.5-flash`, then `anthropic/claude-haiku-4-5`) is a hardcoded default in `src/orchestrator.ts`, not something `nexus.jsonc` can change
4. **Alert** — Emit escalation event, mark as failed

The retry count, retry delay and context-transfer toggle are configurable under
`selfHealing`; the fallback models are not.

### Web Dashboard

A live view of the orchestrator, served by an HTTP + WebSocket server on port 4747 (`127.0.0.1`).

**Nothing is listening until you ask for it.** The server is not started at
startup, and no command starts it implicitly. The start has to happen in the
OpenCode *server* process, next to the orchestrator that feeds it, and there are
two ways to reach it:

```
/nexus dashboard [port] [host]      # from the TUI — starts it and opens it
Ask the agent: "start the nexus dashboard"
```

The TUI command submits `/nexus dashboard [port] [host]` to that server process,
whose prompt hook routes it to the orchestrator; the agent's route calls
`nexus.dashboard.start(port=4747, host="127.0.0.1")` directly. Both end at the
same start, and both print the URL it bound. **If the start fails, nothing is
listening and no browser is opened** — the reason is reported, and no URL is
offered for a server that is not there. The ways it fails are a port already in
use (the bind is refused; pass a different `port`) and `dashboard.enabled: false`
in `nexus.jsonc`, which is refused by name.

Once it is serving, the same command opens it:

```
/nexus dashboard [port] [host]      # /nexus web is an alias of this
/nexus web [port] [host]
```

The TUI cannot start the server itself — its process has no orchestrator, no
module registry and no way to invoke a tool — but it can reach the process that
has all three, and it can ask whether anything is listening. So the command asks
`http://host:port/api/health` first, and then does one of four things:

| What it found | What it does |
|---|---|
| A nexus dashboard | Opens your browser at that URL. Nothing is started a second time |
| A different process on that port | Says so, opens nothing, suggests another port |
| Nothing there | Submits `/nexus dashboard [port] [host]` to the server, waits for the port to answer, then opens the browser |
| Still nothing after ~3s | Says the start did not confirm, opens nothing, and points at the command's own reply for the reason |

The browser opens **only** after a confirmed listen. That is the whole point of
the wait: a browser pointed at a dead address gives a connection-refused page,
which looks like the dashboard failing rather than the dashboard not running.

**How it stays current.** A WebSocket to `/ws/events` carries a throttled
`orchestrator:state` push — every state change schedules a full snapshot, at
most once a second — plus the thirteen orchestrator events as they happen. On
top of that, an **Auto-refresh** checkbox (on by default) has the page ask the
server for a fresh state every 5 seconds and poll `/api/health` and `/api/costs`,
the two things the socket does not carry. The push is what keeps the page fresh;
the interval is a belt-and-braces refresh you can switch off. The page also
shows how old the last snapshot is, and labels it stale past 15 seconds.

**What it shows:**
- **Sessions** — one row per session nexus owns, is still collecting cost from,
  or has abandoned, with each one's state (`running` / `idle` / `abandoned` /
  `settled`), age, last read token count, and unbilled spend. Rows with **no
  owning agent** are called out in a banner above the table, because a session
  that is still generating after its agent was terminated keeps spending and
  nothing is collecting that spend — a case that was invisible on every layer
  before. The **Age** column is elapsed time, not a wall clock, and reads `—`
  for those orphan rows: `spawnedAt` comes from the owning agent, so an unowned
  session has no start time to show. The cell says so in its tooltip, and the
  `—` is shown rather than the column dropped, so the gap is visible.
  This list is nexus's own bookkeeping, not an enumeration of every open session
  on the server, and the page says so on the section itself.
- **Agents** — role, status, model, session id, and metrics
- **Budget** — spend against the configured cap, with the alert threshold marked
- **Tasks and DAG** — the task list, and a graph drawn from the dependency edges
  the state actually reports. Edges pointing at tasks that are not in the
  snapshot, self-edges, and cycles are counted and reported in the section note
  rather than silently not drawn.
- **Cost breakdown** — by agent and by model, read from `/api/costs`, which
  covers the full history rather than only the live agents. The by-model chart
  is grouped into one run per provider; a bar's length and value are still that
  model's own cost, and the footer still sums every bar, so grouping moves rows
  and changes no figure. A model whose key has no provider — a bare model id —
  is drawn first with no group header rather than filed under a provider it does
  not have.
- **Configuration (read-only)** — the resolved config the orchestrator reports
  as in force, plus a `read-only` JSON viewer. The write path was deliberately
  removed rather than left broken: it used to post a `config:update` message
  that the server does not handle, so the Apply button reported success and
  nothing happened. There is no auth story for writes and the socket is a
  localhost server answering with `CORS: *`, so no write path was added to
  replace it — edit `nexus.jsonc` instead. **Models per Role** is grouped by
  provider with the roles nested beneath, every role still shown exactly once;
  the role→model rows are the panel's own key/value grid, so a provider is a
  header rather than a third column. Both the chart and this panel head their
  groups with the host's provider **display name** (`OpenCode Go`), carried by
  the `providers` list that `/api/costs` now reports — so they agree with the
  TUI model picker, which reads the same names from the host's provider list. A
  provider the host published no name for keeps its raw id (`opencode-go`)
  rather than going blank. In **this panel**, grouping is keyed on the raw
  provider id, so a display name can never merge two providers: two providers
  that share one name stay two groups under two headers. That is a property of
  the dashboard, not of every surface — `nexus.model.costs` with no arguments
  does merge two providers that share a display name, because there the heading
  *is* the group key. All three surfaces order groups by display name, so the
  panel, the tool and the picker agree on which provider comes first; they do not
  share a comparator, so the two Node surfaces (locale-aware) and the page
  (code-unit) can order differently on a name that sorts differently under the
  two rules. The panel says all of this on its face.
- **Activity log** — every event the broadcaster forwards, each delivered once.
  Two of them carry a fact the line used to leave out:
  - `cost:delta` names **where the price came from** (`settledTier.pricing`) and
    which token tier the amount was priced at. That is deliberately not the same
    as the measured/estimated split elsewhere on the page: `settledTier.pricing`
    is about the *price* — the model's published list, a fallback table because
    this model is not in it, or an unknown-model fallback — while
    measured/estimated is about the *token counts*, which the orchestrator reads
    off a real session. A line whose `settledTier` is missing says so instead of
    implying a price source.
  - `config:reloaded` names the **cause** (`trigger`) alongside the load number,
    the raw ISO load time, and both config files' state, so a reload that
    happened for a reason you did not ask for is visible as one.

**Stop the dashboard:**
```
/nexus dashboard stop
Ask the agent to call nexus.dashboard.stop
```
This stops the HTTP/WebSocket server only. The orchestrator, its agents and its
sessions keep running. Both routes say so plainly when there was nothing
running, rather than reporting a stop that did not happen.

### Team Mode

Create a team of specialist agents working in parallel:

```
nexus.team.create(name="auth-team", leadRole="architect")
nexus.team.addMember(teamId="...", role="coder", model="opencode/mimo-v2.6-flash-free")
nexus.team.addMember(teamId="...", role="reviewer", model="opencode/muse-spark-1.2-contributor-free")
nexus.team.activate(teamId="...")
```

### Todo & Goal Tracking

Track tasks and persist objectives across sessions:

```
nexus.todo.add(description="Implement auth middleware")
nexus.todo.list()
nexus.todo.complete(id="...")

nexus.goal.set(description="Build complete auth system")
nexus.goal.status()
nexus.goal.complete()
```

### LSP Integration

None, beyond one line. On plugin load Nexus inserts `"lsp": true` into
`~/.config/opencode/opencode.jsonc` — but only if that file already exists and
does not already contain the string `"lsp"`. The edit is best-effort and its
failure is silent. Nexus has no language list, no LSP state, and no surface that
reports anything about LSP.

### AST-Grep

Pattern-aware code search, shelling out to `sg run`:

```
nexus.astgrep.search(pattern="console.log($$$)", language="typescript", directory="src/")
```

There is no `nexus.astgrep.rewrite` tool. The `AstGrep` class has a `rewrite`
method, but it is not registered — and it builds its shell command by
interpolating the pattern into the string, which is presumably why.

### Security Scanning

Regex detection of hardcoded secrets and known-dangerous constructs. The scanner
is six secret patterns (API key, password, token, private key, `-----BEGIN …
PRIVATE KEY-----`, AWS credentials) and eight dangerous-substring patterns
(`eval(`, `exec(`, `child_process`, `innerHTML=`, `document.write(`,
`new Function(`, `__proto__=`, direct `process.env`). It is per-file and
per-line with no dataflow or CVE awareness; secret matches are reported
`critical` and dangerous-pattern matches `medium` regardless of context.

```
nexus.security.scan(content="const API_KEY = \"sk-123\"", filename="config.ts")
```

### Persistent Memory

A SQLite store at `~/.local/share/opencode-nexus/memory.db` that survives
restarts, plus three tools (`memory.set`, `memory.search`, `memory.list`) and
**automatic retrieval**: when a task is about to run, notes keyed to the files
that task touches are placed in the agent's prompt.

The governing rule, and the reason the automatic half exists at all:

> **Memory does not speak over what the code says. It says what the code does
> not.** Writes are explicit, attributed and timestamped. There is **no
> automatic writing**.

A miss injects silence, never a guess. That asymmetry is the whole argument for
retrieval over a tool: an agent that forgets to call `memory.search` fails
silently, an injection that misses also fails silently, and only one of them
cannot invent a claim about your codebase.

#### Writing a note

```bash
nexus.memory.set(
  key="file:src/memory-store.ts",
  value="set() appends rather than upserts — the primary key is a fresh id",
  author="alice"
)
```

**Nothing is injected unless the key is `file:<path>`.** One convention, and a
note that misses it is a note that is silently never shown. `memory.set` says so
in its result, and tells you the key to use instead. Any other key is still
stored, and is reachable through `memory.search` and `memory.list`.

`author` is required and **self-reported** — nothing verifies it, and it is
shown to readers as a claim rather than a record. `confidence` is optional on
purpose: an entry that records no confidence is not a low-confidence entry, and
a default would make your uncertainty invisible to whoever reads it later.

#### `set` appends

Writing the same key twice leaves **both** versions readable. The newest is the
one agents are shown, and the injected block says how many earlier versions it
supersedes. This is deliberate: it keeps the store able to answer *"when did we
believe this?"*, which is the question a stale-memory bug always turns out to
be. `memory.search` returns both versions rather than hiding one, because
`memory.set` told you it kept them.

**There is no `memory.delete` tool.** Removal is API-only
(`orchestrator.memoryStore.delete(key, scope)`), because an agent that finds a
note inconvenient will delete it to unblock itself, and there is no
confirmation step an agent honours. **So there is no in-product way for a
non-programmer to remove a wrong note** — correcting it means writing a new
version. If this feature gets used enough for that gap to matter, a dashboard
affordance is the first thing to build.

#### What is injected, and how it is marked

Up to 5 notes, 800 characters, 240 per value. The block opens by describing
itself, every line carries an author and a **relative** age (`written 6 weeks
ago` — a date is a fact that goes stale silently; an age degrades), and the
value sits inside a quoted, attributed line.

The quotation is the load-bearing part. A stored value can contain an
imperative — someone will write *"always run `bun run migrate` first"* — and
because it is quoted and attributed, it reads as a quotation of a note rather
than a directive. The other three mechanisms (register, attribution, position
after the task) are conventions an agent can talk past; this one is structure.

Truncation is announced in the block (`showing 3 of 9 notes`). A block that
silently shows three of nine reads as "those were all of them".

Only `scope: 'project'` is ever injected, for two independent reasons: only
`project` is written by a human, and a `session` entry is an escalation blob
that nests the failing agent's own memory entries inside itself. Only the
`project` scope is writable by the tool; `session` belongs to the orchestrator's
own context transfer and `learning` is the name of a different, automatically
written mechanism (see below).

#### Five things this feature will not tell you

1. **It is inert on day one, for everyone.** The store ships empty, so the first
   release injects nothing anywhere. The tools are the day-one value; the
   injection is what makes a written note *sticky*.
2. **It only fires on a file the writer named.** With ~10 hand-written entries,
   expect 1–3 to fire on any given task.
3. **It will not tell you when a note has gone stale, because nothing in the
   system can.** There is no automatic writing, so no mechanism revalidates,
   refreshes or expires a note.
4. **Every matching task pays that cost forever**, for a note a human wrote once
   and may never have checked.
5. **A stale note that is confidently wrong is worse than no note.** The
   `speedScore` precedent above is this at release scale.

#### Storage, eviction, and the rest of the details

Entries never expire unless you pass a per-entry `ttl`, and for `project` notes
that is deliberate: nothing rewrites a note, so an expiry would delete it
permanently. `search` is a `LIKE '%q%'` substring match over keys **and**
values, unranked — a result count is a hit count, never a relevance count.

Per-scope caps are enforced (1000 by default) and **eviction is never silent**:
it is reported by `memory.list`, in a `console.warn`, and in the `memory.set`
result that caused it. The `project` scope is **exempt** — evicting a durable
note because disposable `temp` entries arrived would be the wrong trade. Those
eviction totals are per-process and reset on restart, so they under-report
across runs; `memory.list` says so.

Two removed knobs, rather than wired: `MemoryStoreConfig.defaultTTL` and the
`NexusConfig.memory` block. Both were read by nothing, and an `enabled: false`
that does not disable anything is worse than no block — a user who sets it
believes they have turned something off. `NexusConfig.memory` is a **breaking
type change**; delete the block, because it was already inert.

The database file is the most exposed and least marked surface: it is a plain
SQLite file whose only provenance is the `author` column. The dashboard activity
log deliberately does **not** render stored values — only which key, in which
scope, by whom.

```typescript
orchestrator.memoryStore.set({
  key: 'file:api-pattern',
  value: { endpoint: '/users', method: 'GET' },
  scope: 'project',
  author: 'architect',
  confidence: 0.9,
  tags: ['api', 'design']
})
```

### Learning Module

Records failure patterns and solutions, building confidence over time:

```typescript
const solutions = orchestrator.learning.findSolutions('TypeScript TS2345 error')
// → [{ entry: { solution: 'Add type cast', confidence: 0.85 }, similarity: 0.7 }]
```

### Preset Configurations

| Preset | Models | Budget | Self-Healing |
|--------|--------|--------|--------------|
| **minimal** | Gemini Flash | $1 | Off |
| **balanced** | Claude/GPT mix | $10 | On (3 retries) |
| **enterprise** | Top-tier | $50 | On (5 retries) |
| **cost-optimized** | Cheapest | $3 | On (2 retries) |

---

## Agents

Nexus creates 7 agent files in `~/.config/opencode/agents/`:

| Agent | Mode | Purpose |
|-------|------|---------|
| `nexus-orchestrator` | primary | Main orchestrator — decompose, dispatch, integrate |
| `nexus-architect` | subagent | System design and architecture |
| `nexus-coder` | subagent | Implement code tasks |
| `nexus-reviewer` | subagent | Code review (read-only) |
| `nexus-tester` | subagent | Write and run tests |
| `nexus-explorer` | subagent | Explore codebases (read-only) |
| `nexus-documenter` | subagent | Write documentation |

### Clarify

`nexus.clarify` does not ask the user anything and does not wait for a reply. It
formats the question — with a numbered option list and a stated default — and
returns that text as tool content, so the *model* is the one that ends up
holding the question:

```
nexus.clarify(question="Should I use JWT or OAuth?", options="JWT, OAuth", assumption="JWT")
→ ❓ Should I use JWT or OAuth?
  Options:
  1. JWT
  2. OAuth
  💡 Default: JWT
```

The repository also contains a `skills/ask-if-clarify/SKILL.md` prompt. Nothing
in `src/` loads it and it is not in `package.json`'s `files` list, so it is not
installed with the package — treat it as a repo document, not a shipped feature.

---

## Tools

| Tool | Description | Input |
|------|-------------|-------|
| `nexus.spawn` | Spawn a sub-agent | `{ role, task, model?, wait?, timeout? }` |
| `nexus.delegate` | Spawn + wait + result | `{ role, task, model?, timeout? }` |
| `nexus.sessions` | List active sessions | `{}` |
| `nexus.background` | Move agents to background | `{}` |
| `nexus.result` | Get agent result | `{ sessionID }` |
| `nexus.status` | Orchestrator status | `{ detailed? }` |
| `nexus.agents` | List active agents, as JSON | `{ filter? }` — filter by agent status |
| `nexus.costs` | Cost report & budget | `{}` |
| `nexus.notifications.test` | Send one OS notification and report whether it was delivered, and why not | `{}` |
| `nexus.dashboard` | Full orchestrator state as JSON | `{}` |
| `nexus.queue` | Current task list with priorities, as JSON | `{}` |
| `nexus.forecast` | Predict costs | `{ tasks }` |
| `nexus.model.costs` | Show/set model pricing; with no `model`, lists all models grouped by provider | `{ model?, setInput?, setOutput? }` |
| `nexus.preset` | Apply a preset config, or drop the session override | `{ mode?: 'apply' \| 'clear', name? }` — `clear` (2.6.0+) drops the in-process preset/TUI override so `nexus.jsonc` is in control again; no file is modified |
| `nexus.template` | List or instantiate a task template | `{ name?, baseDir? }` — `name: 'list'` (or omitted) lists; `baseDir` resolves the template's file paths, defaulting to cwd |
| `nexus.roles.list` | List custom agent roles from `nexus.jsonc` | `{}` |
| `nexus.roles.add` | Register a custom role **for this session only** | `{ name, displayName, prompt, emoji?, model? }` — a config reload replaces the registry from the file, so a role added this way and not written to `nexus.jsonc` stops resolving on the next reload |
| `nexus.config.save` | Save config to disk | `{ level: 'project' \| 'global' }` |
| `nexus.config.init` | Initialize config files | `{ level }` |
| `nexus.dashboard.start` | Start the web dashboard server (port must be free) | `{ port?, host? }` |
| `nexus.dashboard.stop` | Stop the web dashboard server | `{}` |
| `nexus.todo.add` | Add a todo item | `{ description, assignedTo? }` |
| `nexus.todo.list` | List all todos | `{}` |
| `nexus.todo.complete` | Complete a todo | `{ id }` |
| `nexus.todo.stats` | Todo statistics | `{}` |
| `nexus.goal.set` | Set a goal | `{ description, autoContinue? }` |
| `nexus.goal.status` | Current goal status | `{}` |
| `nexus.goal.complete` | Complete goal | `{}` |
| `nexus.goal.list` | List all goals | `{}` |
| `nexus.team.create` | Create a team | `{ name, leadRole }` |
| `nexus.team.addMember` | Add team member | `{ teamId, role, model }` |
| `nexus.team.status` | Team status | `{ teamId? }` |
| `nexus.team.activate` | Start team | `{ teamId }` |
| `nexus.performance.scores` | Performance scores | `{}` |
| `nexus.performance.best` | Best model for role | `{ role }` |
| `nexus.history.list` | Execution history | `{ count? }` |
| `nexus.history.stats` | Execution statistics | `{}` |
| `nexus.memory.set` | Write a durable note. The only way in — nothing is ever written automatically, and nothing is injected into a task's prompt unless the key is `file:<path>`. **Appends**, so a correction is a new version rather than a replacement | `{ key, value, author, scope?: 'project' \| 'temp', confidence?, tags?, ttl? }` — `scope` defaults to `project`; `session` and `learning` are not writable. Omit `confidence` if you are unsure: an entry with no confidence is not a low-confidence entry |
| `nexus.memory.search` | Substring search over keys **and** values. Unranked, so a result count is hits, not relevance, and nothing is verified against the code. Project scope only by default | `{ query, includeSession? }` — `includeSession: true` also returns internal escalation context, labelled as such and never injected into a task |
| `nexus.memory.list` | List notes in a scope, newest version of each key first, with entry counts by scope and anything evicted for exceeding a per-scope cap | `{ scope?: 'project' \| 'session' \| 'temp', limit? }` — `limit` defaults to 50 |
| `nexus.astgrep.search` | Search AST patterns | `{ pattern, language, directory }` |
| `nexus.astgrep.status` | Check ast-grep install | `{}` |
| `nexus.security.scan` | Scan for security issues | `{ content, filename? }` |
| `nexus.clarify` | Format a clarifying question and return it to the model (it does not query the user) | `{ question, options?, assumption? }` |
| `nexus.git.check` | Report the git convention for this repository: branch, conventional commit subjects, uncommitted work, whether the branch is published. Read-only — runs no `git commit`/`push`/`merge` and never refuses. Asks once per repository, and `decision` records the answer | `{ decision?: 'on' \| 'off', cwd? }` — omit `decision` to just report; `cwd` defaults to the working directory |
| `nexus.worktree.enable` | Enable worktree isolation | `{ repoRoot? }` |
| `nexus.worktree.list` | List worktrees | `{}` |
| `nexus.worktree.disable` | Disable worktrees | `{}` |

---

## TUI Commands

The TUI plugin registers exactly these slash commands. With no argument,
`/nexus` opens the full configuration dialog; with one, it dispatches to a
subcommand (`config`/`c`, `status`/`s`, `dashboard`/`d`, `web`/`w`,
`overview`, `model`/`m`, `reset`).

| Command | Alias | Description |
|---------|-------|-------------|
| `/nexus` | `Ctrl+N` | Full configuration dialog, or a subcommand |
| `/nexus-dashboard` | `/nd` | Start the web dashboard and open it. If one is already serving, opens that and starts nothing — see [Web Dashboard](#web-dashboard) |
| `/nexus-web` | `/nw` | Alias of `/nexus-dashboard` |
| `/nexus-overview` | `/no` | Config, budget and dashboard-status overview. Prints text; starts nothing |
| `/nexus-config` | `/nc` | Configure models & budget |
| `/nexus-model` | `/nm` | Select a model for a role |
| `/nexus-status` | `/ns` | Show the config summary |
| `/nexus-reset` | — | Reset all settings to defaults |

A prompt beginning `/nexus …` typed into the composer is a *different* thing: it
is intercepted by a prompt hook and routed to `orchestrator.handleCommand()`,
which understands `status`, `agents`, `costs`, `pause`, `resume`, and
`dashboard [port] [host]` (which starts the server, or says why it did not),
`dashboard stop`, and `dashboard state` (the state as JSON). Anything else
answers `Unknown command`. This hook cannot cancel the prompt — the plugin API
gives it no way to — so it replaces the command text with the command's result
rather than leaving the model holding a bare `/nexus dashboard` next to an
answer it has no reason to read. The table above is the TUI palette.

---

## Configuration

### Agent Models

Press **Ctrl+N** or type `/nexus` to pick a model per role, then choose project
or global. That writes the `models` block of `nexus.jsonc`; the example in
[Cost-Aware Model Selection](#cost-aware-model-selection) shows its shape.

The model list is grouped under a heading per provider — `OpenCode Go`,
`Claude` — so a multi-provider install reads as sections rather than one flat
run of models. The heading is the provider's display name, and a provider
OpenCode has not published a name for falls back to its raw id. Searching
matches the heading as well as the model name, so typing a provider name
narrows the list to that provider's models.

> That search behaviour is a property of OpenCode's own model-picker dialog, not
> of Nexus, and it is not published in the plugin's type declarations. It was
> verified against the installed CLI's dialog code, where the fuzzy finder is
> invoked with `keys: ["title", "category", "searchText"]` and a score of
> `title×2 + category + searchText` — so the heading genuinely is a search key.
> Treat it as a snapshot of the installed version rather than a stable contract;
> if a future OpenCode drops `category` from those keys, this paragraph is the
> claim that becomes false. The evidence is quoted in full at the
> `buildModelOptions` docstring in `src/tui.tsx`.

Each row shows its input and output price in USD per 1K tokens, in the same
format `nexus.model.costs` prints. A model that only publishes tiered pricing
shows its lowest published tier and names the prompt size above which a
different rate applies, rather than rendering blank or as free. A model that
published no price at all shows no price, which is deliberately not `$0`: no
published price is not the same as a price of zero.

**Use default** resets the role to its default model. It carries an empty
value, and that empty string is what performs the reset — it is not a model
reference.

The resolved map is read at spawn time, so an edit to `nexus.jsonc` applies to
the next spawn without a restart.

### Web Dashboard

`.opencode/nexus.jsonc` (project) and `~/.config/opencode/nexus.jsonc` (global)
both accept:

```jsonc
{
  "dashboard": {
    "enabled": true,   // false makes every start attempt refuse, and say so
    "port": 4747,      // default port; startDashboard({port}) still wins
    "host": "127.0.0.1"
  }
}
```

The server has no authentication, which is why `host` defaults to loopback.
Leave it there unless you have put your own authentication in front of it.

### Notifications

```jsonc
{
  "notifications": {
    "enabled": true
  }
}
```

`enabled` (default `true`) is the whole block, and it is read once at orchestrator
construction — changing it takes effect on the next reload or restart, not on the
next event.

One switch governs every notification site: task-complete, task-failed and the
budget alert/limit notifications alike. There is no per-site or per-level
setting; `false` silences all of them and each suppressed send is counted rather
than attempted.

`nexus.status` reports the outcome as a `notifications` object — `sent`,
`failed`, `suppressed`, `lastError`, `lastErrorAt`, `enabled`, `platform` — in
both the detailed and the summary branch. `nexus.notifications.test` sends one
probe and reports whether the OS notifier accepted it and, if not, why; the
probe is deliberately not counted in `sent`/`failed`.

### Git Flow

On by default, and **validating rather than blocking**: it tells agents what
convention to follow and reports where you stand, but nothing in Nexus ever runs
`git commit`, `git push` or `git merge` on your behalf.

`.opencode/nexus.jsonc` (project) and `~/.config/opencode/nexus.jsonc` (global)
both accept:

```jsonc
{
  "gitFlow": {
    "enabled": true,              // master switch; removes the convention entirely
    "conventionalCommits": true,  // hold commit subjects to the Conventional Commits form
    "requireBranch": true,        // tell agents to work on a branch, not the default one
    "prBeforeMerge": true         // tell agents to open a PR rather than merge
  }
}
```

All four default to `true`. The block is merged **field by field** across the
storage (TUI) > project > global > constructor levels, so a level that sets only
`enabled` does not blank out the three toggles resolved beneath it.

Every key is read. `requireBranch`, `conventionalCommits` and `prBeforeMerge`
each control one clause of the generated agent markdown — switch one off and
that clause is not emitted. `enabled` is the master switch and the one place the
convention is decided; an off answer recorded for a specific repository
(see below) still wins over `enabled: true`, because the more specific statement
does.

**Where the convention lands.** The six generated subagent files in
`~/.config/opencode/agents` (`nexus-architect`, `-coder`, `-explorer`, `-tester`,
`-reviewer`, `-documenter`) are rewritten on every plugin load, so a hand-edit
there does not survive a restart. That is what makes them the durable place for
a convention, and each of the six gains a `## Git Convention` section when the
convention is active *and* the working directory is a git work tree on a branch.
Outside a repository, or on a detached HEAD, the files are written exactly as
before and the section is absent — the condition is deliberate, because
unconditionally telling an agent to work on a branch in a directory that has no
branches is worse than saying nothing.

`nexus-orchestrator.md`, the primary agent, is written separately and does not
carry the section: the convention is directed at the subagents that write code,
and the primary agent's job is to delegate to them.

The cost of that choice, stated plainly: those files are global and shared by
every project you run Nexus in, so this is not project-scoped guidance, and two
projects open at once will overwrite each other's copy.

**Asking once per repository.** Nexus cannot prompt a subagent — a subagent is
driven by tool calls and has no other channel to you — so the ask travels out
through the tool result: `nexus.git.check` tells the agent to ask you, and the
agent relays it in its own next message. The answer is recorded by calling the
same tool with `decision: "on"` or `decision: "off"`, and is stored globally in
`~/.config/opencode/nexus-gitflow.json`, keyed by repository. It is deliberately
not written into your repository (no untracked file for you to gitignore) and not
into `nexus.jsonc` (a per-repository map is not something one project file can
describe). Two worktrees of the same repository share one answer.

If you never answer, the convention stays **on**. The reasoning: the cost of
guessing wrong is a report that says `conventional: false` about three commits,
which a reader ignores, while defaulting off would leave the feature inert for
every user who does not answer.

**What `nexus.git.check` checks, and what it does not.** It reports:

- whether HEAD is on a feature branch, and which;
- whether the commit subjects on **this branch since it diverged from its base**
  are conventional — the same set a pull request would contain, not the whole
  history, and capped at the 50 most recent commits with the cap stated in the
  report when it bites;
- whether the branch is published to a remote, and whether you have uncommitted
  work;
- which ref it used as the base, because the base decides the verdict.

It does **not** determine whether a pull request is *open* — that is not knowable
from a local checkout without querying the forge, so the report says so rather
than inferring it from the presence of a remote. It runs no git write, refuses
nothing, and says both in its own output.

### Config Diagnostics

`nexus.status` carries a `config` object that answers "why did my spawn use an
unexpected model":

| Field | Meaning |
|---|---|
| `sessionOverride` | An in-process preset or TUI override is active, so `models` describes memory rather than disk |
| `diskModelsIgnored` | The same fact, named for the diagnosis: the file's `models` block is being shadowed right now. Clear it with `nexus.preset(mode="clear")` |
| `trigger` | `initial`, `event` (a `filesystem.changed`) or `poll`. `poll` on every reload means the host is not delivering events for these files |
| `loadCount`, `loadedAt` | How many times config has been loaded, and when |
| `project`, `global` | The two paths consulted, and which existed |

### Custom Roles

Define your own agent roles:

```jsonc
{
  "customRoles": [
    {
      "name": "security-auditor",
      "displayName": "Security Auditor",
      "emoji": "🔐",
      "prompt": "You are a security auditor...",
      "model": "anthropic/claude-sonnet-4-6"
    }
  ]
}
```

### Task Templates

```
nexus.template(name="list")      — Show available templates
nexus.template(name="feature")   — Full feature pipeline
nexus.template(name="bugfix")    — Bug investigation and fix
nexus.template(name="refactor")  — Code refactoring pipeline
nexus.template(name="documentation") — Documentation update
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      NEXUS PLUGIN                            │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │              SERVER PLUGIN (index.ts)                │     │
│  │  • 40+ tool registrations                            │     │
│  │  • Auto-creates agent files; opts OpenCode into LSP  │     │
│  │  • Config file loading and creation                 │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │            ORCHESTRATOR (orchestrator.ts)            │     │
│  │  • Real OpenCode session creation                    │     │
│  │  • DAG execution with priority queuing               │     │
│  │  • Cost-aware model routing (scored selection)       │     │
│  │  • Self-healing with 4-step escalation               │     │
│  │  • Context transfer to respawned agents              │     │
│  │  • Deadlock detection (cycle finding)                │     │
│  │  • Todo/Goal tracking                                │     │
│  │  • Team management                                   │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │                    MODULES                          │     │
│  │  Health Monitor │ Learning │ Message Store (JSONL)  │     │
│  │  Persistent Mem │ Fan-Out  │ Notifications (OS)     │     │
│  │  State Broadcaster │ Module Registry │ Security     │     │
│  │  Cost Forecaster │ Performance Tracker │ AST-Grep   │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │              WEB DASHBOARD                          │     │
│  │  • Bun.serve() HTTP + WebSocket (port 4747)         │     │
│  │  • DAG viz, cost chart, read-only config, sessions  │     │
│  │  • Started on request; throttled push + poll        │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │              AGENTS (auto-created)                   │     │
│  │  nexus-orchestrator (primary)                       │     │
│  │  nexus-architect, nexus-coder, nexus-reviewer        │     │
│  │  nexus-tester, nexus-explorer, nexus-documenter      │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## Development

```bash
# Clone the repo
git clone https://github.com/serkanalgur/opencode-nexus.git
cd opencode-nexus

# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Type check
bun run typecheck
```

---

## Release Notes

### Unreleased — memory retrieval

**Added**

- `nexus.memory.set` / `search` / `list`. Memory was reachable only through
  `orchestrator.memoryStore`; it now has a tool surface.
- **Automatic retrieval at spawn.** A task whose declared file scope (or whose
  prose names a path) matches a note keyed `file:<path>` gets that note in its
  prompt, marked as recollection, with an author, a relative age, and the value
  quoted. Capped at 5 notes / 800 characters. See
  [Persistent Memory](#persistent-memory) for the key convention and the five
  things this feature will not tell you.
- Enforced per-scope entry caps, with `project` **exempt**, and eviction
  reported by `memory.list`, by `console.warn`, and in the `memory.set` result
  that caused it.
- `getByKey` is now ordered (`timestamp`, then a monotonic id), so "the newest
  version of a key" is a contract rather than an accident of rowid order. Two
  writes in the same millisecond previously had their winner chosen by
  `Math.random()`.

**Changed / removed**

- **BREAKING: the `NexusConfig.memory` block is gone** (`enabled`, `storage`,
  `maxEntriesPerScope`, `syncInterval`). Nothing read any of it — `enabled` was
  never a gate on anything. Delete it from your config; it was already inert.
- `MemoryStoreConfig.defaultTTL` is gone, also unread. With no automatic
  writing, an expiry would delete a note permanently, so "nothing expires" is
  the honest default and a knob offering otherwise was a lie.
- `MemoryEntry.confidence` is now `number | null`. It was `REAL DEFAULT 1.0` and
  `setMemory` hardcoded `1.0`, so every entry carried a confidence nobody had
  expressed.
- `PersistentMemoryStore.search(query, scope?)` takes an optional scope. It had
  none, so a search tool would have returned another agent's escalation blob
  rendered as a note. `memory.search` is `project`-only by default, with
  `includeSession` as a labelled opt-in.
- Added `PersistentMemoryStore.path`, `takeEviction()`, `getEvictionTotals()`, and
  the exported `isNewerThan()`.

**Known gap, stated rather than discovered**

- **There is no in-product way to remove a wrong note.** `memory.delete` is
  API-only by design — an agent that finds a note inconvenient will delete it to
  unblock itself, and there is no confirmation step an agent honours. Correcting
  a note means writing a new version, which supersedes the old one and keeps it
  readable. **This is the first thing to build if the feature gets used enough
  for it to matter.**

**Not done, and why**

- Eviction is not an orchestrator event. `test/broadcast-event-coverage.test.ts`
  requires every emitted event to be in `BROADCAST_EVENTS`, which would then
  require a `case` in `dashboard/index.html`. That file was out of scope for this
  change, so eviction is reported through a `console.warn`, a counter, and the
  tool result instead. The follow-up is three lines.

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">

**Built with ❤️ by [Serkan Algur](https://github.com/serkanalgur)**

[![GitHub](https://img.shields.io/badge/GitHub-serkanalgur-181717?style=flat-square&logo=github)](https://github.com/serkanalgur)
[![npm](https://img.shields.io/badge/npm-@serkanalgur-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/@serkanalgur/opencode-nexus)

</div>
