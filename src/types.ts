// Core types for OpenCode Nexus

import type { PricingSource, UsageSource } from "./forecast"

/**
 * How a task's cost and token count were arrived at. `usage` says whether the
 * tokens were real, `pricing` says whether the rate was real.
 *
 * Declared here, in the leaf type module, rather than in `orchestrator.ts`
 * where it was introduced: `PerformanceEntry` and `ExecutionRecord` must carry
 * it too, and they are consumed by the tracker, the history and the tool layer
 * — none of which may import the orchestrator. `orchestrator.ts` re-exports
 * this name, so the public surface is unchanged.
 */
export interface CostProvenance {
  usage: UsageSource
  pricing: PricingSource
}

export interface Agent {
  id: string
  name: string
  role: AgentRole
  status: AgentStatus
  model: ModelSelection
  spawnedAt: Date
  lastActivity: Date
  metrics: AgentMetrics
  sessionID?: string
  complexity?: ComplexityScore
}

export type AgentRole = 
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'explorer'
  | 'documenter'
  | string

export type AgentStatus = 
  | 'spawning'
  | 'idle'
  | 'working'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'terminated'

export interface AgentMetrics {
  tasksCompleted: number
  tasksFailed: number
  totalTokens: number
  totalCost: number
  averageResponseTime: number
  errorRate: number
}

export interface Task {
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
  status: TaskStatus
  result?: TaskResult
  assignedAgent?: string
}

export type TaskStatus = 
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TaskResult {
  success: boolean
  output?: string
  error?: string
  filesChanged?: string[]
  duration: number
  tokensUsed: number
  cost: number
}

export interface ComplexityScore {
  overall: number        // 0-100
  factors: {
    fileCount: number
    codeLines: number
    dependencyDepth: number
    domainKnowledge: number
    riskLevel: 'low' | 'medium' | 'high'
  }
}

export interface FileScope {
  include: string[]
  exclude?: string[]
}

export interface RetryPolicy {
  maxRetries: number
  backoffMs: number
  backoffMultiplier: number
}

export interface DAGNode {
  id: string
  task: Task
  dependencies: string[]
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result?: TaskResult
  spawnedAgent?: Agent
}

export interface DAG {
  nodes: Map<string, DAGNode>
  addNode(node: DAGNode): void
  addDependency(nodeId: string, dependsOn: string): void
  removeNode(nodeId: string): void
  getReadyNodes(): DAGNode[]
  markComplete(nodeId: string, result: TaskResult): void
  markFailed(nodeId: string, error: Error): void
  getParallelGroups(): DAGNode[][]
  isComplete(): boolean
}

export interface ModelSelection {
  provider: string
  model: string
  estimatedCost: number
  estimatedQuality: number
  reasoning: string
}

export interface BudgetConstraint {
  maxTotalCost: number
  maxCostPerTask: number
  maxCostPerAgent: number
  alertThreshold: number
  hardLimit: boolean
}

export interface CostReport {
  totalSpent: number
  budgetRemaining: number
  byAgent: Map<string, AgentCost>
  byModel: Map<string, ModelCost>
  timeline: CostTimeline[]
}

export interface AgentCost {
  agentId: string
  agentName: string
  totalCost: number
  tokenCount: number
  taskCount: number
}

export interface ModelCost {
  model: string
  provider: string
  totalCost: number
  tokenCount: number
  callCount: number
}

export interface CostTimeline {
  timestamp: Date
  cost: number
  tokens: number
  agent?: string
}

/**
 * Sessions whose cost stopped being collected while they were still running.
 *
 * A timed-out task is not aborted, so its session keeps spending after the
 * orchestrator has given up on it. Some of that spend is recovered — the
 * remainder is billed when the session goes idle — but a session that never
 * settles in the grace window is abandoned, and the part of its cost that was
 * never read is reported HERE rather than silently dropped. Dropping it would
 * be the original bug at a smaller scale.
 *
 * `observedUncollected` is a LOWER BOUND ON THE UNDER-COUNT, and the direction
 * matters. It is the priced value of the increment seen between the last
 * charge and the last read — spend that demonstrably happened and was
 * demonstrably not billed. Everything the session spends AFTER that last read
 * is also unbilled, and on a session abandoned while still generating that
 * remainder grows without limit, so the true under-count is unbounded above
 * and this figure is only where it is known to start. An earlier version of
 * this field was called `upperBound` and described as "we are under-counting by
 * at most $X", which asserts the opposite of what is knowable from a single
 * observation; there is no upper bound derivable here, because the session may
 * never stop.
 *
 * It is deliberately NOT added to `totalSpent`: adding an estimate to a
 * measured total is the conflation `CostProvenance` exists to prevent, and a
 * total containing a guess can no longer be compared against a budget
 * honestly.
 */
export interface CostReportUncollected {
  /** How many sessions are still uncollected. */
  sessions: number
  /** Sum of each session's last successfully read token count. */
  lastKnownTokens: number
  /**
   * Priced value of the increment observed but not charged, in USD. A LOWER
   * bound on the under-count, and not part of `totalSpent`. See above.
   */
  observedUncollected: number
  /** The DAG node ids whose sessions were abandoned. */
  taskIds: string[]
}

export interface AgentMessage {
  id: string
  from: string
  to?: string
  topic?: string
  type: MessageType
  payload: unknown
  timestamp: Date
  metadata: MessageMetadata
}

export type MessageType = 
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

export interface MessageMetadata {
  priority: 'low' | 'normal' | 'high' | 'critical'
  requiresResponse: boolean
  ttl?: number
}

export interface MemoryEntry {
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

export type MemoryScope = 'project' | 'session' | 'learning' | 'temp'

export interface ExecutionRequest {
  tasks: Task[]
  budget?: BudgetConstraint
  options?: ExecutionOptions
}

export interface ExecutionOptions {
  maxConcurrency?: number
  isolatedWorktrees?: boolean
  enableSelfHealing?: boolean
  enableCommunication?: boolean
}

/**
 * How a total was arrived at, split into what was measured and what was
 * predicted. `measuredSpend + estimatedSpend` is the figure the field it
 * qualifies carries, so a mixed total is legible from the number alone.
 */
export interface SpendSplit {
  measuredSpend: number
  estimatedSpend: number
}

export interface ExecutionResult {
  success: boolean
  tasks: TaskResult[]
  /**
   * A LOWER BOUND, and deliberately not a live object and not a promise.
   *
   * It is `totalSpent` at the instant `execute` returned. A task that timed out
   * has already been charged at the instant of its timeout, but its session is
   * NOT aborted: it keeps generating and keeps spending after the run returns,
   * and the remainder is billed later, when the session finally goes idle
   * (`cost:delta`) or is reported as an uncollected bound
   * (`CostReport.uncollected`).
   *
   * A caller that needs the final figure must read `getCostReport()` after
   * settlement has had a chance to happen, or subscribe to `cost:delta`. A
   * figure that included a not-yet-observed increment would be a prediction
   * wearing a measured number's clothes, which is the one thing
   * `CostProvenance` exists to prevent.
   */
  totalCost: number
  /**
   * Split of `totalCost`. Required rather than optional: `totalCost` is the
   * headline figure handed back to the caller, and a run in which most tasks
   * fell back to estimates must not be readable as a fully billed total. This
   * is the same accounting `getCostReport()` reports, over the same
   * `totalSpent` window, so the two cannot disagree.
   */
  measuredSpend: number
  estimatedSpend: number
  totalDuration: number
  agentsUsed: number
}

export interface RecoveryAction {
  type: 'retry' | 'respawn' | 'fallback' | 'escalate'
  delay?: number
  newModel?: string
  contextTransfer?: boolean
  maxRetries?: number
}

export interface HealthStatus {
  agentId: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'dead'
  lastActivity: Date
  errorCount: number
  responseTime: number
  tokensPerSecond: number
}

export interface SpawnConfig {
  role: AgentRole
  task?: Task
  model?: string
  worktree?: boolean
  context?: Record<string, unknown>
}

export interface NexusConfig {
  maxConcurrency: number
  schedulerInterval: number
  defaultTimeout: number
  budget: BudgetConstraint
  agents: {
    defaultRole: AgentRole
    spawnDelay: number
    healthCheckInterval: number
  }
  selfHealing: {
    enabled: boolean
    maxRetries: number
    retryDelay: number
    backoffMultiplier: number
    contextTransfer: boolean
  }
  communication: {
    mode: 'pubsub' | 'direct' | 'hybrid'
    maxQueueSize: number
    messageTTL: number
    persistence: boolean
  }
  memory: {
    enabled: boolean
    storage: 'sqlite' | 'memory'
    maxEntriesPerScope: number
    syncInterval: number
  }
  dashboard: {
    enabled: boolean
    port: number
    host: string
  }
  security: {
    sastEnabled: boolean
    secretsScanning: boolean
    scopeEnforcement: boolean
  }
  learning: {
    enabled: boolean
    patternStorage: 'sqlite' | 'memory'
    minConfidence: number
  }
  /**
   * Cost-accounting knobs.
   *
   * OPTIONAL, deliberately: `NexusConfig` is an exported type, and a new
   * REQUIRED block would stop every external `NexusConfig` literal from
   * compiling for a field those callers never set. `mergeConfig` fills in the
   * defaults, so an omitted block behaves exactly as a configured one.
   *
   * NOT REACHABLE FROM A CONFIG FILE. `NexusConfigManager` models only
   * `models`, `budget` and `selfHealing` — the same short list that excludes
   * `memory`, `security` and `learning`. This block is settable through the
   * `NexusOrchestrator` constructor only, and it is documented that way rather
   * than as user-configurable, because it is not.
   */
  cost?: {
    /**
     * How long after a task's timeout the orchestrator keeps waiting for that
     * task's session to go idle before abandoning collection of its remaining
     * cost.
     *
     * OMIT THIS to get the derived default, which is roughly HALF the task's
     * own budget clamped to [30s, 180s] — by the time the clock runs out the
     * session is already one model call past a limit that was generous, and a
     * session that still has not settled within half of its own budget again is
     * pathological rather than slow. Setting it to a number replaces the
     * derived window outright rather than adjusting it.
     */
    timeoutDeltaGraceMs: number
  }
}
