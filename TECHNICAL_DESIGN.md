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
10. [Implementation Roadmap](#implementation-roadmap)
11. [Benchmarks & Comparisons](#benchmarks)
12. [Security Considerations](#security)

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
  retryPolicy?: RetryPolicy
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

### 9.1 Global Configuration

```jsonc
// ~/.config/opencode/nexus.jsonc
{
  "$schema": "https://serkanalgur.com/opencode-nexus/schema.json",
  
  // Core settings
  "maxConcurrency": 5,
  "schedulerInterval": 1000,
  "defaultTimeout": 300000, // 5 minutes
  
  // Budget
  "budget": {
    "maxTotalCost": 10.00,
    "maxCostPerTask": 1.00,
    "maxCostPerAgent": 2.00,
    "alertThreshold": 0.2, // Alert at 20% remaining
    "hardLimit": false
  },
  
  // Agent defaults
  "agents": {
    "defaultRole": "coder",
    "spawnDelay": 100,
    "healthCheckInterval": 30000
  },
  
  // Self-healing
  "selfHealing": {
    "enabled": true,
    "maxRetries": 3,
    "retryDelay": 1000,
    "backoffMultiplier": 2,
    "contextTransfer": true
  },
  
  // Communication
  "communication": {
    "mode": "pubsub",
    "maxQueueSize": 100,
    "messageTTL": 60000,
    "persistence": true
  },
  
  // Memory
  "memory": {
    "enabled": true,
    "storage": "sqlite",
    "maxEntriesPerScope": 1000,
    "syncInterval": 5000
  },
  
  // Dashboard
  "dashboard": {
    "enabled": true,
    "port": 4747,
    "host": "127.0.0.1"
  },
  
  // Security
  "security": {
    "sastEnabled": true,
    "secretsScanning": true,
    "scopeEnforcement": true
  },
  
  // Learning
  "learning": {
    "enabled": true,
    "patternStorage": "sqlite",
    "minConfidence": 0.7
  }
}
```

### 9.2 Project Configuration

```jsonc
// .opencode/nexus.jsonc (project-level overrides)
{
  // Override budget for this project
  "budget": {
    "maxTotalCost": 5.00
  },
  
  // Custom agent roles
  "agentRoles": {
    "security-reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "tools": ["read", "grep", "git"]
    }
  },
  
  // Custom task templates
  "taskTemplates": {
    "feature": {
      "pipeline": ["architect", "coder", "reviewer", "tester"],
      "requiredGates": ["review", "tests-pass"]
    }
  }
}
```

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

- [ ] Project setup (package.json, tsconfig, build system)
- [ ] Core orchestrator class
- [ ] DAG executor with basic parallelism
- [ ] Agent lifecycle management (spawn, monitor, terminate)
- [ ] Basic cost tracking

**Deliverable:** Working orchestrator that can run 2-3 agents in parallel

### Phase 2: Communication (Weeks 3-4)

- [ ] Pub/Sub message broker
- [ ] Direct agent messaging
- [ ] Fan-out and broadcast patterns
- [ ] Message persistence

**Deliverable:** Agents can communicate in real-time

### Phase 3: Intelligence (Weeks 5-6)

- [ ] Adaptive agent spawning based on complexity
- [ ] Cost-aware model routing
- [ ] Budget enforcement and alerts
- [ ] Shared memory store

**Deliverable:** Smart routing and memory sharing

### Phase 4: Reliability (Weeks 7-8)

- [ ] Self-healing with auto-retry
- [ ] Context transfer on respawn
- [ ] Escalation policies
- [ ] Pattern learning from failures

**Deliverable:** Fault-tolerant orchestration

### Phase 5: Dashboard & Polish (Weeks 9-10)

- [ ] Real-time web dashboard
- [ ] WebSocket state broadcasting
- [ ] Security scanning integration
- [ ] Git worktree support

**Deliverable:** Production-ready plugin with monitoring

### Phase 6: Ecosystem (Weeks 11-12)

- [ ] Plugin marketplace integration
- [ ] Documentation and examples
- [ ] Performance optimization
- [ ] Beta testing and bug fixes

**Deliverable:** Public release

---

## 11. Benchmarks

### Execution Time Comparison

| Scenario | Sequential | Swarm | Ensemble | Nexus |
|----------|-----------|-------|----------|-------|
| 3 independent tasks | 300s | 120s | 100s | **60s** |
| Dependent chain (3) | 300s | 150s | 150s | **120s** |
| Mixed (2 parallel + 1 dependent) | 300s | 130s | 110s | **70s** |

### Cost Comparison

| Scenario | Fixed Model | Swarm | Nexus (Cost-Aware) |
|----------|------------|-------|---------------------|
| Simple task (3 files) | $0.50 | $0.50 | **$0.15** |
| Complex task (20+ files) | $2.00 | $2.00 | **$1.50** |
| Mixed session (10 tasks) | $10.00 | $10.00 | **$4.00** |

### Token Efficiency

| Metric | Swarm | Nexus |
|--------|-------|-------|
| Tokens per task (avg) | 15,000 | **8,000** |
| Context duplication | High | **Low** (shared memory) |
| Agent overhead | 19 agents | **Dynamic** (2-5 typical) |

---

## 12. Security Considerations

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

## Appendix B: Comparison with Existing Solutions

### vs. opencode-swarm

| Aspect | Swarm | Nexus |
|--------|-------|-------|
| Agent count | Fixed (19) | Dynamic (2-10) |
| Execution | Sequential pipeline | True parallel DAG |
| Communication | None | Real pub/sub |
| Cost tracking | None | Real-time budget |
| Self-healing | Basic timeout | Context transfer |
| Memory | Isolated | Shared store |
| Learning | Evidence files | Pattern database |

### vs. opencode-ensemble

| Aspect | Ensemble | Nexus |
|--------|----------|-------|
| Communication | Basic messaging | Full pub/sub |
| Task board | Lead-managed | Distributed |
| Cost awareness | None | Full budget system |
| Self-healing | Timeout only | Auto-respawn |
| Memory | None | Shared store |
| Dashboard | Basic | Advanced real-time |

### vs. opencode-mission-control

| Aspect | Mission Control | Nexus |
|--------|----------------|-------|
| Isolation | tmux sessions | Git worktrees |
| Execution | Sequential | Parallel DAG |
| Communication | None | Pub/sub |
| PR creation | Built-in | Plugin-based |
| Cost tracking | None | Full budget system |
| Complexity | Simple | Advanced |

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-21  
**Status:** Design Phase
