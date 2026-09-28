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
  estimateTotalCost(): CostEstimate
}
```

### 4.2 Adaptive Agent Spawning

Agents are spawned based on task complexity, not predetermined roles.

```typescript
interface ComplexityAnalyzer {
  analyze(task: Task): ComplexityScore
  
  // Factors considered
  factors: {
    fileCount: number        // How many files are touched
    codeLines: number        // Estimated lines of change
    dependencyDepth: number  // How many dependencies involved
    domainKnowledge: string  // Required domain expertise
    riskLevel: 'low' | 'medium' | 'high'
  }
}

interface AgentSpawner {
  // Spawn based on complexity
  spawnForTask(task: Task): Agent[]
  
  // Dynamic role assignment
  assignRoles(task: Task, complexity: ComplexityScore): AgentRole[]
  
  // Model selection per role
  selectModel(role: AgentRole, budget: Budget): Model
}
```

### 4.3 Real Pub/Sub Communication

Agents communicate through a message broker, not direct calls.

```typescript
interface MessageBroker {
  // Topic-based pub/sub
  publish(topic: string, message: AgentMessage): void
  subscribe(topic: string, handler: MessageHandler): Unsubscribe
  
  // Direct messaging
  send(agentId: string, message: AgentMessage): void
  
  // Fan-out patterns
  fanOut(
    message: AgentMessage, 
    recipients: string[]
  ): void
  
  // Broadcast
  broadcast(message: AgentMessage): void
}

interface AgentMessage {
  id: string
  from: string
  to?: string // undefined = broadcast
  topic?: string
  type: MessageType
  payload: unknown
  timestamp: Date
  metadata: {
    priority: 'low' | 'normal' | 'high' | 'critical'
    requiresResponse: boolean
    ttl?: number // Time to live in ms
  }
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

```typescript
interface CostRouter {
  // Select model based on budget and requirements
  selectModel(params: {
    role: AgentRole
    taskComplexity: ComplexityScore
    budget: BudgetConstraint
    preferredProviders?: string[]
  }): ModelSelection
  
  // Track costs in real-time
  trackCost(agentId: string, usage: TokenUsage): void
  
  // Get current spend
  getCurrentSpend(): CostReport
  
  // Budget enforcement
  enforceBudget(): BudgetEnforcement
}

interface BudgetConstraint {
  maxTotalCost: number
  maxCostPerTask: number
  maxCostPerAgent: number
  alertThreshold: number // % of budget remaining
  hardLimit: boolean     // Stop or warn
}

interface ModelSelection {
  provider: string
  model: string
  estimatedCost: number
  estimatedQuality: number // 0-1
  reasoning: string       // Why this model was selected
}
```

### 4.5 Self-Healing Orchestration

Agents automatically recover from failures.

```typescript
interface SelfHealingManager {
  // Monitor agent health
  monitor(agent: Agent): HealthStatus
  
  // Handle failures
  handleFailure(agent: Agent, error: Error): RecoveryAction
  
  // Transfer context on respawn
  transferContext(
    oldAgent: Agent, 
    newAgent: Agent
  ): Promise<void>
  
  // Escalation policy
  escalate(failure: FailureRecord): EscalationAction
}

interface RecoveryAction {
  type: 'retry' | 'respawn' | 'fallback' | 'escalate'
  delay?: number
  newModel?: string
  contextTransfer?: boolean
  maxRetries?: number
}

interface HealthStatus {
  agentId: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'dead'
  lastActivity: Date
  errorCount: number
  responseTime: number
  tokensPerSecond: number
}
```

### 4.6 Shared Memory Store

Agents share context through a structured memory store.

```typescript
interface SharedMemoryStore {
  // Scoped memory
  project: ScopedMemory    // Project-wide decisions
  session: ScopedMemory    // Current session context
  learning: ScopedMemory   // Learned patterns
  
  // Operations
  get<T>(scope: MemoryScope, key: string): T | undefined
  set<T>(scope: MemoryScope, key: string, value: T): void
  delete(scope: MemoryScope, key: string): void
  
  // Search
  search(query: string, scope?: MemoryScope): MemoryEntry[]
  
  // Observability
  onChange(handler: MemoryChangeHandler): Unsubscribe
}

interface MemoryEntry {
  key: string
  value: unknown
  scope: MemoryScope
  author: string // Agent ID
  timestamp: Date
  ttl?: number
  tags: string[]
  confidence: number // 0-1, how confident we are in this memory
}

type MemoryScope = 'project' | 'session' | 'learning' | 'temp'
```

---

## 5. Plugin Architecture

### 5.1 Composable Modules

Nexus uses a composable architecture where features are optional modules.

```typescript
import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

const orchestrator = new NexusOrchestrator()
  .use(ParallelExecution({ maxConcurrency: 5 }))
  .use(CostAwareRouting({ budget: { maxTotalCost: 10 } }))
  .use(AgentCommunication({ mode: 'pubsub' }))
  .use(SelfHealing({ maxRetries: 3 }))
  .use(MemorySharing({ storage: 'sqlite' }))
  .use(Dashboard({ port: 4747 }))
  .use(SecurityScanning({ sast: true, secrets: true }))
  .use(Learning({ enabled: true }))

// Or with presets
const orchestrator = NexusOrchestrator.preset('balanced')
// Options: 'minimal' | 'balanced' | 'enterprise' | 'cost-optimized'
```

### 5.2 Module Interface

```typescript
interface NexusModule {
  name: string
  version: string
  
  // Lifecycle
  setup(orchestrator: NexusOrchestrator): Promise<void>
  teardown(): Promise<void>
  
  // Hooks
  hooks?: {
    beforeSpawn?: (agent: Agent) => Promise<Agent>
    afterSpawn?: (agent: Agent) => Promise<void>
    beforeExecute?: (task: Task) => Promise<Task>
    afterExecute?: (task: Task, result: Result) => Promise<Result>
    onError?: (error: Error) => Promise<RecoveryAction>
  }
}
```

### 5.3 Built-in Modules

| Module | Description | Required |
|--------|-------------|----------|
| `parallel-execution` | DAG-based parallel task execution | ✅ Yes |
| `cost-routing` | Cost-aware model selection | Optional |
| `pubsub-communication` | Agent-to-agent messaging | Optional |
| `self-healing` | Auto-recovery from failures | Optional |
| `shared-memory` | Cross-agent memory store | Optional |
| `dashboard` | Real-time web monitoring UI | Optional |
| `security-scanning` | SAST/secrets scanning per task | Optional |
| `learning` | Pattern learning from failures | Optional |
| `git-worktree` | Isolated git worktrees per agent | Optional |
| `notification` | OS notifications on events | Optional |

---

## 6. Module Specifications

### 6.1 Parallel Execution Module

**Purpose:** Execute independent tasks concurrently using a dynamic DAG.

```typescript
interface ParallelExecutionConfig {
  maxConcurrency: number      // Max parallel agents (default: 5)
  schedulerInterval: number   // DAG check interval in ms (default: 1000)
  deadlockDetection: boolean  // Detect circular dependencies
  priorityQueuing: boolean    // Priority-based scheduling
}

class ParallelExecutionModule implements NexusModule {
  name = 'parallel-execution'
  
  private dag: DAG
  private runningAgents: Map<string, Agent>
  private readyQueue: PriorityQueue<DAGNode>
  
  async execute(tasks: Task[]): Promise<TaskResult[]> {
    // 1. Build DAG from tasks
    this.dag = this.buildDAG(tasks)
    
    // 2. Start scheduler loop
    return this.scheduleLoop()
  }
  
  private async scheduleLoop(): Promise<TaskResult[]> {
    while (!this.dag.isComplete()) {
      // Get nodes ready to execute
      const ready = this.dag.getReadyNodes()
      
      // Spawn agents for ready nodes (respecting concurrency limit)
      for (const node of ready) {
        if (this.runningAgents.size < this.config.maxConcurrency) {
          await this.spawnAndExecute(node)
        }
      }
      
      // Wait for next scheduler tick
      await sleep(this.config.schedulerInterval)
    }
    
    return this.collectResults()
  }
  
  private async spawnAndExecute(node: DAGNode): Promise<void> {
    const agent = await this.orchestrator.spawnAgent({
      role: node.task.requiredRole,
      task: node.task,
      worktree: this.config.isolatedWorktrees
    })
    
    this.runningAgents.set(node.id, agent)
    node.spawnedAgent = agent
    
    // Monitor completion
    agent.onComplete(async (result) => {
      this.dag.markComplete(node.id, result)
      this.runningAgents.delete(node.id)
    })
    
    agent.onError(async (error) => {
      this.dag.markFailed(node.id, error)
      this.runningAgents.delete(node.id)
      
      // Self-healing will handle respawn
      if (this.orchestrator.hasModule('self-healing')) {
        await this.orchestrator.selfHealing.handleFailure(agent, error)
      }
    })
  }
}
```

### 6.2 Cost-Aware Routing Module

**Purpose:** Select optimal models based on cost, quality, and budget constraints.

```typescript
interface CostRoutingConfig {
  budget: BudgetConstraint
  modelPricing: Map<string, ModelPricing>
  qualityThreshold: number    // Minimum quality score (0-1)
  costOptimization: 'aggressive' | 'balanced' | 'quality-first'
}

class CostRoutingModule implements NexusModule {
  name = 'cost-routing'
  
  private spending: Map<string, number> // agentId -> cost
  private budgetRemaining: number
  
  async selectModel(params: {
    role: AgentRole
    complexity: ComplexityScore
    preferred?: string[]
  }): Promise<ModelSelection> {
    const { role, complexity, preferred } = params
    
    // Get available models for this role
    const candidates = this.getCandidateModels(role)
    
    // Filter by budget
    const affordable = candidates.filter(m => 
      m.estimatedCost <= this.budgetRemaining
    )
    
    // Score each model
    const scored = affordable.map(m => ({
      model: m,
      score: this.scoreModel(m, complexity)
    }))
    
    // Sort by score (cost-adjusted quality)
    scored.sort((a, b) => b.score - a.score)
    
    // Return best option
    return {
      ...scored[0].model,
      reasoning: this.explainSelection(scored[0])
    }
  }
  
  private scoreModel(model: CandidateModel, complexity: ComplexityScore): number {
    const qualityScore = model.quality * (complexity.riskLevel === 'high' ? 1.5 : 1)
    const costScore = 1 - (model.estimatedCost / this.budgetRemaining)
    const speedScore = model.tokensPerSecond / 100
    
    // Weighted scoring
    return (
      qualityScore * 0.5 +
      costScore * 0.3 +
      speedScore * 0.2
    )
  }
}
```

### 6.3 Pub/Sub Communication Module

**Purpose:** Enable real-time agent-to-agent communication.

```typescript
interface PubSubConfig {
  maxQueueSize: number        // Max messages per topic
  messageTTL: number          // Default TTL in ms
  deliveryGuarantee: 'at-most-once' | 'at-least-once'
  persistence: boolean        // Persist messages to disk
}

class PubSubModule implements NexusModule {
  name = 'pubsub-communication'
  
  private topics: Map<string, Topic>
  private agents: Map<string, Agent>
  private messageQueue: MessageQueue
  
  async setup(orchestrator: NexusOrchestrator): Promise<void> {
    // Subscribe to orchestrator events
    orchestrator.on('agent:spawned', (agent) => {
      this.registerAgent(agent)
    })
    
    orchestrator.on('agent:terminated', (agent) => {
      this.unregisterAgent(agent)
    })
  }
  
  publish(topic: string, message: AgentMessage): void {
    const topicInstance = this.getOrCreateTopic(topic)
    topicInstance.publish(message)
    
    // Persist if enabled
    if (this.config.persistence) {
      this.persistMessage(message)
    }
  }
  
  subscribe(topic: string, handler: MessageHandler): Unsubscribe {
    const topicInstance = this.getOrCreateTopic(topic)
    return topicInstance.subscribe(handler)
  }
  
  send(agentId: string, message: AgentMessage): void {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`)
    }
    
    agent.receiveMessage(message)
  }
  
  fanOut(message: AgentMessage, recipients: string[]): void {
    for (const recipient of recipients) {
      this.send(recipient, { ...message, to: recipient })
    }
  }
  
  broadcast(message: AgentMessage): void {
    for (const [agentId, agent] of this.agents) {
      if (agentId !== message.from) {
        agent.receiveMessage({ ...message, to: agentId })
      }
    }
  }
}
```

### 6.4 Self-Healing Module

**Purpose:** Automatically recover from agent failures.

```typescript
interface SelfHealingConfig {
  maxRetries: number
  retryDelay: number          // Base delay in ms
  backoffMultiplier: number   // Exponential backoff
  contextTransferEnabled: boolean
  escalationThreshold: number // Failures before escalation
}

class SelfHealingModule implements NexusModule {
  name = 'self-healing'
  
  private failureCounts: Map<string, number>
  private healthStatus: Map<string, HealthStatus>
  
  async handleFailure(agent: Agent, error: Error): Promise<RecoveryAction> {
    const failureCount = this.failureCounts.get(agent.id) ?? 0
    this.failureCounts.set(agent.id, failureCount + 1)
    
    // Determine recovery action
    if (failureCount < this.config.maxRetries) {
      // Retry with same or different model
      const delay = this.config.retryDelay * 
        Math.pow(this.config.backoffMultiplier, failureCount)
      
      return {
        type: 'retry',
        delay,
        newModel: failureCount > 1 ? this.selectFallbackModel(agent) : undefined,
        contextTransfer: this.config.contextTransferEnabled
      }
    }
    
    if (failureCount < this.config.escalationThreshold) {
      // Respawn with fresh context
      return {
        type: 'respawn',
        contextTransfer: true,
        newModel: this.selectFallbackModel(agent)
      }
    }
    
    // Escalate to user
    return {
      type: 'escalate'
    }
  }
  
  async transferContext(
    oldAgent: Agent, 
    newAgent: Agent
  ): Promise<void> {
    // Transfer partial results
    const partialResults = await oldAgent.getPartialResults()
    await newAgent.setContext('partialResults', partialResults)
    
    // Transfer decisions made
    const decisions = await oldAgent.getDecisions()
    await newAgent.setContext('decisions', decisions)
    
    // Transfer shared memory changes
    const memoryChanges = await oldAgent.getMemoryChanges()
    for (const change of memoryChanges) {
      await newAgent.applyMemoryChange(change)
    }
  }
}
```

### 6.5 Shared Memory Module

**Purpose:** Enable cross-agent memory sharing.

```typescript
interface SharedMemoryConfig {
  storage: 'sqlite' | 'memory'
  persistencePath?: string
  syncInterval: number        // Sync interval in ms
  maxEntriesPerScope: number
}

class SharedMemoryModule implements NexusModule {
  name = 'shared-memory'
  
  private store: MemoryStore
  private subscribers: Map<string, MemoryChangeHandler[]>
  
  async setup(orchestrator: NexusOrchestrator): Promise<void> {
    // Initialize storage
    this.store = await this.createStore()
    
    // Register memory tools for agents
    orchestrator.registerTool({
      name: 'memory_get',
      description: 'Get a value from shared memory',
      execute: async (input, context) => {
        return this.store.get(input.scope, input.key)
      }
    })
    
    orchestrator.registerTool({
      name: 'memory_set',
      description: 'Set a value in shared memory',
      execute: async (input, context) => {
        this.store.set(input.scope, input.key, input.value, {
          author: context.agentId,
          tags: input.tags
        })
      }
    })
    
    orchestrator.registerTool({
      name: 'memory_search',
      description: 'Search shared memory',
      execute: async (input, context) => {
        return this.store.search(input.query, input.scope)
      }
    })
  }
  
  // Reactive memory changes
  onChange(handler: MemoryChangeHandler): Unsubscribe {
    this.subscribers.get('*')?.push(handler)
    return () => {
      const handlers = this.subscribers.get('*') ?? []
      this.subscribers.set('*', handlers.filter(h => h !== handler))
    }
  }
}
```

### 6.6 Dashboard Module

**Purpose:** Real-time web UI for monitoring orchestrator state.

```typescript
interface DashboardConfig {
  port: number
  host: string
  auth?: {
    type: 'basic' | 'token'
    credentials: string
  }
  refreshInterval: number
}

class DashboardModule implements NexusModule {
  name = 'dashboard'
  
  private server: Server
  private wsServer: WebSocketServer
  private state: DashboardState
  
  async setup(orchestrator: NexusOrchestrator): Promise<void> {
    // Create HTTP server
    this.server = createServer()
    
    // Create WebSocket server for real-time updates
    this.wsServer = new WebSocketServer({ server: this.server })
    
    // Subscribe to orchestrator events
    orchestrator.on('*', (event) => {
      this.state.update(event)
      this.broadcastState()
    })
    
    // Start server
    this.server.listen(this.config.port, this.config.host)
  }
  
  private broadcastState(): void {
    const state = this.state.serialize()
    this.wsServer.clients.forEach(client => {
      client.send(JSON.stringify(state))
    })
  }
}
```

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
  // Configuration
  static preset(name: 'minimal' | 'balanced' | 'enterprise' | 'cost-optimized'): NexusOrchestrator
  use(module: NexusModule): this
  
  // Core operations
  async execute(request: ExecutionRequest): Promise<ExecutionResult>
  async spawnAgent(config: SpawnConfig): Promise<Agent>
  async terminateAgent(agentId: string): Promise<void>
  
  // Query
  getAgents(): Agent[]
  getAgent(agentId: string): Agent | undefined
  getDAG(): DAG
  getCostReport(): CostReport
  getMemory(scope: MemoryScope): MemoryEntry[]
  
  // Events
  on(event: string, handler: EventHandler): Unsubscribe
  emit(event: string, data: unknown): void
}
```

### 8.2 Tool Registration

Nexus registers the following tools for agents:

| Tool | Description | Parameters |
|------|-------------|------------|
| `nexus_status` | Get orchestrator status | `{ detailed?: boolean }` |
| `nexus_agents` | List all agents | `{ filter?: AgentFilter }` |
| `nexus_tasks` | List all tasks | `{ filter?: TaskFilter }` |
| `nexus_costs` | Get cost report | `{ period?: TimePeriod }` |
| `nexus_memory_get` | Get shared memory | `{ scope: MemoryScope, key: string }` |
| `nexus_memory_set` | Set shared memory | `{ scope: MemoryScope, key: string, value: unknown }` |
| `nexus_memory_search` | Search memory | `{ query: string, scope?: MemoryScope }` |
| `nexus_send` | Send message to agent | `{ to: string, message: AgentMessage }` |
| `nexus_broadcast` | Broadcast message | `{ message: AgentMessage }` |
| `nexus_request_review` | Request code review | `{ file: string, focus?: string }` |

### 8.3 Slash Commands

| Command | Description |
|---------|-------------|
| `/nexus status` | Show orchestrator status |
| `/nexus agents` | List active agents |
| `/nexus costs` | Show cost breakdown |
| `/nexus pause` | Pause execution |
| `/nexus resume` | Resume execution |
| `/nexus cancel` | Cancel all tasks |
| `/nexus retry` | Retry failed tasks |
| `/nexus dashboard` | Open web dashboard |
| `/nexus memory` | Show shared memory |
| `/nexus help` | Show help |

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
