// Core types for OpenCode Nexus

import type { PricingSource, UsageSource } from "./forecast"
import type { NexusCustomRoleConfig } from "./config"

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
/**
 * One abandoned session, identified. The `uncollected` block used to project
 * only `taskIds`, which threw away the `sessionID`, `agentId` and `model` that
 * `UncollectedSpend` had been storing all along — so the one place the
 * orchestrator admits it is under-billing could not say WHICH session, and a
 * user could not go and look at it.
 *
 * `agentId` is the id the session HAD when we gave up on it, and after a
 * timeout that agent has usually been terminated and removed from
 * `this.agents`, so this row is very often an orphan. That is the point: it is
 * the trail from "we are under-billing" to a session id that can be inspected.
 */
export interface UncollectedSpendEntry {
  sessionID: string
  taskId: string
  /** The agent that owned this session at abandonment; may no longer exist. */
  agentId: string
  model: string
  lastKnownTokens: number
  /** Lower bound on this session's unbilled spend. See above. */
  observedUncollected: number
}

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
  /**
   * The same sessions, identified. `taskIds` is a projection of this and stays
   * because it is what the existing consumers read; this is the full record.
   */
  entries: UncollectedSpendEntry[]
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
  /**
   * How sure the WRITER was, on a 0–1 scale. `null` when they did not say.
   *
   * Nullable because a default is a guess presented as a fact. An earlier
   * version defaulted this to `1.0` and had `setMemory` hardcode it, so every
   * entry in the store carried a confidence nobody had expressed — and the
   * retrieval path rendered it, which made an unexpressed confidence
   * indistinguishable from a considered one. A reader discounting a doubtful
   * note cannot discount a `1.0` that means only "nobody said otherwise".
   *
   * `null` renders as "not stated" and is NOT a low value. An entry that
   * declined to state a confidence is not a claim of uncertainty; it is an
   * absence, and the two must not be conflated.
   */
  confidence: number | null
  tags: string[]
  ttl?: number
}

/**
 * The scopes `MemoryScope` admits, split by whether they may be injected into
 * an agent's prompt automatically.
 *
 * `INJECTABLE_SCOPES` is the whole automatic-retrieval allowlist, and it is a
 * one-element list. Two independent barriers keep `session` out, and both are
 * load-bearing:
 *
 * 1. KEY CONVENTION. An auto-injected key is `file:<path>` or a `text:` slug
 *    (see `src/memory-recall.ts`). The only `session` writer in the codebase
 *    keys `context:<agentId>`, which cannot produce either shape.
 * 2. THIS ALLOWLIST. Barrier 1 alone is not enough, because a `session` entry
 *    is a CARRIER: `collectContext` copies the failing agent's own existing
 *    memory entries into the blob it stores, so one escalation's blob can
 *    contain another agent's content. Only never reading the row stops that.
 *
 * `learning` is excluded for a different reason and it is a trap rather than a
 * policy: `'learning'` as a `MemoryScope` is an unused string in this table,
 * and it shares a name with a DIFFERENT mechanism — `src/learning.ts` — which
 * is an in-memory `Map`, is never persisted, and is written automatically on
 * every task failure. Wiring automatic injection to that scope would either do
 * nothing or smuggle automatic writing in through the back door, which is the
 * one thing this feature is built not to do.
 */
export const INJECTABLE_SCOPES = ['project'] as const satisfies readonly MemoryScope[]

export type MemoryScope = 'project' | 'session' | 'learning' | 'temp'

/**
 * What one spawn injected into its prompt, and how big it was.
 *
 * Exists so the cost of automatic retrieval is a NUMBER rather than an
 * inference. The injected block is prepended to the task prompt and
 * `readSessionTokens` counts it in `input`, so the bill is accurate — but
 * nothing in the cost report says how much of a task's input was a note a human
 * wrote once, and an uncapped block would be an uncapped bill. `characters` is
 * the figure that makes a prompt-weight regression visible.
 */
export interface LastRecall {
  agentId: string
  taskId: string
  taskName: string
  /** Notes actually rendered. Never more than the block's cap. */
  notes: number
  /** Length of the rendered block in characters; 0 when nothing was injected. */
  characters: number
}

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
  /**
   * There is deliberately NO `memory` block here, and its absence is the
   * decision rather than an oversight.
   *
   * This interface used to carry `memory: { enabled, storage,
   * maxEntriesPerScope, syncInterval }`. Nothing read any of it: not the
   * orchestrator, not the store, not the config file parser. `enabled` was
   * never a gate on anything — the store was unreachable from a tool because no
   * tool existed, not because a switch said so — and `maxEntriesPerScope` was
   * written into the defaults literal at `orchestrator.ts` and read by no
   * consumer. A config block whose fields are inert is worse than no block,
   * because a user who sets `memory.enabled: false` believes they have turned
   * something off, and the only evidence they have is that it did not work.
   *
   * REMOVED rather than wired, because with no automatic writing an expiry
   * would delete a note permanently: nothing revalidates, refreshes or
   * re-writes, so a TTL is not a cache policy here, it is data loss with a
   * delay. "Nothing expires" is the honest default, and a knob offering
   * otherwise was a lie.
   *
   * This is a BREAKING type change for any external caller passing a
   * `memory` block in a `NexusConfig` literal. It is called out in the release
   * notes; the fix is to delete the block, because it was already doing
   * nothing.
   */
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
  dashboard: {
    enabled: boolean
    port: number
    host: string
  }
  notifications: {
    /**
     * Whether OS notifications are sent. Reaches
     * `NotificationManager.setEnabled()` through the single gate in
     * `NexusOrchestrator.sendNotification()`.
     */
    enabled: boolean
  }
  /**
   * The git convention layer: on by default, and VALIDATING rather than
   * blocking.
   *
   * OPTIONAL, for the same reason `cost` and `customRoles` are: `NexusConfig`
   * is an exported type, and a new REQUIRED block would stop every external
   * literal from compiling for a field those callers never set. `mergeConfig`
   * fills in the defaults, so an omitted block behaves exactly as a configured
   * one.
   *
   * FILE-SETTABLE under the same key in `nexus.jsonc` — this block is the
   * constructor seed of the ONE `gitFlow` block, beneath the project and global
   * files. Every consumer resolves through the single gate in
   * `src/git-flow.ts` (`resolveGitFlow`), which is also where the per-repo
   * "ask once" decision is applied.
   *
   * Nothing in `src/` writes to git on the strength of this block.
   */
  gitFlow?: {
    /** Whether the convention applies at all. */
    enabled: boolean
    /** Whether commit subjects are held to Conventional Commits. */
    conventionalCommits: boolean
    /** Whether agents are told to work on a branch, not the default one. */
    requireBranch: boolean
    /** Whether agents are told to open a PR rather than merge. */
    prBeforeMerge: boolean
  }
  /**
   * Custom agent roles, as a programmatic starting point.
   *
   * OPTIONAL, for the same reason `cost` is: `NexusConfig` is an exported type
   * and a new REQUIRED block would stop every external literal from compiling.
   * `mergeConfig` carries an omitted one through as absent, which resolves to
   * "no roles" exactly as an empty list does.
   *
   * FILE-SETTABLE under the same key in `nexus.jsonc` — this block is the
   * constructor seed of the ONE `customRoles` block, beneath the project and
   * global files, so a role defined in the file replaces this list and a role
   * defined here survives a file that says nothing about it.
   */
  customRoles?: NexusCustomRoleConfig[]
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
