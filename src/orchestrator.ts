import type { Plugin } from "@opencode/plugin"
import type {
  Agent, Task, DAG, DAGNode, ExecutionRequest, ExecutionResult,
  AgentRole, ComplexityScore, ModelSelection, BudgetConstraint,
  AgentStatus,
  CostReport, AgentMessage, MemoryEntry, MemoryScope, LastRecall,
  SpawnConfig, RecoveryAction, HealthStatus, NexusConfig, TaskResult,
  CostProvenance, SpendSplit, CostReportUncollected
} from "./types"
import { NexusConfigManager, type NexusConfigLoadInfo, type NexusConfigReloadTrigger, type NexusEffortConfig } from "./config"
import { StateBroadcaster } from "./broadcast"
import { DashboardModule, describeDashboardStart, parseDashboardTarget, startDashboardServer } from "./dashboard"
import { detectCycles } from "./dag"
import { effortForDifficulty, effortIndex, formatModelRef, parseModelRef, priceKeyForRef, reconcileEffort, tryParseModelRef, type ModelEffort } from "./model-ref"
import { MessageStore, type MessageStoreConfig } from "./message-store"
import { PersistentMemoryStore, isNewerThan, type MemoryStoreConfig } from "./memory-store"
import { HealthMonitor } from "./health"
import { MessageRouter } from "./fanout"
import { NotificationManager, type NotificationOptions } from "./notifications"
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
import {
  buildGitCheckReport,
  detectGitState,
  resolveGitFlow,
  writeGitFlowDecision,
  type GitCheckReport,
  type GitFlowDecision,
  type GitState,
  type ResolvedGitFlow,
} from "./git-flow"
import { TodoEnforcer } from "./todo"
import {
  recallForTask as runRecall,
  type RecallOutcome,
  type RecallRequest,
} from "./memory-recall"

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
 * Named in the memory-eviction warning so the message says which scope is the
 * exempt one rather than leaving the reader to go and look.
 *
 * The exemption itself lives in `COUNT_EXEMPT_SCOPES` in `src/memory-store.ts`,
 * beside the eviction it governs. This is only the label.
 */
const COUNT_EXEMPT_SCOPES_LABEL = 'project'

/**
 * The git convention's defaults, as a standalone constant.
 *
 * Held here rather than only inside `mergeConfig`'s `defaults` literal because
 * `NexusConfig.gitFlow` is OPTIONAL — an external `NexusConfig` literal may omit
 * it — so `defaults.gitFlow` is typed `... | undefined` and spreading it
 * produces a block whose fields are all `boolean | undefined`. That is the
 * "type says boolean, runtime says undefined" shape, and a consumer reading
 * `requireBranch` off it would get `undefined` where it expects `false`.
 *
 * These values must stay identical to `DEFAULT_CONFIG.gitFlow` in
 * `src/config.ts`, which is the file-settable level, and to the single gate's
 * documented default. Three copies of one default is already too many; the two
 * config-level ones are asserted equal by `test/git-flow.test.ts` so they cannot
 * drift silently.
 */
const GIT_FLOW_DEFAULTS: Required<NonNullable<NexusConfig['gitFlow']>> = {
  enabled: true,
  conventionalCommits: true,
  requireBranch: true,
  prBeforeMerge: true,
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

/**
 * An agent's status as a session's `state`. Exhaustive over `AgentStatus` with
 * no `default` arm on purpose: adding a status to that union then fails to
 * compile HERE, which is the only place that would otherwise silently pick a
 * wrong answer for a status nobody has thought about.
 *
 * `spawning` and `blocked` used to be arms here and nothing in `src/` ever
 * assigned either, so both described a state no agent could be in — and
 * `spawning` in particular was indistinguishable from a real mid-task agent,
 * because they both returned `running`. They are gone from the union;
 * `test/status-union-coverage.test.ts` now fails if a member is ever added back
 * without a writer. This switch is the half that catches a member nobody
 * handles; that test is the half that catches a member nobody ever reaches.
 */
function sessionStateOfAgent(status: AgentStatus): SessionStateView['state'] {
  switch (status) {
    case 'working':
      return 'running'
    case 'idle':
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
  /**
   * The budget in force, which is the file's budget unless an
   * `ExecutionRequest.budget` has claimed it. See `syncFileConfig()`.
   */
  public budget: BudgetConstraint
  /**
   * The `ExecutionRequest.budget` a caller supplied, remembered so that a later
   * config reload does not move the ceiling out from under spend already
   * measured against it. `null` when no request has supplied one.
   */
  private budgetOverride: BudgetConstraint | null = null
  private running: boolean = false
  private paused: boolean = false
  private budgetExceeded: boolean = false
  /**
   * Per-task running totals, and the tasks that have already been reported over
   * `maxCostPerTask`. Backs `checkTaskBudget`.
   *
   * A task is a node, and every attempt at a node spawns a FRESH agent
   * (`spawnAndExecute`), so a task's spend is genuinely the sum of its
   * attempts' — which is the right granularity for a per-task figure, because
   * the escalation chain is what turns one runaway task into three bills.
   *
   * The latch is a `Set` rather than a boolean because the total's latch
   * (`budgetExceeded`) describes one run-wide terminal event, and this is not
   * that: N tasks can each go over, and a user who wants to know which ones
   * needs all N named, not the first.
   */
  private costByTask: Map<string, number> = new Map()
  private tasksOverBudget: Set<string> = new Set()

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
  /**
   * What the most recent spawn injected, and how much of it.
   *
   * Reset to `null` on every spawn, INCLUDING a spawn that injected nothing, so
   * a stale reading from a previous task is never read as this task's cost.
   * Set at both injection points, in `executeTask` and in `spawnAgent`.
   */
  private lastRecall: LastRecall | null = null

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

  /**
   * Detected git state, and the path it was detected at.
   *
   * MEMOISED on purpose. Detection costs two `git` processes — about 80 ms on
   * the development machine, where `spawnSync` itself is ~40 ms (see
   * `detectGitState`'s doc for the measurement) — and it answers questions
   * about the WORKING DIRECTORY, which does not change while the process runs.
   * Recomputing it per tool call would pay that on every `nexus.git.check` for
   * an answer that cannot have changed.
   *
   * Not invalidated on config reload, and deliberately: a reload changes
   * `gitFlow`, not the checkout. The gate is re-resolved from this cached state
   * every time, so a config edit takes effect immediately.
   */
  private cachedGitState: GitState | null = null
  private cachedGitStatePath: string | null = null

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

  /**
   * The one gate every OS notification flows through.
   *
   * Every call site used to open-code `if (this.notifications?.isEnabled())`
   * and then fire a floating `notify()` whose `false` nobody checked. That is
   * five places to keep in sync and no way to tell, afterwards, whether
   * notifications had worked — the actual complaint this replaces.
   *
   * The promise is deliberately NOT awaited by its callers. A notification is
   * a courtesy; blocking a DAG node or an event handler on `osascript` would
   * let a slow or wedged notifier add latency to every task. The notifier
   * bounds that itself with a 3 s timeout, so a wedged process cannot pin a
   * task open either.
   *
   * Floating is made safe by the `.catch()` below, NOT by an assumption about
   * `notify()`. `notify()` swallows its own failures today, but it is `async`,
   * so any future throw inside it becomes a REJECTION rather than a throw, and
   * `engines.node >= 22` terminates the process on an unhandled rejection by
   * default — a cosmetic feature able to kill the orchestrator. `emit`'s
   * per-handler isolation does not help either: these five call sites are
   * direct statements in the DAG and budget paths, not inside `emit` handlers.
   * The handler makes "cannot fail a task" a property of THIS function rather
   * than a property somebody has to keep re-establishing in `notify()`.
   */
  private sendNotification(options: NotificationOptions): void {
    if (!this.notifications) return
    // Belt and braces. This should never fire, and a rejection is already
    // non-fatal by construction — but "should never fire" is exactly the claim
    // that must not be the only thing standing between a notifier bug and a
    // process exit, so the failure is logged and dropped here rather than
    // escalated.
    this.notifications.notify(options).catch((error: unknown) => {
      console.error(
        `[nexus] notification rejected: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  // Real model pricing from OpenCode (populated via loadModelCosts).
  // Keyed by "providerID/id" (bare ids are not unique across providers) and
  // valued in **USD per 1K tokens** — the same unit as the hardcoded table.
  public modelCosts: Map<string, NexusModelCost> = new Map()

  // Provider id → the human label from models.dev (populated via
  // loadProviderNames). PRESENTATION ONLY: nothing prices, ranks, bills or
  // totals from this map, and no key of it is a spend figure. It exists so a
  // surface holding only a `"provider/id"` ref can print `OpenCode Go` where
  // the TUI picker does. A provider with no label here degrades to its raw id.
  //
  // The VALUE is `unknown` on purpose: it is whatever the host's wire put there,
  // and a `name` of `42` is a thing that has been observed. The loader does not
  // vet it, because a usable-looking name has an owner (`providerLabels` in
  // `src/model-groups.ts`) and two copies of one rule is the failure mode this
  // feature exists to remove; `getProviderList` narrows it on the way out.
  private providerNames: Map<string, unknown> = new Map()

  /**
   * `providerID/modelID` → the variant ids that model actually publishes.
   *
   * A SECOND thing off the SAME `provider.list()` snapshot as `providerNames`,
   * taken in the same call for the same reason: one list, one snapshot, so a
   * model cannot have a label from boot and a variant set from a later read.
   * `ProviderInfo.models` carries each `ModelInfo`, and `ModelInfo.variants` is
   * `Array<ModelVariant>` — the array whose `[]` means "this model publishes no
   * variants".
   *
   * EXISTENCE IS THE WHOLE CONTRACT, and the distinction from an empty array is
   * load-bearing. Both mean "ask for no variant", but they mean different
   * things and the difference is reported in `ModelSelection.reasoning`:
   * absent = the catalogue never told us (no `ctx.provider`, a throw, a
   * non-array, a model with no `variants` field), empty = the model publishes
   * none. Inventing a variant for a model we have no catalogue entry for would
   * be the one thing this feature must never do, since the host may reject an
   * unknown variant id and the failure would surface as a failed spawn rather
   * than a wrong effort.
   *
   * The value is `string[]` narrowed to the ids, in the host's own order, and a
   * row whose `variants` is not an array is STORED AS ABSENT rather than as an
   * empty list — the same "a malformed row degrades to no information" rule
   * `loadModelCosts` follows, and the one place the two disagree is the one
   * where claiming "publishes none" would be a claim we cannot support.
   */
  private publishedVariants: Map<string, readonly string[]> = new Map()

  // Set when a spawn fell back to ctx.session.create() instead of the built-in
  // subagent tool (child session not parent-linked). null when the last spawn
  // used the subagent tool.
  public lastDegradedSpawn: { agentId: string; role: string; reason: 'no-parent-context' | 'subagent-tool-unavailable' } | null = null

  constructor(config?: Partial<NexusConfig>, messageStoreConfig?: Partial<MessageStoreConfig>, memoryStoreConfig?: Partial<MemoryStoreConfig>) {
    this.config = this.mergeConfig(config)
    this.budget = this.config.budget
    // The 8th seed is the `memory` block, and it is seeded from
    // `memoryStoreConfig` rather than from `config`. `NexusConfig` deliberately
    // does not carry a `memory` block — it was removed from that type for doing
    // nothing, and re-adding it to feed a seed would resurrect the inert block
    // rather than seed a live one. The store's own parameter is where a
    // programmatic caller already expresses a DB path and a cap, so the config
    // manager is given the same two values: `getConfig().memory.storage` then
    // reports the path the store will actually open instead of the default, and
    // the two cannot disagree. `enabled` is absent from `memoryStoreConfig` (it
    // is a user-facing gate, not a store setting) and so falls through to the
    // default `true`, which is what already happens.
    this.configManager = new NexusConfigManager(
      this.config.dashboard, this.config.notifications, this.config.customRoles,
      this.config.gitFlow, this.config.effort, this.config.budget, this.config.selfHealing,
      { storage: memoryStoreConfig?.dbPath, maxEntries: memoryStoreConfig?.maxEntries },
    )
    this.moduleRegistry = new ModuleRegistry()
    this.messageStore = new MessageStore(messageStoreConfig)
    // A RESOLVER, not the snapshot. `memoryStoreConfig` still seeds
    // `configManager` above, so the constructor parameter keeps working
    // unchanged — but it seeds a CONFIG LEVEL, and the store reads that level
    // live. Passing the object itself froze the path for the life of the
    // process: `getConfig().memory.storage` then reported whatever
    // `nexus.jsonc` said while the store went on opening the path it was
    // constructed with, and the config modal reported a saved setting the app
    // was ignoring.
    //
    // Deliberately NOT a rebuild inside `reloadConfigFromDisk`, which calls
    // `notifyStateChange()` and emits `config:reloaded`: swapping the database
    // there would race every in-flight `recallForTask` from a running agent,
    // and a reconstructed store would reset `evictedTotals` — the running
    // eviction count a surface shows. Resolving at USE time puts the swap on a
    // call that is already reading, which is synchronous, so the transition
    // completes before any other caller can observe it.
    this.memoryStore = new PersistentMemoryStore(() => {
      const memory = this.configManager.getConfig().memory
      return { dbPath: memory.storage, maxEntries: memory.maxEntries }
    })
    this.messageRouter = new MessageRouter()

    // Initialize escalation policy from config selfHealing settings.
    //
    // The three self-healing keys are ALSO written by `syncFileConfig()` rather
    // than only here, and the `fallbackModels` copy stays here because it is a
    // template rather than a setting.
    //
    // Both assignments are needed, and neither is redundant. `syncFileConfig()`
    // runs at the end of this constructor and again on every load from disk, so
    // this block is what a reload OVERWRITES; but `syncFileConfig()` derives
    // `selfHealing` from the manager, and the manager is constructed one line
    // above from `this.config.selfHealing` — so with neither, `this.config`'s
    // value was never a level anything could read and the backoff base was the
    // default for the life of the process. `nexus.jsonc` said `retryDelay:
    // 4321`, the config panel displayed 4321, and the backoff ran 1s/2s/4s.
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

    // The two blocks the config FILES own, resolved once so that the snapshot
    // fields below (`this.budget`, `escalationPolicy`) are not left holding the
    // constructor's defaults for the lifetime of the process. At construction
    // time the manager has loaded nothing yet, so this is a no-op in practice —
    // it is here so there is exactly ONE place that writes those fields, and
    // `initialize()` and `reloadConfigFromDisk()` can both be the second caller.
    this.syncFileConfig()
  }

  /**
   * Push the two file-owned blocks — `budget` and `selfHealing` — out of the
   * config manager and into the fields the rest of this class reads.
   *
   * ── WHY PUSH, AND WHY IT HAD TO BE PUSH ──
   *
   * `this.config` is seeded ONCE, in the constructor, and `src/index.ts`
   * constructs `new NexusOrchestrator()` with no argument at all — so in the
   * shipped product every value in it is a default, whatever the user's
   * `nexus.jsonc` says. Two blocks then read from it and nothing pushed a file's
   * values into them:
   *
   *   - `selfHealing`, whose `retryDelay` became the escalation backoff base at
   *     `this.escalationPolicy.retryDelay`. A file saying `retryDelay: 4321`
   *     parsed, round-tripped and displayed, and the backoff still ran
   *     1s/2s/4s.
   *   - `budget`, of which `maxCostPerTask` gates `checkTaskBudget` and whose
   *     `maxTotalCost` is what the dashboard and the config panel both SHOW.
   *     A user who set `maxCostPerTask: 0.01` and saw no notification concluded
   *     the notification was broken.
   *
   * The point-of-use alternative — read `this.configManager.getConfig()` at each
   * site, the way `applyEffort` reads `.effort` — is not available for either
   * block. `escalationPolicy` is a SNAPSHOT field read deep inside the retry
   * path, and `this.budget` is a snapshot field by contract (see the note on
   * `OrchestratorState.config.budget`: `execute()` may replace it with a caller's
   * `ExecutionRequest.budget`). Re-reading the manager at each of the ~6 read
   * sites would put two different answers for the same knob in the same object
   * and still leave the displayed payload reading the other one. So the manager
   * is the authority and these fields are its cache, refreshed whenever the
   * files are read.
   *
   * Two consequences, both deliberate:
   *
   *   1. `hardLimit` is NOT taken from the file. It is absent from
   *      `NexusFullConfig.budget` — it has never been expressible in
   *      `nexus.jsonc` — and adding it here would either silently start
   *      honouring a key the schema does not offer, or (worse) drop the
   *      constructor's value on every reload. The constructor value is carried
   *      across explicitly so a programmatic `hardLimit: true` survives a
   *      reload. See the README for why the file does not grow the key.
   *   2. `this.budget` is only overwritten when no `ExecutionRequest.budget`
   *      has claimed it for this orchestrator, because a config reload mid-run
   *      must not move the ceiling out from under spend already measured
   *      against the old one.
   */
  private syncFileConfig(): void {
    const file = this.configManager.getConfig()

    // `NexusFullConfig.selfHealing` and `NexusConfig.selfHealing` are the same
    // four fields, so this is a copy rather than a cast. It is written out field
    // by field anyway: a `spread` here would be a place where a fifth field could
    // be added to one type and silently not reach the other.
    const selfHealing: NexusConfig['selfHealing'] = {
      enabled: file.selfHealing.enabled,
      maxRetries: file.selfHealing.maxRetries,
      retryDelay: file.selfHealing.retryDelay,
      contextTransfer: file.selfHealing.contextTransfer
    }

    // The advisory ceilings come from the file; `hardLimit` does not, and
    // preserving it here is what keeps a constructor-supplied hard limit from
    // being reset to `false` by the first `nexus.jsonc` that mentions a budget.
    const budget: BudgetConstraint = {
      maxTotalCost: file.budget.maxTotalCost,
      maxCostPerTask: file.budget.maxCostPerTask,
      alertThreshold: file.budget.alertThreshold,
      hardLimit: this.config.budget.hardLimit
    }

    this.config = { ...this.config, selfHealing, budget }
    this.budget = this.budgetOverride ?? budget
    this.escalationPolicy = {
      ...this.escalationPolicy,
      maxRetries: selfHealing.maxRetries,
      retryDelay: selfHealing.retryDelay,
      enableRespawn: selfHealing.contextTransfer
    }
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

    // …and push the two file-owned blocks into the snapshot fields, immediately
    // after the load and BEFORE anything that reads them. `selfHealing.retryDelay`
    // and `budget.maxCostPerTask` were both constructor-only until this call, so
    // the very first `nexus.jsonc` a project ships was ignored for the life of
    // the process even though the config panel displayed it as set.
    this.syncFileConfig()

    // Register the roles from the just-loaded config, before anything can ask
    // for one. It has to be here rather than at the end of initialize(): a
    // module's `setupAll` and the first spawn both resolve role prompts, and
    // both would otherwise see an empty registry and hand a custom role the
    // generic "You are a <role>" prompt — the role would exist in the file and
    // in `roles.list` while behaving as if it had never been written.
    this.syncCustomRoles()

    // Load real model pricing from OpenCode
    await this.loadModelCosts()

    // Load provider display names. Independent of the above and best-effort: a
    // failure here costs a label, never a price, so it must not be able to stop
    // pricing from loading. Sequential only because both are one-shot awaits at
    // startup and neither depends on the other.
    await this.loadProviderNames()

    // Start periodic cleanup of stale data (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupStaleData(), 300000)

    // Initialize health monitor
    this._healthMonitor = new HealthMonitor({
      checkInterval: this.config.agents.healthCheckInterval
    })

    // Initialize notification manager. `enabled` is driven by config rather
    // than hardcoded: `new NotificationManager(true)` made `notifications.enabled`
    // a dead knob, the same defect `config.dashboard.enabled` had until 2.7.0.
    // Seeded from the merged config, which by now has consulted the project and
    // global files (see the `loadFromPath` above), so `notifications: { enabled: false }`
    // in `nexus.jsonc` is honoured from the first notification onward.
    this.notifications = new NotificationManager(
      this.configManager.getConfig().notifications.enabled
    )

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
   * Load provider id → display name from OpenCode's provider list.
   *
   * WHY `ctx.provider` AND NOT `data.location.provider`
   *
   * The TUI picker reads names from `context.data.location.provider`, a
   * `LocationCollection<ProviderInfo>` that exists ONLY on the TUI's
   * `Plugin.Context` (`@opencode/plugin/tui`, whose `Data` interface declares
   * it). The orchestrator is a different process on a different context type:
   * `NexusPluginContext = Plugin.Context` from `@opencode/plugin`
   * (`src/orchestrator.ts:82`), and that `Context` has no `data` member at all
   * — it is a headless, RPC-shaped context of domains. It does, however, carry
   * `readonly provider: ProviderDomain` (`@opencode/plugin`'s `plugin.d.ts`),
   * and `ProviderDomain extends ProviderApi`, whose `list()` returns
   * `{ location, data: Array<ProviderInfo> }` with `ProviderInfo` carrying both
   * `id` and `name`. So the names ARE reachable from the server; the path to
   * them just is not the TUI's.
   *
   * This is a LABEL LOOKUP and nothing more. It prices nothing, selects no
   * tier, ranks nothing and contributes to no total: a provider name is not a
   * quantity, and the whole map is excluded from every figure in the cost
   * report (see `getCostReport`).
   *
   * Best-effort, like `loadModelCosts`: an absent `ctx.provider` or a throw
   * leaves `providerNames` empty, and every consumer then falls back to the raw
   * provider id — which is exactly the label it would have used before this
   * existed. A malformed ROW is not dropped here; see below.
   *
   * ── WHAT THIS LOADER DELIBERATELY DOES NOT DECIDE ──
   *
   * It stores what the host said, and the ONE thing it filters is the map key:
   * a row whose `id` is absent, non-string or empty cannot be looked up by
   * anything, and keying a `Map` on `undefined` would be a broken data structure
   * rather than a formatting preference, so those rows are dropped.
   *
   * It does NOT filter the NAME. Deciding what counts as a usable label belongs
   * to `providerLabels` in `src/model-groups.ts`, which every surface already
   * calls, and restating that rule here is what produced two loaders that could
   * disagree about the same provider. A row named `""` or `42` is therefore
   * STORED, and `getProviderList` omits the unusable name on the way out, where
   * it degrades to `{ id }` — which is exactly what `providerLabels` already
   * resolves through its raw-id fallback. `test/cost-report-providers.test.ts`
   * proves the whole chain: a malformed row reaches the consumer and still
   * yields a usable, non-blank label.
   *
   * ── WHY THERE IS NO `reload()` HERE, DELIBERATELY ──
   *
   * `ProviderDomain` declares `reload(): Promise<void>`
   * (`@opencode/plugin/dist/promise/provider.d.ts:33`) and nothing calls it, so
   * a provider added, removed or RENAMED mid-session keeps its boot-time label
   * until the server restarts. That is a real gap and it is stated here, in the
   * dashboard page and in the README, rather than left to be discovered.
   *
   * The alternative was weighed and rejected for three reasons:
   *
   *  1. The host declares the method with no contract at all — no parameters
   *     documented, no statement of whether it is idempotent, atomic, or even
   *     when the refreshed data becomes visible to `list()`. Calling it on a
   *     timer is a guess about an API whose only specification is its name, and
   *     a guess that runs forever in a background interval.
   *  2. It would not make the label FRESH, only less stale, so it buys a
   *     narrower version of a defect that is already the mildest kind: a wrong
   *     LABEL on rows that are otherwise correct, never a missing model and
   *     never a wrong price. The raw-id fallback is always true.
   *  3. It would make the surfaces DISAGREE AGAIN. The TUI is a separate process
   *     with its own per-directory memo (`src/tui.tsx`) that this module cannot
   *     reach, so a server-side reload would make the tool and the dashboard
   *     fresh while the picker stayed permanently boot-stale — re-creating, in a
   *     narrower form, exactly the two-snapshot split that having the tool read
   *     this map just removed.
   *
   * So: one snapshot, taken at `initialize()`, shared by the dashboard and the
   * `model.costs` tool by construction, with the staleness documented on all
   * three surfaces rather than papered over on one of them.
   *
   * `publishedVariants` is filled from the SAME loop, and that is the reason it
   * is here rather than a second `provider.list()` call: one call, one
   * snapshot, and no way for the two maps to disagree about which models the
   * host published.
   */
  private async loadProviderNames(): Promise<void> {
    try {
      if (!this.ctx?.provider) return

      const { data } = await this.ctx.provider.list()
      if (!Array.isArray(data) || data.length === 0) return

      for (const provider of data) {
        if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) continue
        // First writer wins, so the order of the host's list decides nothing but
        // stability — the same rule the shared helper uses, and the reason two
        // rows disagreeing about one id is not a case worth guessing at.
        if (!this.providerNames.has(provider.id)) this.providerNames.set(provider.id, provider.name)
      }

      this.collectPublishedVariants(data)
    } catch {
      // Provider naming is best-effort — every consumer falls back to the raw id
    }
  }

  /**
   * Fill `publishedVariants` from an already-fetched `ProviderInfo[]`.
   *
   * Takes the array rather than fetching it, so it runs off the ONE
   * `provider.list()` the loader above already made, and it runs even when every
   * row was rejected for labelling — the label filter drops a row with no
   * `id`, and such a row can still carry models.
   *
   * KEYED BY `priceKeyForRef`, i.e. `providerID/modelID` with any `#variant`
   * stripped, because that is the key a `ModelSelection`'s halves rebuild and
   * therefore the key the lookup is given. It is the SAME key the price table
   * joins on, deliberately: one normaliser, so a model priced as `p/m` is the
   * same model whose variants are listed as `p/m`.
   *
   * Nothing is filtered out of a `variants` array. A variant id is a string the
   * host published, `reconcileEffort` is the one place that decides whether a
   * name is a rung on the ladder, and vetting ids here would put a second,
   * different copy of that rule in the file.
   */
  private collectPublishedVariants(providers: readonly unknown[]): void {
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') continue
      const { id, models } = provider as { id?: unknown; models?: unknown }
      if (typeof id !== 'string' || id.length === 0) continue
      if (!models || typeof models !== 'object') continue
      for (const [key, model] of Object.entries(models as Record<string, unknown>)) {
        if (!model || typeof model !== 'object') continue
        const { variants } = model as { variants?: unknown }
        // A model with no `variants` field is ABSENT, not empty: absence means
        // "not published by the catalogue", empty means "published, and there
        // are none", and `ModelSelection.reasoning` reports the two differently.
        if (!Array.isArray(variants)) continue
        const ids: string[] = []
        for (const variant of variants) {
          if (variant && typeof variant === 'object' && typeof (variant as { id?: unknown }).id === 'string') {
            ids.push((variant as { id: string }).id)
          }
        }
        // The catalogue's own key wins over the reconstructed one. It is the id
        // the host indexes by, and a model whose `id` disagreed with its key
        // would be a row worth trusting under the host's own spelling.
        const modelID = typeof (model as { id?: unknown }).id === 'string' ? (model as { id: string }).id : key
        this.publishedVariants.set(priceKeyForRef(`${id}/${modelID}`), ids)
      }
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
   * Start the web dashboard server.
   *
   * THE GATE LIVES HERE, and that is a deliberate placement: this is the single
   * choke point every start path goes through (the `dashboard.start` tool, and
   * anything else added later), so honouring `dashboard.enabled` anywhere else
   * would be a second copy of the rule. It was readable from nowhere before —
   * the field defaulted to `true`, was documented as a switch, and no code in
   * `src/` read it.
   *
   * `enabled`/`port`/`host` resolve from the CONFIG MANAGER, not from
   * `this.config.dashboard`, so a `dashboard` block in `nexus.jsonc` reaches
   * them. The manager is seeded with `this.config.dashboard` at construction,
   * which is what keeps a programmatic `new NexusOrchestrator({dashboard:
   * {...}})` working — it is the bottom precedence level, so either file still
   * wins. Explicit arguments to this method still win over all of it.
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
   *
   * @throws if `dashboard.enabled` is false, or if the port cannot be bound.
   *   Both messages name the reason; neither leaves a half-built module
   *   reachable through `this.dashboard`.
   */
  startDashboard(port?: number, host?: string): void {
    const dashboardConfig = this.configManager.getConfig().dashboard
    if (!dashboardConfig.enabled) {
      throw new Error(
        'Dashboard is disabled by configuration (`dashboard.enabled: false` in .opencode/nexus.jsonc or '
        + '~/.config/opencode/nexus.jsonc). Set it to true — or remove the block, which defaults to enabled — '
        + 'to start the server.',
      )
    }

    const dashPort = port || dashboardConfig.port
    const dashHost = host || dashboardConfig.host
    // Built into a local and published only on success. The previous
    // `this.dashboard = new DashboardModule(this)` before `start()` left a
    // module with a null server reachable through `this.dashboard` whenever the
    // bind failed, so `stopDashboard()` had a phantom to act on and
    // `dashboard.isRunning()` was answering about a server that never existed.
    const dashboard = new DashboardModule(this)
    dashboard.start(dashPort, dashHost)
    this.dashboard = dashboard
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
   * Git state for `cwd`, or for the process working directory.
   *
   * The ONLY place the orchestrator asks git anything. Everything else that
   * needs to know whether there is a repository, a branch or a remote goes
   * through here, so there is one memoisation and one failure story: a `git`
   * that is missing, slow or broken yields `known: false` and no exception, and
   * no task is ever aborted by a convention layer.
   */
  getGitState(cwd?: string): GitState {
    const path = cwd || process.cwd()
    if (this.cachedGitState === null || this.cachedGitStatePath !== path) {
      this.cachedGitState = detectGitState(path)
      this.cachedGitStatePath = path
    }
    return this.cachedGitState
  }

  /**
   * The effective convention for `cwd`, after config AND any per-repo answer.
   *
   * The single gate. `nexus.git.check` and the agent-markdown injection both
   * call this and neither re-reads the config block, so `gitFlow.enabled` has
   * one reader rather than the two-or-more that let `dashboard.enabled` and
   * `notifications.enabled` drift into dead knobs.
   */
  resolveGitFlow(cwd?: string): ResolvedGitFlow {
    return resolveGitFlow(
      this.configManager.getConfig().gitFlow,
      this.getGitState(cwd),
    )
  }

  /**
   * The read-only report behind `nexus.git.check`.
   *
   * REPORTS, NEVER BLOCKS AND NEVER WRITES. It refuses nothing, and it runs no
   * `git commit`, `git push` or `git merge` — there is no such call in
   * `src/git-flow.ts` to make. `recordGitFlowDecision` is the only method here
   * that touches the filesystem, and it writes nexus's OWN global config
   * directory, never the user's repository.
   */
  checkGitFlow(cwd?: string): GitCheckReport {
    return buildGitCheckReport(this.getGitState(cwd), this.configManager.getConfig().gitFlow)
  }

  /**
   * Record the per-repo answer to the one question this layer asks.
   *
   * Keyed by the REPOSITORY identity — `git rev-parse --git-common-dir`'s parent
   * — and NOT by the top level of the work tree. Those differ inside a linked
   * worktree, where `--show-toplevel` returns the worktree's own path; keying on
   * it would re-ask a user who had already answered, once per worktree. See
   * `GitState.repoId`.
   *
   * Persisted in `~/.config/opencode/nexus-gitflow.json` — see
   * `gitFlowDecisionPath()` for why not the repository and not `nexus.jsonc`.
   */
  recordGitFlowDecision(decision: GitFlowDecision, cwd?: string): GitFlowDecision {
    const state = this.getGitState(cwd)
    if (!state.repoId) {
      throw new Error(
        'Not inside a git work tree, so there is no repository to record a decision about. '
        + 'Run this from inside a repository, or set `gitFlow.enabled: false` in nexus.jsonc instead.',
      )
    }
    return writeGitFlowDecision(state.repoId, decision)
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
      model: this.modelSpendKey(a.model),
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
        model: this.modelSpendKey(agent.model),
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

    // The published rows, and a guard rather than a projection. `id` is the key
    // of every row and `state` is written by all three passes, so neither can be
    // absent or null through those constructors — but `sessions[]` is the one
    // collection a reader is entitled to treat as fully populated, and an empty
    // key reaching it would be a row that names no session and claims no state.
    // A row with no id is dropped here rather than published; a `running`/`settled`
    // row with a real id is not a phantom and stays.
    return [...views.values()].filter(view => view.id.length > 0)
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
    // A record with no session id is not a session. `sessionViews()` pass 1
    // already skips an agent with no session for the same reason — there is
    // nothing to key a row by, and a row with an empty `id` is a phantom in a
    // list a user is meant to trust. Passes 2 and 3 did not have this check,
    // which is the one place a session-keyed row could be built with a
    // non-session key.
    if (!record.sessionID) return
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

  /**
   * The id of the task currently assigned to `agentId`, or null.
   *
   * `assignedAgent` is written once per attempt, in `spawnAndExecute`, and never
   * cleared — so this is a first-match scan over insertion order rather than a
   * live reverse index. That is sound for the caller this now has
   * (`checkTaskBudget`) and worth saying why: every attempt at a node spawns a
   * FRESH agent, so a single agent id is ever assigned to exactly one task, and
   * the first match is therefore the only match. A late charge from a
   * terminated agent of an earlier attempt of the same node still resolves to
   * that node, which is the correct attribution — it is still that task's money.
   *
   * It is NOT sound as a general "which task is this agent on" query, and it is
   * not used as one.
   */
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
        // Read, by `checkBudget`. See `BudgetConstraint.maxCostPerTask` for
        // what it does and, at length, what it does not do.
        maxCostPerTask: 1.00,
        alertThreshold: 0.2,
        hardLimit: false
      },
      // `defaultRole` and `spawnDelay` are GONE, and were read by nothing —
      // see `NexusConfig.agents`. `healthCheckInterval` below is read, at the
      // `HealthMonitor` construction in `initialize()` and in
      // `cleanupStaleData`, and stays.
      agents: {
        healthCheckInterval: 30000
      },
      selfHealing: {
        enabled: true,
        maxRetries: 3,
        // Read, at the `escalationPolicy` construction in the constructor.
        retryDelay: 1000,
        // `backoffMultiplier` is GONE: the backoff in `handleFailure` is
        // `policy.retryDelay * Math.pow(2, retryCount)`, with the 2 written
        // into the expression. See `NexusConfig.selfHealing`.
        contextTransfer: true
      },
      // The `communication` and `security` blocks are GONE, and neither had a
      // reader. Both are argued in `NexusConfig`: `communication` matched no
      // module at all, and `security` matched `src/security.ts` in no field
      // name — a real module, already wired, already taking its settings from
      // its own `SecurityConfig`.
      dashboard: {
        enabled: true,
        port: 4747,
        host: '127.0.0.1'
      },
      notifications: {
        enabled: true
      },
      gitFlow: { ...GIT_FLOW_DEFAULTS },
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
      // No `communication` line: the block is gone from `NexusConfig` along with
      // its only writer. A caller who still passes one is not rejected at
      // runtime — `...restDefaults` / `...partial` are typed, so the property
      // simply is not on the type any more — but nothing reads it either way,
      // which is what the deletion is asserting.
      dashboard: { ...defaults.dashboard, ...partial?.dashboard },
      notifications: { ...defaults.notifications, ...partial?.notifications },
      // Merged per-key rather than carried through the blanket `...partial`
      // above, because a caller passing `{ gitFlow: { enabled: false } }` would
      // otherwise REPLACE the whole block and leave the other three toggles
      // undefined at runtime while the type claims they are booleans.
      //
      // Off `GIT_FLOW_DEFAULTS` rather than off `defaults.gitFlow`, because
      // `NexusConfig.gitFlow` is OPTIONAL (so an external literal may omit it)
      // and spreading an optional property yields a block whose fields are all
      // `boolean | undefined` — which is precisely the "type says boolean,
      // runtime says undefined" shape this line exists to prevent.
      gitFlow: { ...GIT_FLOW_DEFAULTS, ...defaults.gitFlow, ...partial?.gitFlow },
      // No `security` line, for the reason given above `dashboard`. Note what
      // this does NOT touch: `this.securityScanner` below is constructed from
      // `SecurityScanner`'s OWN defaults and scans every task's output at
      // `scanContent` in `executeTask`. That is a live, wired path, and it is
      // unaffected by the deletion — which is the whole finding, and the reason
      // the block was scaffolding rather than a broken connection.
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
      // The roles are not the only thing a reload has to refresh. `selfHealing`
      // and `budget` are read from snapshot fields, and a reload that refreshed
      // only `configManager` left those holding the values the CONSTRUCTOR saw —
      // which, in the shipped product, is to say the defaults. A user editing
      // `retryDelay` in `nexus.jsonc` and reloading would see the file value in
      // `/nexus config` and the old backoff in the retry.
      this.syncFileConfig()
      // Re-read the roles too, and from the same merged config every other
      // consumer reads, so there is one answer to "which roles are in effect".
      // Unlike `notifications` — which is snapshotted into a manager at
      // initialize and stays whatever the file said then — the role registry
      // has to shrink as well as grow: a role deleted from `nexus.jsonc` is
      // gone, and `loadFromConfig` replaces rather than adds so it stops
      // resolving. A user editing this file should not need a restart.
      this.syncCustomRoles()
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
        this.budgetOverride = request.budget
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
   * Resolve the "providerID/modelID[#variant]" reference `spawnAgent` requires.
   *
   * `ModelSelection.model` is the bare id (`scoreModel` splits the candidate
   * through the shared ref parser), so the halves have to be rejoined here — and
   * the variant with them. Rebuilt through `formatModelRef` rather than by hand
   * so the `#` appears exactly when, and only when, a variant is set.
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

    return formatModelRef({ providerID: model.provider, id: model.model, variant: model.variant })
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

      // Recollections, AFTER the task and BEFORE the context-transfer block.
      // The position is part of the marking: the transfer block immediately
      // below already establishes that a trailing block is narration, not
      // instruction, and a recollection belongs in the same register as the
      // thing it most resembles.
      //
      // NOT injected into `buildRolePrompt`. That returns a role string shared
      // by every task of that role, and recollection placed there becomes
      // instruction by accumulation — a note that fires on every coder's task is
      // indistinguishable from the system prompt, which is the specific
      // outcome the whole marking scheme exists to prevent.
      const recall = this.recallForTask({
        files: node.task.files.include,
        text: `${node.task.name}\n${node.task.description}`,
      })
      if (recall.block) {
        taskPrompt += `\n\n${recall.block}`
        this.lastRecall = {
          agentId: agent.id,
          taskId: node.id,
          taskName: node.task.name,
          notes: recall.shown,
          characters: recall.characters,
        }
      } else {
        this.lastRecall = null
      }

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
      this.trackCost(agent.id, this.modelSpendKey(agent.model), result.cost, result.tokensUsed, result.costProvenance)

      // Record performance metrics
      this.performanceTracker.record({
        model: this.modelLabelKey(agent.model),
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
        model: this.modelLabelKey(agent.model),
        status: 'success',
        cost: result.cost,
        costProvenance: result.costProvenance,
        duration: result.duration,
        tokensUsed: result.tokensUsed,
        startedAt: new Date(startTime),
        completedAt: new Date(),
      })

      // Notify on task completion
      this.sendNotification({ title: 'Nexus: Task Complete', body: `${node.task.name} completed successfully` })

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
      this.trackCost(agent.id, this.modelSpendKey(agent.model), result.cost, result.tokensUsed, result.costProvenance)
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
        model: this.modelLabelKey(agent.model),
        error: errorMessage,
        duration,
        sessionID: agent.sessionID
      })

      // Record performance metrics for failed task
      const performanceId = this.performanceTracker.record({
        model: this.modelLabelKey(agent.model),
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
        model: this.modelLabelKey(agent.model),
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
      this.sendNotification({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${errorMessage}`, sound: true })

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
    const model = this.modelSpendKey(agent.model)

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
   * Re-register the custom roles from the merged config, discarding whatever
   * the registry held.
   *
   * The single place roles enter the registry from configuration, so a
   * constructor seed and a file cannot both be applied and cannot be applied in
   * an order that depends on who called first. Replaces rather than adds, so a
   * role removed from the file stops resolving — see `reloadConfigFromDisk`.
   *
   * The report `loadFromConfig` returns is deliberately dropped: a session that
   * defines no roles is not a fact worth a line of output, and a malformed
   * entry is already reported by `loadFromConfig` itself, which is where the
   * detail needed to fix it lives.
   */
  private syncCustomRoles(): void {
    this.customRoles.loadFromConfig(this.configManager.getConfig())
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
      documenter: "You are a technical writer. Create clear, comprehensive documentation for code and APIs.",
      designer: "You are a design director. You decide how a thing should look and behave — layout, hierarchy, information architecture, tone — and you do not implement it. Return a written direction a coder can build from and a reviewer can check against. You do not write or edit code."
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
    //
    // The variant is part of the identity here, and that is deliberate: a
    // fallback entry naming `p/m` is a DIFFERENT configuration from the
    // `p/m#high` that just failed, so escalating to it is a real change rather
    // than the re-run of the identical task the check exists to prevent. For a
    // variant-free agent this is the same string as before.
    const failedRef = this.modelSpendKey(agent.model)
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
      this.sendNotification({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${error.message}`, sound: true })
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
    //
    // Matched on the parsed MODEL ID, not on `split('/')[1]`. The old
    // comparison took the second segment, so a two-slash configured ref such as
    // `openrouter/anthropic/claude-sonnet-4-5` compared `anthropic` against the
    // caller's bare `claude-sonnet-4-5`, found no match, and threw — a config
    // entry that is perfectly valid could not be named without its provider
    // prefix. That is issue #85. It was left alone in the PR that filed it to
    // keep that PR scoped; that reason no longer holds, because this change
    // makes `provider/model#variant` a format this line has to parse.
    if (!modelConfig.includes('/')) {
      const allModels = this.configManager.getConfig().models
      const match = Object.values(allModels).find(m => m && tryParseModelRef(m)?.id === modelConfig)
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

    // ONE parse, and both spawn paths below are driven from it. The reference
    // may carry a `#variant`; the host's grammar is `providerID/modelID#variant`
    // (see `src/model-ref.ts`), so a value that is not one is rejected HERE,
    // loudly, instead of reaching the host as an id that matches no model.
    let parsedRef: ReturnType<typeof parseModelRef>
    try {
      parsedRef = parseModelRef(modelConfig)
    } catch (error) {
      const source = config.model ? 'requested' : 'configured for role'
      throw new Error(
        `Invalid model "${modelConfig}" (${source} "${config.role}"). ` +
        `Use "providerID/modelID" or "providerID/modelID#variant" (e.g. "opencode-go/mimo-v2.5#high"). ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const provider = parsedRef.providerID
    const modelName = parsedRef.id

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
      designer: 'nexus-designer',
    }
    // The `|| 'nexus-coder'` below is a total function over the role strings and
    // says nothing: a role absent from the map runs as a coder, with the
    // coder's permissions and the coder's markdown, and no error anywhere. That
    // is why `AGENT_TYPE_MAP_KEYS` is asserted against `getRoles()` in
    // `test/designer-role.test.ts` rather than left to a test that spawns one
    // designer and looks at the result.
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

    // Recollections are appended HERE, and only when `options.task` is present.
    //
    // `options.task` is the precise discriminator: only `spawnAndDeliver` in
    // `index.ts` passes it, and only those two paths (plus the degraded re-prompt
    // they perform) are delivered from inside this method. Every other caller —
    // the DAG's `spawnAndExecute`, and the model-fallback respawn — passes no
    // options and has its prompt sent afterwards by `executeTask`, which does
    // its own recall. Gating on the flag is what keeps that to ONE store read
    // per task instead of two, and what keeps a DAG prompt from carrying the
    // same block twice.
    //
    // Composing in one place is also what closes the third delivery point. The
    // degraded `ctx.session.prompt` in `index.ts` re-sends this text and used
    // to read `opts.task` directly, bypassing `taskText` — so "injected on
    // spawn" was true of one of the two tool paths. It now reads
    // `agent.deliveredText`, which is the composed string.
    //
    // No `Task` and therefore no `files.include` on this path: `config.task` is
    // usually undefined here and the caller passed a string. `spawnAgent` is
    // given both, so retrieval falls back to paths named inside the text and
    // then to distinctive words. That is a weaker signal than a declared file
    // scope, and the difference is the honest cost of this path having no
    // `Task` object.
    const deliversTextHere = options?.task !== undefined
    const recall = deliversTextHere
      ? this.recallForTask({
          files: config.task?.files.include ?? [],
          text: options?.task || '',
        })
      : null
    const deliveredText = recall?.block
      ? `${taskText}\n\n${recall.block}`
      : taskText

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
        prompt: deliveredText,
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
      // `model` is the STRUCTURED form, and it must carry the variant. The
      // host's `SessionCreateInput.model` is `{ id, providerID, variant? }`, so
      // omitting it meant a `p/m#high` reference arrived as the id `"m#high"` —
      // a model that matches no `ModelInfo` — and the spawn SILENTLY ran on the
      // default model while `metadata.nexusModel` still recorded `m#high`. The
      // key is omitted entirely when there is no variant, so a variant-free
      // spawn passes the same object it always did.
      //
      // The `subagent`-tool branch above hands the host the STRING reference
      // instead, and the host's own `Model.Ref.parse` handles the `#` there.
      // Both branches are now driven from the single `parsedRef` above, so the
      // two paths cannot disagree about the same reference; see
      // `test/model-ref.test.ts`, which asserts that agreement.
      const created = await this.ctx.session.create({
        title,
        agent: agentType,
        model: modelName
          ? { providerID: provider, id: modelName, ...(parsedRef.variant ? { variant: parsedRef.variant } : {}) }
          : undefined,
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
      // What this method actually delivered, with any recollection block already
      // appended. A caller that re-sends the task itself MUST send this rather
      // than the caller's original string: that is how the degraded
      // `ctx.session.prompt` in `index.ts` stays on the same text the subagent
      // path would have delivered, and it is why the degraded path is covered
      // rather than documented as a gap.
      deliveredText,
      model: {
        provider,
        model: modelName || 'default',
        // The effort the spawn actually requested, from the SAME `parsedRef`
        // both spawn paths were driven from. This record is the source for
        // every downstream key — `modelSpendKey` and `modelLabelKey` both read
        // it — so a variant omitted here is one that never reaches the cost
        // ledger, the performance metrics, the execution history, or the state
        // snapshot. It is built here rather than copied from a caller because
        // this is the only place a `ModelSelection` for a spawned agent is
        // constructed.
        ...(parsedRef.variant ? { variant: parsedRef.variant } : {}),
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

    // Recorded on the tool path only, because that is the only path where
    // `spawnAgent` performs the recall. `executeTask` records its own for the
    // DAG path, so `lastRecall` always describes the most recent spawn that
    // actually injected something, and is null when the last one injected
    // nothing.
    if (recall) {
      this.lastRecall = recall.block
        ? {
            agentId,
            taskId: agentId,
            taskName: options?.task || 'direct-spawn',
            notes: recall.shown,
            characters: recall.characters,
          }
        : null
    }

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

  /**
   * Put a spawned agent into a TERMINAL status — and leave it in `this.agents`.
   *
   * WHY THIS EXISTS. `working` is written by the two spawn tools in `index.ts`
   * (and by `executeTask`), and it was read back by nobody who could clear it:
   * the only writer of a terminal status on the tool path was the tool body
   * itself, at the end of its own success branch. Every path that reached the
   * tool's OUTER `catch` — a `session.wait` that rejects rather than timing out,
   * a read that throws, a `storage.set` that fails — returned "Failed to spawn
   * agent" to the caller and left the agent sitting at `working` in
   * `getState().agents` for the rest of the process. A finished agent that
   * claims to still be working is worse than a missing one: the page's `Running`
   * filter stays lit, and `sessionViews()` maps `working` to `running`, so the
   * session row claims the session is spending too.
   *
   * WHY IT DOES NOT DELETE. The row has to survive, because the row is what
   * makes the outcome readable: an agent removed from `this.agents` takes its
   * session row with it (pass 1 of `sessionViews()` reads this map), and the
   * only reason a session outlives its agent — the orphan that
   * `SessionStateView` exists to make visible — is `terminateAgent` deleting a
   * session that is STILL RUNNING. Settling is not that case, and pretending it
   * were would put a fabricated `agentId: null` row on a session that has an
   * owner. So: terminal status, row kept, and `cleanupStaleData()` still owns
   * the removal — an hour of `lastActivity`, which this refreshes.
   *
   * First terminal outcome wins. `completed` and `failed` are two readings of
   * the same task, not two stages of it, so a late `failed` must not overwrite a
   * `completed`. `terminated` does outrank both: it is the escalation path, and
   * it is what `terminateAgent` would have written.
   */
  settleAgent(agentId: string, status: 'completed' | 'failed'): void {
    const agent = this.agents.get(agentId)
    // Unknown agent: nothing to settle. Callers pass an id they were handed, but
    // a terminated agent is legitimately gone by the time a spawn tool unwinds.
    if (!agent) return
    if (agent.status === 'terminated') return
    if (agent.status === 'completed' || agent.status === 'failed') return
    agent.status = status
    // Without this the row is evicted a full hour after it was SPAWNED, which
    // for a long run removes rows that only just finished.
    agent.lastActivity = new Date()
    this.notifyStateChange()
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

    // Only the two ends exist: nothing below ever assigns 'medium', and a third
    // value would need a producer before it earns a name.
    let riskLevel: 'low' | 'high' = 'low'
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
      (riskLevel === 'high' ? 30 : 0)
    )

    return {
      overall,
      factors: { fileCount, codeLines, dependencyDepth, domainKnowledge, riskLevel }
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
   * A `#variant` is stripped BEFORE any of the three, and this is the one place
   * in the plugin a variant is deliberately dropped: `ModelVariant` is
   * `{ id, settings?, headers?, body? }` and carries no `cost`, so `p/m#xhigh`
   * and `p/m` are billed at the same rate and differ only in token volume. Not
   * stripping it was the third silent failure this change fixes — the lookup
   * missed every key, returned `undefined`, and `CostForecaster.tiersFor` fell
   * through to `UNKNOWN_PRICING_PER_1K`, so a MEASURED token count was reported
   * at a 0.01/0.05 guess labelled `unknown-model`. A real figure had become a
   * fabricated one. Variant-free input reaches the three steps below byte for
   * byte as it did before, because `priceKeyForRef` is the identity on it.
   *
   * "Cheapest" compares the BASE tier's input rate, via `selectTier(tiers, 0)`:
   * a prompt size of 0 is below every real context threshold, so this is the
   * base row by construction rather than by indexing `tiers[0]`, which a
   * hand-edited map could have reordered.
   */
  getModelCost(model: string, provider?: string): NexusModelCost | undefined {
    const key = priceKeyForRef(model)
    const exact = this.modelCosts.get(key)
    if (exact) return exact

    if (provider) {
      const qualified = this.modelCosts.get(`${provider}/${key}`)
      if (qualified) return qualified
    }

    const bare = bareModelId(key)
    let best: NexusModelCost | undefined
    for (const [costKey, cost] of this.modelCosts) {
      if (bareModelId(costKey) !== bare) continue
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
    // One parse, from the single ref grammar in `src/model-ref.ts`, so a
    // `#variant` is split off here instead of being swallowed into the model
    // id. The old destructuring-and-rejoin was right about the two-slash case
    // and wrong about everything else.
    //
    // A BARE id is not a reference and the host rejects it, so the historical
    // result is reproduced exactly: `provider` is the whole value and `model`
    // is empty. That is what makes `selectQualifiedModel`'s loud throw fire
    // instead of a silent wrong-model spawn, and it is preserved deliberately.
    const parsed = tryParseModelRef(modelId)
    const provider = parsed ? parsed.providerID : modelId
    const model = parsed ? parsed.id : ''
    const variant = parsed?.variant

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
      // Omitted rather than set to `undefined` when there is none, so the
      // returned object is byte-identical to what it was before a variant could
      // be carried at all.
      ...(variant ? { variant } : {}),
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
      // Same parse `scoreModel` uses, so the price estimated here is the price
      // the ranker compares against. A variant-bearing candidate resolves to the
      // underlying model's price, which is the correct one: `ModelVariant` has
      // no `cost` of its own, and effort changes token volume rather than rate.
      const parsed = tryParseModelRef(ref)
      const provider = parsed ? parsed.providerID : ref
      const model = parsed ? parsed.id : ''
      estimates.set(ref, this.forecaster.estimateCost(complexity, model, provider))
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

    return this.applyEffort({
      provider: best.score.provider,
      model: best.score.model,
      // Threaded from the winning candidate. Omitted when the candidate carried
      // no variant, so a variant-free selection is the same object as before.
      ...(best.score.variant ? { variant: best.score.variant } : {}),
      // A per-task estimate in USD, which is what the field is named and what
      // consumers read it as. Read from the same map the filter and the ranker
      // used, so the reported figure is the figure that was compared.
      estimatedCost: estimates.get(best.ref) ?? 0,
      estimatedQuality: best.score.qualityScore,
      reasoning: best.score.reasoning
    }, complexity, this.configManager.getConfig().effort)
  }

  /**
   * The ONE gate every effort decision goes through.
   *
   * Called from `selectBestModel` and nowhere else, so there is no second path
   * that could pick an effort the config did not sanction — the same
   * single-gate rule `dashboard` and `gitFlow` follow, and the reason a key
   * cannot be readable from two places with no defined precedence between them.
   *
   * ── What this deliberately does NOT do ─────────────────────────────
   *
   * It does not re-rank. The question "which model" was already answered by
   * `scoreModel`, on quality against a per-task dollar estimate, and this runs
   * on the WINNER. The tempting alternative — re-ordering candidates by price
   * times an effort-driven token multiplier — was rejected for a specific
   * reason rather than for being more work: the only token estimate in the
   * repository is `estimateTokensFor`, whose own comment records that the budget
   * filter "estimates with `fileCount = 0`, so it prices the low end of what
   * the real estimator would produce for a task with files in scope" and is
   * therefore OPTIMISTIC BY CONSTRUCTION. Using an optimistic figure to reorder
   * models would bake that optimism into which model runs; using the raw
   * difficulty as a monotone ceiling makes it irrelevant to the ordering,
   * because the ordering never depended on the estimate. The honest fix for the
   * optimism is to give the filter the task, which is a separate change.
   *
   * The cross-model claim is the one this therefore does not make. "A cheaper
   * model at `xhigh` may cost more than an expensive model at `low`" is TRUE and
   * is not answered here, because answering it needs a reasoning-token
   * multiplier nobody has measured. What is answered is the user's half of it:
   * the CEILING, which bounds the extra spend for every task regardless of
   * which model wins.
   *
   * ── The cases, and each one's answer ───────────────────────────────
   *
   *  - **Off.** `enabled: false` returns the selection untouched, with no
   *    variant, no reasoning change, and no reference to this feature. The
   *    returned object is the SAME OBJECT `selectBestModel` built, so "nothing
   *    changes" is structural rather than a promise — there is no field to
   *    differ. `test/effort-selection.test.ts` proves it differentially.
   *  - **The user already named one.** A reference carrying `#variant` is left
   *    EXACTLY as written and the automatic choice does not run. An explicit
   *    setting outranking an automatic default is the least surprising order,
   *    and a config that silently rewrites itself is a defect. When the
   *    catalogue knows the model and does NOT publish that name, the mismatch
   *    is REPORTED in `reasoning` — never corrected, never dropped, and never
   *    a throw, because losing the user's task over a suffix is worse than
   *    running a model at a level its host may reject.
   *  - **The model publishes nothing** (`variants: []`). No suffix, and
   *    `reasoning` says the model publishes no variants. A model that WAS
   *    addressed with a suffix and now publishes none is a config change, not
   *    something to paper over — the absence of a suffix on such a model is
   *    reported rather than being indistinguishable from "off".
   *  - **The catalogue never told us.** No suffix either, reported as unknown
   *    rather than as "publishes none", because the two are different facts and
   *    only one of them is a statement about the model.
   *  - **The ceiling excludes everything published.** No suffix, reported with
   *    the ceiling and the published list, because picking any of them would
   *    spend more than the ceiling allows and pretending otherwise is the one
   *    thing a cost control must not do.
   */
  private applyEffort(
    selection: ModelSelection,
    complexity: ComplexityScore,
    config: NexusEffortConfig
  ): ModelSelection {
    if (!config.enabled) return selection

    const key = `${selection.provider}/${selection.model}`
    const published = this.publishedVariants.get(priceKeyForRef(key))

    // An explicit `#variant` is the user's, and the automatic choice does not
    // run at all. Checked BEFORE anything else so no catalogue state can
    // influence it.
    if (selection.variant !== undefined) {
      const verdict = published === undefined
        ? ` (effort: kept the explicit variant you set; this model's published variants are unknown)`
        : published.includes(selection.variant)
          ? ` (effort: kept the explicit variant you set)`
          : ` (effort: kept the explicit variant you set, but ${key} does not publish "${selection.variant}" — it publishes ${published.length === 0 ? 'none' : published.map(name => `"${name}"`).join(', ')})`
      return { ...selection, reasoning: `${selection.reasoning}${verdict}` }
    }

    const note = (text: string): ModelSelection => ({ ...selection, reasoning: `${selection.reasoning} (effort: ${text})` })

    if (published === undefined) {
      return note(`not chosen — the model catalogue has no entry for ${key}, so no effort can be verified against one`)
    }
    if (published.length === 0) {
      return note(`not chosen — ${key} publishes no variants`)
    }
    if (complexity.overall < config.minDifficulty) {
      return note(`not chosen — difficulty ${complexity.overall} is below effort.minDifficulty ${config.minDifficulty}`)
    }

    // The mapping's ceiling and the user's ceiling meet at the lower of the two.
    // Intersecting them rather than applying only the user's is what makes
    // `minDifficulty` and `maxEffort` independent controls instead of one
    // overwriting the other.
    const wanted = effortForDifficulty(complexity.overall)
    const ceiling: ModelEffort = effortIndex(wanted) < effortIndex(config.maxEffort) ? wanted : config.maxEffort
    const chosen = reconcileEffort(ceiling, published)

    if (chosen === undefined) {
      return note(
        `not chosen — ${key} publishes ${published.map(name => `"${name}"`).join(', ')}, ` +
        `none of which is at or below the ${JSON.stringify(ceiling)} ceiling ` +
        `(difficulty ${complexity.overall} asks for at most ${JSON.stringify(wanted)}, effort.maxEffort is ${JSON.stringify(config.maxEffort)})`
      )
    }
    return { ...selection, variant: chosen, reasoning: `${selection.reasoning} (effort: ${chosen} — difficulty ${complexity.overall} asks for at most ${wanted}, capped by effort.maxEffort ${config.maxEffort}, and ${key} publishes ${published.map(name => `"${name}"`).join(', ')})` }
  }

  // === Cost Tracking ===

  /**
   * The `costByModel` / `costHistory` / `tokensByModel` key for a selection:
   * `providerID/modelID#variant`, or `providerID/modelID` when there is no
   * variant.
   *
   * ONE helper, because these keys were being rebuilt by hand at four separate
   * call sites and a variant threaded through three of them is exactly how it
   * ends up kept in one place and dropped in another.
   *
   * A variant-bearing reference DOES get its own `costByModel` bucket, and that
   * is deliberate. `costByModel` is a spend ledger keyed by what was actually
   * run, and two runs of `p/m` — one at `low`, one at `xhigh` — are two
   * different spending events with very different token volumes; merging them
   * would erase the only thing an effort-aware selection is trying to reveal.
   * The buckets price identically because `ModelVariant` has no `cost` of its
   * own, and that is not an inconsistency: it is the statement that effort
   * changes volume, not rate. The PRICE table stays variant-free and
   * `getModelCost` strips the variant before joining, so the join is still
   * exact.
   */
  private modelSpendKey(selection: ModelSelection): string {
    return formatModelRef({ providerID: selection.provider, id: selection.model, variant: selection.variant })
  }

  /**
   * The `model` label on a `performanceTracker` / `executionHistory` record:
   * the bare id, plus the variant when there is one (`m`, or `m#high`).
   *
   * A variant-free selection yields the bare id it always did, so every existing
   * performance and history key is unchanged.
   */
  private modelLabelKey(selection: ModelSelection): string {
    return selection.variant ? `${selection.model}#${selection.variant}` : selection.model
  }

  /**
   * The ONE place spend is mutated. `model` is expected in the same
   * "providerID/id" form `modelCosts` uses — plus a `#variant` when the agent
   * ran at a non-default effort, so `costByModel` and the price table can be
   * joined directly after `getModelCost` strips the variant. `provenance` is
   * required rather than defaulted: an accounting entry that does not say
   * whether its tokens and rate were real is a reporting bug, so the caller has
   * to state it.
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
    // After `checkBudget` and NOT instead of it: the two report different
    // things, and a run can cross its total while no single task is over — or
    // the reverse, one task many times over, with the total barely moved.
    this.checkTaskBudget(agentId, cost)
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
    // Variant-bearing, so the cost key says what actually ran. Both consumers
    // below are variant-safe: `measureCost` reaches `tiersFor`, whose
    // `bareModelId` strips the variant, and `getModelCost` strips it before
    // joining the price table — which is right, because `ModelVariant` has no
    // `cost` and effort changes token volume, not rate.
    const model = this.modelSpendKey(agent.model)
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

    // The hard limit is TERMINAL, so it is decided first and exclusively, and
    // the alert is then gated on `!this.budgetExceeded`.
    //
    // Ordering is load-bearing, and getting it wrong is a user-visible double
    // notification. When the limit trips, `remaining <= 0`, so
    // `remainingPercent` is <= 0 too — which trivially satisfies
    // `remainingPercent <= alertThreshold` for any sane threshold. So with the
    // alert tested first, one overage crossed BOTH conditions in the same
    // invocation and the user got two notifications for one event, the first
    // reading `Budget low: $-5.00 remaining (-100.0%)`.
    //
    // An `else` would not be the honest fix: "low budget" and "stopped" are
    // genuinely different conditions, and the alert is still correct on its
    // own (non-hard-limit configs rely on it, and a config that trips its limit
    // while merely low should still have warned earlier). Latching
    // `budgetExceeded` before the alert test is what makes the alert step
    // aside for the terminal event, and it also makes it self-limiting: the
    // alert had no repeat guard of its own, and now neither does it need one.
    if (this.budget.hardLimit && remaining <= 0 && !this.budgetExceeded) {
      this.budgetExceeded = true
      this.emit('budget:exceeded', { totalSpent: this.totalSpent })
      // The hard limit tripping pauses the whole run. It was the single most
      // notification-worthy event in the product and it emitted an event no
      // notifier listened to, so the run just quietly stopped. `sound: true`
      // because this one is worth interrupting for.
      this.sendNotification({
        title: 'Nexus: Budget Limit Reached',
        body: `Hard limit hit at $${this.totalSpent.toFixed(2)}. Execution paused.`,
        sound: true
      })
      this.pause()
      return
    }

    // `this.budget.alertThreshold` and NOT `this.config.budget.alertThreshold`.
    // The two are the same object until an `ExecutionRequest.budget` replaces
    // one, and at that moment `this.config.budget` still holds the CONFIGURED
    // thresholds while `remaining` above was computed from the request's
    // ceiling — so the old read compared a number derived from one budget
    // against a threshold belonging to another, and could report "Budget low"
    // against a threshold the run is no longer being held to. One budget, one
    // answer, and it is the one in force.
    if (!this.budgetExceeded && remainingPercent <= this.budget.alertThreshold) {
      this.emit('budget:alert', { remaining, remainingPercent })
      // Notify on budget alert
      this.sendNotification({ title: 'Nexus: Budget Alert', body: `Budget low: $${remaining.toFixed(2)} remaining (${(remainingPercent * 100).toFixed(1)}%)`, sound: true })
    }
  }

  /**
   * The per-TASK half of `checkBudget`: attribute this charge to a task, and
   * notify the first time a task's running total crosses `maxCostPerTask`.
   *
   * CALLED FROM `trackCost` alongside `checkBudget`, and kept separate from it
   * rather than inlined, because the two answer different questions. The total
   * asks "is the run out of money"; this asks "which task spent it", and a
   * single run can be nowhere near its total cap while one task has run up
   * three times what the user budgeted for it. That is the case the total
   * cannot see and the case a user most wants named.
   *
   * ADVISORY, and it stops nothing. The cost of a turn is only known once the
   * turn returns or times out, so there is no point at which this could
   * interrupt work in progress — a ceiling that reports is not a cap, and
   * calling it one is how this knob was a lie in the first place. It is the
   * same relationship `maxTotalCost` has to `hardLimit: false`, which is also
   * only a report. Nothing is dropped, no task is cancelled, no retry is
   * suppressed: the notification and the work both happen.
   *
   * Latched per task, so a task that keeps spending raises one notification
   * rather than one per charge, and a run with five expensive tasks names five.
   *
   * A charge that attributes to no task is not counted against any ceiling and
   * raises nothing — see the note on `taskIdForAgent` at the call site.
   */
  private checkTaskBudget(agentId: string, cost: number): void {
    const limit = this.budget.maxCostPerTask
    // A zero or negative ceiling would fire on the first cent of any task. It
    // is not a documented way to disable a single task's spending — the run's
    // `maxTotalCost` is — so it is treated as "no per-task ceiling" rather than
    // as an instruction to notify about every task.
    if (!Number.isFinite(limit) || limit <= 0) return

    const taskId = this.taskIdForAgent(agentId)
    if (taskId === null) return

    const taskCost = (this.costByTask.get(taskId) ?? 0) + cost
    this.costByTask.set(taskId, taskCost)
    if (taskCost <= limit || this.tasksOverBudget.has(taskId)) return

    this.tasksOverBudget.add(taskId)
    // A notification and NOTHING ELSE, deliberately.
    //
    // The obvious thing here is to emit a `budget:task-exceeded` event beside
    // it, and it is the wrong thing. `test/broadcast-event-coverage.test.ts`
    // greps this file and requires every literal emit site to be named in
    // `BROADCAST_EVENTS`, so an event with no entry in `src/broadcast.ts`
    // reaches no WebSocket client and no dashboard — which is the same disease
    // that test was written to end (nine events, including every `cost:delta`,
    // silently forwarded to nobody). Emitting one anyway would have been the
    // original sin in miniature. `src/broadcast.ts` is also outside the change
    // this was made in, so wiring it properly was not available here; shipping
    // a half-wired event instead of a working notification would have been the
    // worse of the two.
    //
    // So this is reported to the one channel that IS wired: the same
    // `sendNotification` the hard limit uses, through the same
    // `notifications.enabled` gate. It reaches the user; it does not pretend to
    // be an event with subscribers.
    //
    // `sound: false`, and deliberately: unlike the run's hard limit this is not
    // terminal and not rare, so interrupting for every one of them is how a
    // notification gets muted and then missed when it matters. The body also
    // says "Not stopped" in as many words, because the ceiling is advisory and a
    // user who reads "over its per-task budget" is owed the reason nothing
    // halted.
    this.sendNotification({
      title: 'Nexus: Task Over Budget',
      body: `Task ${taskId} spent $${taskCost.toFixed(2)}, over its $${limit.toFixed(2)} per-task budget. Not stopped — reported only.`,
      sound: false
    })
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

  /**
   * The one seam between a task and the memory store.
   *
   * The alias on the import (`runRecall`) is deliberate: the pure function in
   * `src/memory-recall.ts` and this method do the same thing at different
   * layers, and giving them the same name would make `recallForTask(...)` in
   * the body below ambiguous to read — this class's own method is spelled
   * `this.recallForTask`.
   *
   * Every automatic read goes through here, so there is one place that decides
   * what a task is allowed to be reminded of. `src/memory-recall.ts` holds the
   * policy; this holds the wiring and nothing else, which is the same split
   * `src/git-flow.ts` establishes for the git convention.
   *
   * Cost: one synchronous SQLite read per task, on the spawn path and not on
   * the token-read path. The real cost is tokens — the block is prepended to
   * the prompt and `readSessionTokens` counts it in `input`, so the BILL is
   * accurate, but nothing else says how much of a task's input was
   * recollection. `lastRecall` reports it so a prompt-weight regression is
   * visible rather than inferred from a cost line.
   *
   * A FAILED READ DEGRADES TO SILENCE, and is reported. The store is closed by
   * `shutdown()`, and a spawn that races teardown would otherwise throw out of
   * prompt construction and take the task with it — which is exactly what
   * `test/task-cost.test.ts`'s "a task that times out after teardown" asserts
   * must not happen. Recollection is an enhancement; no enhancement is worth an
   * aborted task. The `console.warn` is what keeps the degradation from being
   * invisible: to the agent a failed read and a miss look the same, and only
   * one of them is a problem.
   */
  recallForTask(request: RecallRequest): RecallOutcome {
    // The `memory.enabled` gate, read through the config manager rather than
    // from a second stored copy — so a TUI toggle, a file edit, or a reload
    // takes effect on the very next task, with no re-seeding to forget.
    //
    // HERE and not at the two call sites (`executeTask` ~:2512 and
    // `spawnAgent` ~:3742) because this method already owns the rule "an
    // enhancement never takes down a task" — the try/catch below is the
    // existing expression of it. One guard at the one choke point beats two
    // guards at the call sites, which can drift: a third injection point added
    // later would silently miss both, and a spy on either call site would go on
    // reporting recalls that were never injected.
    //
    // Returns exactly what the catch below returns, so "off" and "the read
    // failed" are the same observable outcome to a caller — which is correct,
    // because to a task they are: nothing was injected.
    if (!this.configManager.getConfig().memory.enabled) {
      return { block: null, matched: 0, shown: 0, characters: 0 }
    }
    try {
      return runRecall(this.memoryStore, request)
    } catch (err) {
      console.warn(
        `[nexus] memory: could not read the memory store (${err instanceof Error ? err.message : String(err)}). `
        + 'No recollections were injected for this task. The store is most likely closed by shutdown().'
      )
      return { block: null, matched: 0, shown: 0, characters: 0 }
    }
  }

  /**
   * What the most recent spawn injected, or `null` if it injected nothing.
   *
   * Null is the common case and is not a failure: the store is empty by default,
   * so until a human writes the first note every task recalls nothing. That is
   * the intended cold start, and a reader who sees `null` here is seeing the
   * feature working, not broken.
   */
  getLastRecall(): LastRecall | null {
    return this.lastRecall
  }

  /**
   * Append one entry and announce it.
   *
   * `confidence` is `null`, and was `1.0`. A hardcoded 1.0 is a claim nobody
   * made: the orchestrator did not know how sure it was about a blob it
   * assembled from a failure, and recording 1.0 in a column the retrieval path
   * renders made an absent confidence indistinguishable from a considered one.
   * `null` renders as "not stated" and means exactly that. See
   * `MemoryEntry.confidence`.
   *
   * THE ONE AUTOMATIC WRITE IN THE WHOLE FEATURE, and it is not one: this is the
   * escalation context transfer, it writes `scope: 'session'`, and `session` is
   * excluded from automatic injection on two independent grounds. The governing
   * principle is that nothing is written without someone asking, and the one
   * exception is a transfer between two attempts at the SAME task — written and
   * consumed within one escalation, for the same agent, and never surfaced to a
   * task that did not cause it.
   */
  setMemory(scope: MemoryScope, key: string, value: unknown, author: string): void {
    const entry = this.memoryStore.set({
      key,
      value,
      scope,
      author,
      confidence: null,
      tags: []
    })
    this.notifyMemoryWritten(entry)
  }

  /**
   * Announce a write that went through the store directly.
   *
   * The single place a write is announced, so the `memory:set` broadcast and
   * the eviction report cannot diverge between the two writers. `setMemory` and
   * the `memory.set` TOOL both come through here, and a third writer added
   * later has one function to call rather than two things to remember.
   *
   * Public because the tool holds the store, not this class's private handle on
   * it — the tool writes through `orchestrator.memoryStore` and announces
   * through here.
   */
  notifyMemoryWritten(entry: MemoryEntry): void {
    this.emit('memory:set', entry)
    this.announceEviction()
  }

  /**
   * Report an eviction, loudly, at the moment it happens.
   *
   * Eviction is never silent: a note that vanished with no output is a note the
   * user assumes was never written, and then never writes again. Three
   * surfaces carry it — a `console.warn` in the terminal, the running total in
   * `getMemoryEvictionTotals()`, and the `memory.set` TOOL RESULT, which is the
   * one that reaches the person who caused the loss, at the moment they caused
   * it.
   *
   * WHY THIS IS NOT AN ORCHESTRATOR EVENT, which the design asked for and which
   * this deliberately does not do.
   *
   * `test/broadcast-event-coverage.test.ts` asserts BOTH directions against the
   * SOURCE TEXT of this file: every event name handed to the emitter must appear
   * in `BROADCAST_EVENTS`, and every name in `BROADCAST_EVENTS` must be emitted
   * here. So a new event name cannot be added here alone — it also needs a line
   * in `src/broadcast.ts`, and then `test/dashboard-page-contract.test.ts`
   * requires `dashboard/index.html` to carry a matching `case` label for it. The
   * dashboard page is outside this change's file scope, so the event is not
   * added rather than added half-way, where it would fail a test or reach a
   * client the page could not render.
   *
   * (That test parses the source rather than the AST, so it also reads event
   * names out of COMMENTS. This paragraph therefore names the event as
   * `memory:evicted` in backticks and never as a call — a doc comment that
   * quotes the emitter is indistinguishable from a call site to it.)
   *
   * The follow-up, when the dashboard page is next edited, is exactly three
   * things: the name added to `BROADCAST_EVENTS` in `src/broadcast.ts`, a
   * `case` for it in the page's message switch, and its three fields added to
   * the payload contract in `test/dashboard-page-execution.test.ts`. The
   * `console.warn` below and the `memory.set` tool result are what stand in
   * until then, and neither loses information — the event would have carried
   * the same three fields.
   */
  private announceEviction(): void {
    const eviction = this.memoryStore.takeEviction()
    if (!eviction) return
    const when = eviction.oldestEvictedAt ? eviction.oldestEvictedAt.toISOString() : 'unknown'
    console.warn(
      `[nexus] memory: evicted ${eviction.count} entrie(s) from scope "${eviction.scope}" to stay within ` +
      `maxEntries (oldest removed was written ${when}). ${COUNT_EXEMPT_SCOPES_LABEL} is never evicted by count.`
    )
  }

  /**
   * Cumulative per-scope evictions this process has performed.
   *
   * Process-scoped, not durable: it resets on restart and therefore
   * UNDER-reports across restarts. `memory.list` says so when it prints this.
   */
  getMemoryEvictionTotals(): Record<string, number> {
    return this.memoryStore.getEvictionTotals()
  }

  getMemory(scope: MemoryScope, key: string): MemoryEntry | undefined {
    return this.memoryStore.get(key, scope) ?? undefined
  }

  /**
   * Every version stored under a key, oldest first, and how many of them there
   * are.
   *
   * `set` appends rather than upserting, so a corrected note leaves the old one
   * readable and "how many versions of this key exist" is a real question a
   * user needs answered. The count is returned alongside rather than left for a
   * caller to infer from a list length, because the number is the part a user
   * reads and the list is the part they skim.
   */
  versionsOfMemory(scope: MemoryScope, key: string): { entries: MemoryEntry[]; count: number } {
    const entries = this.memoryStore.getByKey(key, scope)
    return { entries, count: entries.length }
  }

  /**
   * Search notes, with the scope the caller is allowed to see.
   *
   * THE ALLOWLIST IS A PARAMETER, NOT A CONSTANT INSIDE THIS METHOD, and the
   * reason is D1: the underlying `search` matches over VALUES as well as keys,
   * and a `session` entry is `collectContext(agent)` — an escalation blob that
   * nests the failing agent's own memory entries inside itself. The moment a
   * search tool exists, a user asking what nexus remembers about retries gets
   * back another agent's failure log rendered as though it were a note about
   * their project.
   *
   * So the tool passes `['project']` by default and `['project', 'session']` when
   * a user explicitly asks to include internal escalation context, and labels
   * those hits as internal when it does. `learning` is never offered: it is an
   * unused string in this table that shares a name with a different, unpersisted
   * mechanism (`src/learning.ts`).
   */
  searchMemory(query: string, scopes: readonly MemoryScope[]): MemoryEntry[] {
    // De-duplicated because a key can appear in two eligible scopes, and a
    // result list that shows the same note twice reads as two notes.
    const seen = new Set<string>()
    const out: MemoryEntry[] = []
    for (const scope of scopes) {
      for (const entry of this.memoryStore.search(query, scope)) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        out.push(entry)
      }
    }
    return out.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * The newest version of every key in a scope, newest first.
   *
   * `getByScope` returns every VERSION, and with an appending store a key
   * corrected three times appears three times. A listing that shows three rows
   * for one note is worse than one that shows the note and says how many
   * versions it has, so this collapses to the newest and reports the rest.
   */
  listMemory(scope: MemoryScope, limit: number): { entries: MemoryEntry[]; versionsSuperseded: number } {
    const all = this.memoryStore.getByScope(scope)
    const newest = new Map<string, MemoryEntry>()
    for (const entry of all) {
      const held = newest.get(entry.key)
      // Compared by id, not by timestamp and not by arrival order. Both of those
      // were wrong here and one of them was wrong intermittently: two writes in
      // the same millisecond share a timestamp, and `getByScope` returns
      // newest-first, so a plain assignment kept the OLDEST version — a user who
      // corrected a note was shown the text they had replaced, on about half the
      // runs. `isNewerThan` has no ties.
      if (!held || isNewerThan(entry, held)) {
        newest.set(entry.key, entry)
      }
    }
    const collapsed = [...newest.values()]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit)
    return { entries: collapsed, versionsSuperseded: all.length - collapsed.length }
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
    // "I never see notifications" has to be answerable from here. `sent`,
    // `failed` and `lastError` are what turn that from a hunch into a
    // diagnosis: `failed > 0` with a reason, or `suppressed > 0` with
    // `enabled: false`, are the two cases that used to look identical.
    const notifications = this.notifications?.getStats() ?? null
    if (detailed) return JSON.stringify({ ...state, ...spend, budgetExceeded: this.budgetExceeded, config, notifications }, null, 2)
    return JSON.stringify({
      running: state.running,
      paused: state.paused,
      budgetExceeded: this.budgetExceeded,
      agents: state.agents.length,
      tasks: state.tasks.length,
      totalCost: state.totalSpent,
      ...spend,
      budgetRemaining: state.budgetRemaining,
      notifications,
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
      uncollected: this.uncollectedSummary(),
      // Provider id → display name, for rendering only. See the provenance note.
      providers: this.getProviderList()
    }, null, 2)
  }

  /**
   * The provider label catalogue, as `{ id, name? }` entries.
   *
   * PUBLIC, AND IT IS THE ONLY PROVIDER-NAME SOURCE ON THE SERVER. The
   * `model.costs` tool used to run its own `ctx.provider.list()` on every call,
   * which meant the dashboard was reading this boot-time snapshot while the tool
   * was reading a live one: rename a provider mid-session and the two surfaces
   * printed different headings for the same models. Both now read THIS, so they
   * agree by construction rather than by hoping. See `loadProviderNames` for why
   * the snapshot is not refreshed.
   *
   * `name` is emitted only when we have a usable one, so an entry is `{ id }`
   * rather than `{ id, name: "" }` or `{ id, name: 42 }` for a provider the host
   * named not at all or named wrongly. That makes the omitted-name case
   * structurally the same thing the shared `providerLabels` helper and the
   * dashboard page both already handle: fall back to the raw id. A consumer
   * therefore needs no notion of "empty name" and no local sanitising pass, and
   * the raw-id fallback stays the SINGLE path for a provider we could not name.
   *
   * NOT SPEND, AND NOT IN ANY TOTAL. This is a label lookup, so it is excluded
   * from `totalSpent`, from `measuredSpend`/`estimatedSpend`, from every entry
   * of `byModel`, `byAgent` and `tokensByModel`, and from the `provenance` /
   * `measuredEntries` / `estimatedEntries` block that documents where pricing
   * came from (README "Pricing provenance"). None of those are computed from
   * `providerNames`, and `CostProvenance` is untouched: a provider list cannot
   * change which rate a model was billed at, only what a reader calls the group
   * those bills are printed under. `test/model-costs-report.test.ts` asserts
   * that directly by diffing the whole report with and without a provider list.
   */
  getProviderList(): Array<{ id: string; name?: string }> {
    return [...this.providerNames].map(([id, name]) =>
      typeof name === 'string' && name.length > 0 ? { id, name } : { id },
    )
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

  /**
   * Handle a `/nexus …` command. Runs in the SERVER process — the one that owns
   * this orchestrator — which is the only reason `/nexus dashboard` can start
   * anything at all: see the note in `src/tui.tsx` on why the TUI cannot.
   *
   * `dashboard` is a family, and the bare form is the useful one:
   *
   * - `/nexus dashboard [port] [host]` — start the server, or report what
   *   happened. Reached from the TUI's `/nexus-dashboard`, which submits this
   *   text and then opens the browser only once it has confirmed the listen.
   * - `/nexus dashboard stop` — stop it, honestly, if there was one.
   * - `/nexus dashboard state` — the state dump this command used to be. It
   *   was a JSON dump of `getState()` under a name that read like a server, and
   *   it is kept under an explicit name rather than dropped: it is still the
   *   only way to get orchestrator state as JSON from a prompt.
   */
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
        return this.handleDashboardCommand(parts.slice(2).join(' '))
      default:
        return 'Unknown command. Available: status, agents, costs, pause, resume, dashboard [port] [host], dashboard stop, dashboard state'
    }
  }

  /**
   * The `dashboard` branch of `handleCommand()`.
   *
   * Split out because a `switch` case that parses arguments, can start a
   * server, can stop one and can serialise the orchestrator is four commands
   * wearing one name — and the reason this is a method rather than three lines
   * inline is that it is a public-ish surface: `docs/COMPATIBILITY.md` names
   * the subcommands, and a test pins each of them.
   */
  private handleDashboardCommand(argument: string): string {
    const sub = argument.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase()

    if (sub === "state") {
      return JSON.stringify(this.getState(), null, 2)
    }

    if (sub === "stop") {
      const wasRunning = this.dashboard?.isRunning() ?? false
      this.stopDashboard()
      return wasRunning
        ? "Dashboard stopped. The orchestrator, its agents and its sessions were not affected."
        : "No dashboard was running, so nothing was stopped. The orchestrator, its agents and its "
          + "sessions were not affected."
    }

    const fallback = this.configManager.getConfig().dashboard
    const parsed = parseDashboardTarget(argument, { port: fallback.port, host: fallback.host })
    if ("error" in parsed) {
      return `Dashboard NOT started: ${parsed.error}\nNo server was started and no browser was opened.`
    }
    return describeDashboardStart(
      startDashboardServer(this, parsed.target.port, parsed.target.host),
    )
  }
}
