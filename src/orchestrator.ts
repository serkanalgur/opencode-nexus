import type { Plugin } from "@opencode/plugin"
import type {
  Agent, Task, DAG, DAGNode, ExecutionRequest, ExecutionResult,
  AgentRole, ComplexityScore, ModelSelection, BudgetConstraint,
  CostReport, AgentMessage, MemoryEntry, MemoryScope,
  SpawnConfig, RecoveryAction, HealthStatus, NexusConfig, TaskResult,
  CostProvenance, SpendSplit
} from "./types"
import { NexusConfigManager, type NexusConfigLoadInfo, type NexusConfigReloadTrigger } from "./config"
import { StateBroadcaster } from "./broadcast"
import { DashboardModule } from "./dashboard"
import { detectCycles } from "./dag"
import { MessageStore, type MessageStoreConfig } from "./message-store"
import { PersistentMemoryStore, type MemoryStoreConfig } from "./memory-store"
import { HealthMonitor } from "./health"
import { MessageRouter } from "./fanout"
import { NotificationManager } from "./notifications"
import { LearningModule } from "./learning"
import { ModuleRegistry, type ModuleContext } from "./modules"
import { SecurityScanner } from "./security"
import { PerformanceTracker } from "./performance"
import { ExecutionHistory } from "./history"
import { CustomRoleManager } from "./custom-roles"
import {
  CostForecaster,
  bareModelId,
  selectTier,
  totalTokens,
  type ModelPricingTiers,
  type PricingSource,
  type TokenUsage,
  type UsageSource,
} from "./forecast"
import { WorktreeManager } from "./worktree"
import { TodoEnforcer } from "./todo"

/**
 * Subset of OpenCode's `Tool.Context` that `spawnAgent` needs to fabricate a
 * tool invocation for the built-in `subagent` tool. Passed in from the plugin's
 * tool executor so the child session is linked to the real parent session.
 */
export interface SpawnToolContext {
  sessionID: string
  agent?: string
  messageID?: string
  callID?: string
  signal?: AbortSignal
}

// === OpenCode plugin context ===
//
// This used to be typed `any`, which meant `tsc` could not catch a single wrong
// API call — and the plugin carried several V1-era calls that are dead at
// runtime against OpenCode V2. It is now the real plugin context, so a wrong
// member or a wrong argument shape is a compile error.
//
// Only two things stay hand-written, both because `@opencode/plugin` erases
// them to `any` / `unknown` at the type level:
//   - the `subagent` tool's input schema (runtime-only), and
//   - the `Tool.Context` we fabricate when invoking that tool.

/** The OpenCode V2 plugin context (`@opencode/plugin` 2.0.12). */
export type NexusPluginContext = Plugin.Context

/** One entry of `ctx.session.context()`: a `SessionMessageInfo` union member. */
export type NexusSessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

/**
 * Real pricing for one model, in **USD per 1K tokens**, as a tiered price list.
 *
 * An alias, not a second definition: this is the same type the forecaster
 * resolves, so the `modelCosts` map is handed to `PricingResolver` with no
 * conversion and no possibility of the two sides drifting apart in shape.
 *
 * CHANGELOG NOTE: this is a breaking change to a public, mutable map. `tiers`
 * replaces the flat `{input, output, cacheRead, cacheWrite}` entry, so any
 * out-of-repo reader of `modelCosts` or `getModelCost()` must read
 * `tiers[0].rates` (or `selectTier(...).rates` for a given prompt size).
 */
export type NexusModelCost = ModelPricingTiers

/**
 * One entry of OpenCode's `ModelInfo.cost`, in **USD per MILLION tokens**.
 *
 * Declared structurally rather than imported from `@opencode/plugin`, whose
 * declaration brands every rate as a `Money.USDPerMillionTokens` literal.
 * Those brands carry no information we use, they change the declared `tier`
 * type to a single `"context"` tag, and every field is required — while the
 * data genuinely arrives over a wire and genuinely does omit `cache` on some
 * rows. So the shape is the permissive one and the `tier.type` check below is
 * real at runtime even though the type makes it look redundant.
 */
interface OpenCodeModelCost {
  readonly tier?: { readonly type: string; readonly size: number }
  readonly input?: number
  readonly output?: number
  readonly cache?: { readonly read?: number; readonly write?: number }
}

/**
 * How a task's cost and token count were arrived at. Recorded on every
 * `TaskResult` and every `trackCost` entry so a predicted figure is never read
 * as a billed one: `usage` says whether the tokens were real, `pricing` says
 * whether the rate was real.
 *
 * DECLARED IN `types.ts` and re-exported here under its original name, so the
 * public surface is unchanged while `PerformanceEntry`, `ExecutionRecord` and
 * the tool layer can carry the same type without importing this module.
 */
export type { CostProvenance } from "./types"

/**
 * A `TaskResult` that says how its cost was arrived at. Lives here rather than
 * in `types.ts` only so the provenance travels with the value stored on the DAG
 * node and the execution record, which is where an agent is most likely to
 * encounter a cost that is really an estimate.
 */
export interface CostedTaskResult extends TaskResult {
  costProvenance: CostProvenance
}

/** One task's cost, its token count, and how both were arrived at. */
interface TaskCost {
  cost: number
  tokensUsed: number
  provenance: CostProvenance
}

/** Per-model accounting provenance, so a model with mixed charges is legible. */
interface ModelProvenance {
  usage: UsageSource
  pricing: PricingSource
  measuredEntries: number
  estimatedEntries: number
  measuredSpend: number
  estimatedSpend: number
}

/**
 * The `subagent` tool's input as this plugin invokes it. `ToolInfo["execute"]`'s
 * input parameter is `any` (the tool's schema only exists at runtime), so the
 * shape is declared here and checked at the call site.
 */
export interface SubagentToolInput {
  agent: string
  description: string
  prompt: string
  model: string
  background?: boolean
}

/**
 * The tool context `spawnAgent` fabricates to call the built-in `subagent`
 * tool. Mirrors `Tool.Context` (sessionID, agent, messageID, id, progress)
 * plus the `signal` the plugin's `ToolContext` adds. Narrowed from the real
 * `ToolInfo`, whose `execute` input is `any`.
 */
export interface SubagentToolExecutionContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  progress: (update: { sessionID: string; status: string }) => Promise<void>
  signal: AbortSignal
}

/** The `subagent` tool narrowed to the input shape this plugin uses. */
export interface SubagentTool {
  id: string
  execute(
    input: SubagentToolInput,
    context: SubagentToolExecutionContext
  ): Promise<unknown>
}

/**
 * Text of an assistant message. V2 assistant messages are discriminated by
 * `type` and their text lives in typed `content` parts — there is no `role`
 * field and `content` is an array, not a string.
 *
 * The `part.type === "text"` filter is load-bearing, not a redundant narrowing.
 * A V2 `reasoning` part also carries a `.text` field, so filtering on the
 * presence of `.text` instead — or dropping the filter and concatenating
 * `.text` unconditionally — would silently splice the model's chain of thought
 * into the task output reported back to the caller. Only `text` parts are
 * user-facing output.
 */
export function assistantMessageText(message: NexusSessionMessage): string {
  if (message.type !== "assistant") return ""
  return message.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("")
}

/**
 * Text of the most recent assistant message, or `""` when the session has
 * produced none. Replaces the V1-era `messages.filter(m => m.role ===
 * 'assistant')` read, which never matched and silently degraded every result
 * to a placeholder string.
 */
export function lastAssistantText(messages: readonly NexusSessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== "assistant") continue
    const text = assistantMessageText(messages[i])
    if (text) return text
  }
  return ""
}

/** Sum a numeric field across the per-model provenance records. */
function sumBy<T>(records: Map<string, T>, select: (record: T) => number): number {
  let total = 0
  for (const record of records.values()) total += select(record)
  return total
}

/**
 * A model's base-tier input rate. `selectTier(tiers, 0)` rather than
 * `tiers[0]`: a prompt size of 0 is below every real context threshold, so
 * this is the untiered row by the same rule that prices real usage, instead of
 * trusting an array position that `modelCosts` is public and mutable.
 */
function baseInputRate(cost: NexusModelCost): number {
  return selectTier(cost.tiers, 0).rates.input
}

export interface SpawnOptions {
  /**
   * The tool context of the calling tool. When present (and carrying a
   * `sessionID`), the child session is created through OpenCode's built-in
   * `subagent` tool so OpenCode links it to the parent via `parentID`.
   * When absent (internal scheduler / respawn call sites) a plain
   * `ctx.session.create()` is used, as before.
   */
  toolContext?: SpawnToolContext
  /** Full task text. Required for the subagent-tool path, which delivers it. */
  task?: string
}

/** How a child session was created — lets callers know which path was taken. */
export type SpawnPath = 'subagent-tool' | 'session-create'

export type SpawnedAgent = Agent & { spawnPath?: SpawnPath }

export interface ModelScore {
  model: string
  provider: string
  costScore: number      // 0-1, lower cost = higher score
  qualityScore: number   // 0-1, from estimateModelQuality
  speedScore: number     // 0-1, estimated based on model size
  overallScore: number   // weighted combination
  reasoning: string
}

export interface OrchestratorState {
  running: boolean
  paused: boolean
  agents: Array<{
    id: string
    name: string
    role: string
    status: string
    model: string
    sessionID?: string
    spawnedAt: string
    tasksCompleted: number
    tasksFailed: number
    totalCost: number
  }>
  tasks: Array<{
    id: string
    name: string
    role: string
    priority: string
    status: string
    assignedAgent?: string
    result?: { success: boolean; output?: string; error?: string; duration: number }
  }>
  totalSpent: number
  budgetRemaining: number
  lastUpdated: string
}

export interface EscalationPolicy {
  maxRetries: number
  retryDelay: number
  enableRespawn: boolean
  fallbackModels: string[]
  alertOnFailure: boolean
}

export const DEFAULT_ESCALATION: EscalationPolicy = {
  maxRetries: 3,
  retryDelay: 1000,
  enableRespawn: true,
  fallbackModels: ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4-5'],
  alertOnFailure: true
}

export interface ContextTransferData {
  previousAgentId: string
  partialResults: string[]
  decisions: string[]
  memoryEntries: MemoryEntry[]
  taskProgress: number // 0-100 percentage
  errorLog: string[]
}

export class NexusOrchestrator {
  private agents: Map<string, Agent> = new Map()
  private tasks: Map<string, Task> = new Map()
  private dag: DAG | null = null
  private config: NexusConfig
  public budget: BudgetConstraint
  private running: boolean = false
  private paused: boolean = false
  private budgetExceeded: boolean = false

  // Cost tracking
  public totalSpent: number = 0
  private costByAgent: Map<string, number> = new Map()
  private costByModel: Map<string, number> = new Map()

  // Communication
  private messageQueue: AgentMessage[] = []
  private subscribers: Map<string, ((msg: AgentMessage) => void)[]> = new Map()

  // Message persistence
  public messageStore: MessageStore

  // Memory (SQLite-backed persistent store)
  public memoryStore: PersistentMemoryStore

  // Topic-based fan-out router
  public messageRouter: MessageRouter

  // Event handlers
  private eventHandlers: Map<string, Function[]> = new Map()

  // Config manager
  public configManager: NexusConfigManager

  // OpenCode context (set during initialization)
  public ctx: NexusPluginContext | null = null

  // WebSocket broadcaster (set via initBroadcaster)
  public broadcaster: StateBroadcaster | null = null

  // Dashboard server
  public dashboard: DashboardModule | null = null

  // Health monitor (lazy-initialized via getter)
  private _healthMonitor: HealthMonitor | null = null

  // Learning module for pattern recognition
  public learning: LearningModule

  // Escalation policy for self-healing
  private escalationPolicy: EscalationPolicy

  // Per-node retry counts for escalation tracking
  private nodeRetryCounts: Map<string, number> = new Map()

  // Module registry for composable features
  public moduleRegistry: ModuleRegistry

  // Security scanner for task output scanning
  public securityScanner: SecurityScanner

  // Performance tracker for model/role scoring
  public performanceTracker: PerformanceTracker

  // Execution history tracking
  public executionHistory: ExecutionHistory

  // Custom agent roles defined by the user
  public customRoles: CustomRoleManager

  // Cost forecaster for pre-execution estimates
  public forecaster: CostForecaster

  // Git worktree manager for agent isolation
  public worktreeManager: WorktreeManager | null = null

  // Todo enforcer for task tracking
  public todoEnforcer: TodoEnforcer = new TodoEnforcer()

  // State update callback
  private onStateChange: (() => void) | null = null

  // State change debounce timer
  private stateChangeTimer: ReturnType<typeof setTimeout> | null = null

  // Cost history for periodic cleanup
  private costHistory: Array<{ timestamp: number; cost: number; agentId: string; model: string; tokens: number; provenance: CostProvenance }> = []

  // Token counts per model, and how much of each model's spend was measured
  // rather than predicted. Reported by getCostReport so a mixed total is never
  // read as a fully billed one.
  private tokensByModel: Map<string, number> = new Map()
  private costProvenance: Map<string, ModelProvenance> = new Map()

  // Cleanup interval handle
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  // Lazy-initialized health monitor
  get healthMonitor(): HealthMonitor | null {
    return this._healthMonitor
  }

  // OS notification manager
  public notifications: NotificationManager | null = null

  // Real model pricing from OpenCode (populated via loadModelCosts).
  // Keyed by "providerID/id" (bare ids are not unique across providers) and
  // valued in **USD per 1K tokens** — the same unit as the hardcoded table.
  public modelCosts: Map<string, NexusModelCost> = new Map()

  // Set when a spawn fell back to ctx.session.create() instead of the built-in
  // subagent tool (child session not parent-linked). null when the last spawn
  // used the subagent tool.
  public lastDegradedSpawn: { agentId: string; role: string; reason: 'no-parent-context' | 'subagent-tool-unavailable' } | null = null

  constructor(config?: Partial<NexusConfig>, messageStoreConfig?: Partial<MessageStoreConfig>, memoryStoreConfig?: Partial<MemoryStoreConfig>) {
    this.config = this.mergeConfig(config)
    this.budget = this.config.budget
    this.configManager = new NexusConfigManager()
    this.moduleRegistry = new ModuleRegistry()
    this.messageStore = new MessageStore(messageStoreConfig)
    this.memoryStore = new PersistentMemoryStore(memoryStoreConfig)
    this.messageRouter = new MessageRouter()

    // Initialize escalation policy from config selfHealing settings
    this.escalationPolicy = {
      ...DEFAULT_ESCALATION,
      // Copied, not shared: step 3 escalations `shift()` entries off this list,
      // and a shallow spread would leave every orchestrator instance holding
      // the one array on DEFAULT_ESCALATION — so the first node anywhere to
      // escalate would silently drain the fallbacks for the whole process.
      fallbackModels: [...DEFAULT_ESCALATION.fallbackModels],
      maxRetries: this.config.selfHealing.maxRetries,
      retryDelay: this.config.selfHealing.retryDelay,
      enableRespawn: this.config.selfHealing.contextTransfer
    }

    // Initialize learning module with config min confidence
    this.learning = new LearningModule(this.config.learning.minConfidence)

    // Initialize security scanner
    this.securityScanner = new SecurityScanner()

    // Initialize performance tracker
    this.performanceTracker = new PerformanceTracker()

    // Initialize execution history tracker
    this.executionHistory = new ExecutionHistory()

    // Initialize custom role manager
    this.customRoles = new CustomRoleManager()

    // Initialize cost forecaster. Injected with the `modelCosts` lookup so the
    // forecaster prices from the same per-1K table as everything else instead of
    // carrying a second, divergent price universe.
    this.forecaster = new CostForecaster((model, provider) => this.getModelCost(model, provider))
  }

  /**
   * Initialize with OpenCode plugin context for session API access
   */
  async initialize(ctx: NexusPluginContext, onStateChange?: () => void) {
    this.ctx = ctx
    this.onStateChange = onStateChange ?? null

    // Load project/global config files from disk
    // Use plugin location directory, not process.cwd() which may be wrong
    const projectDir = ctx.location.directory
    this.configManager.loadFromPath(projectDir)

    // Load real model pricing from OpenCode
    await this.loadModelCosts()

    // Start periodic cleanup of stale data (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupStaleData(), 300000)

    // Initialize health monitor
    this._healthMonitor = new HealthMonitor({
      checkInterval: this.config.agents.healthCheckInterval
    })

    // Initialize notification manager
    this.notifications = new NotificationManager(true)

    // Set up all registered modules
    const moduleCtx: ModuleContext = {
      orchestrator: this,
      config: this.config,
      emit: (event: string, data: any) => this.emit(event, data),
      on: (event: string, handler: (data: any) => void) => { this.on(event, handler) }
    }
    await this.moduleRegistry.setupAll(moduleCtx)
  }

  /**
   * Load real model pricing from OpenCode's model list API.
   *
   * `ctx.model.list()` returns `{ location, data }` where each `ModelInfo`
   * carries a `cost` array — one entry per CONTEXT TIER. We keep every tier,
   * because OpenCode bills each call at the tier its own prompt falls into and
   * so must we. `cost` may be empty for free / locally served models, and the
   * whole API may be absent — in both cases `modelCosts` is left untouched and
   * the labelled fallback table in `forecast.ts` is used instead.
   *
   * DIVERGENCE FROM OPENCODE, deliberate: OpenCode's cost function returns a
   * hard ZERO when a model has no `cost` array. Reproducing that would replace
   * "we don't know this model's price" with a measured `$0` that no
   * provenance label can un-ring — the exact regression the `PricingSource`
   * discipline was introduced to prevent. An empty `cost` array is therefore
   * skipped, and the model is priced by the labelled fallback table instead,
   * which says out loud that it is a guess.
   *
   * Units: OpenCode reports `ModelCost` in **USD per MILLION tokens**
   * (`Money.USDPerMillionTokens`). `modelCosts` stores **USD per 1K tokens**,
   * which is the unit the fallback table and every consumer of `modelCosts`
   * use. The conversion happens here, on write, on EVERY tier, so the rest of
   * the plugin never has to think about it.
   *
   * ORDER IS NORMALISED ON WRITE: untiered base first, then context tiers
   * ascending by threshold. `selectTier` does not depend on array order, but a
   * hand-edited or merged `modelCosts` should not be able to change which rate
   * a display site shows for "the price of this model".
   *
   * WHAT STILL UNDER-COUNTS, and why none of it is fixed here:
   *   - R1, our unit of observation is coarser than OpenCode's. It selects a
   *     tier per model CALL and accumulates; we are handed a session TOTAL and
   *     make ONE selection for it. The SIGN of the resulting error is not
   *     knowable at this granularity: with monotonically non-decreasing rates
   *     (the common case) we over-report, but a provider publishing a
   *     DISCOUNTED long-context tier — Gemini's long-context pricing is this
   *     shape — inverts it, and several sub-threshold calls in one session sum
   *     past the threshold and get billed at the cheaper rate. T5 in
   *     `test/pricing-tiers.test.ts` is the worked counterexample. Either way
   *     these figures do not tie exactly to `SessionInfo.cost`, which is why
   *     `accountTaskCost` does not read it and why nothing here should be
   *     described as matching the bill.
   *   - a model absent from `modelCosts` is priced by the forecaster's fallback
   *     table, whose cache rates are ESTIMATES derived from each row's own input
   *     rate (see `forecast.ts`), not provider-sourced figures. They reproduce
   *     the real relation — verified against the real sonnet and opus entries —
   *     but they are not what the provider would bill, and a provider that
   *     does not bill cache writes separately is approximated outright.
   *   - a timed-out task is billed at the instant of the timeout, while its
   *     session keeps running, so the rest of its consumption is never billed.
   *     Correctly labelled `measured` (it is a real reading), but it means the
   *     most expensive case — a runaway task — is the most under-counted.
   */
  private async loadModelCosts(): Promise<void> {
    try {
      if (!this.ctx?.model) return

      const { data } = await this.ctx.model.list()
      if (!Array.isArray(data) || data.length === 0) return

      // per-million → per-1K
      const per1k = (v: number | undefined): number => (v || 0) / 1000

      for (const model of data) {
        if (!model?.cost || !Array.isArray(model.cost) || model.cost.length === 0) continue
        // Keyed by "providerID/id": bare ids are not unique across providers.
        this.modelCosts.set(`${model.providerID}/${model.id}`, {
          tiers: this.normaliseTiers(model.cost, per1k),
        })
      }
    } catch {
      // Cost loading is best-effort — the labelled fallback table will be used
    }
  }

  /**
   * OpenCode's raw `ModelCost[]` → our tiered per-1K price list.
   *
   * Three things happen here, all of them load-bearing:
   *  - per-million → per-1K, on EVERY tier. Normalising only the base is how a
   *    long-context premium ends up 1000× too large.
   *  - non-context tiers are dropped. OpenCode's cost function only ever
   *    consults tiers with `tier.type === "context"`, and only ever falls back
   *    to a row with `tier === undefined`; a row with some other tier type is
   *    invisible to it, so keeping it here would let a tier the bill never
   *    applies compete for selection.
   *  - a model whose list has context tiers but no untiered base gets a
   *    synthetic base from `cost[0]`. OpenCode's own fallback in that case is
   *    ZERO, i.e. "this model bills nothing" — the one answer that cannot be
   *    right for a model that published prices. A synthetic base keeps the
   *    model billable and makes the choice visible; the alternative is a $0
   *    spend reported as `measured`.
   *
   *    Unlike the single-selection divergence above, THIS one can only
   *    over-report, and it is worth being precise about why the two differ.
   *    Against opencode's own arithmetic the synthetic base is safe by
   *    construction: for any prompt where a real context tier matches,
   *    `cost[0]` is never consulted, and for a prompt below every threshold
   *    `Ng` returns 0, which is the floor — so there is no prompt at which our
   *    rate is lower than opencode's. The residual risk is against the TRUE
   *    BILL rather than against `Ng`: a tier-only model's synthetic base is
   *    the lowest-threshold rate it published, so if the provider's real
   *    sub-threshold price were HIGHER than its cheapest published tier we
   *    would under-report. That is not knowable at runtime from the `cost`
   *    array, so it is recorded rather than guarded.
   */
  private normaliseTiers(
    cost: readonly OpenCodeModelCost[],
    per1k: (v: number | undefined) => number
  ): ModelPricingTiers["tiers"] {
    const rates = (row: { input?: number; output?: number; cache?: { read?: number; write?: number } }) => ({
      input: per1k(row.input),
      output: per1k(row.output),
      cacheRead: per1k(row.cache?.read),
      cacheWrite: per1k(row.cache?.write),
    })

    const kept = cost
      .filter(row => row?.tier === undefined || row.tier?.type === "context")
      .map(row => ({
        // An untiered row is the base; a context row's `size` is the threshold.
        // A `{type: "context"}` row whose `size` is missing or not a number
        // falls through to the untiered branch below and becomes the base —
        // conservative, since `Ng` would never select it either. A `NaN` size
        // is NOT caught here: every comparison against it is false, so such a
        // tier is permanently unselectable. It is retained rather than dropped
        // so the row stays visible in the `model.costs` display instead of
        // vanishing from the price list, and `renderTiers` labels it honestly
        // as `over NaN prompt tokens`.
        ...(row.tier?.type === "context" && typeof row.tier.size === "number"
          ? { threshold: row.tier.size }
          : {}),
        rates: rates(row),
      }))

    if (kept.length === 0) return [{ rates: rates(cost[0]) }]

    const base = kept.find(t => t.threshold === undefined)
    const contextual = kept
      .filter(t => t.threshold !== undefined)
      .sort((a, b) => (a.threshold as number) - (b.threshold as number))
    // The synthetic base COPIES `kept[0]`'s rates rather than aliasing them.
    // `modelCosts` is public and mutable, so sharing one rates object between
    // `tiers[0]` and the lowest context tier would let a consumer mutating
    // `tiers[0].rates.input` silently reprice the long-context tier too.
    return base
      ? [{ rates: { ...base.rates } }, ...contextual]
      : [{ rates: { ...kept[0].rates } }, ...contextual]
  }

  /**
   * Manually set model costs (e.g., from TUI model list).
   * Keys may be "providerID/id" or a bare "id". Values are USD per 1K tokens,
   * matching the unit `loadModelCosts` normalises to.
   *
   * A set value is a single UNTIERED tier and it REPLACES any entry already
   * there, rather than merging into one. The user is supplying one rate with
   * no prompt size attached, so the only honest reading of it is "this is the
   * rate, at every size". Merging a flat rate into an entry that already has a
   * 200k premium would leave the user believing they had priced a model that
   * still bills at the premium above that size. Replace-not-merge is also what
   * makes the override authoritative: there is no path by which a stale
   * published tier can outrank a rate the user just typed.
   *
   * THE COST IS THAT CACHE IS BILLED AT $0, and it is unbounded. `cacheRead`
   * and `cacheWrite` default to 0 when omitted, and the `model.costs` tool's
   * schema only offers in/out, so there is no value to default to. A
   * cache-heavy session on a manually priced model therefore bills nothing for
   * its cache — on a long-context run that is the whole bill.
   *
   * Stated plainly rather than defended as the lesser evil. An earlier version
   * of this comment justified the zero by claiming that synthesising a cache
   * rate "would silently override the provider's real cache rates when they are
   * known, which is worse than an explicit zero". That was self-contradictory:
   * replacing the entry already discards the provider's known `cacheRead` and
   * `cacheWrite` along with its tiers, so the thing the comment feared had
   * already happened by the time the default applied. Preferring the provider's
   * real rates when the caller omits them would be strictly better and is the
   * obvious follow-up; it needs a schema change to pass cache rates through, so
   * it is not done here. Until then: a manually priced model's cache is free,
   * and reported spend for one is an UNDER-report of unbounded size.
   */
  setModelCosts(costs: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>): void {
    for (const [model, cost] of Object.entries(costs)) {
      this.modelCosts.set(model, {
        tiers: [{
          rates: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead || 0,
            cacheWrite: cost.cacheWrite || 0,
          },
        }],
      })
    }
  }

  /**
   * Wire up the StateBroadcaster so that every notifyStateChange() call
   * also triggers a throttled broadcast to WebSocket clients.
   */
  initBroadcaster(opts?: { throttleMs?: number }): void {
    this.broadcaster = new StateBroadcaster(this, opts)
    // Chain into the existing onStateChange callback
    const previousOnStateChange = this.onStateChange
    this.onStateChange = () => {
      previousOnStateChange?.()
      this.broadcaster?.broadcastState()
    }
  }

  /**
   * Start the web dashboard server
   */
  startDashboard(port?: number, host?: string): void {
    const dashPort = port || this.config.dashboard.port
    const dashHost = host || this.config.dashboard.host
    this.dashboard = new DashboardModule(this)
    this.dashboard.start(dashPort, dashHost)

    // Wire up events for broadcasting
    this.on('agent:spawned', (agent: any) => this.dashboard?.broadcast('agent:spawned', agent))
    this.on('agent:terminated', (agent: any) => this.dashboard?.broadcast('agent:terminated', agent))
    this.on('budget:alert', (data: any) => this.dashboard?.broadcast('budget:alert', data))
    this.on('budget:exceeded', (data: any) => this.dashboard?.broadcast('budget:exceeded', data))
  }

  /**
   * Stop the web dashboard server
   */
  stopDashboard(): void {
    if (this.dashboard) {
      this.dashboard.stop()
      this.dashboard = null
    }
  }

  /**
   * Enable git worktree isolation for agents
   */
  enableWorktrees(repoRoot?: string): void {
    this.worktreeManager = new WorktreeManager(repoRoot || process.cwd())
  }

  /**
   * Export current state for TUI/dashboard consumption
   */
  getState(): OrchestratorState {
    const agents = Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
      model: `${a.model.provider}/${a.model.model}`,
      sessionID: a.sessionID,
      spawnedAt: a.spawnedAt.toISOString(),
      tasksCompleted: a.metrics.tasksCompleted,
      tasksFailed: a.metrics.tasksFailed,
      totalCost: a.metrics.totalCost
    }))

    const tasks = Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      name: t.name,
      role: t.requiredRole,
      priority: t.priority || 'normal',
      status: t.status,
      assignedAgent: t.assignedAgent,
      result: t.result ? {
        success: t.result.success,
        output: t.result.output?.slice(0, 500),
        error: t.result.error,
        duration: t.result.duration
      } : undefined
    }))

    return {
      running: this.running,
      paused: this.paused,
      agents,
      tasks,
      totalSpent: this.totalSpent,
      budgetRemaining: this.budget.maxTotalCost - this.totalSpent,
      lastUpdated: new Date().toISOString()
    }
  }

  private mergeConfig(partial?: Partial<NexusConfig>): NexusConfig {
    const defaults: NexusConfig = {
      maxConcurrency: 5,
      schedulerInterval: 1000,
      defaultTimeout: 300000,
      budget: {
        maxTotalCost: 10.00,
        maxCostPerTask: 1.00,
        maxCostPerAgent: 2.00,
        alertThreshold: 0.2,
        hardLimit: false
      },
      agents: {
        defaultRole: 'coder',
        spawnDelay: 100,
        healthCheckInterval: 30000
      },
      selfHealing: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000,
        backoffMultiplier: 2,
        contextTransfer: true
      },
      communication: {
        mode: 'pubsub',
        maxQueueSize: 100,
        messageTTL: 60000,
        persistence: false
      },
      memory: {
        enabled: true,
        storage: 'memory',
        maxEntriesPerScope: 1000,
        syncInterval: 5000
      },
      dashboard: {
        enabled: true,
        port: 4747,
        host: '127.0.0.1'
      },
      security: {
        sastEnabled: true,
        secretsScanning: true,
        scopeEnforcement: true
      },
      learning: {
        enabled: true,
        patternStorage: 'memory',
        minConfidence: 0.7
      }
    }

    return {
      ...defaults,
      ...partial,
      budget: { ...defaults.budget, ...partial?.budget },
      agents: { ...defaults.agents, ...partial?.agents },
      selfHealing: { ...defaults.selfHealing, ...partial?.selfHealing },
      communication: { ...defaults.communication, ...partial?.communication },
      memory: { ...defaults.memory, ...partial?.memory },
      dashboard: { ...defaults.dashboard, ...partial?.dashboard },
      security: { ...defaults.security, ...partial?.security },
      learning: { ...defaults.learning, ...partial?.learning }
    }
  }

  public notifyStateChange(): void {
    if (this.stateChangeTimer) return
    this.stateChangeTimer = setTimeout(() => {
      this.stateChangeTimer = null
      this.onStateChange?.()
    }, 100) // 100ms debounce
  }

  /**
   * Re-read the project and global config files from disk.
   *
   * Goes through the same `loadFromPath` as the initial load, so all
   * precedence levels are refreshed together rather than patching one level in
   * isolation. A session-scoped override (the `preset` tool, TUI settings) is
   * deliberately preserved — a disk edit must not silently discard it.
   * Returns the resulting load info (or the previous one when the orchestrator
   * has no plugin context to resolve a project directory from), so callers can
   * report what is now in effect.
   */
  reloadConfigFromDisk(trigger: NexusConfigReloadTrigger = 'event'): NexusConfigLoadInfo | null {
    const projectDir = this.ctx?.location.directory
    if (projectDir) {
      this.configManager.loadFromPath(projectDir, trigger)
    }
    const info = this.configManager.getLoadInfo()
    if (info) {
      // Propagate to dashboard / TUI consumers of orchestrator state.
      this.notifyStateChange()
      this.emit('config:reloaded', info)
    }
    return info
  }

  /**
   * Which config files the last load consulted and the role -> model map they
   * resolved to. null when no load has run yet.
   */
  getConfigInfo(): NexusConfigLoadInfo | null {
    return this.configManager.getLoadInfo()
  }

  // === Core Operations ===

  /**
   * Execute a set of tasks using real OpenCode sessions
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.running) {
      throw new Error("Orchestrator is already running")
    }

    if (!this.ctx) {
      throw new Error("Orchestrator not initialized - call initialize(ctx) first")
    }

    this.running = true
    const startTime = Date.now()
    this.notifyStateChange()

    try {
      // 1. Build DAG
      this.dag = this.buildDAG(request.tasks)

      // 2. Detect circular dependencies before execution
      const dagNodes = Array.from(this.dag.nodes.values())
      const cycles = detectCycles(dagNodes)
      if (cycles.length > 0) {
        const cycleDescriptions = cycles.map(c => c.join(' → ')).join(', ')
        throw new Error(`Circular dependency detected: ${cycleDescriptions}`)
      }

      // 3. Apply budget constraints
      if (request.budget) {
        this.budget = request.budget
      }

      // 4. Execute DAG with real sessions
      await this.executeDAG()

      // 5. Collect results
      const results = this.collectResults()
      const totalDuration = Date.now() - startTime

      return {
        success: true,
        tasks: results,
        totalCost: this.totalSpent,
        // Same window as `totalCost` (`this.totalSpent` is the orchestrator's
        // lifetime total, not a per-run one), so the split always adds up to
        // the headline. A caller reading `totalCost` alone cannot tell a fully
        // billed run from one where every task fell back to estimates; these
        // two say it.
        ...this.spendSplit(),
        totalDuration,
        agentsUsed: this.agents.size
      }
    } catch (error) {
      // Surface the cause: this returns success:false with no tasks, so
      // swallowing the error here left callers with no explanation.
      console.error('[nexus] DAG execution failed:', error)
      return {
        success: false,
        tasks: [],
        totalCost: this.totalSpent,
        ...this.spendSplit(),
        totalDuration: Date.now() - startTime,
        agentsUsed: this.agents.size
      }
    } finally {
      this.running = false
      this.notifyStateChange()
    }
  }

  private buildDAG(tasks: Task[]): DAG {
    const dag: DAG = {
      nodes: new Map(),
      addNode: (node: DAGNode) => {
        dag.nodes.set(node.id, node)
      },
      addDependency: (nodeId: string, dependsOn: string) => {
        const node = dag.nodes.get(nodeId)
        if (node) {
          node.dependencies.push(dependsOn)
        }
      },
      removeNode: (nodeId: string) => {
        dag.nodes.delete(nodeId)
      },
      getReadyNodes: (): DAGNode[] => {
        const ready: DAGNode[] = []
        dag.nodes.forEach((node) => {
          if (node.status === 'pending') {
            const depsComplete = node.dependencies.every(dep => {
              const depNode = dag.nodes.get(dep)
              return depNode?.status === 'completed'
            })
            if (depsComplete) {
              ready.push(node)
            }
          }
        })
        // Sort by priority: critical > high > normal > low
        const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 }
        return ready.sort((a, b) => {
          const pa = priorityOrder[a.task.priority] ?? 2
          const pb = priorityOrder[b.task.priority] ?? 2
          return pa - pb
        })
      },
      markComplete: (nodeId: string, result) => {
        const node = dag.nodes.get(nodeId)
        if (node) {
          node.status = 'completed'
          node.result = result
        }
      },
      markFailed: (nodeId: string, error: Error) => {
        const node = dag.nodes.get(nodeId)
        if (node) {
          node.status = 'failed'
        }
      },
      getParallelGroups: (): DAGNode[][] => {
        const groups: DAGNode[][] = []
        const ready = dag.getReadyNodes()
        if (ready.length > 0) {
          groups.push(ready)
        }
        return groups
      },
      isComplete: (): boolean => {
        let complete = true
        dag.nodes.forEach((node) => {
          if (node.status !== 'completed' && node.status !== 'failed') {
            complete = false
          }
        })
        return complete
      }
    }

    for (const task of tasks) {
      const node: DAGNode = {
        id: task.id,
        task,
        dependencies: task.dependencies,
        status: 'pending'
      }
      dag.addNode(node)
    }

    return dag
  }

  private async executeDAG(): Promise<void> {
    while (!this.dag!.isComplete() && !this.paused) {
      const readyNodes = this.dag!.getReadyNodes()

      // Spawn agents for ready nodes (respecting concurrency limit)
      const spawnPromises: Promise<void>[] = []
      for (const node of readyNodes) {
        if (this.agents.size < this.config.maxConcurrency) {
          // Contain per node: `spawnAndExecute` can throw before any agent
          // exists (malformed model selection, budget exceeded, session-create
          // failure). Unguarded, one rejection fails the whole `Promise.all`
          // and discards every sibling node's result.
          spawnPromises.push(
            this.spawnAndExecute(node).catch((error: unknown) => {
              const err = error instanceof Error ? error : new Error(String(error))
              node.status = 'failed'
              node.task.status = 'failed'
              node.result = { success: false, error: err.message, duration: 0, tokensUsed: 0, cost: 0 }
              // `markFailed` only sets node.status; node.result above is what
              // `collectResults` reads, so both are required for the failure to
              // appear in the `ExecutionResult`.
              this.dag!.markFailed(node.id, err)
              this.notifyStateChange()
              // No agent exists when the spawn itself failed, so agentId /
              // model / sessionID are omitted rather than fabricated.
              this.emit('task:failed', {
                taskId: node.id,
                taskName: node.task.name,
                role: node.task.requiredRole,
                error: err.message,
                duration: 0
              })
            })
          )
        }
      }

      await Promise.all(spawnPromises)

      // Wait for scheduler interval
      await this.sleep(this.config.schedulerInterval)
    }
  }

  /**
   * Resolve the "providerID/modelID" reference that `spawnAgent` requires.
   *
   * `ModelSelection.model` is the bare id (`scoreModel` splits the candidate
   * on "/"), so the two halves have to be rejoined here.
   */
  private selectQualifiedModel(node: DAGNode): string {
    // Analyze complexity and select model
    const complexity = this.analyzeComplexity(node.task)
    const model = this.selectModel(node.task.requiredRole, complexity)

    // A role's configured model is user-supplied and may lack a provider prefix;
    // `scoreModel` then yields the whole value as `provider` and `model: ""`,
    // and `spawnAgent` resolves that empty id to 'default' — a silent wrong-model
    // spawn.
    if (!model.provider || !model.model) {
      const missing = !model.provider && !model.model ? 'provider and model'
        : !model.provider ? 'provider' : 'model'
      throw new Error(
        `Model selection for role "${node.task.requiredRole}" is missing its ${missing}: ` +
        `got { provider: ${JSON.stringify(model.provider)}, model: ${JSON.stringify(model.model)} }. ` +
        `Cannot build a "providerID/modelID" reference.`
      )
    }

    return `${model.provider}/${model.model}`
  }

  /**
   * Spawn, deliver and execute a node — the single path every attempt takes.
   *
   * `options` groups the two orthogonal knobs a caller may set, rather than
   * adding a third positional parameter: they are unrelated concerns (what
   * context the prompt carries vs. which model runs it), and an options bag
   * keeps the single-knob call sites self-documenting — step 3 passes
   * `{ modelOverride }` without an `undefined` placeholder in the middle.
   */
  private async spawnAndExecute(
    node: DAGNode,
    options: { transferContext?: ContextTransferData; modelOverride?: string } = {}
  ): Promise<void> {
    // A fallback model is already a qualified "providerID/modelID" reference
    // from the escalation policy, so it bypasses selection — and with it the
    // qualification check, which has nothing to verify.
    const qualifiedModel = options.modelOverride ?? this.selectQualifiedModel(node)

    // Spawn agent with real session
    const agent = await this.spawnAgent({
      role: node.task.requiredRole,
      task: node.task,
      model: qualifiedModel
    })

    node.spawnedAgent = agent
    node.status = 'running'
    node.task.assignedAgent = agent.id
    this.notifyStateChange()

    // Execute task via OpenCode session
    await this.executeTask(agent, node, options.transferContext)
  }

  /**
   * Execute a task by sending it to a real OpenCode session
   */
  private async executeTask(agent: Agent, node: DAGNode, transferContext?: ContextTransferData): Promise<void> {
    if (!this.ctx || !agent.sessionID) {
      node.status = 'failed'
      node.result = {
        success: false,
        error: "No session available for agent",
        duration: 0,
        tokensUsed: 0,
        cost: 0
      }
      this.notifyStateChange()
      return
    }

    const startTime = Date.now()
    const timeout = node.task.timeout || this.config.defaultTimeout

    try {
      // Build the prompt for the agent
      const rolePrompt = this.buildRolePrompt(node.task.requiredRole)
      let taskPrompt = `${rolePrompt}\n\n## Task\n${node.task.name}\n\n${node.task.description}\n\n## Scope\nFiles: ${node.task.files.include.join(', ')}`

      if (transferContext) {
        taskPrompt += `\n\n## Previous Agent Context (from failed agent ${transferContext.previousAgentId})`
        taskPrompt += `\nPartial results: ${transferContext.partialResults.join(', ') || 'None'}`
        taskPrompt += `\nDecisions made: ${transferContext.decisions.join(', ') || 'None'}`
        taskPrompt += `\nProgress: ${transferContext.taskProgress}%`
        taskPrompt += `\nErrors encountered: ${transferContext.errorLog.join(', ') || 'None'}`
        taskPrompt += `\n\nPlease continue from where the previous agent left off.`
      }

      // Send the task to the session
      await this.ctx.session.prompt({
        sessionID: agent.sessionID,
        text: taskPrompt
      })

      // Wait for completion (with timeout)
      const waitPromise = this.ctx.session.wait({ sessionID: agent.sessionID })
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Task timed out")), timeout)
      )

      await Promise.race([waitPromise, timeoutPromise])

      // Get the result context
      const messages = await this.ctx.session.context({ sessionID: agent.sessionID })
      // Aligned with the `nexus.spawn` / `nexus.delegate` tools: this string is
      // persisted in `TaskResult.output` (execution history, dashboard), so it
      // must say that no output was captured rather than look like a result.
      const output = lastAssistantText(messages) || "Task completed (no output captured)"

      const duration = Date.now() - startTime
      // Real cost from the session's actual token usage, priced with the
      // orchestrator's per-1K `modelCosts` at the context tier that usage
      // selects. The deleted `estimateModelCost` returned a per-1K RATE, which
      // cannot stand in for a task's total — that was the old behaviour and it
      // made spend a sum of rates, unrelated to usage.
      const cost = await this.safeAccountTaskCost(agent, node.task)
      const result: CostedTaskResult = {
        success: true,
        output,
        duration,
        tokensUsed: cost.tokensUsed,
        cost: cost.cost,
        costProvenance: cost.provenance
      }

      this.dag!.markComplete(node.id, result)
      this.todoEnforcer.completeTask(agent.id)
      agent.metrics.tasksCompleted++
      agent.metrics.totalCost += result.cost
      agent.metrics.totalTokens += result.tokensUsed
      // Single accounting path: trackCost owns totalSpent, costByAgent,
      // costByModel and the budget check.
      this.trackCost(agent.id, `${agent.model.provider}/${agent.model.model}`, result.cost, result.tokensUsed, result.costProvenance)

      // Record performance metrics
      this.performanceTracker.record({
        model: agent.model.model,
        role: node.task.requiredRole,
        success: result.success,
        duration: result.duration,
        cost: result.cost,
        costProvenance: result.costProvenance,
        tokensUsed: result.tokensUsed
      })

      // Record successful execution to history
      this.executionHistory.record({
        taskId: node.id,
        taskName: node.task.name,
        role: node.task.requiredRole,
        model: agent.model.model,
        status: 'success',
        cost: result.cost,
        costProvenance: result.costProvenance,
        duration: result.duration,
        tokensUsed: result.tokensUsed,
        startedAt: new Date(startTime),
        completedAt: new Date(),
      })

      // Notify on task completion
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Complete', body: `${node.task.name} completed successfully` })
      }

      // Record learning success if there was a prior failure pattern for this task
      const priorPattern = this.learning.findSolutions(`task ${node.id} failed`)
      if (priorPattern.length > 0) {
        this.learning.recordSuccess(priorPattern[0].entry.id)
      }

      // Scan task output for security issues
      if (output.length > 0) {
        const securityIssues = this.securityScanner.scanContent(output, node.task.name)
        if (securityIssues.length > 0) {
          this.emit('security:issues-found', {
            taskId: node.id,
            taskName: node.task.name,
            issues: securityIssues,
            totalIssues: securityIssues.length
          })
        }
      }

    } catch (error: any) {
      const duration = Date.now() - startTime
      const errorMessage = error.message || "Task failed"
      // A failed or timed-out task still burned tokens. With self-healing a
      // retry spawns a NEW session, so this session's usage would otherwise
      // never be seen by the accounting at all — spend that never reaches
      // `totalSpent` never reaches `checkBudget` either.
      const cost = await this.safeAccountTaskCost(agent, node.task)
      const result: CostedTaskResult = {
        success: false,
        error: errorMessage,
        duration,
        tokensUsed: cost.tokensUsed,
        cost: cost.cost,
        costProvenance: cost.provenance
      }

      // `markFailed` only sets node.status, so the result is assigned here for
      // `collectResults` — the same two-step the spawn-failure path uses.
      this.dag!.markFailed(node.id, new Error(errorMessage))
      node.result = result
      this.trackCost(agent.id, `${agent.model.provider}/${agent.model.model}`, result.cost, result.tokensUsed, result.costProvenance)
      agent.metrics.totalCost += result.cost
      agent.metrics.totalTokens += result.tokensUsed
      this.todoEnforcer.completeTask(agent.id)
      agent.metrics.tasksFailed++
      agent.status = 'failed'

      // Emit failure event for listeners
      this.emit('task:failed', {
        taskId: node.id,
        taskName: node.task.name,
        agentId: agent.id,
        role: node.task.requiredRole,
        model: agent.model.model,
        error: errorMessage,
        duration,
        sessionID: agent.sessionID
      })

      // Record performance metrics for failed task
      this.performanceTracker.record({
        model: agent.model.model,
        role: node.task.requiredRole,
        success: result.success,
        duration: result.duration,
        cost: result.cost,
        costProvenance: result.costProvenance,
        tokensUsed: result.tokensUsed
      })

      // Record failed execution to history (with session ID for traceability)
      this.executionHistory.record({
        taskId: node.id,
        taskName: node.task.name,
        role: node.task.requiredRole,
        model: agent.model.model,
        status: 'failed',
        cost: result.cost,
        costProvenance: result.costProvenance,
        duration: result.duration,
        tokensUsed: result.tokensUsed,
        startedAt: new Date(startTime),
        completedAt: new Date(),
        error: errorMessage
      })

      // Notify on task failure
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${errorMessage}`, sound: true })
      }

      // Self-healing: retry or respawn
      if (this.config.selfHealing.enabled) {
        await this.handleFailure(agent, node, new Error(errorMessage))
      }
    } finally {
      // Only reset to idle if agent is still in a non-terminal state
      if (agent.status !== 'terminated' && agent.status !== 'failed') {
        agent.status = 'idle'
      }
      node.task.status = node.status === 'completed' ? 'completed' : 'failed'
      this.notifyStateChange()
    }
  }

  /**
   * Build a system prompt for the agent's role
   */
  private buildRolePrompt(role: AgentRole): string {
    // Check for a custom role first
    if (this.customRoles.has(role)) {
      return this.customRoles.getPrompt(role) || `You are a ${role}. Complete the assigned task professionally.`
    }

    const rolePrompts: Record<string, string> = {
      architect: "You are a software architect. Focus on system design, architecture patterns, and high-level technical decisions. Analyze requirements and propose structured solutions.",
      coder: "You are a senior software engineer. Write clean, efficient, well-documented code. Follow best practices and coding standards.",
      reviewer: "You are a code reviewer. Review code for correctness, security, performance, and maintainability. Provide constructive feedback.",
      tester: "You are a QA engineer. Write comprehensive tests, identify edge cases, and ensure code quality.",
      explorer: "You are a code explorer. Navigate and analyze codebases, understand architecture, and provide detailed reports.",
      documenter: "You are a technical writer. Create clear, comprehensive documentation for code and APIs."
    }
    return rolePrompts[role] || `You are a ${role}. Complete the assigned task professionally.`
  }

  /**
   * Collect context from a failing agent for transfer to a respawned agent
   */
  collectContext(agent: Agent): ContextTransferData {
    // Gather partial results from session context if available
    const partialResults: string[] = []
    const decisions: string[] = []
    const errorLog: string[] = []

    // Extract recent session messages as partial results
    if (agent.sessionID && this.ctx) {
      // Note: In production, this would pull from the session context API.
      // For now we capture what we can from agent state.
      if (agent.metrics.tasksCompleted > 0) {
        partialResults.push(`${agent.metrics.tasksCompleted} task(s) completed before failure`)
      }
      if (agent.metrics.tasksFailed > 0) {
        errorLog.push(`${agent.metrics.tasksFailed} task(s) failed`)
      }
    }

    // Gather memory entries for this agent's scope
    const memoryEntries: MemoryEntry[] = []
    const byAgentId = this.memoryStore.getByAuthor(agent.id)
    const byRole = this.memoryStore.getByAuthor(agent.role)
    memoryEntries.push(...byAgentId, ...byRole)

    const taskProgress = agent.metrics.tasksCompleted > 0
      ? Math.min(50, agent.metrics.tasksCompleted * 25)
      : 0

    return {
      previousAgentId: agent.id,
      partialResults,
      decisions,
      memoryEntries,
      taskProgress,
      errorLog
    }
  }

  private async handleFailure(agent: Agent, node: DAGNode, error: Error): Promise<void> {
    const policy = this.escalationPolicy
    const retryCount = this.nodeRetryCounts.get(node.id) || 0

    // Record the failure pattern for learning
    const pattern = error.message || 'Unknown error'
    const solution = `Retry (attempt ${retryCount + 1}/${policy.maxRetries})`
    const context = `during ${node.task.requiredRole} task "${node.task.name}"`
    this.learning.recordFailure(pattern, solution, context, [node.task.requiredRole])

    // Step 1: Retry with exponential backoff
    if (retryCount < policy.maxRetries) {
      this.nodeRetryCounts.set(node.id, retryCount + 1)
      const delay = policy.retryDelay * Math.pow(2, retryCount) // exponential backoff
      await this.sleep(delay)

      // Re-spawn and execute the node
      node.status = 'pending'
      this.notifyStateChange()
      await this.spawnAndExecute(node)
      return
    }

    // Step 2: Respawn with context transfer
    if (policy.enableRespawn && this.config.selfHealing.contextTransfer) {
      const context = this.collectContext(agent)
      this.setMemory('session', `context:${agent.id}`, context, agent.id)

      // Terminate the failed agent before respawning
      await this.terminateAgent(agent.id)

      // Respawn with context
      node.status = 'pending'
      this.notifyStateChange()
      await this.spawnAndExecute(node, { transferContext: context })
      return
    }

    // Step 3: Try fallback model
    //
    // Escalation must CHANGE THE MODEL, and that has to be checked rather than
    // assumed. `fallbackModels` and model selection draw from overlapping pools
    // of ids, so the entry at the head can be the very model that just failed:
    // on the fallback price table `selectBestModel` wins with
    // 'google/gemini-2.5-flash' at essentially every complexity, and that is
    // also `DEFAULT_ESCALATION.fallbackModels[0]`. Shifting it unconditionally
    // terminated the agent, burned a full task's tokens re-running the identical
    // task on the identical model, and consumed an escalation entry doing it —
    // so a persistently failing node reached step 4 after a SHORTER real
    // escalation chain than before, which is the opposite of what step 3 is for.
    //
    // Compared as a QUALIFIED reference on both sides. `agent.model` is
    // provider-qualified and so is every entry in the default policy, but a
    // user-configured policy may hold bare ids — comparing qualified against
    // bare would silently never match and the check would do nothing.
    const failedRef = `${agent.model.provider}/${agent.model.model}`
    // Only consume anything if there is something USABLE to consume. When every
    // entry equals the failed model there is no escalation to make, and leaving
    // the list intact keeps one node's dead end from becoming the whole
    // orchestrator's: the policy is shared across nodes, so draining it here
    // would strip the escalation route from every other node too. See the
    // `while` below for the case where some entries are usable.
    const hasUsableFallback = policy.fallbackModels.some(m => m !== failedRef)
    if (policy.fallbackModels.length > 0 && hasUsableFallback) {
      // `shift` consumes the entry, so each escalation burns one fallback: a
      // node reaches step 4 (alert) after at most `fallbackModels.length`
      // fallback attempts. Entries equal to the failed model are stepped over
      // and consumed on the way — they are unusable by this node by definition,
      // and a later node that also failed on that model would find them equally
      // useless.
      let fallbackModel: string | undefined
      while (policy.fallbackModels.length > 0) {
        const candidate = policy.fallbackModels.shift() as string
        if (candidate !== failedRef) {
          fallbackModel = candidate
          break
        }
      }
      if (fallbackModel) {
        // Terminate the failed agent
        await this.terminateAgent(agent.id)

        // Re-enter the normal execution path with the fallback model. Going
        // through `spawnAndExecute` is what makes the attempt real: it assigns
        // `node.spawnedAgent` / `node.task.assignedAgent`, moves the node out
        // of 'pending', prompts the new session with the task and runs
        // `executeTask`. A bare `spawnAgent` did none of that, leaving the node
        // pending forever with an orphaned session the scheduler would re-pick.
        //
        // Context is deliberately NOT transferred. Step 3 is "same task,
        // different (cheaper) model" — step 1's semantics with a model
        // override. Step 2's transfer exists because the *agent* failed and a
        // fresh one needs to know what it walked into; here the failure is
        // attributed to the model, not the agent, and replaying a failed
        // agent's error log into the fallback's prompt would just re-teach it
        // the failure we are trying to route around.
        node.status = 'pending'
        this.notifyStateChange()
        await this.spawnAndExecute(node, { modelOverride: fallbackModel })
        return
      }
    }

    // Step 4: Alert and mark as failed
    if (policy.alertOnFailure) {
      this.emit('agent:escalation', { agentId: agent.id, taskId: node.id, error: error.message })
      // Notify on final failure
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${error.message}`, sound: true })
      }
    }

    node.status = 'failed'
    node.result = {
      success: false,
      error: error.message,
      duration: 0,
      tokensUsed: 0,
      cost: 0
    }
    this.notifyStateChange()
  }

  // === Agent Management ===

  /**
   * Create a child session by invoking OpenCode's built-in `subagent` tool.
   *
   * The public session API (`ctx.session.create`) has no `parentID` field, so a
   * plugin cannot link a child session to its parent that way. The built-in
   * `subagent` tool does set `parentID` from the tool context's `sessionID`,
   * so we call it directly with a fabricated tool context.
   *
   * Returns the child session ID, which the `subagent` tool reports through its
   * `progress` callback immediately after creating the session.
   */
  private async createChildSession(params: {
    tool: SubagentTool
    agent: string
    description: string
    prompt: string
    model: string
    parent: SpawnToolContext
    callID: string
  }): Promise<string> {
    const { tool, agent, description, prompt, model, parent, callID } = params

    if (!parent.sessionID) {
      throw new Error("Cannot spawn agent without a parent session ID")
    }
    // The subagent executor resolves the caller's permission rules from
    // `agent`. Do not fabricate a most-permissive identity — fail loudly.
    if (!parent.agent) {
      throw new Error("Cannot spawn agent without the calling agent id (tool context has no 'agent')")
    }

    // The subagent tool fires progress with the child session ID as soon as the
    // session exists, before the child finishes. That is our source of truth.
    let childSessionID: string | undefined
    let resolveChildSession: ((id: string) => void) | null = null
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const childSessionReady = new Promise<string>((resolve, reject) => {
      resolveChildSession = resolve
      // Never hang spawn waiting on progress if the tool misbehaves.
      watchdog = setTimeout(() => reject(new Error(`subagent tool did not report a child session for ${agent}`)), 30_000)
    })
    childSessionReady.catch(() => {})

    const reportProgress = (p: { sessionID: string; status: string }): Promise<void> => {
      if (p?.sessionID && !childSessionID) {
        childSessionID = p.sessionID
        resolveChildSession?.(p.sessionID)
      }
      return Promise.resolve()
    }

    const toolContext = {
      sessionID: parent.sessionID,
      agent: parent.agent,
      messageID: parent.messageID || `msg_${callID}`,
      id: `call_${callID}`,
      progress: reportProgress,
      signal: parent.signal ?? new AbortController().signal,
    }

    const subagentCall: Promise<unknown> = tool.execute(
      { agent, description, prompt, model, background: true },
      toolContext,
    )

    let childSessionIDResolved: string
    try {
      childSessionIDResolved = await Promise.race([
        childSessionReady,
        // Surface real tool failures (e.g. "Subagent denied") instead of timing out.
        subagentCall.then(
          () => { throw new Error(`subagent tool finished without reporting a child session for ${agent}`) },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(`subagent tool failed for ${agent}: ${message}`)
          },
        ),
      ])
    } finally {
      if (watchdog) clearTimeout(watchdog)
    }

    // The child runs in the background; surface tool failures without rejecting
    // the spawn once we already have a usable child session.
    subagentCall.catch(() => {})

    return childSessionIDResolved
  }

  /**
   * Spawn a real OpenCode session for an agent
   *
   * @param options.toolContext Tool context of the calling tool. Only when this
   *   is supplied (with a `sessionID`) is the built-in `subagent` tool used, so
   *   OpenCode links the child to the real parent session. Internal call sites
   *   (scheduler, model-fallback respawn) have no tool context and keep using
   *   `ctx.session.create()`.
   * @param options.task Full task text, delivered through the subagent tool's
   *   `prompt` on the subagent-tool path. Callers on the create path must
   *   deliver the task themselves via `ctx.session.prompt()`.
   */
  async spawnAgent(config: SpawnConfig, options?: SpawnOptions): Promise<SpawnedAgent> {
    if (!this.ctx) {
      throw new Error("Orchestrator not initialized")
    }

    // Check budget before spawning
    if (this.budgetExceeded) {
      throw new Error("Budget exceeded — cannot spawn new agents")
    }

    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Resolve model: override > config > default
    let modelConfig = config.model || this.configManager.getModelForRole(config.role)

    // Auto-complete model name if missing provider prefix
    // e.g. "mimo-v2.5" → find "opencode-go/mimo-v2.5" in config
    if (!modelConfig.includes('/')) {
      const allModels = this.configManager.getConfig().models
      const match = Object.values(allModels).find(m => m?.split('/')[1] === modelConfig)
      if (match) {
        modelConfig = match
      } else {
        // Report `modelConfig` (the value that failed to resolve), not
        // `config.model`, which is undefined when the value came from the role
        // config rather than the caller.
        const source = config.model ? 'requested' : 'configured for role'
        throw new Error(`Invalid model "${modelConfig}" (${source} "${config.role}"). Use "providerID/modelID" format (e.g. "opencode-go/mimo-v2.5")`)
      }
    }

    const slashIndex = modelConfig.indexOf('/')
    const provider = modelConfig.slice(0, slashIndex)
    const modelName = modelConfig.slice(slashIndex + 1)

    // Build descriptive session title for TUI display
    const roleEmoji = this.configManager.getRoleEmoji(config.role)
    const title = `${roleEmoji} ${this.configManager.getRoleDisplayName(config.role)} — ${modelConfig}`

    // Map Nexus roles to the plugin's own nexus-* agents (see the agent
    // markdown files written in index.ts). These are non-primary, so the
    // subagent executor accepts them.
    const agentTypeMap: Record<string, string> = {
      architect: 'nexus-architect',
      coder: 'nexus-coder',
      reviewer: 'nexus-reviewer',
      tester: 'nexus-tester',
      explorer: 'nexus-explorer',
      documenter: 'nexus-documenter',
    }
    const agentType = agentTypeMap[config.role] || 'nexus-coder'

    // The subagent-tool path requires an explicitly supplied tool context: it
    // must never borrow a parent session latched from an unrelated session.
    const parent: SpawnToolContext | undefined = options?.toolContext?.sessionID
      ? options.toolContext
      : undefined

    const toolList = parent && typeof this.ctx.tool?.list === 'function'
      ? await this.ctx.tool.list()
      : undefined
    // A malformed (non-array) tool list is treated as "tool unavailable", i.e. a
    // degraded spawn. `ToolInfo["execute"]`'s input is `any` (the schema is
    // runtime-only), so the found tool is narrowed to `SubagentTool` — that is
    // the one cast, and it is what makes the `subagent` invocation below
    // type-checked instead of unchecked.
    const subagentTool: SubagentTool | undefined = Array.isArray(toolList)
      ? toolList.find(t => t?.id === 'subagent' && typeof t?.execute === 'function') as SubagentTool | undefined
      : undefined

    // Complete task text. On the subagent-tool path the tool's `prompt`
    // delivers it — that is the single delivery point (no second prompt).
    const taskText = options?.task || config.task?.description || config.task?.name || ''

    let spawnPath: SpawnPath = 'session-create'
    let childSessionID: string

    // `subagentTool` is only ever found when `parent` is set (tool.list() is not
    // consulted otherwise), so this is the linked path.
    if (parent && subagentTool) {
      if (!taskText) {
        throw new Error("spawnAgent requires task text when using the subagent tool path")
      }
      spawnPath = 'subagent-tool'
      childSessionID = await this.createChildSession({
        tool: subagentTool,
        agent: agentType,
        description: title,
        prompt: taskText,
        model: modelConfig,
        parent,
        callID: agentId,
      })
    } else {
      // No tool context (internal scheduler / respawn call sites) or the tool is
      // unavailable. NOTE: there is deliberately no session-metadata write after
      // this — SessionUpdateInput is exactly { sessionID, title?, permissions? },
      // so `metadata` would be silently dropped. The equivalent data (role,
      // model, sessionID) lives on the Agent record, which is persisted to
      // ctx.storage as `orchestrator-state` / `nexus-sidebar-state`.
      const created = await this.ctx.session.create({
        title,
        agent: agentType,
        model: modelName ? { providerID: provider, id: modelName } : undefined,
        metadata: {
          nexusRole: config.role,
          nexusTask: config.task?.name || 'direct-spawn',
          nexusAgentId: agentId,
          nexusModel: modelConfig,
        },
      })
      childSessionID = created.id
    }

    if (spawnPath === 'session-create') {
      // Make the degradation visible: a create-path child is NOT linked to a
      // parent session in OpenCode, which is the defect this code fixes.
      this.lastDegradedSpawn = {
        agentId,
        role: config.role,
        // A parent context was supplied but the tool is missing; without any
        // parent context tool.list() is never even consulted.
        reason: parent ? 'subagent-tool-unavailable' : 'no-parent-context',
      }
      console.warn(
        `[nexus] spawn degraded for ${config.role}: child session ${childSessionID} was created via ` +
        `ctx.session.create (${this.lastDegradedSpawn.reason}) and is not linked to a parent session.`
      )
    } else {
      this.lastDegradedSpawn = null
    }

    const agent: SpawnedAgent = {
      id: agentId,
      name: title,
      role: config.role,
      status: 'idle',
      model: {
        provider,
        model: modelName || 'default',
        estimatedCost: 0,
        estimatedQuality: 0.5,
        reasoning: `Configured for ${config.role}`
      },
      spawnedAt: new Date(),
      lastActivity: new Date(),
      metrics: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        totalCost: 0,
        averageResponseTime: 0,
        errorRate: 0
      },
      sessionID: childSessionID,
      spawnPath
    }

    this.agents.set(agentId, agent)

    // Auto-add todo for the spawned task
    const taskDesc = config.task?.name || `Agent ${config.role} task`
    this.todoEnforcer.trackTask(agentId, taskDesc, config.role)

    this.emit('agent:spawned', agent)
    this.notifyStateChange()

    // Enforce agent map size limit
    this.enforceAgentLimit()

    // Start health monitoring if not already running (lazy init)
    const monitor = this.getOrCreateHealthMonitor()
    if (!monitor.isActive()) {
      monitor.start(() => Array.from(this.agents.values()))
    }

    return agent
  }

  async terminateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.status = 'terminated'
      this.agents.delete(agentId)
      this.emit('agent:terminated', agent)
      this.notifyStateChange()

      // Stop health monitoring if no more agents
      if (this._healthMonitor && this.agents.size === 0) {
        this._healthMonitor.stop()
      }
    }
  }

  // === Complexity Analysis ===

  analyzeComplexity(task: Task): ComplexityScore {
    const fileCount = task.files.include.length
    const codeLines = task.files.include.length * 50
    const dependencyDepth = task.dependencies.length
    let domainKnowledge = 0
    const keywords = ['security', 'auth', 'payment', 'crypto', 'database']
    for (const keyword of keywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        domainKnowledge += 20
      }
    }
    domainKnowledge = Math.min(100, domainKnowledge)

    let riskLevel: string = 'low'
    const highRiskKeywords = ['migration', 'production', 'security', 'payment']
    for (const keyword of highRiskKeywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        riskLevel = 'high'
        break
      }
    }

    const overall = Math.min(100,
      (fileCount * 10) +
      (codeLines / 10) +
      (dependencyDepth * 15) +
      (domainKnowledge * 20) +
      (riskLevel === 'high' ? 30 : riskLevel === 'medium' ? 15 : 0)
    )

    return {
      overall,
      factors: { fileCount, codeLines, dependencyDepth, domainKnowledge, riskLevel: riskLevel as 'low' | 'medium' | 'high' }
    }
  }

  // === Model Selection ===

  selectModel(role: AgentRole, complexity: ComplexityScore): ModelSelection {
    return this.selectBestModel(role, complexity)
  }

  /**
   * Resolve real pricing for a model.
   *
   * `modelCosts` is keyed by "providerID/id", but callers hold either a
   * provider-qualified ref or a bare model id, and users type either form into
   * the `model.costs` tool. Resolution order:
   *   1. the exact key as given (covers "provider/id" and manually set bare ids)
   *   2. "provider/id" reconstructed from `provider` + `model`
   *   3. a bare-id match across providers — the cheapest wins, so a provider
   *      collision cannot silently shadow the cheaper price
   *
   * "Cheapest" compares the BASE tier's input rate, via `selectTier(tiers, 0)`:
   * a prompt size of 0 is below every real context threshold, so this is the
   * base row by construction rather than by indexing `tiers[0]`, which a
   * hand-edited map could have reordered.
   */
  getModelCost(model: string, provider?: string): NexusModelCost | undefined {
    const exact = this.modelCosts.get(model)
    if (exact) return exact

    if (provider) {
      const qualified = this.modelCosts.get(`${provider}/${model}`)
      if (qualified) return qualified
    }

    const bare = bareModelId(model)
    let best: NexusModelCost | undefined
    for (const [key, cost] of this.modelCosts) {
      if (bareModelId(key) !== bare) continue
      if (!best || baseInputRate(cost) < baseInputRate(best)) best = cost
    }
    return best
  }

  /**
   * RISK R5, and it got sharper with the cost term. An unrecognised model falls
   * back to 0.60 here. While the cost term was normalised against a fixed
   * ceiling, it sat at ≈1 for practically every candidate, so a badly-defaulted
   * model was rescued by price and nobody noticed the gap. Now that the cost
   * term is a real per-task estimate, a user-configured model absent from this
   * table can lose to a listed one on cost alone at low complexity. The natural
   * follow-up is to make an unrecognised model neutral rather than pessimistic
   * (or to derive quality from the price tiers), but that is a separate change
   * and deliberately not smuggled in here.
   */
  private estimateModelQuality(model: string): number {
    const quality: Record<string, number> = {
      'claude-opus-4-7': 0.95,
      'claude-sonnet-4-6': 0.85,
      'gpt-5': 0.88,
      'claude-haiku-4-5': 0.75,
      'gemini-2.5-flash': 0.78,
      'gpt-5-mini': 0.70,
      'minimax-m2.5-free': 0.50
    }
    return quality[model] || 0.60
  }

  private estimateModelSpeed(model: string): number {
    const speeds: Record<string, number> = {
      'claude-opus-4-7': 0.4,
      'claude-sonnet-4-6': 0.7,
      'gpt-5': 0.6,
      'claude-haiku-4-5': 0.9,
      'gemini-2.5-flash': 0.95,
      'gpt-5-mini': 0.85,
      'minimax-m2.5-free': 0.8
    }
    return speeds[model] || 0.5
  }

  /**
   * Score one candidate on quality and price.
   *
   * THE COST TERM IS A PER-TASK USD ESTIMATE, not a per-1K rate. It used to be
   * `estimateModelCost`, which returned *either* a real per-1K rate *or* a
   * hand-tuned relative figure — two different scales compared against a fixed
   * `maxCost = 15.00`. That ceiling was calibrated to the invented table, so
   * every REAL price scored ≈1 and cost did not discriminate at all, while two
   * identically-priced models could still score differently because one was
   * priced from `modelCosts` and the other from the table. The relative table
   * is deleted; `forecaster.estimateCost` is the single figure, and it is the
   * same one the budget filter compares.
   *
   * `estimates` is that shared map, keyed by the model reference as passed in.
   * When it is omitted the candidate is priced on its own and the cost term is
   * 1: with no comparison set, price is not a discriminator and must not be
   * scored as one. `selectBestModel` always passes the map, so the ranker and
   * the budget filter read the same numbers rather than re-deriving numbers
   * that happen to agree.
   *
   * IN PRACTICE THIS IS A STEP FUNCTION, NOT A GRADIENT. `1 - estimate/max` is
   * a ratio, but the estimates it orders come from a handful of hand-written
   * per-1K tables, so candidates land in a few distinct price bands and the
   * spread between neighbouring candidates is often a rounding-level price
   * difference. Within a band the term does not discriminate at all. A smooth
   * log-scale alternative, and normalising over only the affordable subset
   * rather than all candidates including ones the budget filter will discard,
   * are both defensible improvements — deliberately not taken here, since they
   * change which model wins and that is a design decision rather than a fix.
   *
   * KNOWN INCONSISTENCY, currently unreachable: on a missing key the budget
   * filter treats the candidate as free (`?? 0`, hence selectable) while this
   * method re-derives the estimate. It cannot fire, because `selectBestModel`
   * builds the map from the same candidate list it scores, so every key is
   * present. Left as-is rather than unified, because the two behaviours are
   * each defensible on their own terms and picking one would silently change
   * what a missing price means.
   */
  scoreModel(
    modelId: string,
    role: string,
    complexity: ComplexityScore,
    estimates?: ReadonlyMap<string, number>
  ): ModelScore {
    const [provider, ...parts] = modelId.split('/')
    const model = parts.join('/')

    const estimate = estimates?.get(modelId)
      ?? this.forecaster.estimateCost(complexity, model, provider)
    let maxEstimate = 0
    for (const value of estimates?.values() ?? []) {
      if (value > maxEstimate) maxEstimate = value
    }

    // EXPLICIT ZERO BRANCH, and it is not cosmetic. `1 - 0/0` is NaN, NaN
    // propagates into `overallScore`, and the sort comparator `(a, b) =>
    // b.overallScore - a.overallScore` then returns NaN, whose sign is falsy —
    // so the sort silently becomes a no-op and the FIRST candidate wins for
    // reasons having nothing to do with cost. Same class of quiet wrong answer
    // the `NaN` guard in `readSessionTokens` exists to prevent, and an
    // all-free candidate set is reachable whenever `modelCosts` reports a
    // locally-served model as free.
    const costScore = maxEstimate === 0 ? 1 : 1 - (estimate / maxEstimate)
    const quality = this.estimateModelQuality(model)
    const speedScore = this.estimateModelSpeed(model)

    // Weight based on complexity: high complexity favors quality, low favors cost
    const qualityWeight = complexity.overall > 70 ? 0.6 : complexity.overall > 40 ? 0.4 : 0.2
    const costWeight = 1 - qualityWeight

    const overallScore = (quality * qualityWeight) + (costScore * costWeight)

    return {
      model,
      provider,
      costScore,
      qualityScore: quality,
      // PRE-EXISTING and unchanged: `speedScore` is reported but is not a term
      // in `overallScore`, so it never affects selection.
      speedScore,
      overallScore,
      reasoning: `Score: ${overallScore.toFixed(2)} (quality: ${quality.toFixed(2)}, cost: ${costScore.toFixed(2)} [~$${estimate.toFixed(4)}/task], speed: ${speedScore.toFixed(2)})`
    }
  }

  selectBestModel(role: string, complexity: ComplexityScore): ModelSelection {
    const configModel = this.configManager.getModelForRole(role)

    // Build candidate list: configured model + alternatives
    const candidates = [
      configModel,
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'opencode/minimax-m2.5-free'
    ]

    // Deduplicate while preserving order
    const unique = [...new Set(candidates)]

    // ONE price per candidate, resolved once. The budget filter and the ranker
    // both read this map, so they agree by construction rather than by two
    // coincidentally-identical calculations.
    const estimates = new Map<string, number>()
    for (const ref of unique) {
      const [provider, ...parts] = ref.split('/')
      estimates.set(ref, this.forecaster.estimateCost(complexity, parts.join('/'), provider))
    }

    // Score all candidates
    const scored = unique.map(ref => ({ ref, score: this.scoreModel(ref, role, complexity, estimates) }))

    // Filter by budget. The comparison is between two per-task dollar figures:
    // the estimated cost of running a task of this complexity on the candidate,
    // versus what is left of the total budget. The old filter compared a per-1K
    // RATE against a per-task remaining total, which are not commensurable, so
    // it excluded models essentially at random.
    const budgetRemaining = this.budget.maxTotalCost - this.totalSpent
    const affordable = scored.filter(({ ref }) => {
      const estimate = estimates.get(ref) ?? 0
      // A genuinely free model costs nothing and must stay selectable however
      // little budget is left — hence the `=== 0` escape hatch.
      return estimate <= budgetRemaining || estimate === 0
    })

    // Pick best — prefer affordable models, but fall back to all if none are affordable
    const best = (affordable.length > 0 ? affordable : scored)
      .sort((a, b) => b.score.overallScore - a.score.overallScore)[0]

    return {
      provider: best.score.provider,
      model: best.score.model,
      // A per-task estimate in USD, which is what the field is named and what
      // consumers read it as. Read from the same map the filter and the ranker
      // used, so the reported figure is the figure that was compared.
      estimatedCost: estimates.get(best.ref) ?? 0,
      estimatedQuality: best.score.qualityScore,
      reasoning: best.score.reasoning
    }
  }

  // === Cost Tracking ===

  /**
   * The ONE place spend is mutated. `model` is expected in the same
   * "providerID/id" form `modelCosts` uses, so `costByModel` and the price
   * table can be joined directly. `provenance` is required rather than
   * defaulted: an accounting entry that does not say whether its tokens and
   * rate were real is a reporting bug, so the caller has to state it.
   */
  trackCost(agentId: string, model: string, cost: number, tokens: number, provenance: CostProvenance): void {
    this.totalSpent += cost
    const agentCost = this.costByAgent.get(agentId) || 0
    this.costByAgent.set(agentId, agentCost + cost)
    const modelCost = this.costByModel.get(model) || 0
    this.costByModel.set(model, modelCost + cost)
    this.tokensByModel.set(model, (this.tokensByModel.get(model) || 0) + tokens)
    this.recordProvenance(model, cost, provenance)
    this.costHistory.push({ timestamp: Date.now(), cost, agentId, model, tokens, provenance })
    this.checkBudget()
    this.notifyStateChange()
  }

  /** Accumulate per-model provenance, keeping the split of measured vs predicted. */
  private recordProvenance(model: string, cost: number, provenance: CostProvenance): void {
    const measured = provenance.usage === 'measured'
    const prior = this.costProvenance.get(model) ?? {
      usage: provenance.usage,
      pricing: provenance.pricing,
      measuredEntries: 0,
      estimatedEntries: 0,
      measuredSpend: 0,
      estimatedSpend: 0,
    }
    // `usage` / `pricing` are last-write-wins; the counters and the spend split
    // are what make a mixed model legible.
    prior.usage = provenance.usage
    prior.pricing = provenance.pricing
    if (measured) {
      prior.measuredEntries++
      prior.measuredSpend += cost
    } else {
      prior.estimatedEntries++
      prior.estimatedSpend += cost
    }
    this.costProvenance.set(model, prior)
  }

  /**
   * Lifetime measured/estimated spend, over exactly the entries that make up
   * `totalSpent` — `trackCost` records provenance for every charge, so the two
   * halves always re-sum to the headline. Returned as the `SpendSplit` half of
   * an `ExecutionResult` and of the cost report, from one place, so the two
   * cannot drift apart.
   */
  private spendSplit(): SpendSplit {
    return {
      measuredSpend: sumBy(this.costProvenance, p => p.measuredSpend),
      estimatedSpend: sumBy(this.costProvenance, p => p.estimatedSpend),
    }
  }

  /**
   * `accountTaskCost` with its failures contained. Cost accounting must not be
   * able to fail the task it is accounting for: an unexpected throw here would
   * otherwise discard a completed task's real output, mark it failed, and let
   * the per-node handler overwrite its result with `cost: 0`. The failure mode
   * we want is "we lost the number", not "we lost the task" — hence a zero
   * charge labelled as an unknown-model estimate, so it is never read as a
   * measured $0.
   */
  private safeAccountTaskCost(agent: Agent, task: Task): Promise<TaskCost> {
    return this.accountTaskCost(agent, task).catch((): TaskCost => ({
      cost: 0,
      tokensUsed: 0,
      provenance: { usage: 'estimated', pricing: 'unknown-model' },
    }))
  }

  /**
   * Cost one task from its session's REAL token usage.
   *
   * `SessionInfo.cost` is deliberately not consulted, and the reason is
   * granularity rather than unit. OpenCode prices every model CALL at the
   * context tier that call's own prompt falls into and accumulates the running
   * total; we are handed one SESSION TOTAL and make a SINGLE tier selection for
   * it. Token counts are the trustworthy signal; the provider-billed total is a
   * figure we cannot reproduce at our observation granularity, and reading it
   * would also mean mixing a tier-aware total with our own per-1K rates.
   *
   * The error is not signed in a knowable direction. With monotonically
   * non-decreasing rates — a premium tier costs more, the common case — a
   * session sum reaches at least as high a tier as any single call's prompt, so
   * we over-report. But a provider may publish a DISCOUNTED long-context tier
   * (Gemini's long-context pricing is exactly this shape): several
   * sub-threshold calls then sum past the threshold and we bill the whole
   * session at the cheaper rate, under-reporting by the ratio between base and
   * discounted rate. T5 in `test/pricing-tiers.test.ts` is the worked example.
   * These figures are therefore not reconcilable with `SessionInfo.cost` in
   * either direction, and must not be presented as the bill.
   *
   * Falls back to the forecaster's token estimate ONLY when the session could
   * not be read. A session that was read successfully and consumed nothing is a
   * real zero and is billed as one — inventing an estimate there would be the
   * one place this code manufactures money. The provenance recorded alongside
   * keeps the difference visible in state.
   */
  private async accountTaskCost(agent: Agent, task: Task): Promise<TaskCost> {
    const model = `${agent.model.provider}/${agent.model.model}`
    const read = agent.sessionID ? await this.readSessionTokens(agent.sessionID) : { read: false as const }

    if (read.read) {
      const measured = this.forecaster.measureCost(read.usage, model, agent.model.provider)
      return {
        cost: measured.cost,
        tokensUsed: measured.tokens,
        provenance: { usage: 'measured', pricing: measured.pricingSource },
      }
    }

    const predicted = this.forecaster.forecastTask(task, task.requiredRole, model, task.complexity)
    return {
      cost: predicted.estimatedCost,
      tokensUsed: predicted.estimatedInputTokens + predicted.estimatedOutputTokens,
      provenance: { usage: 'estimated', pricing: predicted.pricingSource },
    }
  }

  /**
   * Real token usage for a session. Discriminated rather than nullable: `read:
   * false` means the count is UNKNOWN (so an estimate is legitimate), while
   * `read: true` with zero tokens means the session genuinely consumed nothing
   * and that zero must survive. Best-effort — a session-API failure must not
   * fail a task that already ran.
   *
   * Every field is coerced to a finite, non-negative number.
   * `SessionInfo.tokens` is a
   * projection that the installed server always populates, but a missing field
   * would otherwise make `output + undefined` → `NaN`, which flows through the
   * pricing into `totalSpent`; `checkBudget` then compares `NaN` (always false)
   * and the budget alarm goes silent for the rest of the process while every
   * reported cost reads `NaN`. A wrong-but-finite number is strictly better
   * than a poisoned total.
   */
  private async readSessionTokens(sessionID: string): Promise<{ read: true; usage: TokenUsage } | { read: false }> {
    // Non-negative as well as finite: a token count cannot be negative, and
    // letting one through would SUBTRACT from reported spend.
    const finite = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    try {
      const session = await this.ctx?.session.get({ sessionID })
      const tokens = session?.tokens
      if (!tokens) return { read: false }
      return {
        read: true,
        usage: {
          input: finite(tokens.input),
          output: finite(tokens.output),
          reasoning: finite(tokens.reasoning),
          cache: { read: finite(tokens.cache?.read), write: finite(tokens.cache?.write) },
        },
      }
    } catch {
      return { read: false }
    }
  }

  private checkBudget(): void {
    const remaining = this.budget.maxTotalCost - this.totalSpent
    const remainingPercent = remaining / this.budget.maxTotalCost

    if (remainingPercent <= this.config.budget.alertThreshold) {
      this.emit('budget:alert', { remaining, remainingPercent })
      // Notify on budget alert
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Budget Alert', body: `Budget low: $${remaining.toFixed(2)} remaining (${(remainingPercent * 100).toFixed(1)}%)`, sound: true })
      }
    }

    if (this.budget.hardLimit && remaining <= 0 && !this.budgetExceeded) {
      this.budgetExceeded = true
      this.emit('budget:exceeded', { totalSpent: this.totalSpent })
      this.pause()
    }
  }

  // === Communication ===

  publish(topic: string, message: Omit<AgentMessage, 'id' | 'timestamp'>): void {
    const fullMessage: AgentMessage = {
      ...message,
      topic: message.topic ?? topic,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    }
    this.messageQueue.push(fullMessage)

    // Persist to message store
    this.messageStore.add(fullMessage)

    // Legacy topic-based pub/sub
    const handlers = this.subscribers.get(topic) || []
    handlers.forEach(handler => handler(fullMessage))

    // Fan-out routing (topic + wildcard subscribers)
    this.messageRouter.route(fullMessage)
  }

  subscribe(topic: string, handler: (msg: AgentMessage) => void): () => void {
    const handlers = this.subscribers.get(topic) || []
    handlers.push(handler)
    this.subscribers.set(topic, handlers)
    return () => {
      const idx = handlers.indexOf(handler)
      if (idx > -1) handlers.splice(idx, 1)
    }
  }

  // === Memory ===

  setMemory(scope: MemoryScope, key: string, value: unknown, author: string): void {
    const entry = this.memoryStore.set({
      key,
      value,
      scope,
      author,
      confidence: 1.0,
      tags: []
    })
    this.emit('memory:set', entry)
  }

  getMemory(scope: MemoryScope, key: string): MemoryEntry | undefined {
    return this.memoryStore.get(key, scope) ?? undefined
  }

  // === Query ===

  getStatus(detailed?: boolean): string {
    const state = this.getState()
    // Which config files the last load consulted, and what they resolved to.
    // Without this, "the subagent used the wrong model" has no answer short of
    // reading the load log by hand.
    const loadInfo = this.configManager.getLoadInfo()
    // Read the model map live, not off the load snapshot: a preset applied
    // after the last load is exactly the case this block has to get right.
    const config = {
      loaded: loadInfo !== null,
      loadedAt: loadInfo?.loadedAt ?? null,
      loadCount: loadInfo?.loadCount ?? 0,
      // When true, `models` includes an in-process preset/TUI override and is
      // therefore not a statement about what is on disk.
      sessionOverride: this.configManager.hasSessionOverride(),
      // True when a session override is shadowing the `models` level, i.e. the
      // config file's model choices are being ignored right now. Machine-
      // readable because the audience that most needs to know is an agent
      // deciding why its spawn used an unexpected model.
      diskModelsIgnored: this.configManager.hasSessionOverride(),
      // Which mechanism caused the last load. `poll` on every reload means the
      // host is not delivering `filesystem.changed` for these files.
      trigger: loadInfo?.trigger ?? null,
      project: loadInfo?.project ?? null,
      global: loadInfo?.global ?? null,
      models: this.configManager.getResolvedModels()
    }
    // `totalSpent` is a lifetime total over mixed charges, so the split travels
    // with it everywhere this is rendered. `totalCost` / `totalSpent` keep
    // their meaning and their keys; a reader who wants only those still gets
    // them, and a reader who acts on the number can see what it is made of.
    const spend = this.spendSplit()
    if (detailed) return JSON.stringify({ ...state, ...spend, budgetExceeded: this.budgetExceeded, config }, null, 2)
    return JSON.stringify({
      running: state.running,
      paused: state.paused,
      budgetExceeded: this.budgetExceeded,
      agents: state.agents.length,
      tasks: state.tasks.length,
      totalCost: state.totalSpent,
      ...spend,
      budgetRemaining: state.budgetRemaining,
      config
    }, null, 2)
  }

  listAgents(filter?: string): string {
    const state = this.getState()
    const filtered = filter
      ? state.agents.filter(a => a.status === filter)
      : state.agents
    return JSON.stringify(filtered, null, 2)
  }

  getCostReport(): string {
    const state = this.getState()
    return JSON.stringify({
      totalSpent: state.totalSpent,
      budgetRemaining: state.budgetRemaining,
      // Headline split, so `totalSpent` is not read as fully billed on its own.
      ...this.spendSplit(),
      byAgent: Object.fromEntries(this.costByAgent),
      byModel: Object.fromEntries(this.costByModel),
      tokensByModel: Object.fromEntries(this.tokensByModel),
      // Per model: last entry's provenance plus the measured/estimated split, so
      // `byModel[model]` can be read without assuming all of it is billed.
      provenance: Object.fromEntries(this.costProvenance),
      measuredEntries: sumBy(this.costProvenance, p => p.measuredEntries),
      estimatedEntries: sumBy(this.costProvenance, p => p.estimatedEntries)
    }, null, 2)
  }

  // === Control ===

  pause(): void {
    this.paused = true
    this.emit('orchestrator:paused', {})
    this.notifyStateChange()
  }

  resume(): void {
    this.paused = false
    this.emit('orchestrator:resumed', {})
    this.notifyStateChange()
  }

  isBudgetExceeded(): boolean {
    return this.budgetExceeded
  }

  resetBudgetExceeded(): void {
    this.budgetExceeded = false
  }

  async shutdown(): Promise<void> {
    // Tear down all modules before stopping orchestrator components
    await this.moduleRegistry.teardownAll()

    this._healthMonitor?.stop()
    this.stopDashboard()
    this.memoryStore.close()
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    if (this.stateChangeTimer) {
      clearTimeout(this.stateChangeTimer)
      this.stateChangeTimer = null
    }
    this.agents.forEach((agent) => {
      agent.status = 'terminated'
    })
    this.agents.clear()
    this.running = false
    this.emit('orchestrator:shutdown', {})
    this.onStateChange?.()
  }

  // === Helpers ===

  /**
   * Periodically clean up stale agents and cost history to prevent unbounded memory growth.
   */
  private cleanupStaleData(): void {
    const now = Date.now()

    // Clean old terminated agents (terminated for > 1 hour)
    for (const [id, agent] of this.agents) {
      if (agent.status === 'terminated' &&
          now - agent.lastActivity.getTime() > 3600000) {
        this.agents.delete(id)
      }
    }

    // Trim cost history if it grows too large (keep last 500 entries)
    if (this.costHistory.length > 1000) {
      this.costHistory = this.costHistory.slice(-500)
    }
  }

  /**
   * Enforce agent map size limit to prevent unbounded growth.
   * Removes oldest terminated agents when over the concurrency limit.
   */
  private enforceAgentLimit(): void {
    const MAX_AGENTS = this.config.maxConcurrency || 10
    if (this.agents.size > MAX_AGENTS) {
      // Find oldest terminated agents to clean up first
      const terminated = [...this.agents.entries()]
        .filter(([_, a]) => a.status === 'terminated')
        .sort((a, b) => a[1].lastActivity.getTime() - b[1].lastActivity.getTime())

      const toRemove = terminated.slice(0, this.agents.size - MAX_AGENTS)
      for (const [id] of toRemove) {
        this.agents.delete(id)
      }
    }
  }

  /**
   * Get or lazily initialize the health monitor
   */
  private getOrCreateHealthMonitor(): HealthMonitor {
    if (!this._healthMonitor) {
      this._healthMonitor = new HealthMonitor({
        checkInterval: this.config.agents.healthCheckInterval
      })
    }
    return this._healthMonitor
  }

  private collectResults(): TaskResult[] {
    const results: TaskResult[] = []
    if (this.dag) {
      this.dag.nodes.forEach((node) => {
        if (node.result) results.push(node.result)
      })
    }
    return results
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // === Events ===

  on(event: string, handler: Function): () => void {
    const handlers = this.eventHandlers.get(event) || []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
    return () => {
      const idx = handlers.indexOf(handler)
      if (idx > -1) handlers.splice(idx, 1)
    }
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) || []
    handlers.forEach(handler => handler(data))
  }

  // === Command Handling ===

  handleCommand(text: string): string {
    const parts = text.split(' ')
    const command = parts[1]

    switch (command) {
      case 'status':
        return this.getStatus(true)
      case 'agents':
        return this.listAgents(parts[2])
      case 'costs':
        return this.getCostReport()
      case 'pause':
        this.pause()
        return "Orchestrator paused"
      case 'resume':
        this.resume()
        return "Orchestrator resumed"
      case 'dashboard':
        return JSON.stringify(this.getState(), null, 2)
      default:
        return 'Unknown command. Available: status, agents, costs, pause, resume, dashboard'
    }
  }
}
