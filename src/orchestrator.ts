import type { Plugin } from "@opencode/plugin"
import type {
  Agent, Task, DAG, DAGNode, ExecutionRequest, ExecutionResult,
  AgentRole, ComplexityScore, ModelSelection, BudgetConstraint,
  AgentStatus,
  CostReport, AgentMessage, MemoryEntry, MemoryScope,
  SpawnConfig, RecoveryAction, HealthStatus, NexusConfig, TaskResult,
  CostProvenance, SpendSplit, CostReportUncollected
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
  priceUsage,
  priceUsageAtSettledTier,
  promptSizeOf,
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
interface ModelProvenance {
  usage: UsageSource
  pricing: PricingSource
  measuredEntries: number
  estimatedEntries: number
  measuredSpend: number
  estimatedSpend: number
}

/**
 * The timeout of `executeTask`, typed.
 *
 * `handleFailure` records `error.message` as the learning store's failure
 * pattern, and that message is the KEY those patterns are stored and looked up
 * under. So `message` is fixed at exactly `"Task timed out"` and this class
 * adds no `cause`, no subclass-specific prefix and no `name`-derived
 * decoration: giving a timeout a distinct TYPE is worth doing (a caller can
 * tell "this task ran out of budget" from "this task threw"), and forking the
 * learning store's keys is not. `test/task-cost.test.ts` pins the key.
 */
export class TaskTimeoutError extends Error {
  constructor(message: string = 'Task timed out') {
    super(message)
    this.name = 'TaskTimeoutError'
  }
}

/**
 * Backoff between retries of the DELTA read, in ms.
 *
 * Three rungs, so three attempts. Only the first two are ever used by three
 * attempts; the third is what a fourth attempt would wait, kept in the same
 * array so the escalation shape is legible in one place.
 *
 * A failed delta read is a RETRYABLE CONDITION, not a failed charge. It is also
 * why the delta path does not go through `safeAccountTaskCost`, whose
 * estimate-on-read-failure fallback is right for the initial charge and wrong
 * here: a delta whose read failed is not a delta, it is an abandoned
 * collection, and laundering it through `forecastTask` would report a guess as
 * though it were a correction to a measurement.
 */
const DELTA_READ_BACKOFF_MS: readonly number[] = [1000, 2000, 4000]

/**
 * How many abandoned sessions `uncollected` itemises before the oldest is
 * dropped into `uncollectedEvicted`.
 *
 * A CAP, not a TTL, and the choice is forced rather than preferred. A TTL would
 * have to be keyed off the session's own `time.idle`, and that is exactly the
 * value an abandoned session does not have: a session reaches `uncollected`
 * precisely because it never went idle, or because the read that would have
 * shown it idle failed every retry. `readSessionTokens` coerces a missing
 * `time.idle` to 0 for precisely this reason. So an honest TTL would have to
 * re-read the session API on a schedule — async work, from a synchronous
 * projection, for a record whose whole content is "we stopped watching this" —
 * and any TTL short enough to matter would be expiring entries that are still
 * billing, which is worse than the leak it fixes.
 *
 * WHY 200. An entry here is far heavier than a history row: it becomes a
 * `sessions[]` entry on EVERY throttled push and every `/api/state` request,
 * and a full object in `/api/costs`. 200 itemised abandoned sessions is far
 * past the number a real run reaches — an entry requires a task to time out AND
 * its collection to be given up on, so this bounds the payload at a size no
 * dashboard will visibly truncate, while still being a bound. It matches
 * `ExecutionHistory`'s 500 as the same shape (newest-wins, FIFO) and is
 * deliberately lower because these rows cost more to serialise.
 */
const MAX_UNCOLLECTED_SESSIONS = 200

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
interface TimeoutDeltaLedger {
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
interface UncollectedSpend {
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

/**
 * An agent's status as a session's `state`. Exhaustive over `AgentStatus` with
 * no `default` arm on purpose: adding a status to that union then fails to
 * compile HERE, which is the only place that would otherwise silently pick a
 * wrong answer for a status nobody has thought about.
 */
function sessionStateOfAgent(status: AgentStatus): SessionStateView['state'] {
  switch (status) {
    case 'spawning':
    case 'working':
      return 'running'
    case 'idle':
    case 'blocked':
      return 'idle'
    case 'completed':
    case 'failed':
    case 'terminated':
      return 'settled'
  }
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

  // The caller's own state-change callback, supplied to `initialize()`. Held
  // SEPARATELY from the broadcaster rather than chained into it, so that
  // `initBroadcaster()` is idempotent: chaining wrapped the previous callback
  // in a new closure, so calling it twice — or calling it after a
  // `shutdown()` that had already torn the first one down — left the old
  // broadcaster reachable from a closure nothing could unwind. One notify
  // method, two independent listeners, no nesting.
  private stateChangeListener: (() => void) | null = null

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

  // === Timed-out cost deltas ===
  //
  // One live obligation per timed-out session whose cost is still being
  // collected, and the sessions we gave up on. Both maps are self-bounding: an
  // entry is removed the moment its collection settles, independently of
  // whether the timer that drove it has fired.
  private deltaLedgers: Map<string, TimeoutDeltaLedger> = new Map()
  private uncollected: Map<string, UncollectedSpend> = new Map()

  /**
   * Sessions dropped by the `uncollected` cap, accumulated as they are dropped.
   * See `UncollectedEviction` for why eviction is not free and why this exists.
   */
  private uncollectedEvicted: UncollectedEviction = {
    sessions: 0,
    lastKnownTokens: 0,
    observedUncollected: 0,
    cap: MAX_UNCOLLECTED_SESSIONS,
  }

  /**
   * Every live delta timer. `unref`'d on creation so a pending collection can
   * never hold the event loop open, removed in the timer's own `finally`, and
   * the whole set cleared in `shutdown()`.
   *
   * NOT a `setInterval`, deliberately. There is one deadline per timed-out
   * task and then a single probe: a poller would keep re-reading sessions for
   * as long as the process lived, and the signal that ends the obligation is
   * already in hand — the `session.wait` promise that the timeout already left
   * dangling.
   *
   * Also NOT in `HealthMonitor`. It has no session handle, and a terminated
   * agent is removed from `this.agents` while its session is still running, so
   * a monitor that walks `this.agents` structurally cannot see the sessions
   * most likely to still be spending.
   */
  private deltaTimers: Set<ReturnType<typeof setTimeout>> = new Set()

  /**
   * Set at the top of `shutdown()` and never cleared. `running` is NOT the
   * signal for this: it is false whenever a task was reached by any route other
   * than `execute()` — a bare `spawnAndExecute`, a delegated task, a test
   * driving `executeTask` — and those are all legitimate, flushable situations.
   * What matters is only whether teardown has already been and gone.
   */
  private shuttingDown = false

  /**
   * Backoff schedule for the delta read, as a field rather than a constant so a
   * test can shrink it. Production values are `DELTA_READ_BACKOFF_MS`.
   */
  private deltaReadBackoffMs: readonly number[] = DELTA_READ_BACKOFF_MS

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
    this.stateChangeListener = onStateChange ?? null

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

    // The dashboard's transport, wired here rather than left to
    // `startDashboard()`'s caller. Two reasons, and the second is the real one:
    // it makes `docs/API.md`'s claim that `initialize()` sets up the dashboard
    // true, and it is the only place the throttled state push gets an owner at
    // all — `initBroadcaster()` had no caller anywhere in `src/`, so
    // `this.broadcaster` was null in production and the `broadcastState()`
    // chained onto the state-change callback was a no-op at every one of the
    // ~10 `notifyStateChange()` sites. Called LAST so the listener installed by
    // the line above is the one captured, and after the module setup so a module
    // that emits during setup already has somewhere to broadcast to.
    this.initBroadcaster()
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
   *   - a timed-out task WAS billed at the instant of the timeout, while its
   *     session kept running, so the rest of its consumption went unbilled —
   *     which made the most expensive case, a runaway task, the most
   *     under-counted. That is no longer the whole story: the remainder is now
   *     collected once the session goes idle, or reported as a bound under the
   *     cost report's `uncollected` block if it never does. What remains
   *     unfixed is the tier granularity of that correction — see
   *     `priceUsageAtSettledTier` for the residual it leaves and why it cannot
   *     be removed at session-total granularity.
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
   * Wire up the StateBroadcaster so that every state change also triggers a
   * throttled broadcast to WebSocket clients.
   *
   * Idempotent. A second call destroys the first broadcaster rather than
   * stacking a second subscription set on top of it — the old implementation
   * chained the previous state-change callback into a fresh closure, so
   * calling this twice made every broadcast go out twice and left the first
   * broadcaster's `destroy()` unable to unsubscribe it.
   */
  initBroadcaster(opts?: { throttleMs?: number }): void {
    this.broadcaster?.destroy()
    this.broadcaster = new StateBroadcaster(this, opts)
  }

  /**
   * Start the web dashboard server
   *
   * Registers NO event handlers, and that is the whole point. It used to wire
   * `agent:spawned`, `agent:terminated`, `budget:alert` and `budget:exceeded`
   * by hand to `DashboardModule.broadcast()`, which was a pass-through to
   * `broadcaster.broadcast()`. `StateBroadcaster` subscribes to all thirteen
   * events itself, so those four lines made every one of them reach each
   * connected client TWICE — and the page draws one activity row per delivery,
   * so a user watched every spawn and every termination appear twice.
   *
   * Delivery has exactly one owner: the broadcaster. The page's sockets
   * register on it in `DashboardModule`'s `websocket.open`, so there is one
   * client set and one message sequence rather than two competing paths.
   * `test/broadcast-event-coverage.test.ts` runs the dashboard and asserts one
   * delivery for all thirteen, so a second registration cannot creep back in.
   */
  startDashboard(port?: number, host?: string): void {
    const dashPort = port || this.config.dashboard.port
    const dashHost = host || this.config.dashboard.host
    this.dashboard = new DashboardModule(this)
    this.dashboard.start(dashPort, dashHost)
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
      totalTokens: a.metrics.totalTokens,
      averageResponseTime: a.metrics.averageResponseTime,
      errorRate: a.metrics.errorRate,
      totalCost: a.metrics.totalCost
    }))

    const tasks = Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      name: t.name,
      role: t.requiredRole,
      priority: t.priority || 'normal',
      status: t.status,
      dependencies: t.dependencies,
      assignedAgent: t.assignedAgent,
      cost: t.result?.cost,
      tokensUsed: t.result?.tokensUsed,
      result: t.result ? {
        success: t.result.success,
        // Truncated, as before: a full task output is unbounded and this is a
        // state snapshot, not the result archive.
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
      config: {
        models: this.configManager.getResolvedModels(),
        budget: this.budget,
        selfHealing: this.config.selfHealing
      },
      sessions: this.sessionViews(),
      totalSpent: this.totalSpent,
      budgetRemaining: this.budget.maxTotalCost - this.totalSpent,
      lastUpdated: new Date().toISOString()
    }
  }

  /**
   * Union the three session-keyed collections into one view per session. See
   * `SessionStateView` for the case this makes visible and the scope limits it
   * respects.
   *
   * Built in three passes, in ascending order of authority, so each later pass
   * refines rather than replaces:
   *   1. live agents            — what we own
   *   2. pending delta ledgers  — a session still being billed after a timeout
   *   3. abandoned spend        — a session we gave up on, and the ONLY pass
   *                              that can set `observedUncollected`
   *
   * Pass 3 wins over everything, deliberately: on the abandon path
   * `uncollected.set()` runs before the ledger's `finally` deletes it, so for a
   * moment both describe the same session and "abandoned" is the terminal,
   * accurate reading of the two.
   *
   * NOT `async`, and it makes no `ctx.session.get` call. See the note on
   * `state` in `SessionStateView`: enriching per session would fan every
   * throttled push out into N session reads.
   */
  private sessionViews(): SessionStateView[] {
    const views = new Map<string, SessionStateView>()

    for (const agent of this.agents.values()) {
      // An agent with no session never got one (spawn not yet resolved). It is
      // not a session row: there is no id to key it by, and inventing one
      // would put a phantom in the list a user is meant to trust.
      if (!agent.sessionID) continue
      views.set(agent.sessionID, {
        id: agent.sessionID,
        owned: true,
        agentId: agent.id,
        taskId: this.taskIdForAgent(agent.id),
        role: agent.role,
        model: `${agent.model.provider}/${agent.model.model}`,
        state: sessionStateOfAgent(agent.status),
        spawnedAt: agent.spawnedAt.toISOString(),
        lastKnownTokens: agent.metrics.totalTokens,
        observedUncollected: 0
      })
    }

    for (const ledger of this.deltaLedgers.values()) {
      this.applyCollectionRecord(views, {
        sessionID: ledger.sessionID,
        taskId: ledger.taskId,
        agentId: ledger.agentId,
        model: ledger.model,
        state: 'running',
        lastKnownTokens: totalTokens(ledger.charged),
        observedUncollected: 0
      })
    }

    for (const spend of this.uncollected.values()) {
      this.applyCollectionRecord(views, {
        sessionID: spend.sessionID,
        taskId: spend.taskId,
        model: spend.model,
        // The agent is deliberately NOT threaded through. An abandoned session
        // reached by timeout is exactly the case where the agent has already
        // been deleted, so keeping the id would put a plausible-looking
        // `agentId` on a session that has no agent — the fabrication this whole
        // view exists to remove. Resolved from `this.agents` instead, so it is
        // null when and only when the session really is unowned.
        state: 'abandoned',
        lastKnownTokens: spend.lastKnownTokens,
        observedUncollected: spend.observedUncollected
      })
    }

    return [...views.values()]
  }

  /**
   * Fold a timeout-collection record into the session view, creating it when the
   * session is not already there. A created row is an ORPHAN by construction:
   * pass 1 ran first, so the session is absent precisely because no agent owns
   * it.
   */
  private applyCollectionRecord(
    views: Map<string, SessionStateView>,
    record: {
      sessionID: string
      taskId: string
      agentId?: string
      model: string
      state: SessionStateView['state']
      lastKnownTokens: number
      observedUncollected: number
    }
  ): void {
    const existing = views.get(record.sessionID)
    // `record.agentId` is deliberately NOT used to fill a null `agentId` on an
    // existing orphan row, and is not used to decide `owned` either: both are
    // answered by `this.agents`, and only `this.agents` can answer them.
    if (existing) {
      existing.taskId = existing.taskId ?? record.taskId
      existing.model = existing.model ?? record.model
      // A ledger is a live collection and an `uncollected` entry is terminal, so
      // the later pass always wins. `abandoned` is the more informative of the
      // two and `observedUncollected` is only ever non-zero alongside it.
      existing.state = record.state
      existing.lastKnownTokens = record.lastKnownTokens
      existing.observedUncollected = record.observedUncollected
      return
    }

    const owner = record.agentId !== undefined ? this.agents.get(record.agentId) : undefined
    views.set(record.sessionID, {
      id: record.sessionID,
      owned: owner !== undefined,
      agentId: owner?.id ?? null,
      taskId: record.taskId,
      role: owner?.role ?? null,
      model: record.model,
      state: record.state,
      spawnedAt: owner ? owner.spawnedAt.toISOString() : null,
      lastKnownTokens: record.lastKnownTokens,
      observedUncollected: record.observedUncollected
    })
  }

  /** The id of the task currently assigned to `agentId`, or null. */
  private taskIdForAgent(agentId: string): string | null {
    for (const task of this.tasks.values()) {
      if (task.assignedAgent === agentId) return task.id
    }
    return null
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
      },
      // Present only so an explicit override has a base to spread over. This
      // number is NOT the default window: with no override the block is dropped
      // entirely and `armTimeoutDelta` derives the window from the task's own
      // timeout.
      cost: {
        timeoutDeltaGraceMs: 60_000
      },
    }

    // `cost` is held back from the blanket spread on purpose. Spreading
    // `defaults` wholesale would put the block back on every config, and
    // `armTimeoutDelta`'s `??` would never fall through to the derived window —
    // which is exactly the dead code this shape is fixing: a flat 60s for every
    // task regardless of its own budget, behind a doc claiming "roughly half
    // the task's own budget, clamped to [30s, 180s]".
    const { cost: defaultCost, ...restDefaults } = defaults
    return {
      ...restDefaults,
      ...partial,
      budget: { ...defaults.budget, ...partial?.budget },
      agents: { ...defaults.agents, ...partial?.agents },
      selfHealing: { ...defaults.selfHealing, ...partial?.selfHealing },
      communication: { ...defaults.communication, ...partial?.communication },
      memory: { ...defaults.memory, ...partial?.memory },
      dashboard: { ...defaults.dashboard, ...partial?.dashboard },
      security: { ...defaults.security, ...partial?.security },
      learning: { ...defaults.learning, ...partial?.learning },
      // Present only when the caller supplied it; see the note on
      // `restDefaults` above and `NexusConfig.cost`.
      ...(partial?.cost ? { cost: { ...defaultCost, ...partial.cost } } : {}),
    }
  }

  public notifyStateChange(): void {
    if (this.stateChangeTimer) return
    this.stateChangeTimer = setTimeout(() => {
      this.stateChangeTimer = null
      this.notifyStateListeners()
    }, 100) // 100ms debounce
  }

  /**
   * Tell every state consumer that something moved: the caller's callback, and
   * the broadcaster (which throttles). Kept as one method so the two listeners
   * cannot be wired in an order that leaves one of them unreachable.
   */
  private notifyStateListeners(): void {
    this.stateChangeListener?.()
    this.broadcaster?.broadcastState()
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

    // Hoisted out of the `try` so the `finally` can clear the timeout handle and
    // so the catch block can reach the `session.wait` guard when arming the
    // cost delta. See the notes at the `Promise.race` below.
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let waitGuard: Promise<{ outcome: 'idle' | 'poll-failed' }> | null = null
    let waitAbort: AbortController | null = null

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

      // The agent is ACTIVELY WORKING from here until the `finally` below.
      //
      // This is the DAG `executeTask` path, and it is the primary execution
      // path. Nothing here set a status before, so the agent sat at the
      // `spawnAgent` value of `idle` for the whole duration of its task: the
      // sessions table rendered a session burning tokens as `idle`, and the
      // page's `Running` filter matched ZERO rows during a healthy run. The
      // only prior writer of `'working'` was the `spawn` TOOL path in
      // `index.ts` — a different, less common route in.
      //
      // Set immediately BEFORE the prompt, and notify, so the transition is
      // observable by anyone holding a state view rather than appearing only
      // when the task finally lands. The `finally` still owns the way back
      // down, and it does not touch a terminal status.
      agent.status = 'working'
      this.notifyStateChange()

      // Send the task to the session
      await this.ctx.session.prompt({
        sessionID: agent.sessionID,
        text: taskPrompt
      })

      // Wait for completion (with timeout)
      //
      // LEAK 1, CLOSED: the timeout handle is kept and cleared in the `finally`
      // below. Nothing cleared it before, so on the overwhelmingly common
      // success path a 5-minute `setTimeout` stayed referenced after every
      // successful task and kept the event loop alive.
      //
      // LEAK 2, CLOSED: `waitPromise` is OWNED, not merely handed to a race.
      // `Promise.race` does not cancel its loser, so this long-poll is still
      // open after the timeout — and `Promise.race` attaching a rejection
      // handler is the only reason that has been safe. The moment a `.then()`
      // is added for the delta below, a mid-poll `SessionNotFoundError` becomes
      // a real unhandled rejection. So a guard that cannot reject is attached
      // now, and an `AbortSignal` is passed down so the poll can actually be
      // closed rather than merely ignored.
      waitAbort = new AbortController()
      const waitPromise = this.ctx.session.wait(
        { sessionID: agent.sessionID },
        { signal: waitAbort.signal }
      )
      // Never rejects: the delta path races this, and a rejection here has
      // nowhere useful to go. A poll that DIES is not a session that went idle,
      // so it resolves to its own outcome and takes the probe path below.
      waitGuard = waitPromise.then(
        () => ({ outcome: 'idle' as const }),
        () => ({ outcome: 'poll-failed' as const })
      )
      const timeoutPromise = new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new TaskTimeoutError()), timeout)
      })

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
      const performanceId = this.performanceTracker.record({
        model: agent.model.model,
        role: node.task.requiredRole,
        success: result.success,
        duration: result.duration,
        cost: result.cost,
        costProvenance: result.costProvenance,
        tokensUsed: result.tokensUsed
      })

      // Record failed execution to history (with session ID for traceability)
      const historyId = this.executionHistory.record({
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
      }).id

      // ARM THE COST DELTA HERE, and the ordering is LOAD-BEARING: the ledger
      // needs the history record id and the performance entry id, both of
      // which are created by the two `record` calls above. Moving this block
      // above them — or moving `handleFailure` above the accounting, which is
      // the refactor most likely to happen to this function — silently breaks
      // the update path, and it breaks SILENTLY: the delta still prices and
      // charges correctly, and only the history/performance records stop
      // reflecting it.
      //
      // ONLY ON TIMEOUT, and only on a MEASURED charge. A non-timeout failure
      // has no dangling session to collect from, and a timeout whose initial
      // read FAILED has no measured baseline to subtract from — arming one
      // against a predicted charge would bill a correction to a guess, which is
      // the same laundering the delta path refuses to do anywhere else.
      if (error instanceof TaskTimeoutError && cost.usage && waitGuard && agent.sessionID) {
        this.armTimeoutDelta(agent, node, {
          usage: cost.usage,
          idleAt: cost.idleAt,
          result,
          waitGuard,
          abort: waitAbort,
          historyId,
          performanceId,
          timeout,
        })
      }

      // Notify on task failure
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${errorMessage}`, sound: true })
      }

      // Self-healing: retry or respawn
      if (this.config.selfHealing.enabled) {
        await this.handleFailure(agent, node, new Error(errorMessage))
      }
    } finally {
      // LEAK 1, CLOSED: see the note at the `Promise.race`. The handle is
      // cleared on EVERY path, so a successful task no longer leaves a
      // five-minute timer referenced behind it.
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      // Only reset to idle if agent is still in a non-terminal state
      if (agent.status !== 'terminated' && agent.status !== 'failed') {
        agent.status = 'idle'
      }
      node.task.status = node.status === 'completed' ? 'completed' : 'failed'
      this.notifyStateChange()
    }
  }

  // === Timed-out cost deltas ===
  //
  // A timed-out task is billed at the instant of the timeout, while its session
  // is never aborted and keeps generating and keeps spending. The most
  // expensive case — a hung or slow task — was therefore the most
  // under-counted, billed the cheapest possible snapshot.
  //
  // THE SIGNAL WAS ALREADY IN HAND. `Promise.race` does not cancel its loser, so
  // the `session.wait` promise is still live after the timeout and still
  // resolves later, at exactly the moment wanted: `session.wait` is documented
  // server-side as "wait for a session agent loop to become idle", and the TUI
  // uses it as its "the turn is over" primitive. So this is not new plumbing; it
  // is not throwing the signal away.
  //
  // NOT the tool `progress` callback. There is exactly one call site invoking a
  // tool's `progress` in the installed server and it carries exactly one status
  // literal — `progress({sessionID, status: "running"})`, once, at spawn,
  // before the prompt. There is no terminal status, and the channel is wired
  // only on the subagent-tool spawn path, so it cannot express settlement.
  //
  // NOT the event bus either. The installed SDK's `@opencode/protocol` does
  // define `session.idle`, but the running V2 server does not publish it — the
  // literal appears only in the V1 legacy event table — and the V2 bus expresses
  // settlement as `session.execution.succeeded | failed | interrupted`.
  // `session.wait` plus `SessionInfo.time.idle` is simpler, per-session by
  // construction, and cannot be missed, because neither is an ephemeral
  // notification racing a subscription.
  //
  // `ctx.session.interrupt` is deliberately NOT called on timeout. It would make
  // the session idle immediately and collapse the grace window, but it throws
  // away the partial work: for a task that timed out at 299s of a 300s budget
  // that is nearly everything. The goal here is to BILL the remainder, not to
  // kill the run. Whether a runaway task should be killed is a different
  // question, and conflating the two would discard work to improve a report.

  /**
   * Register the obligation to bill the rest of a timed-out session's cost, and
   * schedule the single timer that will discharge it.
   */
  private armTimeoutDelta(agent: Agent, node: DAGNode, args: {
    usage: TokenUsage
    idleAt: number
    result: CostedTaskResult
    waitGuard: Promise<{ outcome: 'idle' | 'poll-failed' }>
    abort: AbortController | null
    historyId: string
    performanceId: string
    timeout: number
  }): void {
    const sessionID = agent.sessionID
    if (!sessionID) return
    const model = `${agent.model.provider}/${agent.model.model}`

    // A task can time out AFTER `shutdown()` has already run — an in-flight
    // `executeTask` outlives the call that started it. Arming here would
    // register a ledger and an `unref`'d timer that nothing will ever flush,
    // because the flush is the one thing `shutdown` does and it has been and
    // gone. Dropping the obligation loses that session's remaining cost
    // entirely, which is the under-count this whole feature exists to remove,
    // so the arm is refused and the timeout is billed at its snapshot as before.
    if (this.shuttingDown) return

    // One ledger per session. A second arm for the same session — which the
    // race below makes impossible today, but which is exactly what the
    // idempotency invariant has to survive — replaces nothing and charges
    // nothing.
    if (this.deltaLedgers.has(sessionID)) return

    const ledger: TimeoutDeltaLedger = {
      sessionID,
      taskId: node.id,
      agentId: agent.id,
      agent,
      node,
      result: args.result,
      model,
      provider: agent.model.provider,
      charged: args.usage,
      idleAtTimeout: args.idleAt,
      pending: false,
      historyId: args.historyId,
      performanceId: args.performanceId,
      abort: args.abort ?? new AbortController(),
    }
    this.deltaLedgers.set(sessionID, ledger)

    // ONE TIMER, NO INTERVAL. The session going idle settles the obligation;
    // the deadline is the single fallback that probes once and then abandons.
    //
    // The window is HALF the task's own budget, clamped to [30s, 180s], unless
    // `cost.timeoutDeltaGraceMs` was set explicitly — in which case that
    // number is the window outright. The clamp used to be dead code: `cost` was
    // a required config block, so `mergeConfig` always populated it and the
    // `??` never fell through to the derived value. `cost` is optional now, and
    // `mergeConfig` leaves it absent unless the caller supplied it, so the
    // derived window is what actually runs by default.
    const graceMs = this.config.cost?.timeoutDeltaGraceMs
      ?? Math.min(180_000, Math.max(30_000, args.timeout / 2))
    const timer = setTimeout(() => {
      // First statement of the callback, not a `finally` — an earlier version of
      // this comment claimed a `finally` that was not there. It does not need
      // one: `settleTimeoutDelta` is not called in a way that can throw
      // synchronously (it is `async`, so it returns a rejected promise at
      // worst), and the rejection is handled on the next line.
      this.deltaTimers.delete(timer)
      // `.catch`, not `void`. A `void`-ed promise that rejects is an unhandled
      // rejection in the host process, and this detached call is one of three
      // this feature introduced. A settlement that throws is reported through
      // the `cost:delta` event; swallowing it here as well is deliberate, since
      // there is no caller left to propagate to.
      this.settleTimeoutDelta(ledger, 'deadline').catch(() => {})
    }, graceMs)
    // A pending collection must never be the reason the process cannot exit.
    timer.unref?.()
    this.deltaTimers.add(timer)

    void (async () => {
      try {
        const { outcome } = await args.waitGuard
        if (outcome === 'idle') await this.settleTimeoutDelta(ledger, 'session-idle')
        else await this.settleTimeoutDelta(ledger, 'poll-failed')
      } catch {
        // Swallowed deliberately, and see the note on the deadline call above.
        // The abort below is what matters on this path, and it is in a
        // `finally`, so it still runs.
      }
    })()
  }

  /**
   * Discharge one obligation: read the session, bill what it did since the last
   * charge, correct every figure that recorded the old total, and report
   * whatever could not be collected.
   *
   * This method is the only writer of `ledger.charged` and the only caller of
   * `trackCost` on this path. It used to take an `observed?: TokenUsage` to
   * skip the read; no caller ever passed it, and it was the one route through
   * this method with no `await` before the charge, so a re-entrant caller
   * supplying it would have priced against the pre-write-back snapshot and
   * double-billed. Removed rather than documented.
   */
  private async settleTimeoutDelta(
    ledger: TimeoutDeltaLedger,
    trigger: 'session-idle' | 'deadline' | 'poll-failed' | 'shutdown'
  ): Promise<void> {
    // ONE WRITER. A second caller for a session that is already being settled,
    // or already settled, calls NOTHING — it does not charge $0, it does not
    // touch `costHistory`, does not record provenance and does not emit. Those
    // are all observable, and a $0 that moves four of them is not a no-op.
    if (ledger.pending) return
    if (this.deltaLedgers.get(ledger.sessionID) !== ledger) return
    // Set SYNCHRONOUSLY, before the first `await`, so re-entrancy cannot slip
    // in behind it.
    ledger.pending = true

    try {
      // The reason the event will carry. The deadline and a dead poll are both
      // "we stopped watching", not "it stopped running" — so they start as
      // `abandoned`, and only the probe below can turn that into
      // `session-idle`, because that is the only way a session that was still
      // running at the deadline can turn out to have settled.
      let reason: 'session-idle' | 'abandoned' | 'shutdown' =
        trigger === 'shutdown' ? 'shutdown' : trigger === 'session-idle' ? 'session-idle' : 'abandoned'

      let now: TokenUsage
      if (trigger === 'deadline' || trigger === 'poll-failed') {
        // ONE final probe, and it answers a different question from the one a
        // read would. A session CAN settle after the deadline — the timer and
        // the wait are two independent observations of the same fact, and
        // losing that race is not evidence the session never settled. If the
        // server says the loop went idle after the timeout snapshot did, the
        // collection is completed for free from the reading already in hand.
        const probe = await this.readSessionTokens(ledger.sessionID)
        if (!probe.read || probe.idleAt <= ledger.idleAtTimeout) {
          this.abandonTimeoutDelta(ledger, probe.read ? probe.usage : undefined, reason)
          return
        }
        now = probe.usage
        reason = 'session-idle'
      } else {
        // Retried: a failed read here is a RETRYABLE CONDITION, not a failed
        // charge, and there is grace-window time left to spend on it. The
        // estimate fallback that `safeAccountTaskCost` uses would be wrong
        // here — a delta whose read failed is an abandoned collection, and
        // laundering it through `forecastTask` as `estimated` would report a
        // guess as a correction to a measurement.
        //
        // `shutdown` is not granted retries: the process is going away.
        const read = trigger === 'shutdown'
          ? await this.readSessionTokens(ledger.sessionID)
          : await this.readSessionTokensWithRetry(ledger.sessionID)
        if (!read.read) {
          this.abandonTimeoutDelta(ledger, undefined, reason)
          return
        }
        now = read.usage
      }

      // Componentwise, and PER FIELD rather than on the total. Clamping a
      // summed total would swallow a genuine reallocation between `input` and
      // `cache.read` — a session whose uncached prompt shrinks as its prefix
      // becomes cacheable is a real and common shape, and the sum of its two
      // fields barely moves while both of them do.
      const delta: TokenUsage = {
        input: Math.max(0, now.input - ledger.charged.input),
        output: Math.max(0, now.output - ledger.charged.output),
        reasoning: Math.max(0, now.reasoning - ledger.charged.reasoning),
        cache: {
          read: Math.max(0, now.cache.read - ledger.charged.cache.read),
          write: Math.max(0, now.cache.write - ledger.charged.cache.write),
        },
      }
      const deltaTokens = totalTokens(delta)

      // NOTHING MOVED — call NOTHING. Not "charge $0": `trackCost` would grow
      // `costHistory`, add a provenance entry, run the budget check and fire a
      // state change for a difference that does not exist. An idle reported
      // twice, or an idle before the next model call billed, is a real state
      // and the right response to it is silence.
      if (deltaTokens === 0) {
        this.emit('cost:delta', {
          taskId: ledger.taskId,
          nodeId: ledger.taskId,
          agentId: ledger.agentId,
          sessionID: ledger.sessionID,
          model: ledger.model,
          deltaCost: 0,
          deltaTokens: 0,
          sessionTotalCost: priceUsage(ledger.charged, this.forecaster.tiersFor(ledger.model, ledger.provider).pricing).total,
          reason,
          settledTier: this.settledTierOf(ledger, ledger.charged),
        })
        return
      }

      const { pricing, source } = this.forecaster.tiersFor(ledger.model, ledger.provider)
      // THE SETTLED TIER, not `priceUsage(delta)`. See `priceUsageAtSettledTier`
      // for why the increment's own prompt size is a meaningless number here,
      // and for the worked numbers in both directions.
      const deltaCost = priceUsageAtSettledTier(delta, pricing, now).total
      // Always `measured`: these token counts came out of a real session
      // through the same `ctx.session.get` that produced the original charge.
      // `CostProvenance` has no temporal field and does not need one —
      // provenance describes HOW a number was arrived at, not WHEN it was
      // observed.
      const provenance: CostProvenance = { usage: 'measured', pricing: source }

      // WRITE THE NEW SNAPSHOT BACK BEFORE THE CHARGE, and be precise about
      // what that buys, because two earlier versions of this comment
      // overclaimed in opposite directions.
      //
      // Three blocks stand between a re-entrant caller and a double bill, and
      // MEASURED they are not equally important:
      //
      //   1. `pending`, set synchronously before the first `await` and cleared
      //      only in the `finally`. It spans the whole body, so it intercepts
      //      every re-entrant caller BEFORE a delta is computed. This is the
      //      one that holds the line on its own: removing it turns the
      //      re-entrancy test red.
      //   2. THIS write-back. It is the backstop for (1), and it is genuinely
      //      load-bearing in that role rather than decorative. With `pending`
      //      removed, re-entry from a `budget:alert` subscriber — which fires
      //      from inside `trackCost`, before this method's `finally`, while the
      //      ledger is still in the map — computes its delta against the
      //      pre-write-back snapshot and bills the same increment a second
      //      time. MEASURED: under `pending`-removed plus write-back-swapped
      //      that path emits a spurious second `cost:delta` carrying
      //      `deltaCost: 0` after the real one.
      //   3. The ledger deletion in the `finally`, ordered before `pending` is
      //      cleared, so it blocks a caller arriving after the body even if the
      //      flag were false.
      //
      // Swapping (2) ALONE, with `pending` intact, is caught by NO test. That
      // is measured, and it is the honest limit of what this suite pins.
      //
      // The ordering is kept because (2) is what makes `charged` a single local
      // source of truth written by this same method — every delta here is
      // `max(0, now - charged)` against a snapshot this method produced — and
      // because it is the only thing between (1) and a double bill if (1) is
      // ever broken.
      ledger.charged = now

      // CHARGE AND CORRECT, CONTAINED.
      //
      // `trackCost` ends in `checkBudget()`, which `emit`s `budget:alert` and
      // `budget:exceeded`, and `emit` is a bare `forEach` with no try/catch. A
      // throwing subscriber therefore used to land the charge, skip every
      // correction below it, emit nothing, and propagate out — leaving
      // `totalSpent` carrying the delta while the history record, the
      // performance entry, the agent metrics and the DAG result all still held
      // the old figure, with no event to say so. The money was wrong AND
      // unreported. Reproduced: totalSpent 1.80 against history 1.50 and
      // performance 1.50.
      //
      // So the whole sequence is contained, the event fires on every outcome
      // with whatever state was reached, and the error is reported in the
      // payload rather than thrown. Throwing would be worse than useless on the
      // teardown path: there is no caller left to propagate to, and an
      // exception escaping `shutdown()` would abandon the agents-clear and
      // every remaining ledger behind it.
      let historyAdjusted = false
      let performanceAdjusted = false
      let nodeAdjusted = false
      let agentAdjusted = false
      let error: string | undefined
      try {
        // `trackCost` also runs `checkBudget` and `notifyStateChange`, so
        // `totalSpent`, the budget alert, `getStatus()`, `getCostReport()`, the
        // dashboard and the TUI sidebar all pick the delta up from this one
        // call. Every figure below is a SECOND place that recorded the old
        // total, and each is reported individually so a partial correction is
        // visible rather than something a reader has to infer from a total.
        this.trackCost(ledger.agentId, ledger.model, deltaCost, deltaTokens, provenance)

        // `false` means the record was evicted (history trims to 500,
        // performance to 1000), which is why these are reported rather than
        // assumed.
        historyAdjusted = this.executionHistory.adjust(ledger.historyId, {
          cost: deltaCost,
          tokensUsed: deltaTokens,
        })
        performanceAdjusted = this.performanceTracker.adjust(ledger.performanceId, { cost: deltaCost })

        // `agent.metrics.totalCost` / `totalTokens`, which `getState()` and
        // `listAgents()` publish and the dashboard charts per agent. It cannot
        // come back false — there is no trim to evict it — so leaving it
        // uncorrected would have made this the one per-agent figure that
        // disagreed with its corrected siblings.
        ledger.agent.metrics.totalCost += deltaCost
        ledger.agent.metrics.totalTokens += deltaTokens
        agentAdjusted = true

        // `node.result.cost`, but ONLY while it is still this attempt's result.
        // Escalation re-enters `executeTask` with the SAME node and overwrites
        // `node.result`, so attempt 1's late delta must not be added to
        // attempt 2's figure. Object identity is the cheap test; a node whose
        // result has moved on is reported as uncorrected rather than
        // mis-added, which is the honest outcome — the cost is in `totalSpent`
        // either way, and `costByAgent` attributes it to the right agent.
        if (ledger.node.result === ledger.result) {
          ledger.result.cost += deltaCost
          ledger.result.tokensUsed += deltaTokens
          nodeAdjusted = true
        }
        // This session is no longer abandoned — it settled.
        this.uncollected.delete(ledger.sessionID)
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown)
      }

      this.emit('cost:delta', {
        taskId: ledger.taskId,
        nodeId: ledger.taskId,
        agentId: ledger.agentId,
        sessionID: ledger.sessionID,
        model: ledger.model,
        deltaCost,
        deltaTokens,
        sessionTotalCost: priceUsage(now, pricing).total,
        // `shutdown` here means CHARGED AT TEARDOWN, SETTLEMENT UNVERIFIED: the
        // flush is the last chance to read a session that may already be gone.
        // `abandonTimeoutDelta` rewrites `shutdown` to `abandoned` for the
        // opposite reason — there it sits beside a `deltaCost` of 0, where
        // "shutdown" would read as "it settled and we billed it", whereas here
        // the `deltaCost` is non-zero and the charge really was made.
        reason,
        settledTier: this.settledTierOf(ledger, now),
        recordsAdjusted: { history: historyAdjusted, performance: performanceAdjusted, node: nodeAdjusted, agent: agentAdjusted },
        ...(error === undefined ? {} : { error }),
      })
    } finally {
      // ALWAYS, on every path including the ones that returned above. A settled
      // entry is deleted, which bounds the map independently of the timers:
      // the timer set and the ledger set are cleaned up by different code and
      // neither can be relied on to clean up the other.
      this.deltaLedgers.delete(ledger.sessionID)
      ledger.pending = false
      // Close the long-poll HERE, not in the wait guard's `finally`. That
      // `finally` only runs when `waitGuard` settles, and on the
      // deadline-abandon path — a session that never goes idle, which is the
      // case abandon exists for — the wait never settles, so the abort never
      // fired and the server-side poll stayed open for the life of the
      // process. Aborting an already-aborted signal is a no-op, so this is safe
      // when the wait did settle normally.
      ledger.abort.abort()
    }
  }

  /**
   * Give up on a session that is still running, and record the part of its cost
   * we will never read.
   *
   * RECORDED AND NOT CHARGED, deliberately. Charging a mid-flight reading would
   * put a number in `totalSpent` that is not a settled figure and is not known
   * to be final, which is the conflation `CostProvenance` exists to prevent.
   * Dropping it silently would be the original bug at a smaller scale.
   *
   * WHAT THE REPORTED FIGURE IS, precisely, because an earlier version of this
   * called it an upper bound and had the direction backwards:
   * `observedUncollected` is the priced value of the increment seen between the
   * last charge and the last read — spend that demonstrably happened and was
   * demonstrably not billed. It is a LOWER BOUND ON THE UNDER-COUNT. Everything
   * the session spends after that last read is also unbilled, and a session
   * abandoned while still generating has no reason to stop, so the true
   * under-count is unbounded above and this figure is only where it is known to
   * begin. There is no upper bound derivable from a single observation, and
   * claiming one would be the same class of error as the bug this change fixes.
   */
  private abandonTimeoutDelta(
    ledger: TimeoutDeltaLedger,
    probeUsage: TokenUsage | undefined,
    reason: 'session-idle' | 'abandoned' | 'shutdown'
  ): void {
    // Whatever prompted the give-up — a deadline, a dead poll, or a read that
    // failed every retry — the collection was ABANDONED and nothing was
    // collected. `session-idle` would read as "it settled and we billed it"
    // next to a `deltaCost` of 0, which is the opposite of what happened. The
    // `uncollected` block in the report is the other discriminator; the reason
    // says the same thing for anyone reading only the event.
    const eventReason = reason === 'shutdown' ? 'shutdown' : 'abandoned'
    const known = probeUsage ?? ledger.charged
    const { pricing } = this.forecaster.tiersFor(ledger.model, ledger.provider)
    const observedIncrement: TokenUsage = {
      input: Math.max(0, known.input - ledger.charged.input),
      output: Math.max(0, known.output - ledger.charged.output),
      reasoning: Math.max(0, known.reasoning - ledger.charged.reasoning),
      cache: {
        read: Math.max(0, known.cache.read - ledger.charged.cache.read),
        write: Math.max(0, known.cache.write - ledger.charged.cache.write),
      },
    }
    // Zero when the last read showed no growth at all, and that zero is
    // CORRECT rather than a missing value: it says the observed-but-uncharged
    // spend is nothing we can see. An earlier version fell back to
    // `lastDeltaCost` here, which was dead — a ledger settles at most once
    // because the `finally` deletes it, so that field was always 0 — and a
    // test then pinned that coincidental 0 as a policy. Field and branch both
    // deleted.
    const observedUncollected = totalTokens(observedIncrement) > 0
      ? priceUsageAtSettledTier(observedIncrement, pricing, known).total
      : 0

    // Delete-then-set, so the entry lands at the BACK of the map's insertion
    // order. A JS `Map` keeps a re-`set` key in its ORIGINAL position, which
    // would leave a freshly abandoned session sitting at the front of the FIFO
    // queue and eligible for immediate eviction. It cannot happen today — a
    // ledger settles at most once, because the `finally` deletes it — but the
    // one-line cost of not depending on that is zero.
    this.uncollected.delete(ledger.sessionID)
    this.uncollected.set(ledger.sessionID, {
      sessionID: ledger.sessionID,
      taskId: ledger.taskId,
      agentId: ledger.agentId,
      model: ledger.model,
      lastKnownTokens: totalTokens(known),
      observedUncollected,
    })
    this.trimUncollected()

    this.emit('cost:delta', {
      taskId: ledger.taskId,
      nodeId: ledger.taskId,
      agentId: ledger.agentId,
      sessionID: ledger.sessionID,
      model: ledger.model,
      deltaCost: 0,
      deltaTokens: 0,
      sessionTotalCost: priceUsage(known, pricing).total,
      reason: eventReason,
      settledTier: this.settledTierOf(ledger, known),
      uncollected: { lastKnownTokens: totalTokens(known), observedUncollected },
    })
  }

  /** Which table priced the delta, and the prompt size that selected the tier. */
  private settledTierOf(ledger: TimeoutDeltaLedger, usage: TokenUsage): {
    pricing: PricingSource
    promptSizeAtSettlement: number
    threshold: number | null
  } {
    const { pricing, source } = this.forecaster.tiersFor(ledger.model, ledger.provider)
    const promptSize = promptSizeOf(usage)
    return {
      pricing: source,
      promptSizeAtSettlement: promptSize,
      threshold: selectTier(pricing.tiers, promptSize).threshold ?? null,
    }
  }

  /**
   * Discharge every outstanding obligation at once, with a single read each.
   *
   * Used by `shutdown` — a session that settles after the orchestrator has gone
   * is still spending, and the one-shot flush is the last chance to bill it. A
   * session that has not settled is recorded as uncollected with a `shutdown`
   * reason, which is a true statement: we stopped looking because the process
   * is ending, not because the session stopped.
   */
  private async flushTimeoutDeltas(): Promise<void> {
    // Timers first, so nothing re-arms a collection we are about to discharge.
    for (const timer of this.deltaTimers) clearTimeout(timer)
    this.deltaTimers.clear()
    for (const ledger of [...this.deltaLedgers.values()]) {
      // Contained per ledger, not per loop. One settlement that throws must not
      // abandon the ledgers after it, nor propagate out of `shutdown()` and
      // leave `agents.clear()` unrun. The failure is already reported through
      // that ledger's own `cost:delta`.
      await this.settleTimeoutDelta(ledger, 'shutdown').catch(() => {})
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
      usage: null,
      idleAt: 0,
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
        usage: read.usage,
        idleAt: read.idleAt,
      }
    }

    const predicted = this.forecaster.forecastTask(task, task.requiredRole, model, task.complexity)
    return {
      cost: predicted.estimatedCost,
      tokensUsed: predicted.estimatedInputTokens + predicted.estimatedOutputTokens,
      provenance: { usage: 'estimated', pricing: predicted.pricingSource },
      usage: null,
      idleAt: 0,
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
  private async readSessionTokens(sessionID: string): Promise<{ read: true; usage: TokenUsage; idleAt: number } | { read: false }> {
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
        // `time.idle` is the server's own "this session's agent loop went idle"
        // stamp, and it is what makes settlement detectable from a plain poll
        // rather than only from a live subscription. Absent for a session that
        // has never been idle, which is the case this comparison must read as
        // "not settled" — 0 is below every real stamp.
        idleAt: typeof session?.time?.idle === 'number' && Number.isFinite(session.time.idle)
          ? session.time.idle
          : 0,
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

  /**
   * `readSessionTokens` with retries, for the DELTA read only.
   *
   * Three attempts, backing off between them, all of it inside the grace
   * window. Returns `read: false` only when every attempt failed — at which
   * point the collection is abandoned and reported, never estimated.
   */
  private async readSessionTokensWithRetry(sessionID: string): Promise<{ read: true; usage: TokenUsage; idleAt: number } | { read: false }> {
    for (let attempt = 0; attempt < this.deltaReadBackoffMs.length; attempt++) {
      if (attempt > 0) await this.sleep(this.deltaReadBackoffMs[attempt] ?? 0)
      const read = await this.readSessionTokens(sessionID)
      if (read.read) return read
    }
    return { read: false }
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
      estimatedEntries: sumBy(this.costProvenance, p => p.estimatedEntries),
      // Sessions still running after we stopped charging for them.
      // `observedUncollected` is deliberately NOT in `totalSpent`: adding an
      // estimate to a measured total is the conflation `CostProvenance` exists
      // to prevent. It is a LOWER BOUND on the under-count, not an upper one —
      // everything those sessions spend after our last read is unbilled too —
      // so a reader learns "we are under-counting by at least $X, and by an
      // unknown amount on top", which is the true shape of the gap.
      uncollected: this.uncollectedSummary()
    }, null, 2)
  }

  /**
   * Keep `uncollected` at `MAX_UNCOLLECTED_SESSIONS`, dropping the OLDEST
   * entries first.
   *
   * A `Map` iterates in insertion order, so the first key is the oldest — the
   * same newest-wins shape `ExecutionHistory` and `PerformanceTracker` use, and
   * the right way round here: the most recent abandonment is the one a reader is
   * most likely to still be able to act on, because it is the one whose session
   * is closest to having been terminated.
   *
   * THE PREVIOUS BEHAVIOUR WAS A LEAK THAT ALSO SHIPPED. The only `delete` was
   * on the successful settle path, so the map grew by one entry per abandoned
   * session for the life of the process. That was tolerable while the map was
   * read only by `getCostReport()`. It stopped being tolerable when
   * `sessionViews()` began iterating it on every `getState()` — which runs on
   * every throttled socket push and every `/api/state` — so the leak began
   * inflating every payload pushed to every client, for as long as the process
   * lived. Bounded now.
   *
   * Eviction is not free, and `uncollectedEvicted` is the receipt: the dropped
   * session disappears from `entries` and from `getState().sessions[]`, so the
   * per-session detail is genuinely lost, while the sums are carried forward so
   * the MAGNITUDE of what is missing is never lost with it.
   */
  private trimUncollected(): void {
    while (this.uncollected.size > MAX_UNCOLLECTED_SESSIONS) {
      const oldest = this.uncollected.keys().next()
      // `size > cap >= 1` guarantees an entry exists, so this branch is
      // unreachable — stated rather than asserted, because a bare
      // `as UncollectedSpend` on an unchecked `.value` would be a lie the
      // compiler could not catch.
      if (oldest.done) return
      const dropped = this.uncollected.get(oldest.value)
      if (dropped) {
        this.uncollectedEvicted.sessions += 1
        this.uncollectedEvicted.lastKnownTokens += dropped.lastKnownTokens
        this.uncollectedEvicted.observedUncollected += dropped.observedUncollected
      }
      this.uncollected.delete(oldest.value)
    }
  }

  /**
   * The `uncollected` block of the cost report. See `CostReportUncollected` for
   * the figures and `UncollectedEviction` for `evicted`.
   *
   * THE TWO BLOCKS ARE NOT SUMMED, deliberately, and the reason is that
   * `observedUncollected` must keep meaning one thing. The surviving totals are
   * over surviving entries; adding `evicted.observedUncollected` into them
   * would change what the existing field asserts — a reader of
   * `uncollected.observedUncollected` has been promised the sum over the entries
   * it can see, and quietly widening it to cover entries it cannot see would
   * break that promise for anyone diffing two reports. So the two are reported
   * side by side and the arithmetic is left to the reader, who can add a
   * lower bound to a lower bound and still get a lower bound.
   *
   * The direction of both is unchanged by the cap: each is a LOWER BOUND on
   * what was left unbilled, and the evicted block is one too. What the cap
   * changes is only whether the money is itemised, not whether it is counted.
   */
  private uncollectedSummary(): UncollectedSummary {
    const all = [...this.uncollected.values()]
    return {
      sessions: all.length,
      lastKnownTokens: all.reduce((sum, u) => sum + u.lastKnownTokens, 0),
      observedUncollected: all.reduce((sum, u) => sum + u.observedUncollected, 0),
      taskIds: all.map(u => u.taskId),
      // The identity `taskIds` throws away. Reporting the session id is what
      // makes this actionable: "we are under-billing by at least $X" names no
      // session, and a task id on its own does not survive the agent that was
      // terminated to produce it.
      entries: all.map(u => ({
        sessionID: u.sessionID,
        taskId: u.taskId,
        agentId: u.agentId,
        model: u.model,
        lastKnownTokens: u.lastKnownTokens,
        observedUncollected: u.observedUncollected,
      })),
      // Always present, even at zero, so a consumer can tell "nothing was
      // dropped" from "this build does not report drops" without probing.
      evicted: { ...this.uncollectedEvicted },
    }
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
    // FIRST, before anything that can await: an in-flight `executeTask` can
    // reach its timeout during the teardown below, and must not arm a ledger
    // after the flush that is supposed to discharge every ledger has run.
    this.shuttingDown = true

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
    // BEFORE `agents.clear()`, and for two reasons that are both about the
    // agent map rather than the ledgers. A terminated agent is removed from
    // `this.agents` while its session keeps running, so after a step-2 or
    // step-3 respawn the abandoned session is reachable from nowhere except
    // this ledger — this flush is the only mechanism that will ever account
    // for the sessions escalation itself creates. And it is the last chance to
    // bill them: a session that settles after the orchestrator has gone is
    // still spending.
    await this.flushTimeoutDeltas()
    this.agents.forEach((agent) => {
      agent.status = 'terminated'
    })
    this.agents.clear()
    this.running = false
    // Emitted BEFORE the broadcaster is destroyed, so a connected client
    // actually receives the shutdown rather than having the socket closed
    // under it. This final state push is synchronous and undelayed for that
    // reason: `broadcastState()` is throttled onto a timer, and destroying the
    // broadcaster on the next line would clear that timer and drop the last
    // snapshot. `notifyStateListeners()` still runs the caller's own callback —
    // only the broadcaster's copy of the state is skipped.
    this.emit('orchestrator:shutdown', {})
    this.stateChangeListener?.()
    this.broadcaster?.destroy()
    this.broadcaster = null
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

  /**
   * Dispatch one event to every subscriber, ISOLATING each handler's failures.
   *
   * This is a fan-out to code nexus does not own: plugin listeners, and — since
   * the state broadcaster subscribed to all thirteen events — a
   * `JSON.stringify` of every payload leaving the orchestrator. That widened
   * the blast radius of a throw from "the rest of this event's listeners" to
   * "the rest of this event's listeners, once per event nexus emits", and
   * `forEach` gives a throw no way to stop at the offender: it unwinds the
   * whole loop.
   *
   * So each handler gets its own `try`. One bad subscriber now costs exactly
   * one subscriber's delivery, and the throw is LOGGED rather than swallowed —
   * an isolation boundary that says nothing is worse than no boundary at all,
   * because it makes the failure invisible instead of merely contained.
   *
   * Note the ordering consequence, which is deliberate: handlers still run in
   * registration order, and a throwing handler does not reorder or skip the
   * ones after it. Delivery is not transactional and was never claimed to be.
   */
  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) || []
    handlers.forEach((handler) => {
      try {
        handler(data)
      } catch (error) {
        console.error(`[nexus] event handler for "${event}" threw; other listeners were still notified:`, error)
      }
    })
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
