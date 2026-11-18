/**
 * Constants and small helpers the orchestrator class uses. Moved out of
 * `src/orchestrator.ts` unchanged; that module re-exports every exported name.
 */
import type { Task, AgentStatus, NexusConfig } from "./types"
import { selectTier } from "./forecast"
import type { NexusModelCost, SessionStateView, EscalationPolicy } from "./orchestrator-types"

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
export const DELTA_READ_BACKOFF_MS: readonly number[] = [1000, 2000, 4000]


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
export const MAX_UNCOLLECTED_SESSIONS = 200


/**
 * Named in the memory-eviction warning so the message says which scope is the
 * exempt one rather than leaving the reader to go and look.
 *
 * The exemption itself lives in `COUNT_EXEMPT_SCOPES` in `src/memory-store.ts`,
 * beside the eviction it governs. This is only the label.
 */
export const COUNT_EXEMPT_SCOPES_LABEL = 'project'


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
export const GIT_FLOW_DEFAULTS: Required<NonNullable<NexusConfig['gitFlow']>> = {
  enabled: true,
  conventionalCommits: true,
  requireBranch: true,
  prBeforeMerge: true,
}


/** Sum a numeric field across the per-model provenance records. */
export function sumBy<T>(records: Map<string, T>, select: (record: T) => number): number {
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
export function baseInputRate(cost: NexusModelCost): number {
  return selectTier(cost.tiers, 0).rates.input
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
export function sessionStateOfAgent(status: AgentStatus): SessionStateView['state'] {
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


export const DEFAULT_ESCALATION: EscalationPolicy = {
  maxRetries: 3,
  retryDelay: 1000,
  enableRespawn: true,
  fallbackModels: ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4-5'],
  alertOnFailure: true
}
