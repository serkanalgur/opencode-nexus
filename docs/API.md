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

Initialize the orchestrator with an OpenCode plugin context. This sets up internal systems (dashboard, health monitor, learning module) and loads persisted configuration.

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

#### getModelForRole(role: string): string

```typescript
getModelForRole(role: string): string
```

Return the model identifier assigned to the given role.

#### saveProjectConfig(basePath: string): void

```typescript
saveProjectConfig(basePath: string): void
```

Persist the current configuration to `<basePath>/.opencode/nexus.jsonc`.

#### saveGlobalConfig(): void

```typescript
saveGlobalConfig(): void
```

Persist the current configuration to `~/.config/opencode/nexus.jsonc`.

#### applyPreset(name: string): void

```typescript
applyPreset(name: string): void
```

Apply a named preset. Available presets: `minimal`, `balanced`, `enterprise`, `cost-optimized`.

---

### DashboardModule

Web dashboard server providing real-time monitoring via HTTP and WebSocket.

#### start(port: number, host: string): void

```typescript
start(port: number, host: string): void
```

Start the HTTP + WebSocket server on the given port and host.

#### stop(): void

```typescript
stop(): void
```

Stop the server and close all connections.

#### broadcast(event: string, data: unknown): void

```typescript
broadcast(event: string, data: unknown): void
```

Broadcast an event to all connected WebSocket clients.

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
