import { describe, it, expect, beforeAll } from 'bun:test'
import { BROADCAST_EVENTS } from '../src/broadcast'
import {
  blankNonCode,
  emitPayloads,
  executableSource,
  extractInlineScript,
  interfaceFieldNames,
  inlineFieldNames,
  logEntryCap,
  readDashboardHtml,
  readSourceFile,
  topLevelDeclaredNames,
} from './helpers/dashboard-page'
import {
  loadDashboardPage,
  PARSE_FAILURE,
  RENDER_FAILURE,
  type LoadedPage,
} from './helpers/dashboard-dom'

/**
 * The page, executed.
 *
 * The companion to `dashboard-page-contract.test.ts`, and the half that was
 * missing. That file is 37 assertions about what the page's source SAYS. This
 * one runs the page and asserts that it KEEPS RUNNING, which is a different
 * property and the one that actually decides whether a user sees a dashboard.
 *
 * WHAT IT COST TO LEAVE IT OUT
 *
 * `renderState` read `liveAgents.length` one line above `var liveAgents`. Every
 * static assertion still passed — the text was present, the `case` labels were
 * all thirteen, the budget keys were correctly spelled — and in a browser the
 * page threw
 *
 *     TypeError: undefined is not an object (evaluating 'liveAgents.length')
 *
 * on every state push and every five-second refresh, which meant the sessions
 * section, the cost breakdown, the DAG and the config panel never rendered at
 * all. It was reported to the user as "Non-JSON frame from server", because
 * `ws.onmessage` wrapped the parse and the render in one `try`, so a `TypeError`
 * from the page's own code was logged as a fact about the server. The message
 * was not merely unhelpful, it was false, and it sent the investigation in the
 * wrong direction. Three things are load-bearing here:
 *
 *   1. The assertion is on the page's OWN error report, not on an exception
 *      crossing the harness. `ws.onmessage` catches render failures by design,
 *      so "nothing threw at me" would pass on a page that failed to render
 *      every single frame. This test therefore reads the log a user reads, and
 *      fails on the two markers the page uses for "I could not draw this".
 *   2. Every frame is driven off the EXPORTED `BROADCAST_EVENTS`, not a
 *      hand-copied array. A hand copy is the thing that rots — that is how eight
 *      dead `case` labels got into the page in the first place — and an event
 *      added to the broadcaster would otherwise reach no test at all.
 *   3. The states are HOSTILE, and every assertion that could pass on an empty
 *      render is paired with one that cannot. A run in which all thirteen
 *      renderers quietly bailed would satisfy "did not throw"; it would not
 *      satisfy a single one of the content assertions below.
 */

/** `getState()`'s shape, with every field present and every value awkward. */
const HOSTILE_STATE = {
  running: true,
  paused: false,
  lastUpdated: '2026-01-01T12:00:00.000Z',
  agents: [
    {
      id: 'agent-1',
      name: 'Alpha',
      role: 'coder',
      status: 'working',
      model: 'anthropic/claude-sonnet-4-6',
      sessionID: 'ses_1',
      spawnedAt: '2026-01-01T11:00:00.000Z',
      tasksCompleted: 2,
      tasksFailed: 1,
      totalTokens: 12_345,
      averageResponseTime: 940,
      errorRate: 0.125,
      totalCost: 1.25,
    },
    // A `null` in the middle of `agents`. The page filters to `liveAgents`
    // precisely so this is survivable — and the headline count must be the
    // FILTERED length, which is the arithmetic the sub-line has to agree with.
    null,
    // An agent the server has barely described: no name, no session, no
    // spawn time. Every one of those renders through a formatter that has to
    // say "unreported" rather than invent a value. `tasksFailed: 7` is not
    // awkward in itself — it is here so the per-field probes further down have a
    // value in this fixture that appears nowhere else, since `1` would be
    // satisfied by half the page.
    {
      id: 'agent-2',
      role: 'reviewer',
      status: 'idle',
      model: 'openai/gpt-5-mini',
      tasksFailed: 7,
      totalTokens: 0,
      averageResponseTime: null,
      errorRate: null,
      totalCost: 0,
    },
  ],
  tasks: [
    {
      id: 'task-1',
      name: 'Root',
      role: 'architect',
      priority: 'high',
      status: 'completed',
      dependencies: [],
      assignedAgent: 'agent-1',
    },
    {
      id: 'task-2',
      name: 'Child',
      status: 'running',
      // One real edge and one that points at nothing. The dangling reference is
      // the case that must be COUNTED and said out loud rather than dropped.
      dependencies: ['task-1', 'task-does-not-exist'],
      assignedAgent: null,
    },
    // A task that lists ITSELF. It is in the snapshot, so it is neither
    // dangling nor part of a cycle, and it will stall rather than fail.
    { id: 'task-3', name: 'SelfDep', status: 'queued', dependencies: ['task-3'] },
    { id: 'task-4', name: 'CycleA', status: 'failed', dependencies: ['task-5'] },
    { id: 'task-5', name: 'CycleB', status: 'queued', dependencies: ['task-4'] },
    // A task with no id at all. An edge has nothing to address, so it cannot be
    // a node — but dropping it silently would read as "no dependencies".
    { name: 'NoId', status: 'running', dependencies: [] },
    null,
    {
      id: 'task-6',
      name: 'LongOutput',
      status: 'failed',
      dependencies: [],
      assignedAgent: 'agent-2',
      cost: 0.4,
      tokensUsed: 8000,
      result: {
        success: false,
        // Past `SERVER_OUTPUT_TRUNCATION`, so the truncation caption has to
        // appear — otherwise a clipped output reads as a whole one.
        output: 'x'.repeat(600),
        error: 'boom <script>alert(1)</script>',
        duration: 1234,
      },
    },
  ],
  sessions: [
    {
      id: 'ses_1',
      owned: true,
      agentId: 'agent-1',
      taskId: 'task-1',
      role: 'coder',
      model: 'anthropic/claude-sonnet-4-6',
      state: 'running',
      // Not the same instant as the agent's own `spawnedAt`, deliberately: the
      // per-field probes assert on the RAW timestamp each one puts in a `title`,
      // and two identical ISO strings could not tell the two reads apart.
      spawnedAt: '2026-01-01T09:30:00.000Z',
      lastKnownTokens: 12_345,
      observedUncollected: 0,
    },
    // Orphan AND running: the exact combination the section-level banner
    // exists for. Still generating, with no agent to bill it.
    { id: 'ses_2', owned: false, agentId: null, state: 'running', lastKnownTokens: 0 },
    // Abandoned, with money that was never collected.
    {
      id: 'ses_3',
      owned: false,
      agentId: null,
      state: 'abandoned',
      lastKnownTokens: 4_000,
      observedUncollected: 0.42,
    },
    null,
  ],
  config: {
    models: {
      architect: 'anthropic/claude-sonnet-4-6',
      coder: 'anthropic/claude-sonnet-4-6',
      reviewer: 'openai/gpt-5-mini',
    },
    // The per-task ceiling is an awkward value rather than a tidy one for the
    // same reason as `tasksFailed: 7` — the per-field probes need it to be a
    // string no other field in this fixture renders. `$1.00` would have been a
    // substring of `maxTotalCost`'s `$10.00`.
    budget: {
      maxTotalCost: 10,
      maxCostPerTask: 3.25,
      alertThreshold: 0.2,
      hardLimit: false,
    },
    selfHealing: {
      enabled: true,
      maxRetries: 4,
      retryDelay: 1234,
      contextTransfer: false,
    },
  },
  totalSpent: 4.5,
  budgetRemaining: 5.5,
}

/** Every block but `selfHealing`, and `models` empty. Partial config is normal. */
const PARTIAL_CONFIG_STATE = {
  ...HOSTILE_STATE,
  agents: [],
  tasks: [],
  sessions: [],
  totalSpent: 0,
  budgetRemaining: 10,
  config: {
    models: {},
    budget: { maxTotalCost: 10 },
  },
}

/** No config at all, no agents, no tasks: the "the server told us nothing" state. */
const EMPTY_STATE = {
  running: false,
  paused: false,
  agents: [],
  tasks: [],
  sessions: [],
  totalSpent: null,
  budgetRemaining: null,
}

/**
 * A hostile payload for every event, keyed by the name the server emits.
 *
 * Every payload is missing something the page's formatter would like to have, so
 * each handler has to narrow rather than assume: a `cost:delta` with no
 * `sessionID`, a `security:issues-found` with a non-object issue and no
 * `totalIssues`, a `config:reloaded` with no `project` block.
 */
const HOSTILE_PAYLOADS: Record<string, unknown> = {
  'agent:spawned': { id: 'agent-9', name: 'Omega', role: 'tester', status: 'working' },
  'agent:terminated': { id: 'agent-9' },
  'agent:escalation': { agentId: 'agent-9' },
  'task:failed': { taskId: 'task-6' },
  'cost:delta': {
    taskId: 'task-2',
    agentId: 'agent-1',
    sessionID: 'ses_1',
    deltaCost: 0.25,
    sessionTotalCost: 1.5,
    reason: 'abandoned',
    uncollected: { lastKnownTokens: 4_000, observedUncollected: 0.42 },
  },
  'security:issues-found': {
    taskId: 'task-6',
    // No `totalIssues` at all, and a non-object entry inside `issues`.
    issues: [null, { message: 'innerHTML sink', severity: 'high', file: 'a.ts', line: 12 }],
  },
  'memory:set': { key: 'prefers-concise' },
  'budget:alert': { remaining: 0.5, remainingPercent: 0.05 },
  'budget:exceeded': {},
  'config:reloaded': { loadCount: 3, loadedAt: '2026-01-01T12:00:00.000Z' },
  'orchestrator:paused': {},
  'orchestrator:resumed': {},
  'orchestrator:shutdown': {},
}

/** `/api/costs`, as `getCostReport()` actually serialises it. */
const COST_ROUTES = {
  '/api/costs': {
    totalSpent: 4.5,
    budgetRemaining: 5.5,
    measuredSpend: 4.0,
    estimatedSpend: 0.5,
    measuredEntries: 12,
    estimatedEntries: 3,
    byAgent: {
      // `agent-1` is live, so its name resolves. `agent-9` was terminated and is
      // no longer in `state.agents`, which is most of the chart and the case
      // that must be labelled rather than dropped.
      'agent-1': 3.0,
      'agent-9': 1.5,
    },
    byModel: {
      'anthropic/claude-sonnet-4-6': 3.0,
      'openai/gpt-5-mini': 1.5,
    },
    tokensByModel: {
      'anthropic/claude-sonnet-4-6': 20_000,
      'openai/gpt-5-mini': 4_000,
    },
    uncollected: {
      sessions: 1,
      lastKnownTokens: 4_000,
      observedUncollected: 0.42,
      taskIds: ['task-2'],
      entries: [],
      evicted: { sessions: 2, lastKnownTokens: 9_000, observedUncollected: 0.21 },
    },
  },
  '/api/health': { uptime: 3_661 },
}

/**
 * The page's own activity-log cap, read out of its source.
 *
 * `dashboard/index.html` keeps the newest `MAX_LOG_ENTRIES` entries and evicts
 * older ones. Restating the number here would be a second copy to keep in step,
 * so it is read from the page — which also makes this line fail loudly if the
 * constant is ever renamed, rather than leaving `failuresSince`'s guard below
 * comparing against a stale cap.
 */
const MAX_LOG_ENTRIES = logEntryCap(extractInlineScript(await readDashboardHtml()))

/**
 * Failures the page logged, counting only entries added since `from`.
 *
 * The activity log is append-only — there is no "clear" the page exposes and no
 * reason to add one — so a failure assertion has to be a DELTA. Comparing the
 * whole log would make every test depend on the order the ones above it ran in,
 * and would make the first failure of the run indistinguishable from the rest.
 *
 * The newest entry is at the FRONT, not the back: `addLog` does
 * `insertBefore(entry, $logContainer.firstChild)`, because the activity log reads
 * newest-first. So the entries added since `from` are the first `added` of the
 * list, and slicing from the other end would scan the OLDEST messages and miss
 * every failure — which is precisely the kind of quietly-inverted assertion that
 * lets a bug through while reporting green.
 *
 * AND IT REFUSES TO ANSWER ONCE THE LOG IS FULL.
 *
 * That guard is the reason this function can be trusted at all, and getting it
 * wrong is invisible, so it is worth being exact about the arithmetic. The log
 * never shrinks; it grows to `MAX_LOG_ENTRIES` and then evicts the oldest on
 * every further entry. Past that point `activityMessages().length` is pinned, so
 * a mark taken at the cap and a mark taken just below it both come back as a
 * delta of zero or less however many failures were actually logged — and
 * `slice(0, 0)` is `[]`, which is indistinguishable from "the page rendered
 * everything". This is the suite's central control: it is the only thing
 * asserting that no render path throws, and at saturation it would be asserting
 * nothing while reporting green. (The narrow form `all.length < from` does not
 * catch it: the case that matters is `all.length === from`, which is also what
 * a clean frame that logs nothing legitimately looks like, so equality cannot be
 * the test. Saturation itself is the unambiguous signal, and it is the page's
 * cap, not a number this file chose.)
 *
 * Throwing rather than returning `[]` is deliberate. A test that has outgrown
 * the log needs to be told to load a fresh page, and the cheapest way to be told
 * is to be failed.
 */
function failuresSince(page: LoadedPage, from: number): string[] {
  const all = page.activityMessages()
  if (all.length >= MAX_LOG_ENTRIES) {
    throw new Error(
      `the activity log is full (${all.length}/${MAX_LOG_ENTRIES} entries, mark was ${from}) — ` +
        `entries logged since the mark have already been evicted, so failuresSince cannot tell ` +
        `failure from silence here. Load a fresh page for this assertion instead of reusing one.`,
    )
  }
  return all
    .slice(0, all.length - from)
    .filter((message) => message.includes(RENDER_FAILURE) || message.includes(PARSE_FAILURE))
}

/** How many log entries exist now — pass this to `failuresSince` before acting. */
function logMark(page: LoadedPage): number {
  return page.activityMessages().length
}

let page: LoadedPage

beforeAll(async () => {
  page = await loadDashboardPage({ routes: COST_ROUTES })
  page.open()
  await page.settle()
})

describe('the page loads and connects', () => {
  it('runs its whole script without throwing at load', async () => {
    // `loadDashboardPage` evaluates the inline script for real: the IIFE runs,
    // every `getElementById` resolves against the real markup, the filters are
    // wired, and `connect()` runs. A throw here fails the whole file, which is
    // the correct outcome — there is no partial credit for a page that loads.
    expect(page.socket).toBeDefined()
  })

  it('resolves every id it looks up, and looks up no id the markup lacks', () => {
    // `getElementById` returns null for an unknown id here exactly as a browser
    // does, so a renamed or deleted id would have crashed above. This asserts
    // the quieter version: the page never went looking for something absent.
    expect(page.document.unknownIdLookups).toEqual([])
  })

  it('wires the auto-refresh control', () => {
    // The tick itself is inert (see the harness), so what is asserted is the
    // wiring: without a `change` listener the checkbox on the card does nothing,
    // and no source-level check would notice a handler deleted from it.
    expect(page.element('auto-refresh-check').listenerCount('change')).toBe(1)
  })

  it('labels the socket Live once it opens', () => {
    expect(page.text('conn-text')).toBe('Live')
  })
})

describe('no render path throws on any frame the server can send', () => {
  it('renders a full state snapshot without reporting a failure', () => {
    // THE core assertion. `ws.onmessage` catches render failures on purpose, so
    // this cannot be written as "nothing was thrown" — it is written as "the
    // page did not log that it failed", which is the same information a user has
    // and the only version that can fail on a page that renders nothing.
    const mark = logMark(page)
    page.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
    expect({ frame: 'orchestrator:state', failures: failuresSince(page, mark) }).toEqual({
      frame: 'orchestrator:state',
      failures: [],
    })
  })

  it('renders a partial-config state, an empty state and a repeat of each', () => {
    // Repeated, because the bug it exists for fires on EVERY push: a second
    // identical frame must not be handled differently from the first. Partial
    // config and a wholly empty state are the two shapes a real orchestrator
    // reports before anything has been configured or spawned.
    for (const [name, state] of [
      ['partial-config', PARTIAL_CONFIG_STATE],
      ['empty', EMPTY_STATE],
      ['partial-config-again', PARTIAL_CONFIG_STATE],
    ] as const) {
      const mark = logMark(page)
      page.deliver({ type: 'orchestrator:state', data: state, timestamp: 'now' })
      expect({ frame: name, failures: failuresSince(page, mark) }).toEqual({
        frame: name,
        failures: [],
      })
    }
  })

  it('has a hostile payload for every event the broadcaster forwards', () => {
    // Driven off the exported list, so an event added to `BROADCAST_EVENTS`
    // without a payload here fails rather than going untested.
    expect(BROADCAST_EVENTS.filter((name) => !(name in HOSTILE_PAYLOADS))).toEqual([])
  })

  it('handles every broadcast event, plus the state push and the pong', () => {
    const mark = logMark(page)
    for (const name of BROADCAST_EVENTS) {
      page.deliver({ type: name, data: HOSTILE_PAYLOADS[name], timestamp: 'now' })
    }
    // The two socket messages that are not events, and one with no `type` at
    // all, which must reach the switch's default arm without a name to report.
    page.deliver({ type: 'pong', timestamp: 'now' })
    page.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
    page.deliver({ timestamp: 'now' })
    expect(failuresSince(page, mark)).toEqual([])
  })
})

describe('a parse failure and a render failure are told apart', () => {
  it('reports an unparseable frame as the server sending something unparseable', () => {
    page.deliverRaw('this is not json {{{')
    const messages = page.activityMessages()
    expect(messages.some((m) => m.includes(PARSE_FAILURE))).toBe(true)
    // A frame the page could not even parse cannot be blamed on the page. This
    // is the shipped bug's mirror image: one `try` around both the parse and the
    // handler meant a page-side `TypeError` was logged as a server-side fault, so
    // the parse message must NOT be reachable from a render failure and vice
    // versa. The source-level half of this — that there are two `catch` blocks
    // and not one — lives in `dashboard-page-contract.test.ts`; the mutation
    // check on that file's companion is what proves this one fires.
    expect(messages.some((m) => m.includes(RENDER_FAILURE))).toBe(false)
  })

  it('never logs a failure for a frame it handled cleanly', () => {
    // Delivered after the parse-failure test so the sequence is order-proof: a
    // clean frame after a broken one must add no failure of its own, which also
    // rules out a page that latches into an error state once something has gone
    // wrong — and which is why the count is a delta rather than a whole-log scan.
    const mark = logMark(page)
    page.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
    expect(failuresSince(page, mark)).toEqual([])
  })
})

describe('the activity log cannot silently stop being able to answer', () => {
  // The guard in `failuresSince` is the only thing standing between this suite
  // and a green run that asserts nothing, and a guard nobody exercises is a
  // guard that is not there. So it is driven to saturation for real: the page's
  // own `addLog` is what evicts, by delivering frames the page cannot parse,
  // and the cap is reached by arithmetic on the page's own behaviour rather than
  // by asserting that the arithmetic in `failuresSince` would come out a certain
  // way.

  /** Every unparseable frame adds exactly one log entry and one parse failure. */
  const overflowWith = (page: LoadedPage, frames: number): void => {
    for (let i = 0; i < frames; i++) page.deliverRaw('not json {{{')
  }

  it('refuses to read failures out of a log it has already overflowed', async () => {
    const full = await loadDashboardPage({ routes: COST_ROUTES })
    full.open()
    await full.settle()

    // The mark is taken while there is still room, which is the ordinary case
    // and the one that used to go wrong: the log fills DURING the action the
    // assertion is about.
    const mark = logMark(full)
    expect(mark).toBeLessThan(MAX_LOG_ENTRIES)

    // Deliberately past the cap, so the page evicts entries the mark cannot see.
    overflowWith(full, MAX_LOG_ENTRIES + 25)
    // Saturation reached by the page's own eviction, not assumed: the log is
    // pinned at the cap and no longer growing, which is the whole condition.
    expect({
      length: full.activityMessages().length,
      atCap: full.activityMessages().length >= MAX_LOG_ENTRIES,
      cap: MAX_LOG_ENTRIES,
    }).toEqual({ length: MAX_LOG_ENTRIES, atCap: true, cap: MAX_LOG_ENTRIES })

    expect(() => failuresSince(full, mark)).toThrow(/activity log is full/)
  })

  it('refuses on a mark taken from an already-full log', async () => {
    // The other way the same silence arrives, and the one a test hits by simply
    // running late in the file: nothing is added at all, so `all.length` equals
    // the mark and the delta is a clean-looking zero. On a full log that zero is
    // not evidence of anything.
    const full = await loadDashboardPage({ routes: COST_ROUTES })
    full.open()
    await full.settle()
    overflowWith(full, MAX_LOG_ENTRIES + 25)
    const mark = logMark(full)
    expect(full.activityMessages().length).toBe(MAX_LOG_ENTRIES)
    expect(() => failuresSince(full, mark)).toThrow(/activity log is full/)
  })

  it('still reports real failures on a page that has not saturated', async () => {
    // The control, and without it the two tests above would be satisfied by a
    // page that had stopped logging altogether. The same frames, on a page with
    // room left, are found — so what the guard is proving is that saturation
    // stops the answer, not that the failures were never there.
    const roomy = await loadDashboardPage({ routes: COST_ROUTES })
    roomy.open()
    await roomy.settle()
    const mark = logMark(roomy)
    overflowWith(roomy, 20)
    expect({ length: roomy.activityMessages().length, failures: failuresSince(roomy, mark).length }).toEqual({
      length: mark + 20,
      failures: 20,
    })
  })
})

describe('the renderers actually produced content', () => {
  // Every assertion in this block is a non-vacuity guard on the block above. A
  // page in which all thirteen render functions returned early without touching
  // the DOM would log no failures and pass "no render path throws" — and would
  // be, from a user's chair, indistinguishable from the frozen page that shipped.

  beforeAll(() => {
    // The shared page has by now seen the partial and the empty state. Put the
    // hostile one back so these assertions read one known input rather than
    // depending on the order the describes above happened to run in.
    page.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
  })

  it('counts live agents, not raw array entries', () => {
    // `agents` holds three entries, one of them `null`. The headline is the
    // FILTERED count, and the sub-line beneath it does arithmetic on the same
    // list, so a reader can add it up.
    expect(page.text('stat-agents')).toBe('2')
    expect(page.text('stat-agents-sub')).toBe('1 working · 1 not working (live agents only)')
  })

  it('counts tasks and reports the failures among them', () => {
    // `tasks` holds eight entries: six identified tasks, one with no id, and one
    // `null`. The headline is the array length; the split is over the live ones —
    // four of which are running or queued, including the self-dependent task and
    // the idless one, neither of which the page may quietly drop from the count.
    expect(page.text('stat-tasks')).toBe('8')
    expect(page.text('stat-tasks-sub')).toBe('4 running/queued · 1 done · 2 failed')
  })

  it('reports spend against the ceiling rather than inventing one', () => {
    expect(page.text('stat-spent')).toBe('$4.50')
    expect(page.text('stat-spent-sub')).toBe('of $10.00 ceiling · 45.0% consumed')
    expect(page.text('stat-remaining-sub')).toBe('55.0% of $10.00 ceiling')
  })
  it('renders the unbilled figure as a lower bound, from the cost report', async () => {
    expect(page.text('stat-unbilled')).toBe('≥ $0.42')
    // The three-way evicted distinction, on the real report the harness served.
    expect(page.text('stat-unbilled-sub')).toContain('plus 2 evicted from the itemised list')
  })

  it('renders the sessions table and makes the orphan unmissable', () => {
    expect(page.html('sessions-container')).toContain('No owning agent')
    expect(page.html('orphan-banner')).toContain('1 running session')
    expect(page.html('orphan-banner')).toContain('1 abandoned session')
    // Four entries including a `null`; the row count is the array length and the
    // table must have been built rather than skipped.
    expect(page.text('session-count')).toBe('4')
    expect(page.html('sessions-container')).toContain('ses_1')
  })

  it('renders the agent grid, skipping the null entry', () => {
    expect(page.text('agent-count')).toBe('3')
    expect(page.html('agents-container')).toContain('Alpha')
    // An agent with no name falls back rather than rendering `undefined`.
    expect(page.html('agents-container')).toContain('reviewer')
  })

  it('renders the budget panel from the real config keys', () => {
    expect(page.text('budget-total')).toBe('$10.00')
    expect(page.text('budget-alert')).toBe('20.0% remaining')
    expect(page.text('gauge-pct')).toBe('55%')
  })

  it('renders tasks with their result block and its truncation caption', () => {
    const html = page.html('task-list')
    expect(html).toContain('LongOutput')
    // The `null` task is skipped, not rendered as a blank row.
    expect(html).toContain('deps: task-1, task-does-not-exist')
    // Past the server's 500-character truncation, and labelled as such.
    expect(html).toContain('Output truncated to 500 characters by the server.')
    // The error is escaped, not interpolated as markup.
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('lays out the graph and reports every edge it could not draw', () => {
    expect(page.html('dag-container')).toContain('dag-canvas')
    expect(page.html('dag-container')).toContain('dag-node')
    const note = page.html('dag-note')
    // One of each of the four undrawable shapes, each named in the note.
    expect(note).toContain('2 tasks sit in a dependency cycle')
    expect(note).toContain('1 dependency reference points at a task id that is not in this snapshot')
    expect(note).toContain('1 task report no `id`')
    expect(note).toContain('1 task list themselves as a dependency')
    // `drawDagEdges` runs rather than bailing at its first guard, and finds no
    // laid-out boxes to attach to, which is the branch that counts the skips.
    expect(note).toContain('could not be drawn')
  })

  it('renders the cost charts from /api/costs, not from the live agents', () => {
    const byAgent = page.html('cost-by-agent')
    expect(byAgent).toContain('Alpha')
    // A terminated agent is still in the ledger even though it is gone from
    // `state.agents`; that is the whole reason the chart is not built from it.
    expect(byAgent).toContain('not a live agent')
    expect(page.html('cost-by-model')).toContain('anthropic/claude-sonnet-4-6')
    // The measured/estimated split, which `totalSpent` alone does not carry.
    const accounting = page.html('cost-accounting')
    expect(accounting).toContain('Measured')
    expect(accounting).toContain('$4.00')
    expect(accounting).toContain('of which evicted from the itemised list')
  })

  it('renders the config panel and the read-only viewer', () => {
    expect(page.html('config-models')).toContain('anthropic/claude-sonnet-4-6')
    expect(page.html('config-budget')).toContain('maxTotalCost')
    expect(page.html('config-budget')).toContain('hardLimit (stop at ceiling)')
    expect(page.html('config-healing')).toContain('retryDelay')
    // The two rows this change DELETED, asserted as absent rather than dropped.
    // An assertion that vanishes with the row it guarded is how "the per-agent
    // ceiling" and the "× 3.50" backoff multiplier survived for this long while
    // doing nothing, so both absences are pinned from here. `retryDelay` above
    // is the positive half: it is the backoff base that IS read, and it is
    // asserted in the same breath so the block cannot be emptied wholesale.
    expect(page.html('config-budget')).not.toContain('maxCostPerAgent')
    expect(page.html('config-healing')).not.toContain('backoffMultiplier')
    // The resolved config, serialised into the readonly field.
    expect(page.element('config-editor').value).toContain('"maxTotalCost": 10')
  })

  it('logs the events it handled, and liveness', () => {
    const log = page.activityLog()
    expect(log).toContain('Agent spawned')
    expect(log).toContain('Escalation')
    expect(log).toContain('ABANDONED')
    expect(log).toContain('Budget exceeded')
    // `pong` is a liveness reply, not a state change, so it is not logged.
    expect(log).not.toContain('pong')
  })
})

describe('the two client-side config controls run against the reported config', () => {
  beforeAll(() => {
    page.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
  })

  it('re-indents the reported config and says nothing was sent', () => {
    page.element('config-format-btn').dispatch('click')
    expect(page.element('config-editor').value).toBe(
      JSON.stringify(HOSTILE_STATE.config, null, 2),
    )
    expect(page.text('config-editor-status')).toContain('Re-indented')
  })

  it('shape-checks the reported config against the real key names', () => {
    page.element('config-validate-btn').dispatch('click')
    // The reported config is complete, so there is nothing to observe — which is
    // the assertion: the check fires and reaches its passing branch, rather than
    // dying on a key name the server never sends.
    expect(page.text('config-editor-status')).toContain('Shape check passed')
  })
})

describe('a partial or hostile config is described, not invented', () => {
  it('says which blocks were not reported at all', async () => {
    const partial = await loadDashboardPage({ routes: COST_ROUTES })
    partial.open()
    await partial.settle()
    const mark = logMark(partial)
    partial.deliver({ type: 'orchestrator:state', data: PARTIAL_CONFIG_STATE, timestamp: 'now' })
    expect(failuresSince(partial, mark)).toEqual([])
    // `selfHealing` is absent from this config, and `models` is empty. Both
    // render as an explicit "not reported" rather than as a plausible default.
    expect(partial.html('config-healing')).toContain('not reported')
    expect(partial.html('config-models')).toContain('empty')
    // An alert threshold that is missing must not become an invented band.
    expect(partial.text('budget-alert')).toBe('not reported')
    expect(partial.text('gauge-pct')).toBe('100%')
  })

  it('reports no cost report rather than zero bars when /api/costs fails', async () => {
    const broken = await loadDashboardPage({
      routes: { '/api/costs': 'reject', '/api/health': 'reject' },
    })
    broken.open()
    await broken.settle()
    const mark = logMark(broken)
    broken.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
    expect(failuresSince(broken, mark)).toEqual([])
    // The distinction the page is built around: unavailable is not zero.
    expect(broken.html('cost-by-agent')).toContain('No cost report yet')
    expect(broken.text('cost-status')).toContain('Cost report unavailable')
    expect(broken.text('uptime')).toBe('Server uptime unavailable')
  })

  it('renders an empty state without inventing a single value', async () => {
    const empty = await loadDashboardPage({ routes: COST_ROUTES })
    empty.open()
    await empty.settle()
    const mark = logMark(empty)
    empty.deliver({ type: 'orchestrator:state', data: EMPTY_STATE, timestamp: 'now' })
    expect(failuresSince(empty, mark)).toEqual([])
    // No config reported at all, and unspent money that was never measured.
    expect(empty.html('config-models')).toContain('state.config not reported')
    expect(empty.text('stat-spent')).toBe('—')
    expect(empty.text('stat-spent-sub')).toBe('Budget ceiling not reported')
    expect(empty.html('dag-container')).toContain('No tasks in the graph yet')
    expect(empty.html('sessions-container')).toContain('No sessions reported')
    // The overview card, which is a different element from the section above and
    // used to be the one place a populated `state.sessions` never reached.
    expect(empty.text('stat-sessions')).toBe('0')
    expect(empty.text('stat-sessions-sub')).toBe('No sessions reported')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE GAUGE IS AN SVG ELEMENT, AND ITS `className` IS NOT WRITABLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bug that killed the page, and the harness gap that let it ship.
 *
 * `renderBudget` assigned `$gaugeFill.className`. `#gauge-fill` is a `<circle>`,
 * and an SVG element's `className` is a read-only `SVGAnimatedString`, so every
 * assignment raised
 *
 *     TypeError: Cannot set property className of #<SVGElement> which has only a getter
 *
 * The budget gauge is drawn on EVERY state frame, so the page threw before it
 * finished rendering every frame and nothing below the overview card ever
 * appeared. Twenty-nine tests in this file were green while it did.
 *
 * They were green because the shim could not represent the failure. It modelled
 * `className` as a writable field on every element and minted every id-bearing
 * element as a `<div>`, so `#gauge-fill` was a div in the test and a circle in
 * the browser. That is the lesson worth keeping: which sites of a pattern are
 * broken is a property of an element's NAMESPACE, and no amount of reading the
 * page's JavaScript — and no amount of grepping it — can tell you. Only
 * executing the page against a DOM that knows the difference can.
 *
 * So this block asserts two separate things, and they are load-bearing for
 * DIFFERENT reasons — which was measured, not assumed. Reintroducing the
 * original `className =` at each of the 24 swept sites in turn, one at a time:
 *
 *   - at the two SVG sites (the gauge fill), the executed assertions below fail,
 *     loudly and with the page's own error text, because the strict shim turns
 *     the write into the `TypeError` a browser raises;
 *   - at the other 22 sites, which are all HTML elements and therefore never
 *     crashed, the executed assertions do NOT fail — those render paths are not
 *     driven by a test that reads their classes back. The source lint below is
 *     the only thing in the suite that catches a `className` write at any of
 *     them.
 *
 * That asymmetry is the reason both halves are here. The lint cannot see a
 * namespace, so on its own it would have passed the original bug untouched: it
 * is a pattern check, and the bug was in the pattern. The executed tests cannot
 * see the 22 undriven sites, so on their own they would let the pattern back in
 * at any of them. Neither is sufficient. Note also what the 22 do NOT need: they
 * never crashed and still do not, so their `className` write is a latent trap
 * rather than a live bug — which is exactly why it has to be caught by
 * something other than "does the page still work".
 */

/** A state frame whose gauge takes the measurable branch, at a chosen fraction. */
function stateWithBudget(remaining: number, ceiling = 10, alertThreshold: number | null = 0.2) {
  return {
    ...HOSTILE_STATE,
    config: {
      ...HOSTILE_STATE.config,
      budget: { maxTotalCost: ceiling, alertThreshold, hardLimit: false },
    },
    budgetRemaining: remaining,
  }
}

describe('the budget gauge is SVG, so its classes cannot be written via className', () => {
  it('renders the measured branch without reporting a failure', async () => {
    const gauged = await loadDashboardPage({ routes: COST_ROUTES })
    gauged.open()
    await gauged.settle()
    const mark = logMark(gauged)

    // 55% of a $10 ceiling remaining: above the 20% alert threshold, so the
    // `fill` branch with no severity class. This is the frame the page could
    // not draw at all before the fix.
    gauged.deliver({
      type: 'orchestrator:state',
      data: stateWithBudget(5.5),
      timestamp: 'now',
    })
    expect(failuresSince(gauged, mark)).toEqual([])

    // The gauge is not merely non-crashing, it is drawn: the circle carries
    // `fill`, the ring is not dimmed, and the percentage is on screen. Without
    // these a page that deleted `renderBudget` outright would pass the
    // no-failure assertion above, which is the whole reason this test could
    // not be "did not throw" alone.
    expect(gauged.element('gauge-fill').className).toBe('fill')
    expect(gauged.element('gauge-ring').className).toBe('gauge-ring')
    expect(gauged.text('gauge-pct')).toBe('55%')
  })

  it('renders the unmeasurable branch, where the same write happened a second time', async () => {
    // The other `$gaugeFill.className` site, in the `remainingFraction === null`
    // branch. A one-site fix would leave this one throwing, so it is driven and
    // asserted separately rather than assumed to follow.
    const gauged = await loadDashboardPage({ routes: COST_ROUTES })
    gauged.open()
    await gauged.settle()
    const mark = logMark(gauged)

    gauged.deliver({ type: 'orchestrator:state', data: EMPTY_STATE, timestamp: 'now' })
    expect(failuresSince(gauged, mark)).toEqual([])

    expect(gauged.element('gauge-fill').className).toBe('fill')
    // The ring is dimmed in this branch, which is the one class change that is
    // observable from the outside and therefore the one worth pinning.
    expect(gauged.element('gauge-ring').className).toBe('gauge-ring unmeasurable')
    expect(gauged.text('gauge-pct')).toBe('—')
  })

  it('applies the danger class on the SVG circle when the frame is at the alert threshold', async () => {
    // The branch whose class is a computed concatenation, and the only site
    // whose class value is not a literal. A sweep that mangled the expression
    // would still leave `fill` correct on the other two branches.
    const gauged = await loadDashboardPage({ routes: COST_ROUTES })
    gauged.open()
    await gauged.settle()

    gauged.deliver({
      type: 'orchestrator:state',
      data: stateWithBudget(1, 10, 0.2),
      timestamp: 'now',
    })
    expect(gauged.element('gauge-fill').className).toBe('fill danger')

    // And the same frame one notch above the threshold drops it again, so the
    // assertion above is about the comparison and not about a sticky class.
    gauged.deliver({
      type: 'orchestrator:state',
      data: stateWithBudget(5, 10, 0.2),
      timestamp: 'now',
    })
    expect(gauged.element('gauge-fill').className).toBe('fill')
  })

  it('writes no class through className anywhere in the page', async () => {
    // The half that catches the 22 HTML sites. Measured: reintroducing
    // `className =` at any one of them fails THIS test and nothing else in the
    // suite, because no test drives those render paths and reads their classes
    // back. So despite being a source grep, this is not redundant with the
    // executed tests above — it is the sole coverage for 22 of the 24 sites.
    //
    // What it is blind to is namespaces, and that is not a small gap: it is the
    // entire content of the shipped bug, which is why it is stated here as one
    // half of a pair rather than as a proof. On its own it would have passed
    // `el.className = 'fill'` on a `<circle>` without complaint.
    //
    // Deliberately scoped to WRITES. A read of `className` is a different
    // operation, is legal in both namespaces, and is excluded so this stays a
    // statement about the pattern that crashes rather than about a substring.
    //
    // Comments are stripped first, and that is not a detail: the page now
    // documents at `$gaugeFill` WHY `className` is unsafe, in prose containing
    // the very text `el.className = 'fill'`. Checked against the raw source
    // this assertion fails on the explanation of the fix rather than on a
    // regression, which is the fastest way to get a lint deleted.
    const script = executableSource(extractInlineScript(await readDashboardHtml()))
    const writes = script.match(/\.className\s*(=[^=]|\?\?=)/g) ?? []
    expect(writes).toEqual([])
  })

  it('delivers the classes the page writes to the elements it wrote them for', async () => {
    // A sweep from `className =` to `setAttribute('class', …)` has to be a
    // behaviour-preserving rename, and the only way to know that is to read the
    // values back off the elements after a real render. This covers SIX of the
    // 22 HTML sites — the four orchestrator-pill branches, the connection badge
    // and the cost banner — and it is worth being precise that it does not
    // cover all 22: the other sixteen are not driven by any test that reads
    // their classes back, which is the gap the lint above exists to close. The
    // gauge sites are covered by the three tests before this one.
    const swept = await loadDashboardPage({ routes: COST_ROUTES })
    swept.open()
    await swept.settle()
    swept.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })

    // Sites 1-4 of the sweep: the orchestrator pill, across all four branches.
    for (const [data, expected] of [
      [{ running: false, paused: false }, 'orch-pill idle'],
      [{ running: true, paused: false }, 'orch-pill running'],
      [{ running: false, paused: true }, 'orch-pill paused'],
      [{ lastUpdated: 'nonsense', running: 'yes', paused: 'no' }, 'orch-pill unknown'],
    ] as const) {
      swept.deliver({
        type: 'orchestrator:state',
        data: { ...HOSTILE_STATE, ...data },
        timestamp: 'now',
      })
      expect(swept.element('orch-status').className).toBe(expected)
    }

    // Site 9 of the sweep: the connection badge, from the socket's lifecycle. A
    // dropped socket puts the page into `reconnecting` — `disconnected` is
    // only reached once the retry budget is spent, which with inert timers never
    // happens here, so `reconnecting` is the honest assertion and `connected`
    // below is the one that would catch a badge frozen by a failed write.
    expect(swept.element('conn-badge').className).toBe('connection-badge connected')
    swept.socket.close()
    await swept.settle()
    expect(swept.element('conn-badge').className).toBe('connection-badge reconnecting')

    // Sites 14-16 of the sweep: the cost-status banner. The hostile state's
    // /api/costs route succeeds, so the banner is cleared to its hidden form.
    expect(swept.element('cost-status').className).toBe('cost-status hidden')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EVERY FIELD THE SERVER SENDS HAS A DECISION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four fields, one defect.
 *
 * `stat-sessions` was resolved by `getElementById` and never assigned by any
 * render path, so the overview Sessions card read `—` / "No sessions reported"
 * for the whole life of the card while the Sessions SECTION below it rendered
 * the same `state.sessions` perfectly. `cost:delta.settledTier`,
 * `config:reloaded.trigger` and `SessionStateView.spawnedAt` were sent, and
 * read nowhere.
 *
 * All four are the same shape, and it is a shape no assertion in the suite could
 * see. The static contract test's required-field list contains `sessions`; the
 * page DOES read `state.sessions`, in `renderSessions`; so the grep passes. A
 * grep cannot tell "reads the field somewhere" from "fills this element", and
 * every test that existed was a grep. The execution half fixed the *other* half
 * of that gap — a page that runs — and it still could not tell a card that was
 * filled from a card that was not.
 *
 * So this block attacks the gap from the other side. The list of fields the
 * page does NOT read cannot be written by the same hand as the page, or it is
 * just the page's beliefs about itself again. It is read out of the server's own
 * declarations and `this.emit` call sites instead, which is a list nobody on the
 * page side can quietly narrow. Every field that comes back needs a decision:
 * consumed, with a probe on the value reaching the screen — or not consumed, with
 * the reason. Adding a field to `SessionStateView` or to a `cost:delta` emit
 * site fails here until somebody decides, which is the control that would have
 * caught all four, and the one that keeps working for the fifth.
 */

/** Where a value has to appear for a field to count as consumed. */
type Probe =
  /** Somewhere in an element's rendered text or markup. */
  | { readonly kind: 'element'; readonly id: string; readonly contains: string }
  /**
   * In an attribute — a `title`, which is where an unambiguous raw value goes.
   *
   * The attribute is a LITERAL and not `string` because `readProbe` can only
   * read `title`: it was written as `probe.attribute === 'title' ? … : ''`, which
   * means a probe naming any other attribute read the empty string and failed.
   * That is loud, so it is not a false pass — but it is a runtime surprise in a
   * file that otherwise gets its mistakes from the type checker, and it would
   * have been a confusing one to debug. Narrowing it to the one attribute the
   * read supports makes a second attribute a compile error, and adding support
   * for one is then a deliberate edit to both the union and `readProbe`.
   */
  | { readonly kind: 'attribute'; readonly id: string; readonly attribute: 'title'; readonly contains: string }
  /** In a key/value row of a rendered panel, matched on the KEY alone. */
  | { readonly kind: 'row'; readonly id: string; readonly key: string; readonly equals: string }
  /** In the `value` of a form control, as the page assigned it. */
  | { readonly kind: 'value'; readonly id: string; readonly contains: string }
  /** In the activity log — the line a user reads and a grep cannot reach. */
  | { readonly kind: 'activity'; readonly contains: string }
  /** In the technical log stream. */
  | { readonly kind: 'stream'; readonly contains: string }

/** One field, and what the page does about it. */
type Decision = {
  /**
   * True when a value of this field can be seen on the page.
   *
   * Not "the page mentions the name somewhere" — the probe is a rendered-output
   * assertion, and the fixture's values are chosen to be unmatchable by any
   * other field's read. That is the property the contract test's
   * required-field list lacks and cannot have.
   */
  readonly consumed: boolean
  /** Why, in both branches. The reason is the deliverable for `false`. */
  readonly why: string
  readonly probe?: Probe
  /**
   * True for a shape the extractor cannot reach from the server's declarations.
   *
   * These are fields of a METHOD RETURN TYPE (`settledTierOf`) or of a value
   * nested inside a payload. The mechanical check below covers the top level,
   * which is where fields actually get added; these are listed by hand, and the
   * flag is what stops the "no decision for a field the server no longer sends"
   * assertion from firing on them. The asymmetry is deliberate and it is the
   * weaker of the two directions — see the note above `FIELD_DECISIONS`.
   */
  readonly nested?: true
}

/**
 * Events emitted as a bare identifier rather than an inline object literal.
 *
 * Their shape is the type of the identifier, which no amount of reading the call
 * site can recover, so it has to be named. It is still far smaller than listing
 * the fields: renaming a field in `Agent` is the event this test exists to
 * catch, and it fails here without touching this map. The completeness assertion
 * below also checks this map against the events the extractor actually found, so
 * a new identifier-payload event fails rather than going unexamined.
 *
 * `agent:spawned` and `agent:terminated` share one entry because the server
 * emits the same `Agent` for both — a spawn and a termination of the same
 * object — so one set of decisions genuinely covers the two payloads.
 */
const IDENTIFIER_PAYLOADS: Record<string, { file: string; interface: string; prefix: string }> = {
  'agent:spawned': { file: 'types', interface: 'Agent', prefix: 'agent' },
  'agent:terminated': { file: 'types', interface: 'Agent', prefix: 'agent' },
  'memory:set': { file: 'types', interface: 'MemoryEntry', prefix: 'event:memory:set' },
  'config:reloaded': { file: 'config', interface: 'NexusConfigLoadInfo', prefix: 'event:config:reloaded' },
}

/**
 * Sub-shapes `OrchestratorState` names rather than spells out.
 *
 * `config.budget` is a `BudgetConstraint` and `config.selfHealing` is
 * `NexusConfig['selfHealing']` — both REFERENCES, so there is no `{` to descend
 * into and the extractor cannot follow them from the declaration. Naming the
 * target interface is a much smaller thing to keep current than listing its
 * fields, and a new field in either target still fails the completeness
 * assertion. A new sub-BLOCK under `config` fails the `state.config.*`
 * completeness assertion, which is the check that has to notice it.
 */
const CONFIG_SUB_SHAPES: Record<string, { file: string; interface: string; path: readonly string[] }> = {
  'state.config.budget': { file: 'types', interface: 'BudgetConstraint', path: [] },
  'state.config.selfHealing': { file: 'types', interface: 'NexusConfig', path: ['selfHealing'] },
}

/**
 * Every field the server sends, and the page's decision about each.
 *
 * Read the `consumed: false` entries as a list of things someone looked at and
 * turned down — that is the part a reader cannot reconstruct from the page. The
 * `consumed: true` entries carry a probe, which is the part that fails.
 */
const FIELD_DECISIONS: Record<string, Decision> = {
  // ── getState(): the snapshot ──
  'state.running': {
    consumed: true,
    why: 'The lifecycle pill, and its title states both booleans verbatim.',
    probe: { kind: 'attribute', id: 'orch-status', attribute: 'title', contains: 'state.running=true' },
  },
  'state.paused': {
    consumed: true,
    why: 'Wins over `running`, because a paused orchestrator is mid-run and not executing.',
    probe: { kind: 'attribute', id: 'orch-status', attribute: 'title', contains: 'state.paused=false' },
  },
  'state.lastUpdated': {
    consumed: true,
    why: 'The snapshot-age line reads it, and its title carries the raw ISO so the value stays checkable.',
    probe: {
      kind: 'attribute',
      id: 'last-refresh',
      attribute: 'title',
      contains: 'state.lastUpdated 2026-01-01T12:00:00.000Z',
    },
  },
  'state.agents': {
    consumed: true,
    why: 'The Agents section header count, and the input to the agent grid.',
    probe: { kind: 'element', id: 'agent-count', contains: '3' },
  },
  'state.tasks': {
    consumed: true,
    why: 'The Tasks stat card headline, and the input to the task list and the graph.',
    probe: { kind: 'element', id: 'stat-tasks', contains: '8' },
  },
  'state.config': {
    consumed: true,
    why: 'The three config panels and the read-only resolved-config viewer.',
    probe: { kind: 'value', id: 'config-editor', contains: '"maxTotalCost": 10' },
  },
  'state.sessions': {
    consumed: true,
    why: 'The Sessions section, AND the overview card — the two share one census so they cannot disagree.',
    probe: { kind: 'element', id: 'session-count', contains: '4' },
  },
  'state.totalSpent': {
    consumed: true,
    why: 'The Spend card, the budget panel, and the unbilled figure it is deliberately kept apart from.',
    probe: { kind: 'element', id: 'stat-spent', contains: '$4.50' },
  },
  'state.budgetRemaining': {
    consumed: true,
    why: 'The Remaining card, the budget gauge fraction, and the "at ceiling" test.',
    probe: { kind: 'element', id: 'stat-remaining', contains: '$5.50' },
  },

  // ── getState().agents[] ──
  'state.agents[].id': {
    consumed: true,
    why: 'The key of the live-agent lookup behind the cost chart, which is what labels a terminated agent.',
    probe: { kind: 'element', id: 'cost-by-agent', contains: 'Alpha' },
  },
  'state.agents[].name': {
    consumed: true,
    why: 'The agent card heading, falling back to the role and then the id.',
    probe: { kind: 'element', id: 'agents-container', contains: 'Alpha' },
  },
  'state.agents[].role': {
    consumed: true,
    why: 'The role badge, the card emoji, and the cost-bar colour.',
    probe: { kind: 'element', id: 'agents-container', contains: '>reviewer<' },
  },
  'state.agents[].status': {
    consumed: true,
    why: 'The status dot, and the "working / not working" split under the Agents stat.',
    probe: { kind: 'element', id: 'stat-agents-sub', contains: '1 working · 1 not working (live agents only)' },
  },
  'state.agents[].model': {
    consumed: true,
    why: 'The resolved-model line on every card, and the model behind the cost-bar colour.',
    probe: { kind: 'element', id: 'agents-container', contains: 'openai/gpt-5-mini' },
  },
  'state.agents[].sessionID': {
    consumed: true,
    why: 'The session link on the card. Read with the server\'s casing, which the old page got wrong.',
    probe: { kind: 'element', id: 'agents-container', contains: '>ses_1<' },
  },
  'state.agents[].spawnedAt': {
    consumed: true,
    why: 'The card\'s spawn line, with the raw ISO on its title. The Sessions row now reads the session equivalent too.',
    probe: {
      kind: 'element',
      id: 'agents-container',
      contains: 'state.agents[].spawnedAt 2026-01-01T11:00:00.000Z',
    },
  },
  'state.agents[].tasksCompleted': {
    consumed: true,
    why: 'The "Tasks" metric on the card — a count of what the agent finished, against the failures beside it, so a card that has done a lot of failing says so.',
    probe: { kind: 'element', id: 'agents-container', contains: '2 done' },
  },
  'state.agents[].tasksFailed': {
    consumed: true,
    why: 'The "Failed" metric on the card. Counted in its own right rather than inferred from completed, because the two need not sum to the tasks the agent was given.',
    probe: { kind: 'element', id: 'agents-container', contains: '>7<' },
  },
  'state.agents[].totalTokens': {
    consumed: true,
    why: 'The "Tokens" metric on the card. This is the field the page had nowhere to put before the state contract was widened, which is why a cost per agent used to appear with no tokens behind it.',
    probe: { kind: 'element', id: 'agents-container', contains: '>12,345<' },
  },
  'state.agents[].averageResponseTime': {
    consumed: true,
    why: 'The "Avg resp" metric on the card, in the unit it is denominated in, so a stalled agent and a merely slow one are distinguishable.',
    probe: { kind: 'element', id: 'agents-container', contains: '940ms' },
  },
  'state.agents[].errorRate': {
    consumed: true,
    why: 'The "Error rate" metric on the card, as a percentage rather than a bare fraction, and a dash when the server reported no reading at all.',
    probe: { kind: 'element', id: 'agents-container', contains: '12.5%' },
  },
  'state.agents[].totalCost': {
    consumed: true,
    why: 'The "Cost" metric and the agent budget bar, which is scaled against the run\'s TOTAL cap now that the never-enforced per-agent ceiling is gone.',
    probe: { kind: 'element', id: 'agents-container', contains: '$1.25' },
  },

  // ── getState().tasks[] ──
  'state.tasks[].id': {
    consumed: true,
    why: 'The task heading\'s tooltip, and the node key in the dependency graph.',
    probe: { kind: 'element', id: 'task-list', contains: 'title="task-1"' },
  },
  'state.tasks[].name': {
    consumed: true,
    why: 'The task heading, falling back to the id.',
    probe: { kind: 'element', id: 'task-list', contains: 'LongOutput' },
  },
  'state.tasks[].role': {
    consumed: true,
    why: 'The role chip beside the task name, and the node role in the graph — the REQUIRED role, which is not always the role that ended up running the task.',
    probe: { kind: 'element', id: 'task-list', contains: 'task-role">architect' },
  },
  'state.tasks[].priority': {
    consumed: true,
    why: 'The priority chip, and the `priority-*` class that colours it.',
    probe: { kind: 'element', id: 'task-list', contains: 'priority-high' },
  },
  'state.tasks[].status': {
    consumed: true,
    why: 'The status chip, the card class, the graph node class, and the running/queued split.',
    probe: { kind: 'element', id: 'task-list', contains: 'task-status queued' },
  },
  'state.tasks[].dependencies': {
    consumed: true,
    why: 'The dependency edges the graph draws — one per reported dependency, not one per adjacent pair.',
    probe: { kind: 'element', id: 'task-list', contains: 'deps: task-1, task-does-not-exist' },
  },
  'state.tasks[].assignedAgent': {
    consumed: true,
    why: 'The "agent:" meta line, which says "unassigned" rather than showing a dash.',
    probe: { kind: 'element', id: 'task-list', contains: 'agent: agent-1' },
  },
  'state.tasks[].cost': {
    consumed: true,
    why: 'The billed figure on the task row, shown only once there is a result to bill.',
    probe: { kind: 'element', id: 'task-list', contains: '$0.40' },
  },
  'state.tasks[].tokensUsed': {
    consumed: true,
    why: 'The token figure on the row and in its meta line.',
    probe: { kind: 'element', id: 'task-list', contains: '8,000 tok' },
  },
  'state.tasks[].result.success': {
    consumed: true,
    why: 'The result block\'s summary, which says when the flag itself was not reported.',
    probe: { kind: 'element', id: 'task-list', contains: 'Result: failed' },
  },
  'state.tasks[].result.output': {
    consumed: true,
    why: 'The result body, with the server\'s 500-character truncation stated rather than left to pass for the whole output.',
    probe: { kind: 'element', id: 'task-list', contains: 'Output truncated to 500 characters' },
  },
  'state.tasks[].result.error': {
    consumed: true,
    why: 'The result body\'s error, escaped — the one place a user can see WHY a task failed.',
    probe: { kind: 'element', id: 'task-list', contains: '&lt;script&gt;' },
  },
  'state.tasks[].result.duration': {
    consumed: true,
    why: 'How long the task took, which is what separates a hang from a fast failure.',
    probe: { kind: 'element', id: 'task-list', contains: 'Duration: 1.23s' },
  },

  // ── getState().config ──
  'state.config.models': {
    consumed: true,
    why: 'The Models panel, over the resolved map\'s OWN keys — a role nobody thought of still shows up.',
    probe: { kind: 'row', id: 'config-models', key: '🏗️ architect', equals: 'anthropic/claude-sonnet-4-6' },
  },
  'state.config.budget.maxTotalCost': {
    consumed: true,
    why: 'The gauge fraction, the Spend card percentage, and the cost-bar scale.',
    probe: { kind: 'row', id: 'config-budget', key: 'maxTotalCost', equals: '$10.00' },
  },
  'state.config.budget.maxCostPerTask': {
    consumed: true,
    // The key is suffixed `(advisory)` because that is what the field now IS:
    // `checkTaskBudget` in `src/orchestrator.ts` notifies on a per-task
    // overspend and stops nothing, since a turn already in flight cannot be
    // interrupted. The page does not scale anything by it — no surface reports
    // a per-TASK cost bar — so the label is the only place the claim is made.
    why: 'Shown in the panel, labelled for what it is. The page does not scale anything by it: no surface reports a per-TASK cost bar.',
    probe: { kind: 'row', id: 'config-budget', key: 'maxCostPerTask (advisory)', equals: '$3.25' },
  },
  'state.config.budget.alertThreshold': {
    consumed: true,
    why: 'Stated as what it is — the REMAINING fraction at or below which the budget alerts.',
    probe: { kind: 'row', id: 'config-budget', key: 'alertThreshold', equals: '20.0% remaining' },
  },
  'state.config.budget.hardLimit': {
    consumed: true,
    why: 'Labelled "stop at ceiling" so its sense cannot be misread as the old `autoTerminate` inverse.',
    probe: { kind: 'row', id: 'config-budget', key: 'hardLimit (stop at ceiling)', equals: 'disabled' },
  },
  'state.config.selfHealing.enabled': {
    consumed: true,
    why: 'Shown under its real key name in the panel and shape-checked, so a config that omits it is reported rather than defaulted to a plausible value.',
    probe: { kind: 'row', id: 'config-healing', key: 'enabled', equals: 'enabled' },
  },
  'state.config.selfHealing.maxRetries': {
    consumed: true,
    why: 'Shown, and the shape check warns above ten.',
    probe: { kind: 'row', id: 'config-healing', key: 'maxRetries', equals: '4' },
  },
  'state.config.selfHealing.retryDelay': {
    consumed: true,
    why: 'Shown in the unit it is denominated in, so a 1234ms delay and a 1234-second one cannot be confused, and a missing value is a dash rather than a 0ms delay.',
    probe: { kind: 'row', id: 'config-healing', key: 'retryDelay', equals: '1.23s' },
  },
  // `state.config.selfHealing.backoffMultiplier` is DELETED from this table,
  // and its absence is the assertion. It was the sharpest of the dead knobs: the
  // page rendered it as "× 3.50" beside `retryDelay`, so the dashboard and the
  // `NexusFullConfig` file shape both told a user the backoff factor was
  // configurable — while `handleFailure` computes
  // `retryDelay * Math.pow(2, retryCount)` with the 2 inline. A fixture that
  // still sent `backoffMultiplier: 3.5` would keep the row rendering and the
  // probe passing against a key the server can no longer send, which is exactly
  // the drift the "no decision for a field the server no longer sends" check
  // above exists to catch. `retryDelay` is the whole configurable backoff now.
  'state.config.selfHealing.contextTransfer': {
    consumed: true,
    why: 'Shown — and it is the one self-healing key that changes what the page SHOWS rather than only what it prints.',
    probe: { kind: 'row', id: 'config-healing', key: 'contextTransfer', equals: 'disabled' },
  },

  // ── getState().sessions[] ──
  'state.sessions[].id': {
    consumed: true,
    why: 'The row key, the orphan banner\'s id list, and the session filter\'s subject.',
    probe: { kind: 'element', id: 'sessions-container', contains: 'ses_1' },
  },
  'state.sessions[].owned': {
    consumed: true,
    why: 'Half of the orphan test, and the reason the overview card counts unowned sessions at all.',
    probe: { kind: 'element', id: 'stat-sessions-sub', contains: '2 with no owning agent' },
  },
  'state.sessions[].agentId': {
    consumed: true,
    why: 'The row\'s Owner cell — a spelled-out "No owning agent" when there is none.',
    probe: { kind: 'element', id: 'sessions-container', contains: 'No owning agent' },
  },
  'state.sessions[].taskId': {
    consumed: true,
    why: 'The row\'s Task cell, and the one join between a session and the Tasks section — a dash for a session with no collection record naming one, never a task id invented from the session.',
    probe: { kind: 'element', id: 'sessions-container', contains: '>task-1<' },
  },
  'state.sessions[].role': {
    consumed: true,
    why: 'The row\'s Role cell, and a dash for an orphan — the role belongs to the owning agent and an orphan has none, so a role there would be the fabrication the view exists to remove.',
    probe: { kind: 'element', id: 'sessions-container', contains: '>coder<' },
  },
  'state.sessions[].model': {
    consumed: true,
    why: 'The row\'s Model cell. Null for an orphan with no collection record, so it can read as "—".',
    probe: { kind: 'element', id: 'sessions-container', contains: 'anthropic/claude-sonnet-4-6' },
  },
  'state.sessions[].state': {
    consumed: true,
    why: 'The row\'s state pill, and the ranking that puts orphans and abandoned sessions on top.',
    probe: { kind: 'element', id: 'sessions-container', contains: 'session-state running' },
  },
  'state.sessions[].spawnedAt': {
    consumed: true,
    why: 'The row\'s Age cell — elapsed for a reader, raw ISO on the title. Null for an orphan, and the banner says so rather than letting that pass for "new".',
    probe: {
      kind: 'element',
      id: 'sessions-container',
      contains: 'state.sessions[].spawnedAt 2026-01-01T09:30:00.000Z',
    },
  },
  'state.sessions[].lastKnownTokens': {
    consumed: true,
    why: 'The "Last read tokens" cell, which says "No reading" for a 0 that means unobserved.',
    probe: { kind: 'element', id: 'sessions-container', contains: '>12,345<' },
  },
  'state.sessions[].observedUncollected': {
    consumed: true,
    why: 'The row\'s unbilled cell, as a lower bound and never added to Spend.',
    probe: { kind: 'element', id: 'sessions-container', contains: '≥ $0.42' },
  },

  // ── agent:spawned / agent:terminated — the `Agent` payload ──
  'agent.id': {
    consumed: true,
    why: 'Last resort in the label, and what identifies the line when the agent has no name and no role.',
    probe: { kind: 'activity', contains: 'Agent spawned: ag-bare' },
  },
  'agent.name': {
    consumed: true,
    why: 'The first thing on the line, and a spawn or termination with no name is not identifiable at all.',
    probe: { kind: 'activity', contains: 'Agent spawned: Zephyr' },
  },
  'agent.role': {
    consumed: true,
    why: 'The label\'s second fallback, so an unnamed agent is still identifiable by what it was for.',
    probe: { kind: 'activity', contains: 'Agent spawned: explorer' },
  },
  'agent.status': {
    consumed: false,
    why: 'At the moment of `agent:spawned` it is `spawning` and at `agent:terminated` it is `terminated` — both are constant at their emit sites, so the field carries no information the event name does not already carry. The status a reader actually wants is the one on the card, and that comes from the throttled state push.',
  },
  'agent.model': {
    consumed: false,
    why: 'It is in the state push within a second and on the card the push fills. A log line repeating it would be a second, staler copy of a number the reader can watch change.',
  },
  'agent.spawnedAt': {
    consumed: false,
    why: 'The card shows it, in both places the page has one, including the raw ISO on the card\'s title. Repeating it per spawn would add a line to the log and no information.',
  },
  'agent.lastActivity': {
    consumed: false,
    why: 'Never shown anywhere on the page, and correctly so: it is the orchestrator\'s own write timestamp, not a reading, so a user would have no way to tell what it means. Adding it would be new surface rather than a read of an existing one.',
  },
  'agent.metrics': {
    consumed: false,
    why: 'Collected, and corrected by the timeout-delta settlement, but the card renders all six from the state push. The log line\'s job is to say WHO appeared, and a spawn line that opens with a wall of counters buries that.',
  },
  'agent.sessionID': {
    consumed: false,
    why: 'On the card, from the state push. A spawn with no resolved session yet is the normal case, so the field is often absent and a line that said so half the time would be noise.',
  },
  'agent.complexity': {
    consumed: false,
    why: 'Optional, and nothing on the page is scaled by it. It is a routing input, not a reported fact, and the Models panel is where the routing is visible.',
  },

  // ── agent:escalation ──
  'event:agent:escalation.agentId': {
    consumed: true,
    why: 'The line names the agent, because an escalation is about one agent running out of options.',
    probe: { kind: 'activity', contains: 'on agent ag-esc' },
  },
  'event:agent:escalation.taskId': {
    consumed: true,
    why: 'The line names the task, via the shared label.',
    probe: { kind: 'activity', contains: 'Escalation: tk-esc' },
  },
  'event:agent:escalation.error': {
    consumed: true,
    why: 'The cause. An escalation with no cause stated is a notification with no content.',
    probe: { kind: 'activity', contains: 'every fallback model refused' },
  },

  // ── task:failed ──
  'event:task:failed.taskId': {
    consumed: true,
    why: 'The label\'s last resort, so a failure reported without a name is still addressable.',
    probe: { kind: 'activity', contains: 'Task failed: tf-bare' },
  },
  'event:task:failed.taskName': {
    consumed: true,
    why: 'The label\'s first choice — a task id is not a name a reader recognises.',
    probe: { kind: 'activity', contains: 'Task failed: Wedges' },
  },
  'event:task:failed.error': {
    consumed: true,
    why: 'The cause, and the only part of this event that is not already on the Tasks section.',
    probe: { kind: 'activity', contains: 'the downstream refused the connection' },
  },
  'event:task:failed.duration': {
    consumed: true,
    why: 'Separates a task that failed instantly from one that ran for three quarters of a minute and then failed — and only the second is a hang worth chasing. A `duration: 0` from the spawn-failure site is named as such, because there it means the spawn itself did not complete rather than "no reading".',
    probe: { kind: 'activity', contains: 'after 45.23s' },
  },
  'event:task:failed.role': {
    consumed: false,
    why: 'On the task row, from the state push. The log line names the task and the cause, which is what you act on.',
  },
  'event:task:failed.agentId': {
    consumed: false,
    why: 'On the Agents section within a second. And the spawn-failure emit site omits it deliberately rather than fabricating it, so it is absent from half of this event\'s deliveries — a line that had to say "unreported" half the time would be worse than one that does not.',
  },
  'event:task:failed.model': {
    consumed: false,
    why: 'On the agent card, and omitted by the same spawn-failure site for the same reason.',
  },
  'event:task:failed.sessionID': {
    consumed: false,
    why: 'On the Sessions section, and omitted by the same spawn-failure site for the same reason.',
  },

  // ── cost:delta ──
  'event:cost:delta.taskId': {
    consumed: true,
    why: 'The line is session-keyed, and the task is what a reader connects it to on the Tasks section.',
    probe: { kind: 'activity', contains: '· cd-1 ·' },
  },
  'event:cost:delta.nodeId': {
    consumed: false,
    why: 'An ALIAS, not a second fact: every emit site writes `nodeId: ledger.taskId`, the same value as `taskId` beside it. Printing both would put two ids for one task on the line the first time they ever disagreed, and the page has no way to adjudicate which is the real one.',
  },
  'event:cost:delta.agentId': {
    consumed: true,
    why: 'Names the agent the money was attributed to. This is a cost line, and "whose cost" is the first question about a cost.',
    probe: { kind: 'activity', contains: 'Session ses_cd on ag-9' },
  },
  'event:cost:delta.sessionID': {
    consumed: true,
    why: 'The line is keyed on it — the one field a cost event carries that the Sessions table can be joined to.',
    probe: { kind: 'activity', contains: 'Session ses_cd' },
  },
  'event:cost:delta.model': {
    consumed: true,
    why: 'The model is what determines the price, and the line now names where the price came from — printing "priced by a fallback table" beside no model at all would leave the reader unable to act on it.',
    probe: { kind: 'activity', contains: 'anthropic/claude-sonnet-4-6 went idle' },
  },
  'event:cost:delta.deltaCost': {
    consumed: true,
    why: 'The amount. Rendered through `fmt$`, so an unreported amount is a dash and never a zero.',
    probe: { kind: 'activity', contains: 'settled $0.25' },
  },
  'event:cost:delta.deltaTokens': {
    consumed: true,
    why: 'A dollar amount with no token count says nothing about magnitude: $0.25 over three tokens and $0.25 over three million are the same string.',
    probe: { kind: 'activity', contains: '1,234 tok' },
  },
  'event:cost:delta.sessionTotalCost': {
    consumed: true,
    why: 'The running total for the session, which is the only cumulative figure this event carries.',
    probe: { kind: 'activity', contains: 'session total $1.50' },
  },
  'event:cost:delta.reason': {
    consumed: true,
    why: 'Decides the whole shape of the line: `abandoned` is unbilled spend, `shutdown` is charged at teardown, `session-idle` is a clean settlement. It also drives the log STREAM severity, so an abandoned delta cannot render as an ordinary one.',
    probe: { kind: 'activity', contains: 'went idle' },
  },
  'event:cost:delta.settledTier': {
    consumed: true,
    why: 'Says WHERE THE PRICE CAME FROM. `pricing` is a `PricingSource`, so a line priced off a generic fallback table can be told apart from one priced off this model\'s published list — and on the one surface where the page otherwise insists on a measured/estimated distinction, an unlabelled amount is the gap. Precisely: this is about the price, not the token counts, so the line says "priced by" and never "estimated".',
    probe: { kind: 'activity', contains: 'priced by a FALLBACK price table' },
  },
  'event:cost:delta.settledTier.pricing': {
    consumed: true,
    why: 'The `PricingSource` token, glossed in plain words AND quoted, so a source this build has not heard of is reported as unrecognised rather than described as something it is not.',
    probe: { kind: 'activity', contains: 'this model is not in it (fallback-table)' },
    nested: true,
  },
  'event:cost:delta.settledTier.promptSizeAtSettlement': {
    consumed: true,
    why: 'The size that selected the tier, printed with the threshold so a reader can see WHICH tier priced them rather than trusting that it was sensible.',
    probe: { kind: 'activity', contains: '120,000 prompt tokens at settlement' },
    nested: true,
  },
  'event:cost:delta.settledTier.threshold': {
    consumed: true,
    why: 'The tier boundary. A null is a real value and not a missing one — it is the base tier, which has no threshold to switch at — so it is NAMED rather than reported as unreported.',
    probe: { kind: 'activity', contains: 'the 200,000-token tier' },
    nested: true,
  },
  'event:cost:delta.recordsAdjusted': {
    consumed: true,
    why: 'Names which per-agent, per-task, history and performance records the increment was written into after the fact. That is worth saying on THIS page in particular, because the agent cost bars and the Spend card are built from exactly those records — so it is the explanation for a total that moved without a bill appearing.',
    probe: { kind: 'activity', contains: 'corrected the history, performance, node records' },
    nested: true,
  },
  'event:cost:delta.error': {
    consumed: true,
    why: 'A settlement that threw still bills, so a dollar figure printed with no mention of the error beside it reads as a clean one. The line says the charge was made and the bookkeeping failed.',
    probe: { kind: 'activity', contains: 'SETTLEMENT ERROR: the ledger read timed out' },
    nested: true,
  },
  'event:cost:delta.uncollected': {
    consumed: true,
    why: 'The abandoned branch\'s lower bound, and the only figure on a cost line that is explicitly NOT a total.',
    probe: { kind: 'activity', contains: 'at least $0.42 unbilled (lower bound)' },
    nested: true,
  },

  // ── security:issues-found ──
  'event:security:issues-found.taskId': {
    consumed: true,
    why: 'The label\'s last resort, so an issue report with no task name is still addressable.',
    probe: { kind: 'activity', contains: 'Security: task-6' },
  },
  'event:security:issues-found.taskName': {
    consumed: true,
    why: 'The label\'s first choice, because a security finding attached to a named task is actionable and one attached to a bare task id is a search.',
    probe: { kind: 'activity', contains: 'Security: Audited' },
  },
  'event:security:issues-found.issues': {
    consumed: true,
    why: 'The first three, with severity, category and file:line, and the rest summarised as a count rather than dropped.',
    probe: { kind: 'activity', contains: 'innerHTML sink [high/injection at src/a.ts:12]' },
  },
  'event:security:issues-found.totalIssues': {
    consumed: true,
    why: 'The count, so a line that shows three of nine does not read as three.',
    probe: { kind: 'activity', contains: '2 issues' },
  },

  // ── memory:set — the `MemoryEntry` payload ──
  'event:memory:set.key': {
    consumed: true,
    why: 'What was set. Without it the line says only that something was.',
    probe: { kind: 'activity', contains: 'Memory set: prefers-concise' },
  },
  'event:memory:set.scope': {
    consumed: true,
    why: 'A project memory and a temp one have very different lifetimes, so the scope is part of the fact.',
    probe: { kind: 'activity', contains: 'scope project' },
  },
  'event:memory:set.author': {
    consumed: true,
    why: 'Who decided it, which is the difference between a fact the orchestrator learned and one a user asserted.',
    probe: { kind: 'activity', contains: 'author nexus' },
  },
  'event:memory:set.id': {
    consumed: false,
    why: 'An opaque store id. It addresses nothing a reader can act on, and the KEY already names the entry uniquely within its scope.',
  },
  'event:memory:set.value': {
    consumed: false,
    why: '`MemoryEntry.value` is `unknown`: it can be any JSON of any size, and this event has exactly one emit site. Printing it would mean putting unbounded user data into an append-only log capped at 200 entries, where a single large value evicts the failures that explain the rest of the run. The line identifies WHICH memory was set, which is what the event is about.',
  },
  'event:memory:set.timestamp': {
    consumed: false,
    why: 'The log entry already carries the wall-clock time the page received it, one field away in the same markup. Printing a second timestamp of the same instant is the redundancy the page avoids everywhere else.',
  },
  'event:memory:set.confidence': {
    consumed: false,
    why: 'There is exactly one emit site and it hardcodes `1.0`. A field that can only ever hold one value is not information a reader can use, and a confidence of 1.00 printed on every line would read as a meaningful score.',
  },
  'event:memory:set.tags': {
    consumed: false,
    why: 'The same site hardcodes `[]`, for the same reason. If a second call site ever sets it, the completeness assertion is what will notice.',
  },
  'event:memory:set.ttl': {
    consumed: false,
    why: 'Absent on every entry the one call site creates. Nothing expires on this path, so a lifetime column would be uniformly empty rather than informative.',
  },

  // ── budget:alert ──
  'event:budget:alert.remaining': {
    consumed: true,
    why: 'The money left, which is the figure an alert is about.',
    probe: { kind: 'activity', contains: 'Budget alert: $0.50 remaining' },
  },
  'event:budget:alert.remainingPercent': {
    consumed: true,
    why: 'The fraction, so the alert can be judged against the ceiling without finding it elsewhere.',
    probe: { kind: 'activity', contains: '(5.0%)' },
  },

  // ── budget:exceeded ──
  'event:budget:exceeded.totalSpent': {
    consumed: true,
    why: 'What was spent when the ceiling was hit — the only figure on the line.',
    probe: { kind: 'activity', contains: 'Budget exceeded. Spent: $12.50' },
  },

  // ── config:reloaded — the `NexusConfigLoadInfo` payload ──
  'event:config:reloaded.trigger': {
    consumed: true,
    why: 'THE CAUSE, and the half of this event that explains it. The line already said how many times, when and which files; a reload you did not cause — `event` from the watch, `poll` from the interval check — is exactly the one worth explaining, and without the trigger it read as the orchestrator having changed its own mind. It leads the line for that reason.',
    probe: { kind: 'activity', contains: 'trigger poll' },
  },
  'event:config:reloaded.models': {
    consumed: true,
    why: 'The SIZE of the resolved map, which is the checkable figure: after a reload the next question is always "did it pick up my change?", and a count can be compared against the Models panel without reading the whole map back out of the config viewer.',
    probe: { kind: 'activity', contains: '3 roles resolved' },
  },
  'event:config:reloaded.project': {
    consumed: true,
    why: 'Which project file was consulted, and whether it was found and parsed.',
    probe: { kind: 'activity', contains: 'project /p/nexus.jsonc (found, parsed)' },
  },
  'event:config:reloaded.global': {
    consumed: true,
    why: 'The same for the global file, which is the other half of the precedence order.',
    probe: { kind: 'activity', contains: 'global /g/nexus.jsonc (absent, unparsed)' },
  },
  'event:config:reloaded.sessionOverride': {
    consumed: true,
    why: 'Whether a session-scoped override is layered on top of disk, so the resolved map is never presented as a statement about the files alone.',
    probe: { kind: 'activity', contains: 'session override layered on top of disk' },
  },
  'event:config:reloaded.loadedAt': {
    consumed: true,
    why: 'WHEN, as the raw ISO. Every other line on this page carries raw server values, and a log line whose one locale-formatted timestamp is the only one a reader has to interpret by eye is the one they cannot grep.',
    probe: { kind: 'activity', contains: 'loaded 2026-01-02T03:04:05.000Z' },
  },
  'event:config:reloaded.loadCount': {
    consumed: true,
    why: 'How many times this has loaded, which is what distinguishes a poll noticing a change from a config that is being rewritten in a loop.',
    probe: { kind: 'activity', contains: 'load #7' },
  },
}

/** Keys for a `Probe` of each kind, so a mistyped probe is a type error. */
function probeOf(entry: Decision): Probe {
  if (entry.probe === undefined) {
    throw new Error(`a consumed field has no probe: ${JSON.stringify(entry.why)}`)
  }
  return entry.probe
}

/**
 * Keys that name a GROUP of fields rather than a field.
 *
 * `tasks[].result`, `config.budget` and `config.selfHealing` are objects: the
 * data is in what is inside them, which the enumeration supplies separately from
 * the inline descent and from `CONFIG_SUB_SHAPES`. Demanding a decision about
 * the node itself could only ever produce a fiction — there is no value a server
 * could send for `state.config.budget` that is not one of its five keys.
 *
 * Asserted below to be a real prefix of at least one decision key, so this set
 * cannot go stale: a renamed or removed container fails rather than quietly
 * filtering nothing.
 */
const CONTAINER_KEYS = new Set([
  'state.tasks[].result',
  'state.config.budget',
  'state.config.selfHealing',
])

/** Every field name the server declares or emits, as `<prefix>.<field>` keys. */
async function serverFieldKeys(): Promise<string[]> {
  const [orchestrator, types, config] = await Promise.all([
    readSourceFile('orchestrator'),
    readSourceFile('types'),
    readSourceFile('config'),
  ])
  const byFile: Record<string, string> = { orchestrator, types, config }
  const keys: string[] = []

  const add = (prefix: string, fields: readonly string[]): void => {
    for (const field of fields) {
      const key = `${prefix}.${field}`
      if (!CONTAINER_KEYS.has(key)) keys.push(key)
    }
  }

  // The state snapshot, in the one declaration the server publishes it through.
  const state = 'OrchestratorState'
  add('state', interfaceFieldNames(orchestrator, state))
  add('state.agents[]', inlineFieldNames(orchestrator, state, ['agents']))
  add('state.tasks[]', inlineFieldNames(orchestrator, state, ['tasks']))
  add('state.tasks[].result', inlineFieldNames(orchestrator, state, ['tasks', 'result']))
  add('state.config', inlineFieldNames(orchestrator, state, ['config']))
  add('state.sessions[]', interfaceFieldNames(orchestrator, 'SessionStateView'))
  for (const [prefix, shape] of Object.entries(CONFIG_SUB_SHAPES)) {
    add(prefix, inlineFieldNames(byFile[shape.file] as string, shape.interface, shape.path))
  }

  // Every event payload, off the emit sites.
  for (const event of BROADCAST_EVENTS) {
    const payloads = emitPayloads(orchestrator, event)
    if (payloads.length === 0) {
      throw new Error(`no this.emit('${event}', …) site in src/orchestrator.ts`)
    }
    for (const payload of payloads) {
      if (payload.kind === 'literal') {
        add(`event:${event}`, payload.fields)
        continue
      }
      const shape = IDENTIFIER_PAYLOADS[event]
      if (shape === undefined) {
        throw new Error(
          `this.emit('${event}', ${payload.name}) passes an identifier, so its shape cannot be read ` +
            `from the call site — name the interface in IDENTIFIER_PAYLOADS`,
        )
      }
      add(shape.prefix, interfaceFieldNames(byFile[shape.file] as string, shape.interface))
    }
  }
  return [...new Set(keys)].sort()
}

/**
 * Frames carrying a value for every field the page claims to consume.
 *
 * `HOSTILE_PAYLOADS` deliberately omits things, which is right for proving the
 * formatters narrow rather than assume and useless for proving a value REACHES
 * the screen: there is nothing to reach it with. So this list fills each payload
 * in, and adds the second and third deliveries an event needs where a field is
 * only reachable through a fallback — `agentLabel` returns `name`, then `role`,
 * then `id`, so all three need their own frame to be probeable at all.
 *
 * The values are chosen to be unmatchable by any other field's read. That is what
 * makes each probe an assertion about ONE field rather than about the page
 * having rendered something.
 */
const CONSUMPTION_FRAMES: readonly unknown[] = [
  { type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' },
  { type: 'agent:spawned', data: { id: 'ag-spawn', name: 'Zephyr', role: 'explorer', status: 'working', model: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, spawnedAt: '2026-01-02T00:00:00.000Z', lastActivity: '2026-01-02T00:01:00.000Z', metrics: { tasksCompleted: 0, tasksFailed: 0, totalTokens: 0, totalCost: 0, averageResponseTime: 0, errorRate: 0 }, sessionID: 'ses_spawn', complexity: { score: 0.5 } }, timestamp: 'now' },
  { type: 'agent:spawned', data: { id: 'ag-bare', role: 'explorer', status: 'spawning' }, timestamp: 'now' },
  { type: 'agent:spawned', data: { id: 'ag-bare' }, timestamp: 'now' },
  { type: 'agent:terminated', data: { id: 'ag-term', role: 'documenter', status: 'terminated' }, timestamp: 'now' },
  { type: 'agent:escalation', data: { agentId: 'ag-esc', taskId: 'tk-esc', error: 'every fallback model refused' }, timestamp: 'now' },
  { type: 'task:failed', data: { taskId: 'tf-1', taskName: 'Wedges', agentId: 'ag-9', role: 'coder', model: 'anthropic/claude-sonnet-4-6', error: 'the downstream refused the connection', duration: 45_230, sessionID: 'ses_tf' }, timestamp: 'now' },
  { type: 'task:failed', data: { taskId: 'tf-bare', error: 'no name reported', duration: 0 }, timestamp: 'now' },
  { type: 'cost:delta', data: { taskId: 'cd-1', nodeId: 'cd-1', agentId: 'ag-9', sessionID: 'ses_cd', model: 'anthropic/claude-sonnet-4-6', deltaCost: 0.25, deltaTokens: 1234, sessionTotalCost: 1.5, reason: 'session-idle', settledTier: { pricing: 'fallback-table', promptSizeAtSettlement: 120_000, threshold: 200_000 }, recordsAdjusted: { history: true, performance: true, node: true, agent: false }, error: 'the ledger read timed out' }, timestamp: 'now' },
  { type: 'cost:delta', data: { taskId: 'cd-2', nodeId: 'cd-2', agentId: null, sessionID: 'ses_abandoned', model: null, deltaCost: 0, deltaTokens: 0, sessionTotalCost: 0.42, reason: 'abandoned', settledTier: { pricing: 'model-costs', promptSizeAtSettlement: 4000, threshold: null }, recordsAdjusted: { history: false, performance: false, node: false, agent: false }, uncollected: { lastKnownTokens: 4000, observedUncollected: 0.42 } }, timestamp: 'now' },
  { type: 'security:issues-found', data: { taskId: 'sec-1', taskName: 'Audited', totalIssues: 2, issues: [{ id: 'SEC-1', severity: 'high', category: 'injection', message: 'innerHTML sink', file: 'src/a.ts', line: 12 }] }, timestamp: 'now' },
  { type: 'security:issues-found', data: { taskId: 'task-6', issues: [null, { message: 'unscoped', severity: 'low' }] }, timestamp: 'now' },
  { type: 'memory:set', data: { id: 'mem-1', key: 'prefers-concise', value: { style: 'terse' }, scope: 'project', author: 'nexus', timestamp: '2026-01-02T00:00:00.000Z', confidence: 1, tags: [], ttl: 3600 }, timestamp: 'now' },
  { type: 'budget:alert', data: { remaining: 0.5, remainingPercent: 0.05 }, timestamp: 'now' },
  { type: 'budget:exceeded', data: { totalSpent: 12.5 }, timestamp: 'now' },
  { type: 'config:reloaded', data: { project: { path: '/p/nexus.jsonc', existed: true, parsed: true }, global: { path: '/g/nexus.jsonc', existed: false, parsed: false }, models: { architect: 'anthropic/claude-sonnet-4-6', coder: 'anthropic/claude-sonnet-4-6', tester: 'openai/gpt-5-mini' }, sessionOverride: true, loadedAt: '2026-01-02T03:04:05.000Z', loadCount: 7, trigger: 'poll' }, timestamp: 'now' },
  { type: 'orchestrator:paused', data: {}, timestamp: 'now' },
  { type: 'orchestrator:resumed', data: {}, timestamp: 'now' },
  { type: 'orchestrator:shutdown', data: {}, timestamp: 'now' },
]

describe('the enumeration of unread fields is itself checked', () => {
  it('reads the field names out of the server, and reads them right', async () => {
    // THE self-check, and it comes first because everything below is only as
    // trustworthy as this. A source-walking extractor is machinery, and
    // machinery that silently returns nothing produces a test that is green
    // because it is asking about nothing — which is the exact failure this
    // whole block exists to end, one level up.
    //
    // So three shapes the server is not going to rewrite casually are pinned
    // outright, chosen to cover the three things the extractor has to get
    // right: a multi-line interface body, a `;`-separated single-line inline
    // type, and an object literal written with SHORTHAND properties — which is
    // how `budget:alert` is emitted, and which a colon-requiring scanner reads
    // as an empty payload.
    const orchestrator = await readSourceFile('orchestrator')
    const types = await readSourceFile('types')

    expect(interfaceFieldNames(orchestrator, 'SessionStateView')).toEqual([
      'id', 'owned', 'agentId', 'taskId', 'role', 'model', 'state', 'spawnedAt',
      'lastKnownTokens', 'observedUncollected',
    ])
    expect(inlineFieldNames(orchestrator, 'OrchestratorState', ['tasks', 'result'])).toEqual([
      'success', 'output', 'error', 'duration',
    ])
    // The shorthand case: `this.emit('budget:alert', { remaining, remainingPercent })`.
    expect(emitPayloads(orchestrator, 'budget:alert')).toEqual([
      { kind: 'literal', fields: ['remaining', 'remainingPercent'] },
    ])
    // And that an interface the page reads nothing from is still walked, so a
    // flat interface cannot come back empty and pass as "no fields".
    //
    // `maxCostPerAgent` is gone from this list, and its absence is the point:
    // it was the page's only reader, the page used it to caption every agent
    // card "of $N per-agent ceiling · OVER CEILING", and there was no such
    // ceiling. Deleting the row and this field together is the whole change —
    // see the deliberate absence pin in `test/config-knobs.test.ts`.
    expect(interfaceFieldNames(types, 'BudgetConstraint')).toEqual([
      'maxTotalCost', 'maxCostPerTask', 'alertThreshold', 'hardLimit',
    ])
  })

  it('fails on a member it cannot read rather than dropping it', () => {
    // The failure mode this whole block is about, one level down. The extractor
    // used to skip any member whose head was not a bare identifier, and a skipped
    // member is a field nothing checks: the completeness assertion below would
    // go on asking about a slightly smaller world and staying green.
    //
    // The case that matters is a QUOTED key. `blankNonCode` blanks string
    // literals before the member is read — which is what makes brace counting
    // sound — so `'totalSpentX'` arrives as whitespace and used to vanish
    // without a word. Asserted as a throw rather than as a returned list,
    // because the throw is the behaviour: the key cannot be recovered here, and
    // an unrecognised member in a server declaration is itself the signal worth
    // seeing.
    // The argument is a brace BODY, the text between the braces, which is what
    // `interfaceFieldNames` and `emitPayloads` hand it once they have found the
    // braces themselves.
    expect(() => topLevelDeclaredNames("'totalSpentX': 1, totalSpent")).toThrow(/quoted key/)
    expect(() => topLevelDeclaredNames('"totalSpentX": 1, totalSpent')).toThrow(/quoted key/)
    // And an ordinary member is still read, so the guard is about the unreadable
    // ones and not about being strict in general.
    expect(topLevelDeclaredNames('totalSpent: 4.5, budgetRemaining')).toEqual([
      'totalSpent',
      'budgetRemaining',
    ])
    // A spread of something that is not an object literal contributes keys the
    // extractor cannot know, which is the same silent shrink, so it is loud too.
    expect(() => topLevelDeclaredNames('...baseDefaults')).toThrow(/conditional spread/)
    // A method signature is not a data field and is not one of the forms above.
    // Today no walked declaration contains one; if a future interface adds one,
    // the throw is the signal to decide here rather than to lose a field.
    expect(() => topLevelDeclaredNames('format(value: number): string')).toThrow(
      /does not recognise/,
    )
  })

  it('blanks a file with an astral character in it, index for index', () => {
    // `blankNonCode` built its output with `[...source]`, which iterates CODE
    // POINTS while every offset it is used with is a UTF-16 CODE UNIT. One
    // emoji — this codebase's role glyphs, in string literals AND in doc
    // comments — made the blanked copy two characters shorter than its input
    // and shifted every position after it, so a declaration below it was read
    // out of the middle of a comment and the completeness check failed with a
    // member no declaration has. The failure pointed at the dashboard page and
    // at nothing in the file that had actually changed.
    const source = [
      '/** Role glyph: \u{1F916} */',
      'export interface Demo {',
      '  coder: string',
      '}',
      '',
    ].join('\n')
    const blanked = blankNonCode(source)
    // Same length, so an index into the copy is an index into the original.
    expect(blanked.length).toBe(source.length)
    // And the declaration below the emoji still reads as itself.
    expect(interfaceFieldNames(source, 'Demo')).toEqual(['coder'])
  })

  it('has a decision for every field the server sends', async () => {
    // THE completeness assertion. `stat-sessions` was blank because nobody
    // decided what to do with `state.sessions` at the point the card is
    // filled; this fails for a field that is sent and undecided, which is the
    // same condition one step earlier and therefore catches it.
    const keys = await serverFieldKeys()
    const undecided = keys.filter((key) => !(key in FIELD_DECISIONS))
    expect(undecided).toEqual([])
    // Non-vacuity: an extractor that returned nothing would satisfy the line
    // above just as happily.
    expect(keys.length).toBeGreaterThan(80)
    // And every container key still stands for something, so `CONTAINER_KEYS`
    // cannot quietly start filtering keys that no longer exist.
    const decided = Object.keys(FIELD_DECISIONS)
    const staleContainers = [...CONTAINER_KEYS].filter(
      (container) => !decided.some((key) => key.startsWith(`${container}.`)),
    )
    expect(staleContainers).toEqual([])
  })

  it('has no decision for a field the server no longer sends', async () => {
    // The other direction, and the one that keeps the table honest. A decision
    // for a field that is gone is a claim about the page that nothing can check,
    // and it is how a table like this starts lying: the entry stays, reads as
    // coverage, and describes a payload that no longer exists.
    const keys = new Set(await serverFieldKeys())
    const stale = Object.keys(FIELD_DECISIONS).filter(
      (key) => FIELD_DECISIONS[key]?.nested !== true && !keys.has(key),
    )
    expect(stale).toEqual([])
  })

  it('gives every consumed field a probe and every unread one a reason', async () => {
    // Both branches of the table have to be filled in. A consumed field with no
    // probe is a claim that nothing checks — the shape the original
    // required-field list had, and the reason it could not see a blank card.
    // An unread field with no reason is a silent omission, which is the defect
    // being fixed rather than a decision about it.
    for (const [key, decision] of Object.entries(FIELD_DECISIONS)) {
      expect({ key, consumed: decision.consumed, hasProbe: decision.probe !== undefined }).toEqual({
        key,
        consumed: decision.consumed,
        hasProbe: decision.consumed,
      })
      expect({ key, why: decision.why.length > 40 }).toEqual({ key, why: true })
    }
  })
})

describe('every field the page claims to consume reaches the screen', () => {
  let probePage: LoadedPage
  let frameMark = 0

  beforeAll(async () => {
    probePage = await loadDashboardPage({ routes: COST_ROUTES })
    probePage.open()
    await probePage.settle()
    frameMark = logMark(probePage)
    for (const frame of CONSUMPTION_FRAMES) probePage.deliver(frame)
  })

  it('draws every frame the probes are about to read', () => {
    // A non-vacuity guard, in its own test rather than inside `beforeAll`.
    //
    // The frames are a fixed list, so if the page cannot draw one of them the
    // probes below would all be answering a question about a page that had
    // stopped rendering — and every one of them would fail for that reason
    // instead of its own. Asserted first, and as a NAMED test: an `expect`
    // inside `beforeAll` takes the test names down with it, so the reader gets
    // "(unnamed)" for the assertion they most need to read first.
    expect({ frame: 'consumption frames', failures: failuresSince(probePage, frameMark) }).toEqual({
      frame: 'consumption frames',
      failures: [],
    })
  })

  it('renders a value for every consumed field', () => {
    // THE assertion the four defects got past, and the one that generalises. It
    // is deliberately not a grep: `FIELD_DECISIONS` says the page consumes
    // `state.sessions`, and this asks the rendered page whether a value of that
    // field came out — which is the question "reads the field somewhere"
    // cannot answer and "does not throw" cannot answer either.
    //
    // One `it` over every probe on purpose. A per-field test would pass or fail
    // individually and a reader would be left with a list to triage; a single
    // diff of "which marker did not appear" is the whole report, and the
    // failing key is in it.
    const rendered: Record<string, string> = {}
    for (const [key, decision] of Object.entries(FIELD_DECISIONS)) {
      if (!decision.consumed) continue
      const probe = probeOf(decision)
      if (probe.kind === 'row') {
        // Matched on the KEY, not on the value: the alternative is a substring
        // over the whole panel, and `$1.00` is a substring of `$10.00`, so a
        // value-substring probe for one budget key is satisfied by another.
        const actual = probePage.configRows(probe.id)[probe.key]
        if (actual !== probe.equals) {
          rendered[key] = `#${probe.id} row "${probe.key}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(probe.equals)}`
        }
        continue
      }
      const actual = readProbe(probePage, probe)
      if (!actual.includes(probe.contains)) {
        rendered[key] = `expected ${JSON.stringify(probe.contains)} in ${describeProbe(probe)}`
      }
    }
    expect(rendered).toEqual({})
  })

  it('fills the Sessions overview card from the same census as the section', async () => {
    // The specific regression, kept as its own test so that if the card ever
    // goes back to `—` again the failure names the card rather than appearing
    // as one line in a list of ninety-eight — which is how many fields
    // `FIELD_DECISIONS` currently claims are consumed, each with its own probe.
    //
    // The equality with `session-count` is the point. The card and the section
    // are two surfaces answering one question on one page, and when they were
    // free to disagree they did: the section counted four and the card said
    // "No sessions reported". Asserting the card is not a dash would have
    // caught it too; asserting the two AGREE is what stops the next drift.
    const fresh = await loadDashboardPage({ routes: COST_ROUTES })
    fresh.open()
    await fresh.settle()
    fresh.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
    expect(fresh.text('stat-sessions')).toBe('4')
    expect(fresh.text('stat-sessions')).toBe(fresh.text('session-count'))
  })

  it('does not let a leaking fleet read as a healthy one', async () => {
    // The sub-line's job, stated as a property. `ses_2` is RUNNING and UNOWNED:
    // an agent was terminated and the session is still generating, with nobody
    // collecting what it spends. A sub-line that said "4 sessions" would satisfy
    // every other assertion in this file and be wrong about the thing the view
    // exists to show.
    const fresh = await loadDashboardPage({ routes: COST_ROUTES })
    fresh.open()
    await fresh.settle()
    fresh.deliver({ type: 'orchestrator:state', data: HOSTILE_STATE, timestamp: 'now' })
    const sub = fresh.text('stat-sessions-sub')
    expect(sub).toBe('2 running · 1 abandoned · 2 with no owning agent (1 still running) · 1 unreported')
    // Every clause reachable from the headline, which is the arithmetic a reader
    // can check without trusting the page.
    expect(fresh.text('stat-sessions')).toBe('4')
  })

  it('marks a paused orchestrator as paused, not as running', async () => {
    // `paused` and `running` are separate fields and `paused` wins, because a
    // paused orchestrator is mid-run and not executing. The state push above
    // cannot show this — HOSTILE_STATE is `running: true, paused: false`.
    const fresh = await loadDashboardPage({ routes: COST_ROUTES })
    fresh.open()
    await fresh.settle()
    fresh.deliver({
      type: 'orchestrator:state',
      data: { ...HOSTILE_STATE, running: true, paused: true },
      timestamp: 'now',
    })
    expect(fresh.text('orch-status')).toBe('Paused')
  })
})

/** The rendered text a probe is looking in. Excludes the `row` kind. */
function readProbe(page: LoadedPage, probe: Exclude<Probe, { kind: 'row' }>): string {
  switch (probe.kind) {
    case 'element':
      return `${page.html(probe.id)}\n${page.text(probe.id)}`
    case 'attribute':
      // The page writes `title` on the elements it looks up, and `FakeElement`
      // is a class rather than an index signature — so the probe names the
      // attribute as a literal and the read is a plain field access, which is
      // also what a browser gives you. The `attribute` field is typed `'title'`,
      // so there is no second attribute this silently reads as `''`.
      return page.element(probe.id).title
    case 'value':
      return page.value(probe.id)
    case 'activity':
      return page.activityMessages().join('\n')
    case 'stream':
      return page.logStream()
  }
}

/** A probe's location, for a failure message that says where to look. */
function describeProbe(probe: Exclude<Probe, { kind: 'row' }>): string {
  switch (probe.kind) {
    case 'element':
      return `#${probe.id}`
    case 'attribute':
      return `#${probe.id}[${probe.attribute}]`
    case 'value':
      return `#${probe.id}.value`
    case 'activity':
      return 'the activity log'
    case 'stream':
      return 'the log stream'
  }
}
