# OpenCode Nexus - Technical Design Document

> **Adaptive Multi-Agent Orchestration with Cost Intelligence**

**Version:** 1.0.0  
**Author:** Serkan Algur  
**Package:** `@serkanalgur/opencode-nexus`  
**License:** MIT

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Architecture Overview](#architecture-overview)
4. [Core Concepts](#core-concepts)
5. [Plugin Architecture](#plugin-architecture)
6. [Module Specifications](#module-specifications)
7. [Data Models](#data-models)
8. [API Reference](#api-reference)
9. [Configuration](#configuration)
10. [Security Considerations](#security)

---

## 1. Executive Summary

OpenCode Nexus is a next-generation agent orchestration plugin for OpenCode V2 that introduces **adaptive multi-agent execution** with **cost-aware routing**, **real pub/sub communication**, **self-healing capabilities**, and **shared memory** between agents.

### Key Differentiators

| Feature | Existing Solutions | Nexus |
|---------|-------------------|-------|
| Parallel Execution | File-disjoint only | **Dynamic DAG with true parallelism** |
| Agent Communication | None or basic messaging | **Real pub/sub with topic routing** |
| Agent Spawning | Fixed agent count | **Adaptive based on task complexity** |
| Cost Management | None | **Real-time cost tracking + budget enforcement** |
| Self-Healing | Basic timeout/retry | **Context transfer + auto-respawn** |
| Memory Sharing | Agent-isolated | **Cross-agent shared memory store** |
| Learning | Evidence-based | **Pattern learning from failures** |
| Plugin System | Monolithic | **Composable modules with hot-reload** |

### Target Users

- Solo developers using OpenCode for complex projects
- Small teams needing parallel AI coding assistance
- Cost-conscious users who want to optimize token spending
- Projects requiring high reliability (self-healing)

---

## 2. Problem Statement

### Current Limitations in Agent Orchestration

1. **Sequential Bottleneck**: Most orchestration plugins run agents sequentially (coder → reviewer → test), wasting time on independent tasks.

2. **No True Parallelism**: "Parallel" execution is limited to file-disjoint tasks. Real-world coding often involves shared files.

3. **Agent Communication Gap**: Agents can't share discoveries, decisions, or context in real-time. Each agent operates in isolation.

4. **Cost Blindness**: No orchestration plugin considers token costs when selecting models or routing tasks. Users overspend on simple tasks.

5. **No Self-Healing**: When an agent crashes or times out, the entire pipeline stops. Manual intervention is required.

6. **Fixed Agent Architecture**: Agent roles and counts are predetermined. No dynamic adaptation based on task complexity.

7. **Memory Isolation**: Agents can't share learned patterns, decisions, or context across sessions.

### User Pain Points

```
"I have 3 independent tasks but the orchestrator runs them one by one"
"I want my coder agent to talk to my reviewer agent directly"
"I'm spending $50/session but could spend $10 with smart routing"
"My agent crashed mid-task and I lost all progress"
"I keep making the same mistakes because agents don't learn"
```

---

## 3. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        NEXUS ORCHESTRATOR                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    DAG       │  │   Cost       │  │   Adaptive   │          │
│  │  Executor    │  │  Router      │  │  Spawner     │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                    │
│  ┌──────┴─────────────────┴─────────────────┴───────┐          │
│  │              AGENT LIFECYCLE MANAGER              │          │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │          │
│  │  │ Spawn   │  │ Monitor │  │ Respawn │          │          │
│  │  └─────────┘  └─────────┘  └─────────┘          │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │           COMMUNICATION LAYER (Pub/Sub)           │          │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │          │
│  │  │ Topics  │  │ Direct  │  │ Fan-out │          │          │
│  │  └─────────┘  └─────────┘  └─────────┘          │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              SHARED MEMORY STORE                  │          │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │          │
│  │  │ Project │  │ Session │  │ Learning│          │          │
│  │  │ Memory  │  │ Context │  │ Patterns│          │          │
│  │  └─────────┘  └─────────┘  └─────────┘          │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │            DASHBOARD & MONITORING                  │          │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │          │
│  │  │ Web UI  │  │ Metrics │  │ Alerts  │          │          │
│  │  └─────────┘  └─────────┘  └─────────┘          │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
              │  Agent 1  │   │  Agent 2  │   │  Agent N  │
              │ (Coder)   │   │ (Reviewer)│   │  (Test)   │
              └───────────┘   └───────────┘   └───────────┘
```

### Component Interaction Flow

```
User Request
     │
     ▼
┌─────────────────┐
│ 1. Analyze Task │ ← Complexity Analysis
│    Complexity   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Build DAG    │ ← Dependency Graph
│    (Runtime)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. Select Models│ ← Cost-Aware Routing
│    per Agent    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. Spawn Agents │ ← Dynamic Spawning
│    (Parallel)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. Execute DAG  │ ← True Parallel Execution
│    with Comms   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 6. Monitor &    │ ← Self-Healing
│    Self-Heal    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 7. Collect      │ ← Result Aggregation
│    Results      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 8. Learn &      │ ← Pattern Learning
│    Update       │
└─────────────────┘
```

---

## 4. Core Concepts

### 4.1 Dynamic DAG Execution

Unlike static dependency graphs, Nexus builds and modifies the DAG at runtime based on task outcomes.

```typescript
interface DAGNode {
  id: string
  task: TaskDefinition
  dependencies: string[]
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result?: TaskResult
  spawnedAgent?: Agent
}

interface DAG {
  nodes: Map<string, DAGNode>
  
  // Runtime modification
  addNode(node: DAGNode): void
  addDependency(nodeId: string, dependsOn: string): void
  removeNode(nodeId: string): void
  
  // Execution
  getReadyNodes(): DAGNode[] // Nodes with all deps completed
  markComplete(nodeId: string, result: TaskResult): void
  markFailed(nodeId: string, error: Error): void
  
  // Analysis
  getParallelGroups(): DAGNode[][] // Groups that can run in parallel
  isComplete(): boolean            // No node remains pending or running
}
```

The scheduler loop in `NexusOrchestrator.execute()` walks the DAG by calling
`getReadyNodes()` until `isComplete()` is true; cycle detection lives in
`detectCycles(nodes: DAGNode[]): string[][]` (`src/dag.ts`).

### 4.2 Adaptive Agent Spawning

Agents are spawned based on task complexity, not predetermined roles.

Complexity analysis and spawning are methods on `NexusOrchestrator`, not
separate collaborators. The shape below is the actual signature and factor
arithmetic from `src/orchestrator.ts`.

```typescript
// src/orchestrator.ts
analyzeComplexity(task: Task): ComplexityScore

spawnAgent(config: SpawnConfig, options?: SpawnOptions): Promise<SpawnedAgent>
terminateAgent(agentId: string): Promise<void>
```

`analyzeComplexity` derives every factor from the task itself rather than
taking them as input:

```typescript
interface ComplexityScore {
  overall: number        // 0-100
  factors: {
    fileCount: number              // task.files.include.length
    codeLines: number              // fileCount * 50 (synthetic estimate)
    dependencyDepth: number        // task.dependencies.length
    domainKnowledge: number        // 0-100, keyword hits in the description
    riskLevel: 'low' | 'high'      // note: only these two ends are produced
  }
}
```

`riskLevel` is `low` or `high` — the implementation never assigns `medium`, so
a third value has no producer even though `ComplexityScore` in `src/types.ts`
still types it as `'low' | 'medium' | 'high'`.

### 4.3 Real Pub/Sub Communication

Agents communicate through a message broker, not direct calls.

There is no `MessageBroker` type in the codebase. Agent-to-agent messaging is
three cooperating pieces, each in its own file:

```typescript
// src/fanout.ts — topic routing
class MessageRouter {
  subscribe(subscriberId: string, topic: string, handler: (msg: AgentMessage) => void): void
  unsubscribe(subscriberId: string): void
  route(message: AgentMessage): string[]   // returns the subscriber IDs delivered to
}

// src/message-store.ts — durable JSONL message log
class MessageStore {
  add(message: AgentMessage): void
}

// src/broadcast.ts — orchestrator event → WebSocket clients
class StateBroadcaster {
  addClient(ws: WebSocketLike): void
  removeClient(ws: WebSocketLike): void
}
```

The orchestrator exposes the publish/subscribe surface directly, delegating to
the router:

```typescript
// src/orchestrator.ts
publish(topic: string, message: Omit<AgentMessage, 'id' | 'timestamp'>): void
subscribe(topic: string, handler: (msg: AgentMessage) => void): () => void
```

`StateBroadcaster` subscribes to every event named in `BROADCAST_EVENTS` and
forwards each to connected dashboard clients, throttling full `orchestrator:state`
snapshots to at most once per second.

```typescript
interface AgentMessage {
  id: string
  from: string
  to?: string // undefined = broadcast
  topic?: string
  type: MessageType
  payload: unknown
  timestamp: Date
  metadata: MessageMetadata
}

interface MessageMetadata {
  priority: 'low' | 'normal' | 'high' | 'critical'
  requiresResponse: boolean
  ttl?: number // Time to live in ms
}

type MessageType = 
  | 'task-assigned'
  | 'task-completed'
  | 'task-failed'
  | 'review-requested'
  | 'review-completed'
  | 'decision-made'
  | 'context-update'
  | 'error-report'
  | 'help-requested'
  | 'status-update'
```

### 4.4 Cost-Aware Routing

Every model selection considers cost vs quality tradeoffs.

There is no `CostRouter` interface. Selection lives on the orchestrator and
pricing lives in a dedicated forecaster:

```typescript
// src/orchestrator.ts — candidate selection and cost attribution
selectModel(role: AgentRole, complexity: ComplexityScore): ModelSelection
selectBestModel(role: string, complexity: ComplexityScore): ModelSelection
scoreModel(ref, role, complexity, estimates): number
trackCost(agentId: string, model: string, cost: number, tokens: number, provenance: CostProvenance): void
getModelCost(model: string, provider?: string): NexusModelCost | undefined
isBudgetExceeded(): boolean

// src/forecast.ts — price estimation
class CostForecaster {
  tiersFor(model: string, provider?: string): { pricing: ModelPricingTiers; source: PricingSource }
  estimateCost(complexity: ComplexityScore, model: string, provider?: string): number
}
```

`selectBestModel` builds its candidate list from the role's configured model
plus a small set of known alternatives, prices each once, filters out anything
whose per-task estimate exceeds the remaining total budget, and ranks the
survivors. `ModelPricingTiers` (also `src/forecast.ts`) carries input, output
and cache rates; `PricingSource` records whether a price came from
`model-costs`, the built-in `FALLBACK_PRICING_PER_1K` table, or the
`unknown-model` placeholder.

```typescript
interface BudgetConstraint {
  maxTotalCost: number
  maxCostPerTask: number   // per-task advisory ceiling (see note below)
  alertThreshold: number   // fraction of budget remaining that triggers an alert
  hardLimit: boolean       // whether exceeding the total is terminal
}

interface ModelSelection {
  provider: string
  model: string            // bare model id, without provider or variant
  variant?: string         // the `#variant` half, without the `#`
  estimatedCost: number
  estimatedQuality: number // 0-1
  reasoning: string        // Why this model was selected
}
```

### 4.5 Self-Healing Orchestration

Agents automatically recover from failures.

There is no `SelfHealingManager` interface. Failure recovery is a private
orchestrator method and health sampling is a standalone monitor:

```typescript
// src/orchestrator.ts
private handleFailure(agent: Agent, node: DAGNode, error: Error): Promise<void>
collectContext(agent: Agent): ContextTransferData   // feeds the respawn prompt

// src/health.ts
class HealthMonitor {
  start(getAgents: () => Agent[]): void
  stop(): void
  checkAgent(agent: Agent): HealthCheck
  getHealth(agentId: string): HealthCheck | null
  getHistory(agentId: string): HealthCheck[]
  getUnhealthyAgents(): string[]
}
```

Recovery is driven by the `selfHealing` config block (`maxRetries`, `retryDelay`,
`contextTransfer`) and an internal `EscalationPolicy` built from it in the
orchestrator constructor; per-node retry counts live in `nodeRetryCounts`. When
a retry respawns, the previous agent's partial results are prepended to the next
agent's prompt as context transfer.

```typescript
interface HealthCheck {
  agentId: string
  timestamp: Date
  responseTime: number
  errorRate: number
  tokensPerSecond: number
  memoryUsage: number
  status: 'healthy' | 'degraded' | 'unhealthy'
}
```

### 4.6 Shared Memory Store

Agents share context through a structured memory store.

The store is `PersistentMemoryStore` (`src/memory-store.ts`), not a
`SharedMemoryStore`. Writes append a new version rather than replacing, which is
why the read side is split into "latest" and "all versions" queries.

```typescript
// src/memory-store.ts
class PersistentMemoryStore {
  set(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry
  get(key: string, scope?: MemoryScope): MemoryEntry | null
  getByKey(key: string, scope?: MemoryScope): MemoryEntry[]   // all versions
  getByScope(scope: MemoryScope): MemoryEntry[]
  search(query: string, scope?: MemoryScope): MemoryEntry[]
  getRecent(count: number): MemoryEntry[]
  getByAuthor(author: string): MemoryEntry[]
  delete(key: string, scope?: MemoryScope): boolean
  clear(scope?: MemoryScope): number
  getStats(): { total: number; byScope: Record<string, number>; expired: number; evicted: Record<string, number> }
  close(): void
}

// src/orchestrator.ts — the surface agents actually reach
setMemory(scope: MemoryScope, key: string, value: unknown, author: string): void
getMemory(scope: MemoryScope, key: string): MemoryEntry | undefined
versionsOfMemory(scope, key): { entries: MemoryEntry[]; count: number }
searchMemory(query: string, scopes: readonly MemoryScope[]): MemoryEntry[]
listMemory(scope: MemoryScope, limit: number): { entries: MemoryEntry[]; versionsSuperseded: number }
recallForTask(request: RecallRequest): RecallOutcome
```

`recallForTask` is what injects notes into a task's prompt, and it is capped;
`getLastRecall()` reports how many notes were rendered and how many characters
they took, so the retrieval cost is a number rather than an inference. Only a
key of the form `file:<path>` is auto-injected into tasks touching that file.

```typescript
interface MemoryEntry {
  id: string
  key: string
  value: unknown
  scope: MemoryScope
  author: string        // self-reported by the writer
  timestamp: Date
  confidence: number | null  // null when unstated — NOT a low value
  tags: string[]
  ttl?: number
}

type MemoryScope = 'project' | 'session' | 'learning' | 'temp'
```

---

## 5. Plugin Architecture

### 5.1 Composable Modules

Nexus uses a composable architecture where features are optional modules.

There is no fluent `.use(...)` builder and no `NexusOrchestrator.preset()`
static. The orchestrator is constructed directly and modules are registered
against its `ModuleRegistry` (`src/modules.ts`):

```typescript
import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

const orchestrator = new NexusOrchestrator(config?, messageStoreConfig?, memoryStoreConfig?)

orchestrator.moduleRegistry.register({
  name: 'my-module',
  description: 'What it does',
  version: '1.0.0',
  setup: async (ctx) => { /* ctx.orchestrator, ctx.config, ctx.emit, ctx.on */ },
  teardown: async () => {},
  tools: [{ name, description, execute }],
  hooks: [{ event, handler }],
})

// Modules are set up during initialize(), and torn down on shutdown()
await orchestrator.moduleRegistry.setupAll(moduleCtx)
await orchestrator.moduleRegistry.teardownAll()
```

Registering a name twice throws. A module whose `setup` throws is logged and
skipped — `setupAll` does not fail the orchestrator over one bad module.

**Presets** are a configuration feature, not an orchestrator constructor. They
are applied through the config manager (`src/config.ts`):

```typescript
configManager.applyPreset(name: string): void   // merges PRESETS[name].config
configManager.listPresets(): string[]
```

The `PRESETS` table defines `minimal`, `balanced` and `enterprise`. Separately,
the `preset` **tool** (registered in `src/index.ts`) applies a session-scoped
preset that shadows `nexus.jsonc` until cleared — a different mechanism from
`applyPreset`, which writes the merged config.

### 5.2 Module Interface

```typescript
// src/modules.ts
interface NexusModule {
  name: string
  description: string
  version: string

  // Lifecycle
  setup?: (ctx: ModuleContext) => Promise<void>
  teardown?: () => Promise<void>

  // Optional: tools exposed to agents, and event hooks
  tools?: ModuleTool[]
  hooks?: ModuleHook[]
}

interface ModuleContext {
  orchestrator: any
  config: any
  emit: (event: string, data: any) => void
  on: (event: string, handler: (data: any) => void) => void
}

interface ModuleTool {
  name: string
  description: string
  execute: (input: any) => Promise<{ content: string }>
}

interface ModuleHook {
  event: string
  handler: (data: any) => void | Promise<void>
}
```

Note that `setup` receives a `ModuleContext`, not the orchestrator directly, and
hooks are declared as `{ event, handler }` pairs rather than the named
`beforeSpawn`/`afterExecute` callbacks shown in earlier drafts.

### 5.3 Built-in Modules

Most subsystems are constructed directly by the orchestrator rather than
registered in the `ModuleRegistry`, and the ones that are component classes do
not carry kebab-case module names. The table below lists the real units, keyed
by the class that implements them.

| Subsystem | Implementation | Lifecycle |
|-----------|----------------|-----------|
| Parallel DAG execution | `NexusOrchestrator.execute()` + `detectCycles()` (`src/dag.ts`) | Built in, always on |
| Cost-aware model selection | `selectBestModel()` / `scoreModel()` + `CostForecaster` (`src/forecast.ts`) | Built in, always on |
| Pub/sub messaging | `MessageRouter` (`src/fanout.ts`), `MessageStore` (`src/message-store.ts`) | Constructed in the orchestrator constructor |
| Real-time state broadcast | `StateBroadcaster` (`src/broadcast.ts`) | Created by `initBroadcaster()` |
| Self-healing | `handleFailure()` + `EscalationPolicy` (orchestrator-internal) | Driven by the `selfHealing` config block |
| Health monitoring | `HealthMonitor` (`src/health.ts`) | `start()`ed in `initialize()` |
| Shared memory | `PersistentMemoryStore` (`src/memory-store.ts`), `recallForTask()` | Constructed in the constructor |
| Dashboard | `DashboardModule` (`src/dashboard.ts`) | Created by `startDashboard()` |
| Security scanning | `SecurityScanner` (`src/security.ts`) | Constructed in the constructor |
| Learning | `LearningModule` (`src/learning.ts`) | Constructed in the constructor |
| Git worktrees | `WorktreeManager` (`src/worktree.ts`) | Created by `enableWorktrees()`; `null` until then |
| Notifications | `NotificationManager` (`src/notifications.ts`) | Created in `initialize()`, gated on config |
| Performance scoring | `PerformanceTracker` (`src/performance.ts`) | Constructed in the constructor |
| Execution history | `ExecutionHistory` (`src/history.ts`) | Constructed in the constructor |
| Custom roles | `CustomRoleManager` (`src/custom-roles.ts`) | Constructed in the constructor |
| Templates | `instantiateTemplate()` / `listTemplates()` (`src/templates.ts`) | Stateless helpers |
| Teams | `TeamManager` (`src/team.ts`) | Created per tool invocation in `src/index.ts` |
| Goals | `GoalManager` (`src/goal.ts`) | Created per session in `src/index.ts` |
| Todos | `TodoEnforcer` (`src/todo.ts`) | An orchestrator field, `new TodoEnforcer()` |
| ast-grep | `AstGrep` (`src/astgrep.ts`) | Created per tool invocation in `src/index.ts` |
| git-flow | `detectGitState()` / `resolveGitFlow()` / `checkGitFlow()` (`src/git-flow.ts`) | Stateless helpers |
| Model groups & refs | `src/model-groups.ts`, `src/model-ref.ts` | Stateless helpers |
| Config loading & hot-reload | `NexusConfigManager` (`src/config.ts`), `reloadConfigFromDisk()` | Reloaded on file change |
| Skills install | `installNexusSkills()` (`src/skills-install.ts`) | On-demand |
| TUI commands | `src/tui.tsx` — `LOCAL_COMMANDS` routing | Separate TUI process; forwards unknown subcommands to the server |

`ModuleRegistry` exists as the extension point for third-party modules, but no
built-in subsystem registers through it — `setupAll()` is called during
`initialize()` over an empty registry in the shipped configuration.

---

## 6. Module Specifications

### 6.1 Parallel Execution Module

**Purpose:** Execute independent tasks concurrently using a dynamic DAG.

There is no `ParallelExecutionModule` class and no `PriorityQueue<DAGNode>` in
the source tree. Scheduling is the orchestrator's own `executeDAG()` loop, and
concurrency is bounded by counting live agents rather than a ready queue.

```typescript
// src/orchestrator.ts
async execute(request: ExecutionRequest): Promise<ExecutionResult> {
  // 1. Build the DAG from the task list
  this.dag = this.buildDAG(request.tasks)

  // 2. Refuse a cyclic graph before spawning anything
  const cycles = detectCycles(Array.from(this.dag.nodes.values()))
  if (cycles.length > 0) {
    throw new Error(`Circular dependency detected: ${cycles.map(c => c.join(' → ')).join(', ')}`)
  }

  // 3. Apply a per-request budget override, if one was supplied
  if (request.budget) { this.budgetOverride = request.budget; this.budget = request.budget }

  // 4. Run the scheduler, then collect
  await this.executeDAG()
  return { success: true, tasks: this.collectResults(), totalCost: this.totalSpent, ...this.spendSplit(), totalDuration, agentsUsed: this.agents.size }
}

private async executeDAG(): Promise<void> {
  while (!this.dag!.isComplete() && !this.paused) {
    const spawnPromises: Promise<void>[] = []
    for (const node of this.dag!.getReadyNodes()) {
      if (this.agents.size < this.config.maxConcurrency) {
        // Per-node catch: one spawn failure must not reject the whole
        // Promise.all and discard every sibling's result.
        spawnPromises.push(this.spawnAndExecute(node).catch(/* mark node failed, emit task:failed */))
      }
    }
    await Promise.all(spawnPromises)
    await this.sleep(this.config.schedulerInterval)
  }
}
```

Relevant config keys are `maxConcurrency` and `schedulerInterval`. There is no
`deadlockDetection` toggle — cycle detection is unconditional — and no
priority-queue scheduling; `Task.priority` is carried on the task but the ready
set is `getReadyNodes()`.

### 6.2 Cost-Aware Routing Module

**Purpose:** Select optimal models based on cost, quality, and budget constraints.

There is no `CostRoutingModule` class and no `costOptimization` mode setting.
Selection is three orchestrator methods over a `CostForecaster` that reads
prices from the `model.costs` tool's data, with a built-in fallback table
behind it.

```typescript
// src/orchestrator.ts
selectBestModel(role: string, complexity: ComplexityScore): ModelSelection {
  const candidates = dedupe([
    this.configManager.getModelForRole(role),
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-haiku-4-5',
    'openai/gpt-5-mini',
    'google/gemini-2.5-flash',
    'opencode/minimax-m2.5-free',
  ])

  // Price each candidate ONCE, so the budget filter and the ranker agree
  const estimates = new Map(candidates.map(ref => [ref, this.forecaster.estimateCost(complexity, model, provider)]))

  // Filter by remaining total budget. A genuinely free model stays selectable
  // however little budget is left, hence the `=== 0` escape hatch.
  const budgetRemaining = this.budget.maxTotalCost - this.totalSpent
  const affordable = scored.filter(({ ref }) => (estimates.get(ref) ?? 0) <= budgetRemaining || estimates.get(ref) === 0)

  // ...rank by overallScore and return the winner
}

scoreModel(modelId, role, complexity, estimates?): ModelScore {
  const costScore = maxEstimate === 0 ? 1 : 1 - (estimate / maxEstimate)
  const quality = this.estimateModelQuality(model)

  // Complexity shifts the quality/cost trade-off
  const qualityWeight = complexity.overall > 70 ? 0.6 : complexity.overall > 40 ? 0.4 : 0.2
  const costWeight = 1 - qualityWeight

  return { model, provider, ...(variant ? { variant } : {}), costScore, qualityScore: quality, speedScore, overallScore: quality * qualityWeight + costScore * costWeight, reasoning }
}
```

`speedScore` is reported but is **not** a term in `overallScore`, so it never
affects selection. There is no `qualityThreshold` setting: quality enters only
through the complexity-driven weight above.

### 6.3 Pub/Sub Communication Module

**Purpose:** Enable real-time agent-to-agent communication.

There is no `PubSubModule` class, and no `maxQueueSize` / `messageTTL` /
`deliveryGuarantee` settings. Publishing is one orchestrator method that feeds
three sinks, and delivery is at-most-once to in-process handlers.

```typescript
// src/orchestrator.ts
publish(topic: string, message: Omit<AgentMessage, 'id' | 'timestamp'>): void {
  const fullMessage: AgentMessage = {
    ...message,
    topic: message.topic ?? topic,
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date()
  }

  this.messageQueue.push(fullMessage)   // 1. in-process ring buffer
  this.messageStore.add(fullMessage)   // 2. JSONL on disk (always)

  // 3. legacy per-topic handlers registered via subscribe()
  const handlers = this.subscribers.get(topic) || []
  handlers.forEach(handler => handler(fullMessage))

  // 4. fan-out: exact-topic subscribers plus '*' wildcard subscribers
  this.messageRouter.route(fullMessage)
}

subscribe(topic: string, handler: (msg: AgentMessage) => void): () => void {
  // returns an unsubscribe closure
}
```

Note what is absent from the real API: there is no `send(agentId, message)`
direct-delivery method, no `fanOut(message, recipients)` and no
`broadcast(message)`. Those were never implemented. Routing to a specific agent
is done by publishing on a topic that agent subscribes to; `MessageRouter`
supports a `'*'` wildcard topic for "all messages".

### 6.4 Self-Healing Module

**Purpose:** Automatically recover from agent failures.

There is no `SelfHealingModule` class and no `RecoveryAction` type — recovery
does not return a decision object, it performs the action inline. The policy is
a plain data object and the escalation ladder is a four-step method.

```typescript
// src/orchestrator.ts
export interface EscalationPolicy {
  maxRetries: number
  retryDelay: number
  enableRespawn: boolean
  fallbackModels: string[]
  alertOnFailure: boolean
}

private async handleFailure(agent: Agent, node: DAGNode, error: Error): Promise<void> {
  const retryCount = this.nodeRetryCounts.get(node.id) || 0

  // Every failure is recorded for pattern learning first
  this.learning.recordFailure(pattern, solution, context, [node.task.requiredRole])

  // Step 1: Retry with exponential backoff — delay is retryDelay * 2^retryCount
  if (retryCount < policy.maxRetries) { ...; await this.spawnAndExecute(node); return }

  // Step 2: Respawn with context transfer
  if (policy.enableRespawn && this.config.selfHealing.contextTransfer) {
    const context = this.collectContext(agent)
    this.setMemory('session', `context:${agent.id}`, context, agent.id)
    await this.terminateAgent(agent.id)
    await this.spawnAndExecute(node, { transferContext: context })
    return
  }

  // Step 3: Fall back to a different model — verified to actually differ from
  //         the model that just failed, compared as a qualified reference
  // Step 4: Escalate to the user
}
```

Config keys are `selfHealing.maxRetries`, `selfHealing.retryDelay` and
`selfHealing.contextTransfer`; `fallbackModels` and `alertOnFailure` come from
`DEFAULT_ESCALATION` rather than from user config. There is no
`backoffMultiplier` setting — the backoff factor is hard-coded to 2 — and no
`escalationThreshold`; the ladder is positional rather than threshold-based.

### 6.5 Shared Memory Module

**Purpose:** Enable cross-agent memory sharing.

There is no `SharedMemoryModule` and no `storage: 'sqlite' | 'memory'` choice —
the store is always the persistent SQLite-backed one. The agent-facing surface
is three tools registered in `src/index.ts` as `memory.set`, `memory.search` and
`memory.list` (not `memory_get` / `memory_set` / `memory_search`).

```typescript
// src/memory-store.ts — constructed with the orchestrator, configured by MessageStoreConfig-style opts
class PersistentMemoryStore { /* see §4.6 */ }

// src/index.ts — the tools agents actually call
memory.set      { key, value, scope?, author, confidence?, tags?, ttl? }
memory.search   { query, includeSession? }
memory.list     { scope?, limit? }
```

Behaviour worth knowing when reading the tool schemas:

- Writes are **append-only**. Correcting a note writes a new version; it does
  not replace the old one. `memory.list` reports `versionsSuperseded` for this.
- Only `project` and `temp` are writable. `session` and `learning` are not.
- `author` is required and **self-reported** — nothing verifies it.
- `confidence` is optional and nullable. Omitting it is correct when unsure; an
  invented number hides that uncertainty from later readers.
- Automatic injection into a task prompt happens for `file:<path>` keys only,
  and only in `project` scope. `memory.search` is otherwise the only way in.

### 6.6 Dashboard Module

**Purpose:** Real-time web UI for monitoring orchestrator state.

```typescript
// src/dashboard.ts
class DashboardModule {
  constructor(orchestrator: NexusOrchestrator)
  start(port: number, host: string): void
  stop(): void
  getAddress(): DashboardAddress | null
  getClientCount(): number
  isRunning(): boolean
}

// src/orchestrator.ts
startDashboard(port?: number, host?: string): void
stopDashboard(): void
initBroadcaster(opts?: { throttleMs?: number }): void
```

Port and host default to `dashboard.port` / `dashboard.host` from the config
(4747 / 127.0.0.1), and `startDashboard()` throws outright if
`dashboard.enabled` is `false` rather than silently no-opping. The module is
built inside `startDashboard()` and only assigned to `this.dashboard` after the
bind succeeds, so a failed bind leaves no phantom module for `stopDashboard()` to
act on.

There is no `auth` block and no `refreshInterval`. The dashboard binds to
loopback by default and has no authentication of its own — see the security
section on what that means for the bind address. Real-time updates arrive over
WebSocket, pushed by `StateBroadcaster`; state snapshots are throttled to at
most one per second.

---

## 7. Data Models

### 7.1 Core Types

```typescript
// Agent
interface Agent {
  id: string
  name: string
  role: AgentRole
  status: AgentStatus
  model: ModelSelection
  spawnedAt: Date
  lastActivity: Date
  metrics: AgentMetrics
}

type AgentRole = 
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'explorer'
  | 'documenter'
  | string // Custom roles

type AgentStatus = 
  | 'spawning'
  | 'idle'
  | 'working'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'terminated'

interface AgentMetrics {
  tasksCompleted: number
  tasksFailed: number
  totalTokens: number
  totalCost: number
  averageResponseTime: number
  errorRate: number
}

// Task
interface Task {
  id: string
  name: string
  description: string
  requiredRole: AgentRole
  complexity: ComplexityScore
  dependencies: string[]
  files: FileScope
  priority: 'low' | 'normal' | 'high' | 'critical'
  timeout?: number
}

interface ComplexityScore {
  overall: number        // 0-100
  factors: {
    fileCount: number
    codeLines: number
    dependencyDepth: number
    domainKnowledge: number
    riskLevel: 'low' | 'medium' | 'high'
  }
}

// Message
interface AgentMessage {
  id: string
  from: string
  to?: string
  topic?: string
  type: MessageType
  payload: unknown
  timestamp: Date
  metadata: MessageMetadata
}

// Memory
interface MemoryEntry {
  id: string
  key: string
  value: unknown
  scope: MemoryScope
  author: string
  timestamp: Date
  confidence: number
  tags: string[]
  ttl?: number
}

// Cost
interface CostReport {
  totalSpent: number
  budgetRemaining: number
  byAgent: Map<string, AgentCost>
  byModel: Map<string, ModelCost>
  timeline: CostTimeline[]
}
```

---

## 8. API Reference

### 8.1 Orchestrator API

```typescript
class NexusOrchestrator {
  constructor(config?: Partial<NexusConfig>, messageStoreConfig?: Partial<MessageStoreConfig>, memoryStoreConfig?: Partial<MemoryStoreConfig>)
  async initialize(ctx: NexusPluginContext, onStateChange?: () => void): Promise<void>
  async shutdown(): Promise<void>

  // Execution
  async execute(request: ExecutionRequest): Promise<ExecutionResult>
  async spawnAgent(config: SpawnConfig, options?: SpawnOptions): Promise<SpawnedAgent>
  async terminateAgent(agentId: string): Promise<void>

  // Selection
  analyzeComplexity(task: Task): ComplexityScore
  selectModel(role: AgentRole, complexity: ComplexityScore): ModelSelection
  selectBestModel(role: string, complexity: ComplexityScore): ModelSelection

  // Cost
  getCostReport(): string
  isBudgetExceeded(): boolean
  resetBudgetExceeded(): void
  getModelCost(model: string, provider?: string): NexusModelCost | undefined

  // Messaging and memory
  publish(topic: string, message: Omit<AgentMessage, 'id' | 'timestamp'>): void
  subscribe(topic: string, handler: (msg: AgentMessage) => void): () => void
  setMemory(scope, key, value, author): void
  getMemory(scope, key): MemoryEntry | undefined
  searchMemory(query: string, scopes: readonly MemoryScope[]): MemoryEntry[]

  // Dashboard, worktrees, git
  startDashboard(port?: number, host?: string): void
  stopDashboard(): void
  enableWorktrees(repoRoot?: string): void
  getGitState(cwd?: string): GitState
  resolveGitFlow(cwd?: string): ResolvedGitFlow
  checkGitFlow(cwd?: string): GitCheckReport
  recordGitFlowDecision(decision, cwd?): GitFlowDecision

  // Config
  reloadConfigFromDisk(trigger?: NexusConfigReloadTrigger): NexusConfigLoadInfo | null
  getConfigInfo(): NexusConfigLoadInfo | null

  // Modules
  moduleRegistry: ModuleRegistry   // register(), setupAll(), teardownAll()

  // Events
  on(event: string, handler: Function): () => void   // returns unsubscribe

  // Commands
  handleCommand(text: string): string
}
```

There is no `NexusOrchestrator.preset()` static and no `use()`. Presets live in
`configManager.applyPreset(name)`; see §5.1. There is also no `getAgents()`,
`getAgent()`, `getDAG()` or `getCostReport(): CostReport` — agent and cost
queries are reached through the `agents` and `costs` tools, whose handlers call
`listAgents(filter?)` and `getCostReport(): string`. Note that both return
formatted strings, not objects. `on()` returns the unsubscribe closure.

### 8.2 Tool Registration

Nexus registers 48 tools. They are registered **without a `nexus_` prefix** —
the plugin lives in the `nexus` namespace, so a tool named `status` is
addressed as `nexus_status` by *clients* that require a namespace prefix, but the
registered name is `status`. The names below are the literal `name` values passed
to `editor.add()` in `src/index.ts`.

There is no `tasks` tool, no `send`/`broadcast` tool and no `request_review`
tool.

**Orchestration and state**

| Tool | Description | Parameters |
|------|-------------|------------|
| `status` | Orchestrator status, metrics, and the config files in effect | `{ detailed?: boolean }` |
| `agents` | List all active agents | `{ filter?: string }` (by status) |
| `costs` | Cost report and budget status | — |
| `dashboard` | Full orchestrator state for dashboard display | — |
| `queue` | Current task queue with priorities | — |
| `notifications.test` | Send a test OS notification | — |
| `performance.scores` | Agent performance scores by model and role | — |
| `performance.best` | Best model for a specific role | `{ role: string }` |
| `security.scan` | Scan content for security issues | `{ content: string, filename?: string }` |
| `history.list` | List execution history | `{ count?: number }` |
| `history.stats` | Execution statistics | — |
| `sessions` | List active Nexus agent sessions | — |
| `background` | Move running agents to background (detach) | — |
| `result` | Result of a completed agent session | `{ sessionID: string }` |
| `clarify` | Ask a clarifying question on an ambiguous task | `{ question, options?, assumption? }` |

**Spawning and delegation**

| Tool | Description | Parameters |
|------|-------------|------------|
| `spawn` | Spawn a sub-agent; `wait=true` blocks for the result | `{ role, task, model?, wait?, timeout? }` |
| `delegate` | Spawn and wait in one call (wrapper over spawn+wait) | `{ role, task, model?, timeout? }` |
| `template` | List or instantiate task templates | `{ name, baseDir? }` (`name: 'list'` to list) |
| `forecast` | Estimate cost before executing | `{ tasks: string }` (JSON array) |

**Memory**

| Tool | Description | Parameters |
|------|-------------|------------|
| `memory.set` | Write a durable note (append-only, self-reported author) | `{ key, value, scope?, author, confidence?, tags?, ttl? }` |
| `memory.search` | Substring search over keys and values, unranked | `{ query, includeSession? }` |
| `memory.list` | List notes in a scope, newest version of each key first | `{ scope?, limit? }` |

**Configuration**

| Tool | Description | Parameters |
|------|-------------|------------|
| `config.save` | Save Nexus config to disk | `{ level: 'project' \| 'global', basePath? }` |
| `config.init` | Initialize default config files | `{ level: 'project' \| 'global' \| 'both', basePath? }` |
| `preset` | Apply or clear a **session** preset shadowing `nexus.jsonc` | `{ mode: 'apply' \| 'clear', name? }` |
| `model.costs` | Show real model pricing, or set custom per-1K rates | `{ model?, setInput?, setOutput? }` |
| `roles.list` | List custom agent roles | — |
| `roles.add` | Add a custom agent role | `{ name, displayName, emoji?, prompt, model? }` |

**Dashboard and git/worktrees**

| Tool | Description | Parameters |
|------|-------------|------------|
| `dashboard.start` | Start the web dashboard server | `{ port?, host? }` |
| `dashboard.stop` | Stop the dashboard server | — |
| `worktree.enable` | Enable git worktree isolation for agents | `{ repoRoot? }` |
| `worktree.disable` | Disable isolation and clean up | — |
| `worktree.list` | List active agent worktrees | — |
| `git.check` | Report this repo's git convention (read-only) | `{ cwd?, decision? }` |

**Goals, todos and teams**

| Tool | Description | Parameters |
|------|-------------|------------|
| `todo.add` | Add a tracked todo | `{ description, assignedTo? }` |
| `todo.list` | List todo items | — |
| `todo.complete` | Mark a todo complete | `{ id: string }` |
| `todo.stats` | Todo statistics | — |
| `goal.set` | Set a persistent objective | `{ description, autoContinue? }` |
| `goal.status` | Current active goal status | — |
| `goal.complete` | Mark the active goal complete | — |
| `goal.list` | List all goals | — |
| `team.create` | Create a team with a lead role | `{ name, leadRole }` |
| `team.addMember` | Add a member to a team | `{ teamId, role }` |
| `team.status` | Show team status | `{ teamId? }` |
| `team.activate` | Activate a team to start execution | `{ teamId }` |

**Search**

| Tool | Description | Parameters |
|------|-------------|------------|
| `astgrep.search` | Search for AST patterns in the codebase | `{ pattern, language, directory }` |
| `astgrep.status` | Check whether ast-grep is installed | — |

### 8.3 Slash Commands

There are two layers, and they accept different subcommands.

**Server-side**, handled by `NexusOrchestrator.handleCommand()` in the process
that owns the orchestrator (`src/orchestrator.ts`):

| Command | Description |
|---------|-------------|
| `/nexus status` | Orchestrator status (`getStatus(true)`) |
| `/nexus agents [filter]` | List agents, optionally filtered |
| `/nexus costs` | Cost breakdown |
| `/nexus pause` | Pause execution |
| `/nexus resume` | Resume execution |
| `/nexus dashboard [port] [host]` | Start the dashboard server |
| `/nexus dashboard stop` | Stop the dashboard server |
| `/nexus dashboard state` | Print the orchestrator state as JSON |

An unrecognised subcommand gets exactly one line back: *"Unknown command.
Available: status, agents, costs, pause, resume, dashboard [port] [host],
dashboard stop, dashboard state"*. There is no `/nexus cancel`, no
`/nexus retry`, no `/nexus memory` and no `/nexus help` — none of those have
ever been implemented.

**TUI-side**, handled locally in the OpenCode TUI process (`src/tui.tsx`,
`LOCAL_COMMANDS`). The TUI has no orchestrator, so these are answered from
config and the OpenCode client rather than by the server:

| Command | Description |
|---------|-------------|
| `/nexus config` | Configure models and budget |
| `/nexus status` | Config summary (answered here, not forwarded) |
| `/nexus dashboard [port] [host]` | Start the dashboard and open a browser |
| `/nexus web [port] [host]` | Alias of `dashboard` |
| `/nexus overview` | Config/budget/dashboard-status overview; starts nothing |
| `/nexus model <role>` | Select the model for a role |
| `/nexus reset` | Reset configuration to defaults |

Anything the TUI does not claim locally is forwarded verbatim to the server, so
a subcommand added to `handleCommand()` becomes reachable from the TUI with no
TUI change. The two lists are documented in `docs/COMPATIBILITY.md`.

---

## 9. Configuration

Configuration lives in two places, and the difference between them is the
single most important thing to know about this section.

**A config file** — `.opencode/nexus.jsonc` (project) and
`~/.config/opencode/nexus.jsonc` (global), both JSONC, both read at load and
re-read on reload, with precedence **session override > project > global >
defaults**. The file schema is `NexusFullConfig` (`src/config.ts:299`), and it
is deliberately *narrower* than the `NexusConfig` type: it carries eight blocks.

**The `NexusConfig` constructor argument** — the full shape in `src/types.ts:465`.
It adds `agents`, `learning` and `cost`, which have no file equivalent at all, and
it carries `budget.hardLimit`, which the file does not. Those are set by code
embedding Nexus, never by a user editing JSON.

The two shapes disagreeing is not an accident of history; it is the design, and
`§9.3` lists exactly which keys are in which.

### 9.1 Config File Schema

This is the complete set of keys accepted in `nexus.jsonc`. Anything not listed
here is not read.

```jsonc
// .opencode/nexus.jsonc (project) or ~/.config/opencode/nexus.jsonc (global)
{
  "$schema": "https://serkanalgur.com/opencode-nexus/schema.json",

  // Model per role. Every key optional; an absent key falls back to the
  // built-in default for that role (see DEFAULT_CONFIG in src/config.ts).
  "models": {
    "architect": "anthropic/claude-sonnet-4-6",
    "coder": "anthropic/claude-sonnet-4-6",
    "reviewer": "anthropic/claude-sonnet-4-6",
    "tester": "anthropic/claude-sonnet-4-6",
    "explorer": "anthropic/claude-sonnet-4-6",
    "documenter": "anthropic/claude-sonnet-4-6",
    "designer": "anthropic/claude-sonnet-4-6"
  },

  // Budget. ADVISORY ceilings: cost of a turn is only known once the turn
  // returns, so these report an overspend after the fact and refuse nothing.
  // That is what makes hardLimit, which this file does NOT carry, worth having.
  "budget": {
    "maxTotalCost": 10.00,
    "maxCostPerTask": 1.00,
    "alertThreshold": 0.2 // notify at 20% of the budget remaining
  },

  // Self-healing. retryDelay is the BASE of the backoff: attempt n waits
  // retryDelay * 2 ** n, with the 2 written into the expression.
  "selfHealing": {
    "enabled": true,
    "maxRetries": 3,
    "retryDelay": 1000,
    "contextTransfer": true
  },

  // Dashboard. `enabled: false` is enforced, not decorative: startDashboard()
  // refuses and names the key. port/host are the defaults for startDashboard();
  // an explicit argument to that method still wins.
  "dashboard": {
    "enabled": true,
    "port": 4747,
    "host": "127.0.0.1"
  },

  // OS notifications. One gate (sendNotification) covers task complete/failed
  // and the budget alerts alike.
  "notifications": {
    "enabled": true
  },

  // The git convention layer. VALIDATING, not blocking — nothing in src/ writes
  // to git on the strength of this block. A per-repo "ask once" off-switch in
  // the most specific repository beats a true here.
  "gitFlow": {
    "enabled": true,
    "conventionalCommits": true,
    "requireBranch": true,
    "prBeforeMerge": true
  },

  // Effort selection. Off by default. maxEffort is a CEILING, not a target:
  // it can only lower the difficulty→effort mapping, never raise it. A task is
  // asked for nothing when its difficulty is below minDifficulty.
  "effort": {
    "enabled": false,
    "maxEffort": "high",
    "minDifficulty": 0
  },

  // Custom agent roles. An ARRAY, not a keyed object. `model` is this role's
  // first candidate model — model selection is still the ranker's, and the
  // equivalent older spelling is an entry under `models`.
  "customRoles": [
    {
      "name": "security-reviewer",
      "displayName": "Security Reviewer",
      "emoji": "🔐",
      "prompt": "Review for injection, secret leakage and unsafe shell construction.",
      "model": "anthropic/claude-sonnet-4-6"
    }
  ]
}
```

Named presets — `minimal`, `balanced`, `enterprise`, `cost-optimized`
(`PRESETS`, `src/config.ts:1571`) — are applied in code through
`configManager.applyPreset(name)`, not by writing a key into the file. A
`presets` or `preset` key in `nexus.jsonc` is not part of this schema.

#### Blocks that do not exist

There is no `memory`, `security` or `communication` block in this schema, and
there is no such block on the `NexusConfig` type either. They were **deleted**,
not left unread, and the reasoning is recorded on the type itself
(`src/types.ts:465+`):

- **`memory`** — `{ enabled, storage, maxEntriesPerScope, syncInterval }` was
  read by nothing. `maxEntriesPerScope` was written into the defaults literal
  and consumed by no reader. It was removed rather than wired because with no
  automatic writing an expiry deletes a note permanently: nothing revalidates or
  rewrites, so a TTL here is data loss with a delay.
- **`security`** — `{ sastEnabled, secretsScanning, scopeEnforcement }` shares
  **not one field name** with the real, live `SecurityConfig` in
  `src/security.ts` (`enabled`, `scanSecrets`, `scanPatterns`,
  `customPatterns`, `excludeFiles`). It was scaffolding in a vocabulary the
  module never adopted, not a connection that was lost. `SecurityScanner` is
  configured through its own module today, and is exposed to agents as
  `nexus.security.scan`.
- **`communication`** — `{ mode, maxQueueSize, messageTTL, persistence }` had no
  reader. `mode: 'pubsub'` described a dispatch policy nothing dispatches on;
  `maxQueueSize: 100` bounded no queue, because `MessageStore`'s own bound is
  10,000. `MessageStore` takes its limits through its constructor, not through
  `nexus.jsonc`.

A config key that nothing reads is worse than no key at all: a user who sets
`memory.enabled: false` concludes they disabled something, and their only
evidence is that it did not work. None of the three are accepted in either
place, and `saveProjectConfig` cannot drop what is not there.

#### What is preserved on save

`saveProjectConfig()` and `saveGlobalConfig()` write all eight blocks —
`models`, `budget`, `selfHealing`, `dashboard`, `notifications`, `gitFlow`,
`effort`, `customRoles` — unconditionally, as the **entire file body**
(`getSaveableConfig()`, `src/config.ts:1429`). So a block omitted from a saved
file is a block deleted from the user's config on the next save, and
`effort: { enabled: false }` surviving a TUI model change depends on the whole
block being written. `budget.hardLimit` and `budget.maxCostPerAgent` do not
appear in a saved file either: they are not in `NexusFullConfig.budget`, and
`getConfig()` builds each block field by field (`src/config.ts:865`), so a key
the schema dropped contributes nothing to the merge. The config loader names
unknown keys in a warning at load time, since a key is still attributable to a
file there and nowhere later.

### 9.2 Project Configuration

A project file is the same schema as the global one, at project precedence. It
overrides per block; it does not have a different shape.

```jsonc
// .opencode/nexus.jsonc — same eight blocks, project precedence
{
  // Lower the ceiling for this repository only
  "budget": {
    "maxTotalCost": 5.00,
    "maxCostPerTask": 0.50
  },

  // A cheaper model for routine roles in this repository
  "models": {
    "explorer": "google/gemini-2.5-flash"
  },

  // Add a role without disturbing the roles defined globally: customRoles is
  // an array, so this repository's list is its own — merge levels do not
  // concatenate lists of roles.
  "customRoles": [
    {
      "name": "migration-auditor",
      "prompt": "Check a change for ordering hazards, destructive DDL and irreversible writes."
    }
  ]
}
```

Two things a project file does **not** do:

- **Define task templates.** There is no `taskTemplates` key. The templates ship
  in code as `TEMPLATES` in `src/templates.ts` — `feature`, `bugfix`,
  `refactor`, `documentation`, `factors` — and are addressed by name at
  dispatch, not configured.
- **Define agent roles under a keyed object.** There is no `agentRoles` key.
  Roles are the `customRoles` array above, and the seven built-in roles
  (`architect`, `coder`, `reviewer`, `tester`, `explorer`, `documenter`,
  `designer`) are fixed in code and additionally selectable per role under
  `models`.

### 9.3 Constructor-Only Settings

These are real, live settings on `NexusConfig`, and they are **not** settable
from `nexus.jsonc`. They are for a host application embedding Nexus.

| Key | Why it is constructor-only |
| --- | --- |
| `agents.healthCheckInterval` | Drives `HealthMonitor` construction in `initialize()` and `cleanupStaleData`. There is no file block. |
| `learning` (`enabled`, `patternStorage`, `minConfidence`) | `minConfidence` is read at `new LearningModule(...)`; the file has no `learning` block. |
| `cost.timeoutDeltaGraceMs` | How long past a task's timeout to keep waiting for its session to settle before abandoning the remaining cost. Omit it for the derived default, roughly half the task budget clamped to [30s, 180s]. |
| `budget.hardLimit` | `true` terminates on budget exhaustion. Absent from `NexusFullConfig.budget` by design, so a reload cannot silently start honouring it — and the constructor's value is carried across a reload explicitly (`syncFileConfig`, `src/orchestrator.ts:1222`). |
| `maxConcurrency`, `schedulerInterval`, `defaultTimeout` | Read at orchestrator construction; the file schema does not offer them. |

Two former members of these blocks were removed rather than left inert, and
neither is accepted anywhere:

- **`agents.defaultRole`** — every spawn takes its role from
  `DAGNode.task.requiredRole` (`spawnAndExecute`), so a default would be
  overridden by every task that names its own role, which is all of them.
- **`agents.spawnDelay`** — read by nothing. `spawnAgent` has no delay of its
  own; agents are dispatched by `maxConcurrency` and the scheduler interval, and
  the concurrency limit *is* the throttle.

And one from `selfHealing`:

- **`selfHealing.backoffMultiplier`** — the backoff in `handleFailure` is
  `retryDelay * 2 ** retryCount` with the base 2 written into the expression, so
  the field could only restate a constant. `retryDelay` and `maxRetries` are
  the two knobs that carry meaning, and both are read.

`memory`, `security` and `communication` were removed from the constructor
shape for the reasons in `§9.1`. They are BREAKING type changes for any external
caller passing them in a `NexusConfig` literal — and none of them ever had an
effect to lose.

---

## 10. Security Considerations

### Agent Isolation

- Each agent runs in its own worktree (when enabled)
- Agents can't access files outside their scope
- Shell commands are validated for injection

### Memory Security

- Shared memory is scoped (project/session/learning)
- Memory entries have TTL and author tracking
- Sensitive data can be excluded from memory

### Budget Enforcement

- Hard limits prevent runaway costs
- Alerts at configurable thresholds
- Emergency stop when budget exhausted

### Communication Security

- Messages are authenticated (agent ID verification)
- TTL prevents message accumulation
- Queue size limits prevent memory exhaustion

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **DAG** | Directed Acyclic Graph - task dependency model |
| **Pub/Sub** | Publish/Subscribe messaging pattern |
| **Worktree** | Isolated git working directory |
| **Self-Healing** | Automatic recovery from failures |
| **Context Transfer** | Moving agent state to new instance |
| **Cost-Aware Routing** | Model selection based on budget |
| **Complexity Score** | Task difficulty rating (0-100) |
| **Pattern Learning** | Learning from failure patterns |

---

**Document Version:** 2.13.1  
**Status:** Shipped  
**Note:** Sections 10 (Roadmap) and 11 (Benchmarks) were removed — their contents no longer describe the code. See the git history for the original text.
