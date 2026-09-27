// Core types for OpenCode Nexus

import type { PricingSource, UsageSource } from "./forecast"
import type { NexusCustomRoleConfig } from "./config"
import type { ModelEffort } from "./model-ref"

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
  /**
   * The `#variant` half of the reference, WITHOUT the `#` — the effort level
   * the model was asked to run at, or `undefined` when the reference carried
   * none.
   *
   * It has to be a field of its own rather than being folded into `model`,
   * because `model` is the bare id and every consumer that rebuilds a key does
   * so from `provider` + `model`. A variant carried in the string alone is
   * dropped the moment anyone slices the id off, and the failure is silent:
   * the spawn falls back to the default model while the record still claims
   * `m#high`. See `src/model-ref.ts` and `ModelScore.variant`.
   *
   * A variant changes the REQUEST, not the price — `ModelVariant` carries no
   * `cost`. Effort moves token volume, which the measured path already prices
   * correctly, because reasoning tokens are billed separately from output.
   */
  variant?: string
  estimatedCost: number
  estimatedQuality: number
  reasoning: string
}

export interface BudgetConstraint {
  maxTotalCost: number
  /**
   * The per-TASK advisory ceiling, in USD. Reaches `checkTaskBudget`, which
   * attributes every charge to a task and notifies the first time one task's
   * running total crosses this.
   *
   * ADVISORY, and the word matters: nothing here can interrupt a turn that is
   * already running, because the cost of a turn is only known once it returns
   * or times out. So this reports an overspend after the fact and refuses
   * nothing — the same relationship `maxTotalCost` has to `hardLimit`, which is
   * also advisory unless a user opts into the terminal behaviour. What it buys
   * is the one thing the total cap cannot give: WHICH task ran the bill up.
   *
   * It reaches the user as an OS notification, not as an emitted event. See
   * `checkTaskBudget` for why there is deliberately no `budget:task-exceeded`
   * on the event bus.
   */
  maxCostPerTask: number
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
  /**
   * There is deliberately NO `defaultRole` and NO `spawnDelay` here.
   *
   * Both lived in this block and were read by nothing: every spawn takes its
   * role from `DAGNode.task.requiredRole` (see `spawnAndExecute`), and
   * `spawnAgent` has no delay of its own — agents are dispatched by
   * `maxConcurrency` and the scheduler interval, and the throttle that exists
   * is the concurrency limit itself. A `defaultRole` a user set would be
   * silently ignored by every task that names its own role, which is all of
   * them.
   *
   * `healthCheckInterval` — the third field, in the same literal — IS read, at
   * the `HealthMonitor` construction in `initialize()` and in
   * `cleanupStaleData`, and stays.
   *
   * This is a BREAKING type change for any external caller passing either field
   * in a `NexusConfig` literal. Neither ever had an effect to lose.
   */
  agents: {
    healthCheckInterval: number
  }
  /**
   * There is deliberately NO `backoffMultiplier` in this block.
   *
   * It was here, defaulted to 2, and read by nothing. The retry backoff in
   * `handleFailure` is `policy.retryDelay * Math.pow(2, retryCount)` with the
   * base 2 written into the expression — so the field could only ever have
   * restated a constant that was already there, and a user who set it to 3
   * would have watched 1s/2s/4s continue regardless.
   *
   * DELETED, not wired: unlike `retryDelay` there is no reading of this that
   * adds capability. A multiplier of 1 would turn the backoff off, which is
   * what a user wanting fast retries should do by setting `retryDelay` to
   * something small — and a multiplier that can be set to 0 would make the
   * wait `NaN`. `retryDelay` and `maxRetries` are the two knobs that carry
   * meaning here, and both are read.
   *
   * `selfHealing` consequently has FOUR fields, and `NexusFullConfig` now has
   * all four too — `retryDelay` was the one that was reachable only through the
   * constructor and invisible to `nexus.jsonc`, which is what made the two
   * shapes disagree in the first place.
   *
   * This is a BREAKING type change for any external caller passing
   * `backoffMultiplier` in a `NexusConfig` literal. It never had an effect to
   * lose.
   */
  selfHealing: {
    enabled: boolean
    maxRetries: number
    /**
     * The BASE of the retry backoff, in ms; attempt `n` waits
     * `retryDelay * 2 ** n`. Reaches `DEFAULT_ESCALATION` via the
     * `escalationPolicy` construction in the orchestrator's constructor, and is
     * FILE-SETTABLE under the same key — see `NexusFullConfig.selfHealing`.
     */
    retryDelay: number
    contextTransfer: boolean
  }
  /**
   * There is deliberately NO `security` block here, and `src/security.ts` is
   * worth reading to see what that is not.
   *
   * This block used to carry `{ sastEnabled, secretsScanning,
   * scopeEnforcement }`. Nothing read any of it. `SecurityScanner` — the real
   * module, and a live one: constructed at `orchestrator.ts`, run over every
   * task's output there, exposed through the `nexus.security.scan` tool, and
   * covered by `test/security.test.ts` — takes its settings from its OWN
   * `SecurityConfig` (`enabled`, `scanSecrets`, `scanPatterns`,
   * `customPatterns`, `excludeFiles`) and has since before this block was ever
   * written. The two never met: not one field name is shared, and
   * `scopeEnforcement` describes a capability `SecurityScanner` does not have
   * in any form. This was scaffolding written in a vocabulary the module
   * adopted differently, not a connection that was made and then lost.
   *
   * DELETED rather than wired. Making the scanner configurable from
   * `nexus.jsonc` is a real gap worth closing, but it is a NEW file-settable
   * block built on the module's own field names — an additive product
   * decision, not a repair, and doing it here would have meant inventing the
   * wiring rather than restoring one.
   *
   * This is a BREAKING type change for any external caller passing a `security`
   * block in a `NexusConfig` literal. It never had an effect to lose.
   */
  /**
   * There is deliberately NO `communication` block here.
   *
   * It used to carry `{ mode, maxQueueSize, messageTTL, persistence }`. No
   * reader anywhere, and nothing in `src/` answers to any of the four:
   * `MessageStore` is configured through its own constructor parameter
   * (`MessageStoreConfig.maxMessages` / `.rotationSize` — different names, and
   * not reachable from a `NexusConfig` literal at all), and `MessageRouter`
   * takes no settings. `mode: 'pubsub'` described a dispatch policy nothing
   * dispatches on, and `maxQueueSize: 100` bounded no queue — the message
   * store's own bound is 10,000.
   *
   * REMOVED for the same reason the `memory` block above was: a block whose
   * fields are inert is worse than no block, because a user who sets
   * `communication.messageTTL` has no evidence but the silence.
   *
   * This is a BREAKING type change for any external caller passing a
   * `communication` block in a `NexusConfig` literal.
   */
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
   * Effort selection: whether the orchestrator asks a model for a reasoning
   * effort matched to the task's difficulty.
   *
   * OPTIONAL, for the same reason `gitFlow` is: `NexusConfig` is an exported
   * type, and a new REQUIRED block would stop every external literal from
   * compiling for a field those callers never set.
   *
   * FILE-SETTABLE under the same key in `nexus.jsonc` — this block is the
   * constructor seed of the ONE `effort` block, beneath the project and global
   * files. Every consumer resolves through the single gate in
   * `selectBestModel`, and no other file in `src/` reads it.
   *
   * It changes the REQUEST, never the price: `ModelVariant` carries no `cost`,
   * so `ModelPricingTiers` has no variant axis and none was added. A variant
   * moves token volume, which the measured path already bills as reasoning
   * tokens. See `NexusEffortConfig` in `src/config.ts` for each key.
   */
  effort?: {
    /** Whether an effort is chosen automatically. */
    enabled: boolean
    /** The highest effort any task may be asked for. */
    maxEffort: ModelEffort
    /** The `0-100` difficulty below which no effort is chosen. */
    minDifficulty: number
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
   * `memory` and `learning`, and that now also excludes `security` and
   * `communication`, both of which have been deleted outright rather than left
   * unread (see the notes on those two). This block is settable through the
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
