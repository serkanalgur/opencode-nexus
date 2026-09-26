# OpenCode Nexus API Reference

This document describes the public API for the `@serkanalgur/opencode-nexus` package.

---

## Classes

### NexusOrchestrator

Main orchestrator class for managing agents and tasks.

#### Constructor

```typescript
new NexusOrchestrator(config?: Partial<NexusConfig>)
```

Creates a new orchestrator instance. If no config is provided, defaults from the `ConfigManager` are used.

#### Methods

##### initialize(ctx: PluginContext)

```typescript
initialize(ctx: PluginContext): Promise<void>
```

Initialize the orchestrator with an OpenCode plugin context. This loads persisted configuration, starts the health monitor and notification manager, sets up the registered plugin modules, and wires the `StateBroadcaster`.

The broadcaster is wired here because it is the transport the dashboard's sockets register on, and because `initBroadcaster()` otherwise had no caller — every `notifyStateChange()` was a no-op in production. The **dashboard server is NOT started here.** `startDashboard()` is the only thing that binds a port, and nothing in the plugin calls it implicitly.

##### spawnAgent(config: SpawnConfig): Promise\<Agent\>

```typescript
spawnAgent(config: SpawnConfig): Promise<Agent>
```

Spawn a real agent session via the OpenCode plugin context.

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.role` | `string` | Agent role: `architect`, `coder`, `reviewer`, `tester`, `explorer`, or `documenter` |
| `config.model` | `string?` | Optional model override. When omitted the best model is selected automatically based on task complexity and budget. |

##### execute(request: ExecutionRequest): Promise\<ExecutionResult\>

```typescript
execute(request: ExecutionRequest): Promise<ExecutionResult>
```

Execute a set of tasks in dependency (DAG) order. Tasks with no unmet dependencies are executed in parallel up to the configured concurrency limit.

##### selectBestModel(role: string, complexity: ComplexityScore): ModelSelection

```typescript
selectBestModel(role: string, complexity: ComplexityScore): ModelSelection
```

Select the optimal model for a given role and complexity score. Takes budget constraints into account.

##### analyzeComplexity(task: Task): ComplexityScore

```typescript
analyzeComplexity(task: Task): ComplexityScore
```

Analyze and return a complexity score (0–100) for a task. The score considers file count, description length, and dependency depth.

##### trackCost(agentId: string, model: string, cost: number, tokens: number): void

```typescript
trackCost(agentId: string, model: string, cost: number, tokens: number): void
```

Record cost and token usage for an agent. Throws if the budget would be exceeded.

##### publish(topic: string, message: AgentMessage): void

```typescript
publish(topic: string, message: AgentMessage): void
```

Publish a message to a named topic via the internal `MessageRouter`.

##### subscribe(topic: string, handler: Function): () => void

```typescript
subscribe(topic: string, handler: (msg: AgentMessage) => void): () => void
```

Subscribe to a topic. Returns an unsubscribe function.

##### setMemory(scope: string, key: string, value: string, author: string): void

```typescript
setMemory(scope: string, key: string, value: string, author: string): void
```

Store a memory entry. Scope is typically an agent ID or the string `"global"`.

##### getMemory(key: string, scope?: string): MemoryEntry | null

```typescript
getMemory(key: string, scope?: string): MemoryEntry | null
```

Retrieve a memory entry by key, optionally filtered by scope.

---

### ConfigManager

Configuration management with file I/O. Accessed via `orchestrator.configManager`.

#### The config file schema

`.opencode/nexus.jsonc` (project) and `~/.config/opencode/nexus.jsonc` (global)
are JSONC — comments allowed. Precedence is **storage (session override) >
project > global > defaults**, and the whole set is re-read on reload, so
editing any level takes effect without a restart.

```jsonc
{
  "models": { "architect": "provider/model", "coder": "provider/model", /* ... */ },
  "budget": { "maxTotalCost": 10, "maxCostPerTask": 1, "maxCostPerAgent": 2, "alertThreshold": 0.2 },
  "selfHealing": { "enabled": true, "maxRetries": 3, "contextTransfer": true },
  "dashboard": { "enabled": true, "port": 4747, "host": "127.0.0.1" }
}
```

`dashboard.enabled` is **honoured**: `NexusOrchestrator.startDashboard()` refuses
to start and names the key when it is `false`, and the TUI's `/nexus web` command
reports the same reason instead of probing a port that is switched off. The
other `dashboard` fields are the defaults for `startDashboard()`; explicit
arguments to that method still win.

`saveProjectConfig` and `saveGlobalConfig` write `models`, `budget`,
`selfHealing` and `dashboard` — all four, unconditionally. They overwrite the
whole file, so a block left out of that list would be a block *deleted* from the
user's config on the first save.

Blocks on the `NexusConfig` type that are **not** in this schema — `memory`,
`security`, `learning`, `communication`, `cost` — are settable through the
`NexusOrchestrator` constructor only, and are documented that way rather than
as user-configurable, because they are not.

#### getConfig(): NexusFullConfig

```typescript
getConfig(): NexusFullConfig
```

The resolved configuration, after all four precedence levels.

#### getModelForRole(role: string): string

```typescript
getModelForRole(role: string): string
```

Return the model identifier assigned to the given role.

#### saveProjectConfig(basePath: string): void

```typescript
saveProjectConfig(basePath: string): void
```

Persist the current configuration to `<basePath>/.opencode/nexus.jsonc`. Writes
`models`, `budget`, `selfHealing` and `dashboard` — see the schema above.

#### saveGlobalConfig(): void

```typescript
saveGlobalConfig(): void
```

Persist the current configuration to `~/.config/opencode/nexus.jsonc`. Same four
blocks.

#### applyPreset(name: string): void

```typescript
applyPreset(name: string): void
```

Apply a named preset. Available presets: `minimal`, `balanced`, `enterprise`, `cost-optimized`.

---

### DashboardModule

Web dashboard server providing real-time monitoring via HTTP and WebSocket.

Reached through `NexusOrchestrator.startDashboard()` / `stopDashboard()`, which
are the only callers. **The server is never started implicitly** — not by
`initialize()`, not by a module, not by a config value. Nothing in this package
listens on a port until `startDashboard()` is called.

#### start(port: number, host: string): void

```typescript
start(port: number, host: string): void
```

Start the HTTP + WebSocket server on the given port and host.

Throws if the port cannot be bound (it is in use, or the process lacks
permission). `NexusOrchestrator.startDashboard()` resolves `port` and `host`
from the `dashboard` block of the resolved config when they are not passed, and
**refuses to start at all when `dashboard.enabled` is `false`**, naming the
config key in the error.

#### stop(): void

```typescript
stop(): void
```

Stop the server and close all connections. A no-op when nothing is running.

#### isRunning(): boolean

```typescript
isRunning(): boolean
```

Whether this module currently holds a bound server. `true` immediately after a
successful `start()`, `false` after `stop()` and after a failed `start()`.

#### getClientCount(): number

```typescript
getClientCount(): number
```

Number of connected WebSocket clients. Owned by the `StateBroadcaster`, not by
this module — `DashboardModule` registers sockets on the broadcaster in its
`websocket.open` handler so that there is exactly one client set and one message
sequence.

#### There is no `broadcast()`

It was removed. It was a pass-through to `StateBroadcaster.broadcast()`, and
`DashboardModule.start()` also used to hand-wire four events to it — which made
every one of those events reach each client **twice**. Event delivery has
exactly one owner now, the broadcaster, which subscribes to all thirteen events
itself.

#### HTTP routes

All responses carry `Access-Control-Allow-Origin: *`. `OPTIONS` on any path
returns the CORS preflight response with no body.

| Route | Method | Response |
|-------|--------|----------|
| `/api/state` | GET | `OrchestratorState` — the object below, verbatim |
| `/api/config` | GET | `NexusConfigManager.exportConfig()`: the resolved config file, i.e. `models`, `budget`, `selfHealing` and `dashboard`. This is the CONFIG FILE's resolved form; `state.config` below is the orchestrator's view, which can differ while a run is in progress |
| `/api/agents` | GET | The `agents` array of `OrchestratorState` |
| `/api/costs` | GET | The object form of `getCostReport()` (that method returns a JSON *string*; it is parsed before serialising, so callers get an object, not a double-encoded one) |
| `/api/health` | GET | `{ ok: true, uptime: number }` — `uptime` is `process.uptime()` of the dashboard's own process. This is also the probe the TUI's `/nexus web` uses to tell a dashboard from any other process on the port |
| `/ws/events` | GET (upgrade) | WebSocket upgrade; see below |
| anything else | GET | The dashboard single-page app (the inlined `dashboard/index.html`) |

An unmatched `/api/*` path is a **404 with a JSON body**, not the SPA. An
`/api/*` handler that throws is a **500** with `{ error, detail }`. This is
deliberate: a 200 of HTML for a missing endpoint means no client can fail loudly
about a route that is not there, which is how the page's `state.config?.budget`
and `a.sessionId` drifted from the server without anything noticing.

#### `OrchestratorState` (the `/api/state` and `orchestrator:state` shape)

```typescript
{
  running: boolean
  paused: boolean
  agents: Array<{
    id, name, role, status, model,          // strings; `model` is "providerID/modelID"
    sessionID?: string,                      // `sessionID`, not `sessionId`
    spawnedAt: string,                       // ISO
    tasksCompleted, tasksFailed, totalTokens: number
    averageResponseTime: number,             // ms
    errorRate: number,                       // 0-1
    totalCost: number
  }>
  tasks: Array<{
    id, name, role, priority, status: string
    dependencies: string[]                   // DAG edge ids; [] means "no edges", never null
    assignedAgent?: string
    cost?: number
    tokensUsed?: number
    result?: { success: boolean, output?: string, error?: string, duration: number }
  }>
  config: {
    models: Record<string, string>           // resolved role -> "providerID/modelID"
    budget: BudgetConstraint                 // the budget IN FORCE, which execute() can replace
    selfHealing: { enabled, maxRetries, contextTransfer }
  }
  sessions: SessionStateView[]               // see below
  totalSpent: number
  budgetRemaining: number
  lastUpdated: string                        // ISO
}
```

There are no aliases for these key names. `budget.maxTotalCost` is not
`maxBudget`; `budget.hardLimit` is not `autoTerminate` and has the opposite
sense (it means "stop at the ceiling"); `selfHealing.enabled` is not
`retryOnFailure`. There is no `criticalThreshold`, `escalation` or
`deadlockDetection` key, because no such configuration exists.

`SessionStateView` is one row per session — `{ id, owned, agentId, taskId, role,
model, state, spawnedAt, lastKnownTokens, observedUncollected }` — unioned from
the three collections nexus holds: owned agents, pending timeout cost
collection, and abandoned spend. It is **not** an enumeration of every open
session on the server, and it is **not** built by walking `parentID` (a
`ctx.session.create()` child is not parent-linked). `agentId: null` with
`owned: false` marks an **orphan**: a session still running after its agent was
terminated, which keeps spending with nothing collecting it. `state` is one of
`running`, `idle`, `abandoned`, `settled`, and is inferred from nexus's own
bookkeeping rather than observed from the server.

#### WebSocket protocol

Connect to `ws://<host>:<port>/ws/events`. **Server → client**, every frame is
`{ type, data, timestamp }`:

| `type` | When | `data` |
|--------|------|--------|
| `orchestrator:state` | Once on connect, then on every state change, throttled to at most one frame per second | `OrchestratorState` |
| `agent:spawned` | An agent is spawned | event payload |
| `agent:terminated` | An agent is terminated | event payload |
| `agent:escalation` | The escalation chain fires | event payload |
| `task:failed` | A task fails | event payload |
| `cost:delta` | A cost delta is settled | event payload |
| `security:issues-found` | The security module reports issues | event payload |
| `memory:set` | A memory entry is written | event payload |
| `budget:alert` | Spend crosses `alertThreshold` | event payload |
| `budget:exceeded` | Spend crosses a budget ceiling | event payload |
| `config:reloaded` | A config file changed and was re-read | event payload |
| `orchestrator:paused` | `pause()` | event payload |
| `orchestrator:resumed` | `resume()` | event payload |
| `orchestrator:shutdown` | `shutdown()` | event payload |
| `pong` | In reply to `ping` | absent |

The thirteen event names are `BROADCAST_EVENTS` in `src/broadcast.ts`, and
`test/broadcast-event-coverage.test.ts` ties that list to the `this.emit(...)`
sites in `orchestrator.ts` in both directions — statically and by asserting each
one really reaches a connected client. That test exists because the list used to
be four names long while the orchestrator emitted thirteen, so nine events
reached no client and nothing complained.

**Client → server**, JSON text. Exactly two messages are understood; anything
else is ignored:

| `type` | Reply |
|--------|-------|
| `getState` | one immediate `orchestrator:state` frame — the explicit ask that no throttled push can serve |
| `ping` | one `pong` frame |

**There is no write path.** In particular there is no `config:update`: the
dashboard's config panel once posted one, the button reported success, and
nothing happened. There is no authentication and the server answers with
`CORS: *`, so no write path was added to replace it. Change `nexus.jsonc` and
let the config watcher reload it.

---

### HealthMonitor

Periodic agent health monitoring.

#### start(getAgents: Function): void

```typescript
start(getAgents: () => Agent[]): void
```

Start periodic health checks. `getAgents` is called on each interval to obtain the current agent list.

#### stop(): void

```typescript
stop(): void
```

Stop monitoring and clear the interval.

#### getHealth(agentId: string): HealthCheck | null

```typescript
getHealth(agentId: string): HealthCheck | null
```

Return the most recent health check for the given agent, or `null` if none exists.

#### getUnhealthyAgents(): string[]

```typescript
getUnhealthyAgents(): string[]
```

Return the IDs of all agents whose most recent health check indicates an unhealthy state.

---

### LearningModule

Pattern recognition engine that learns from failures and successful recoveries.

#### recordFailure(pattern: string, solution: string, context: string, tags: string[]): LearningEntry

```typescript
recordFailure(pattern: string, solution: string, context: string, tags: string[]): LearningEntry
```

Record a failure pattern and its solution. Returns the created `LearningEntry`.

#### recordSuccess(entryId: string): void

```typescript
recordSuccess(entryId: string): void
```

Mark a previously recorded entry as successfully applied, increasing its confidence score.

#### findSolutions(errorPattern: string): PatternMatch[]

```typescript
findSolutions(errorPattern: string): PatternMatch[]
```

Search for solutions matching the given error pattern. Results are ordered by confidence.

#### getReliable(): LearningEntry[]

```typescript
getReliable(): LearningEntry[]
```

Return all entries with a confidence score above the reliability threshold.

---

### ModuleRegistry

Composable module management for extending orchestrator functionality.

#### register(module: NexusModule): void

```typescript
register(module: NexusModule): void
```

Register a module. Modules are initialized in registration order during `setupAll`.

#### setupAll(ctx: ModuleContext): Promise\<void\>

```typescript
setupAll(ctx: ModuleContext): Promise<void>
```

Initialize all registered modules by calling their `setup` method with the shared context.

#### teardownAll(): Promise\<void\>

```typescript
teardownAll(): Promise<void>
```

Tear down all registered modules by calling their `teardown` method in reverse order.

---

### SecurityScanner

Scans code content for common security vulnerabilities.

#### scanContent(content: string, filename: string): SecurityIssue[]

```typescript
scanContent(content: string, filename: string): SecurityIssue[]
```

Scan the given source code string for security issues. Returns an array of `SecurityIssue` objects.

#### getResult(): SecurityScanResult

```typescript
getResult(): SecurityScanResult
```

Return the aggregated scan result including a numeric score and all issues found across previous `scanContent` calls.

---

### MessageRouter

Topic-based fan-out message routing.

#### subscribe(id: string, topic: string, handler: Function): void

```typescript
subscribe(id: string, topic: string, handler: (msg: AgentMessage) => void): void
```

Subscribe to a topic. Use `'*'` as the topic to receive all messages.

#### route(message: AgentMessage): string[]

```typescript
route(message: AgentMessage): string[]
```

Route a message to all matching subscribers. Returns the list of subscriber IDs that received the message.

---

### PersistentMemoryStore

SQLite-backed persistent key–value memory store.

#### set(entry): MemoryEntry

```typescript
set(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry
```

Store a memory entry. Returns the entry with an assigned `id` and `timestamp`.

#### get(key: string, scope?: string): MemoryEntry | null

```typescript
get(key: string, scope?: string): MemoryEntry | null
```

Retrieve a memory entry by key, optionally filtered by scope.

#### search(query: string): MemoryEntry[]

```typescript
search(query: string): MemoryEntry[]
```

Full-text search across keys and values.

---

### NotificationManager

Cross-platform OS notification support.

#### notify(options: NotificationOptions): Promise\<boolean\>

```typescript
notify(options: NotificationOptions): Promise<boolean>
```

Send an OS-level notification. Returns `true` if the notification was shown successfully.
