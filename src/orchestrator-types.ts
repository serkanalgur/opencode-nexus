/**
 * Types shared by the orchestrator and its callers. Moved out of
 * `src/orchestrator.ts` unchanged; that module re-exports every name.
 */
import type { Plugin } from "@opencode/plugin"
import type { Agent, DAGNode, AgentRole, BudgetConstraint, MemoryEntry, NexusConfig, TaskResult, CostProvenance, CostReportUncollected } from "./types"
import { totalTokens, type ModelPricingTiers, type PricingSource, type TokenUsage, type UsageSource } from "./forecast"

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
export interface OpenCodeModelCost {
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
export interface TaskCost {
  cost: number
  tokensUsed: number
  provenance: CostProvenance
  /**
   * The session usage this charge was derived from, or `null` when the charge
   * is a fallback estimate.
   *
   * Carried so the timeout path can tell "we measured this session and here is
   * the snapshot we billed" from "we never managed to read it". Only the first
   * can be corrected: a delta needs a measured baseline to subtract from, and
   * arming one against a predicted charge would bill a correction to a guess.
   */
  usage: TokenUsage | null
  /**
   * `time.idle` as of the same read, or 0 when there was none. Carried so the
   * timeout path has a settlement threshold that genuinely predates its own
   * deadline, without spending a second `session.get` to look it up.
   */
  idleAt: number
}


/** Per-model accounting provenance, so a model with mixed charges is legible. */
export interface ModelProvenance {
  usage: UsageSource
  pricing: PricingSource
  measuredEntries: number
  estimatedEntries: number
  measuredSpend: number
  estimatedSpend: number
}


/**
 * One outstanding "bill the rest of this session" obligation, keyed by
 * SESSION id.
 *
 * KEYED ON `sessionID`, NOT `nodeId`, and the reason is load-bearing: every
 * escalation step (retry, respawn, fallback model) spawns a NEW session, so a
 * node that times out four times produces four independent deltas. Keyed on
 * `nodeId`, those four attempts would fight over one entry and three of them
 * would compute a zero delta against a snapshot the others had already moved
 * past.
 *
 * `charged` is a CUMULATIVE snapshot of what has been billed for this session,
 * not a running sum of increments, so the next delta is simply
 * `max(0, now - charged)` componentwise. Cumulative is what makes the invariant
 * below expressible at all: with a running sum there is no state to compare
 * `now` against, and a second caller's only way to avoid a double bill would be
 * to trust that nobody else got there first.
 *
 * IDEMPOTENCY INVARIANT: a second caller for a session already being settled
 * bills nothing, because `pending` is set synchronously before the first
 * `await` and spans the whole body, and the settled ledger is then deleted in
 * the `finally`. A naive second `trackCost` would be a straight double bill,
 * which is strictly worse than the under-bill this whole mechanism exists to
 * fix, and there is no idempotency key anywhere else in the plugin that would
 * have caught it.
 *
 * `charged` is written back before the charge. That is the SECOND layer, and it
 * is a real one rather than a redundant one: with `pending` removed, re-entry
 * from a `budget:alert` subscriber bills the same increment twice, because that
 * subscriber fires from inside `trackCost` — after the charge, before this
 * method's `finally` — and so computes its delta against the stale snapshot.
 * Swapping the two statements ALONE, with `pending` intact, is caught by no
 * test; that is measured, and it is the honest limit of what the suite pins.
 * The ordering is kept because it makes `charged` a single local source of
 * truth written by the same method that reads it. See `settleTimeoutDelta` for
 * the three-block analysis.
 */
export interface TimeoutDeltaLedger {
  sessionID: string
  /** DAG node id. Reported so an abandoned session can be traced to its task. */
  taskId: string
  agentId: string
  /**
   * The agent whose session this is, retained so `agent.metrics.totalCost` can
   * be corrected on settlement. It is a per-AGENT figure that `getState()` and
   * `listAgents()` publish and the dashboard charts, and leaving it at the
   * timeout snapshot made it the one per-agent cost that disagreed with its
   * two corrected siblings (`costByAgent` via `trackCost`, and the history
   * record via `adjust`).
   *
   * Retaining the object is safe where retaining `node` is not: escalation
   * spawns a NEW agent per attempt, so this reference is unambiguous. It may
   * point at an agent already removed from `this.agents` by `terminateAgent`,
   * which is exactly the case worth correcting — a terminated agent's late spend
   * is otherwise visible nowhere at all.
   */
  agent: Agent
  /**
   * The DAG node, and the exact `result` object this attempt produced, so
   * `node.result.cost` can be corrected — but ONLY while it is still the
   * current result. Escalation re-enters `executeTask` with the SAME node and
   * overwrites `node.result`, so a late delta from attempt 1 must not be added
   * to attempt 2's figure. The identity check at the correction site is what
   * makes this safe, and a node whose result has moved on is reported as
   * uncorrected rather than silently mis-added.
   */
  node: DAGNode
  result: CostedTaskResult
  /** "providerID/model" — the `trackCost` key and the `modelCosts` key. */
  model: string
  provider: string
  /** Cumulative session usage already billed. See the note above. */
  charged: TokenUsage
  /** `time.idle` observed at the timeout snapshot. The settlement threshold. */
  idleAtTimeout: number
  /** Re-entrancy guard. Set synchronously, before any `await`. */
  pending: boolean
  /** The `ExecutionHistory` record id, so the record is adjusted in place. */
  historyId: string
  /** The `PerformanceTracker` entry id, likewise. */
  performanceId: string
  /** Aborts the abandoned `session.wait` long-poll once we are done with it. */
  abort: AbortController
}


/** A session we stopped collecting from while it was still running. */
export interface UncollectedSpend {
  sessionID: string
  taskId: string
  agentId: string
  model: string
  /** The most recent token count we actually read for this session. */
  lastKnownTokens: number
  /**
   * Priced value of the increment observed between the last charge and the
   * last read, which is spend that happened and was not billed. A LOWER BOUND
   * on the under-count, NOT an upper bound on it: everything the session spends
   * after that read is also unbilled and, for a session abandoned while still
   * generating, is unbounded. See `CostReportUncollected`.
   */
  observedUncollected: number
}


/**
 * What the `uncollected` cap dropped, so that a bounded map does not become a
 * silently shrinking number.
 *
 * The cost of evicting an abandoned session is that it stops appearing in the
 * `uncollected` block's `entries` and in `getState().sessions[]`. The
 * under-count does not go away — it is still real spend we did not bill — but
 * after eviction the only place it is visible is here. So the aggregate travels
 * with the entries rather than being discarded with them: a reader can always
 * say "at least $X, across N sessions, some of which are no longer itemised".
 *
 * `observedUncollected` here is a LOWER BOUND in exactly the sense the
 * surviving entries' is, and it is NOT added into the surviving total — see
 * `uncollectedSummary` for why the two are reported side by side rather than
 * summed into one number that would read as the under-count.
 */
export interface UncollectedEviction {
  /** How many abandoned sessions have been dropped from `entries`. */
  sessions: number
  /** Sum of each dropped session's last successfully read token count. */
  lastKnownTokens: number
  /**
   * Sum of each dropped session's observed-but-uncharged spend, in USD. A
   * LOWER BOUND on the under-count of the dropped sessions, on the same terms
   * as the surviving entries'.
   */
  observedUncollected: number
  /** The cap in force, so a reader can tell "0 dropped" from "never hit". */
  cap: number
}


/**
 * `CostReportUncollected` plus the eviction block.
 *
 * Declared HERE rather than in `types.ts` because that file is outside this
 * change's allowed paths, and it is worth naming why that matters: the honest
 * shape of this report is `CostReportUncollected` MINUS a field. The public
 * `uncollected` block must grow an `evicted` key, because the cap means
 * "entries" is no longer the whole story, and a reader who cannot see the cap
 * cannot tell a complete list from a truncated one. Growing the interface
 * locally keeps the extension visible and typed at the one site that produces
 * it, rather than leaving the report's real shape undocumented in its own
 * declaration.
 */
export interface UncollectedSummary extends CostReportUncollected {
  evicted: UncollectedEviction
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


export type SpawnedAgent = Agent & {
  spawnPath?: SpawnPath
  /**
   * The exact text `spawnAgent` delivered to the child session, with any
   * recollection block already appended.
   *
   * Present so a caller that ALSO delivers the task — the degraded
   * `ctx.session.prompt` fallback in `index.ts` — sends this instead of
   * re-deriving the task from its own arguments. That fallback used to send the
   * caller's original string, which bypassed the composed text entirely and
   * made "recollections are injected on spawn" true of one of the two spawn
   * paths rather than both.
   *
   * Equals the caller's own text when nothing was recalled, so sending it is
   * always safe and never a behaviour change on the common path.
   */
  deliveredText?: string
}


export interface ModelScore {
  model: string
  provider: string
  /**
   * The `#variant` half of the candidate reference, WITHOUT the `#`, or
   * `undefined` for a variant-free one. Carried alongside `model` rather than
   * inside it because `model` is the bare id the pricing path resolves against,
   * and slicing the id off is what dropped the variant before. `undefined` when
   * the reference is not parseable at all — a bare id leaves `model` empty (see
   * `scoreModel`), and inventing a variant for it would be a guess.
   */
  variant?: string
  costScore: number      // 0-1, lower cost = higher score
  qualityScore: number   // 0-1, from estimateModelQuality
  speedScore: number     // 0-1, estimated based on model size
  overallScore: number   // weighted combination
  reasoning: string
}


/**
 * One session the orchestrator knows something about, as published on
 * `OrchestratorState.sessions`.
 *
 * WHY THIS EXISTS, since it is not a collection anything else holds: on the
 * timeout path the task is failed and `handleFailure` calls `terminateAgent`,
 * which does `this.agents.delete(agentId)`. The session is NOT aborted — it
 * keeps generating and keeps spending (see the `ExecutionResult.totalCost`
 * note) — so a RUNNING SESSION WITH NO OWNING AGENT exists, and it was
 * invisible on every layer: not in `agents` (deleted), not in the page's
 * activity log, and not in the cost report, which could say it was
 * under-billing but not WHICH session. `agentId: null` with `owned: false` is
 * the field that makes that case visible rather than merely possible.
 *
 * SCOPE, deliberately narrow. This is a union of the three collections nexus
 * already holds — owned agents, pending timeout collections, and abandoned
 * spend. It is NOT an enumeration of every open session on the server:
 * `SessionDomain` is a `Pick<SessionApi, …>` that excludes `list`, so the
 * server cannot be asked. It is also NOT built by walking `parentID`, because a
 * `ctx.session.create()` child is NOT parent-linked (see `lastDegradedSpawn`),
 * which is exactly what the TUI's `family()`-based sidebar gets wrong.
 *
 * `state` is INFERRED FROM NEXUS'S OWN BOOKKEEPING, not observed from the
 * server. `ctx.session.get` would give an authoritative `time.idle`, but
 * `getState()` is synchronous and is called from every throttled push and from
 * `/api/state`; making it await one request per session would turn a
 * single-socket state push into an N-request fan-out against the same server
 * that is running the agents. A field that is usually right because it is
 * usually stale is worse than a field that is honestly derived, so this is
 * derived.
 */
export interface SessionStateView {
  /** OpenCode session id. The key: one row per session, never per agent. */
  id: string
  /** True iff an entry for this session's agent is in `this.agents` right now. */
  owned: boolean
  /**
   * The owning agent's id, or null when the session is an ORPHAN — a session
   * that is still running (or was, when we gave up collecting) after its agent
   * was removed by `terminateAgent`. This is the field the whole view exists
   * for: an orphan with a non-zero `observedUncollected` is spend that happened
   * and was not billed, attached to a session nobody owns.
   */
  agentId: string | null
  /** DAG node id, when known: the collection record's, else the task assigned to the agent. */
  taskId: string | null
  /** The owning agent's role, or null for an orphan. */
  role: AgentRole | null
  /** "providerID/model", or null when no collection record named one. */
  model: string | null
  /**
   * - `running`   — actively doing work: an agent that is spawning/working, or a
   *   session whose timed-out cost we are still collecting. On the DAG path
   *   this is the whole of the task: `executeTask` sets `working` before it
   *   issues the prompt, and the `finally` puts it back down.
   * - `idle`      — an agent alive but BETWEEN tasks (`idle`, `blocked`). An
   *   agent at `idle` holds a session and is expected to be given more work;
   *   it is not spending. An agent that IS spending reports `running`.
   * - `settled`   — an agent that is done (`completed`, `failed`, `terminated`)
   *   and is not expected to spend more. Distinct from `idle` because "not
   *   spending right now" and "finished" are different answers.
   * - `abandoned` — we stopped collecting its cost while it was still running.
   *   The only state that implies unbilled spend; see `observedUncollected`.
   *
   *   All four are reachable on the DAG path: `running` and `idle` by the
   *   transition above, `settled` by a terminal status, and `abandoned` by a
   *   `terminateAgent` that leaves a still-running session behind.
   *
   *   An `abandoned` row is ABSENT once the `uncollected` cap has evicted it,
   *   because pass 3 of `sessionViews()` reads that map. A row vanishing here
   *   therefore means "we dropped the detail", NOT "nothing was unbilled" — the
   *   cost report's `uncollected.evicted` block carries the sums for whatever
   *   left, and is the surface to read for the magnitude. This is the one place
   *   the cap is visible as a disappearance rather than as a number, which is
   *   why the doc says so here too.
   */
  state: 'running' | 'idle' | 'abandoned' | 'settled'
  /** ISO timestamp, from the owning agent. null for an orphan. */
  spawnedAt: string | null
  /**
   * The most recent token count we have actually observed for this session.
   *
   * Three sources, in descending order of precision: the abandoned record's
   * `lastKnownTokens` (a real read), the ledger's cumulative `charged` usage
   * (also a real read), and — for a plain owned session with no ledger — the
   * owning agent's measured `metrics.totalTokens`. Nexus spawns one agent per
   * task, so for an owned session that last figure is the same quantity. A
   * session with no read at all reports 0, which means "unobserved", not
   * "spent nothing"; the same convention `readSessionTokens` uses for a missing
   * `time.idle`.
   */
  lastKnownTokens: number
  /**
   * Priced value of the increment we observed but did not charge, in USD. 0
   * unless this session is in `uncollected`, where it is a LOWER BOUND on the
   * under-count rather than an upper bound. See `CostReportUncollected`.
   */
  observedUncollected: number
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
    /**
     * Tokens measured for this agent, from `Agent.metrics`. Collected, and
     * corrected by the timeout-delta settlement, but never read here — so the
     * page had a cost per agent and no tokens for it.
     */
    totalTokens: number
    /** `Agent.metrics.averageResponseTime`, in ms. */
    averageResponseTime: number
    /** `Agent.metrics.errorRate`, 0-1. */
    errorRate: number
    totalCost: number
  }>
  tasks: Array<{
    id: string
    name: string
    role: string
    priority: string
    status: string
    /**
     * DAG edge ids — what this task waits on, per `Task.dependencies`. Absent
     * from the projection before, so the page drew a flat list whose arrows
     * meant nothing. Empty (never null) for a task with no dependencies, so a
     * client can tell "no edges" from "not reported".
     */
    dependencies: string[]
    assignedAgent?: string
    /** `TaskResult.cost` — the billed figure for this task. */
    cost?: number
    /** `TaskResult.tokensUsed`. */
    tokensUsed?: number
    result?: { success: boolean; output?: string; error?: string; duration: number }
  }>
  /**
   * The live, resolved configuration, under its REAL key names.
   *
   * Present so a consumer does not have to invent a config. The names are the
   * contract and no aliases are provided: `budget.maxTotalCost` (not
   * `maxBudget`/`max`), `budget.hardLimit` (not `autoTerminate` — and with the
   * opposite sense to what that name suggests, since `hardLimit: true` means
   * "STOP at the ceiling"), `selfHealing.enabled` (not `retryOnFailure`).
   * There is no `criticalThreshold`/`criticalPct`, `escalation` or
   * `deadlockDetection` key on either side, because no such configuration
   * exists: `alertThreshold` is the only budget threshold, and
   * `selfHealing.maxRetries` is the retry knob.
   */
  config: {
    /** Resolved `role -> model` map, after defaults -> global -> project -> session override. */
    models: Record<string, string>
    /**
     * The budget actually in force. Read from `this.budget` rather than
     * `this.config.budget` because `execute()` can replace the former with the
     * caller's `ExecutionRequest.budget` for the duration of a run; a config
     * panel reading the configured ceiling while spend is measured against
     * another one would lie by omission.
     */
    budget: BudgetConstraint
    selfHealing: NexusConfig['selfHealing']
  }
  /**
   * Sessions nexus knows about, orphans included. See `SessionStateView` for
   * why this is a union of three internal collections rather than a session
   * list, and for the scope limits that keep it from being one.
   */
  sessions: SessionStateView[]
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


export interface ContextTransferData {
  previousAgentId: string
  partialResults: string[]
  decisions: string[]
  memoryEntries: MemoryEntry[]
  taskProgress: number // 0-100 percentage
  errorLog: string[]
}
