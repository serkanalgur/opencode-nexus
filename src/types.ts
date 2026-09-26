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
}
