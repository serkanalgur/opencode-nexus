import { describe, it, expect, beforeAll } from 'bun:test'
import { join } from 'node:path'
import { BROADCAST_EVENTS } from '../src/broadcast'

/**
 * The page's side of the WebSocket contract.
 *
 * `test/broadcast-event-coverage.test.ts` proves every event the orchestrator
 * emits reaches a socket. This proves the socket's other end — the hand-written
 * page — actually does something with them, which is a different failure and
 * was the real one: the page handled eighteen event names, eight of which
 * nothing emits, and missed nine that do. A page can be perfectly wired to a
 * broadcaster and still render nothing, and nothing at runtime says so.
 *
 * The disease this file treats as the disease is FABRICATION. The page's
 * defining failure was not that it showed too little; it was that it showed
 * plausible numbers the server never sent — `budget.maxBudget` falling back to
 * a hardcoded `MAX_BUDGET` of $10, a `criticalThreshold` that no configuration
 * has, an `autoTerminate` boolean that was the inverse of the real `hardLimit`,
 * a `sessionId` read with the wrong casing so the branch was dead, and
 * `t.progress` synthesised from status. Each of those rendered as data. So the
 * assertions below are mostly NEGATIVE — they pin the absence of a value the
 * page has no business showing — plus a coverage half that ties the page's
 * `case` labels to `BROADCAST_EVENTS`, which is the one thing that can catch a
 * handler being renamed out from under it.
 *
 * All of it is source-level, so it carries the usual caveat: it cannot see
 * through a dynamic property access. That is why every check is paired with a
 * non-vacuity guard on the number of things it found, and why the coverage half
 * is driven off the exported list rather than a copy — a copy is the thing that
 * rots, which is how the eight dead cases got there.
 */

const HTML_PATH = join(import.meta.dir, '..', 'dashboard', 'index.html')

let html = ''
let script = ''

/**
 * The page's executable source: the `<script>` body with comments removed.
 *
 * Comment stripping is the point. The page documents at length WHY certain keys
 * are not read — `criticalThreshold`, `autoTerminate`, `config:update` all
 * appear in prose explaining their removal — and a grep that cannot tell prose
 * from code would either fail on the explanation or force the explanation out of
 * the file. What is left is what actually runs.
 */
function executableSource(): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

beforeAll(async () => {
  html = await Bun.file(HTML_PATH).text()
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error('dashboard/index.html has no <script> block')
  script = match[1] as string
})

describe('the page finds the script and the body it drives', () => {
  it('extracts a script large enough to be the whole page logic', async () => {
    // Non-vacuity guard for every source check below: if the extraction rots
    // and yields an empty string, the negative assertions all pass on nothing.
    expect(script.length).toBeGreaterThan(10_000)
  })

  it('is a single hand-written page, with no framework or build step', () => {
    // The constraint is load-bearing (the whole thing is inlined into the
    // bundle as text), so it is asserted rather than left to convention.
    expect(html.match(/<script/g)?.length ?? 0).toBe(1)
    expect(html).not.toContain('import ')
    expect(html).not.toContain('require(')
  })
})

describe('the page handles every event the broadcaster forwards', () => {
  /** `case '<name>':` labels in the message switch. */
  function handledEventNames(): string[] {
    return [...script.matchAll(/case '([a-zA-Z:_-]+)':/g)].map((m) => m[1] as string)
  }

  it('finds a switch with the expected number of cases', () => {
    // Guards the coverage check below against a regex that stops matching.
    expect(handledEventNames().length).toBeGreaterThanOrEqual(BROADCAST_EVENTS.length)
  })

  it('has a case for every one of them', () => {
    const handled = new Set(handledEventNames())
    // Driven off the exported list, so an event added to the broadcaster fails
    // here until the page handles it — which is the whole point.
    expect(BROADCAST_EVENTS.filter((name) => !handled.has(name))).toEqual([])
  })

  it('handles the throttled state push and the ping reply', () => {
    // The two messages the socket sends that are not in `BROADCAST_EVENTS`:
    // the state snapshot (which is most of what the page renders) and the
    // `pong` reply. Both are load-bearing and neither is an event.
    const handled = new Set(handledEventNames())
    expect(handled.has('orchestrator:state')).toBe(true)
    expect(handled.has('pong')).toBe(true)
  })

  it('handles no event name the orchestrator does not emit', () => {
    // The other direction, and the one that was actually broken: the page
    // carried `state`, `task:started`, `task-assigned`, `task:completed`,
    // `task-failed`, `task-completed`, `review-completed` and `status-update`.
    // Six of those are `MessageType` members whose publisher
    // (`MessageRouter.publish`) has zero call sites, and `state` was an alias
    // that never existed. Eight `case` labels that could not run.
    const emitted = new Set<string>(BROADCAST_EVENTS)
    // The two non-event messages, allowed above and named here rather than as a
    // bare exemption.
    emitted.add('orchestrator:state')
    emitted.add('pong')
    const handled = handledEventNames()
    expect(handled.filter((name) => !emitted.has(name))).toEqual([])
  })

  it('does not dedupe events client-side, because the server delivers each once', () => {
    // The broadcaster forwards each event to each client exactly once, so any
    // suppression set on the page would drop real events. A count or a
    // seen-set keyed on event name is the shape this fails on.
    const code = executableSource()
    expect(/seenEvents|handledEvents|dedup|lastEventType/.test(code)).toBe(false)
  })
})

describe('the page renders only what the server reports', () => {
  const code = () => executableSource()

  it('reads every field the state contract now carries', () => {
    // Coverage, the inverse of the checks below. Each of these was sent and
    // unread: a paused orchestrator looked exactly like a running one, and
    // nothing on the page said why a task had failed.
    const required = [
      'running', 'paused', 'lastUpdated',
      'sessions', 'owned', 'agentId', 'lastKnownTokens', 'observedUncollected',
      'spawnedAt', 'sessionID', 'totalTokens', 'averageResponseTime', 'errorRate',
      'dependencies', 'assignedAgent', 'priority', 'result', 'cost', 'tokensUsed',
      'config', 'models', 'maxTotalCost', 'alertThreshold', 'hardLimit',
      'selfHealing', 'enabled', 'maxRetries', 'retryDelay', 'backoffMultiplier', 'contextTransfer',
    ]
    const missing = required.filter((field) => !new RegExp(`\\.${field}\\b`).test(code()))
    expect(missing).toEqual([])
  })

  it('reads config under the real key names and invents none', () => {
    // `getState()` publishes `budget.maxTotalCost`, `budget.alertThreshold`
    // and `budget.hardLimit` under those names and no aliases. The page read
    // `maxBudget || max` with a hardcoded `MAX_BUDGET` fallback, a
    // `criticalThreshold || criticalPct` defaulted to 10, and an
    // `autoTerminate` defaulted to true — the last being the INVERSE of
    // `hardLimit`, which defaults to false. A wrong boolean, not a blank.
    const c = code()
    // Scoped to reads off the budget object, so `Math.max` (which the page
    // legitimately uses) is not what this is about.
    expect(/budget\.maxBudget\b/.test(c)).toBe(false)
    expect(/budget\.max\b(?!\w)/.test(c)).toBe(false)
    expect(/\.criticalThreshold\b/.test(c)).toBe(false)
    expect(/\.criticalPct\b/.test(c)).toBe(false)
    expect(/\.autoTerminate\b/.test(c)).toBe(false)
    expect(/\bMAX_BUDGET\b/.test(c)).toBe(false)
  })

  it('reads selfHealing under the real key names', () => {
    // `retryOnFailure` was never a key; `escalation` and `deadlockDetection`
    // are not keys either — escalation is a code default after retries and
    // model fallback are exhausted, not configuration.
    const c = code()
    expect(/\.retryOnFailure\b/.test(c)).toBe(false)
    expect(/\.deadlockDetection\b/.test(c)).toBe(false)
    expect(/\.escalation\b/.test(c)).toBe(false)
  })

  it('does not read a session id with the wrong casing', () => {
    // The server sends `sessionID`. The page read `sessionId`, so the branch
    // that renders a session's identity was dead and no link ever appeared.
    // Asserted positively too, so this is not satisfied by deleting the row.
    const c = code()
    expect(/\.sessionId\b/.test(c)).toBe(false)
    expect(/\.sessionID\b/.test(c)).toBe(true)
  })

  it('does not synthesise a progress value the server never sends', () => {
    // `t.progress` is not in the state. The page fabricated 0/50/100 from
    // status and drew it, which made a queued task and a finished one
    // differ by a bar that meant nothing.
    expect(/\.progress\b/.test(code())).toBe(false)
    expect(/dag-progress/.test(code())).toBe(false)
  })

  it('does not read config from a state key that does not exist', () => {
    // `state.config?.budget || state.budgetConfig` and
    // `state.config?.models || state.models` — neither fallback was ever on
    // the state, so with `state.config` absent every config row rendered a
    // hardcoded default that looked configured.
    const c = code()
    expect(/budgetConfig/.test(c)).toBe(false)
    expect(/\bstate\.models\b/.test(c)).toBe(false)
  })

  it('has no optional chaining, so a missing field cannot fail silently', () => {
    // The vanilla-JS stand-in for "no silent-failure `?.` on a field that must
    // exist". The page narrows every value through `num()`/`text()`/`asObject()`,
    // which return an explicit "not reported" rather than swallowing the error.
    expect(/\?\./.test(script)).toBe(false)
    expect(/\?\?/.test(script)).toBe(false)
  })

  it('renders the unbilled figure as a lower bound and never adds it to spend', () => {
    // `observedUncollected` is a LOWER bound on what was left unbilled, and is
    // deliberately not part of `totalSpent`. Adding it would produce a figure
    // that is neither measured nor a bound, which is the conflation
    // `CostProvenance` exists to prevent — so the page must neither sum it in
    // nor describe it as a total.
    const c = code()
    expect(/excluded from/i.test(c) || /not in Spend/i.test(c)).toBe(true)
    // "at least" / "lower bound" phrasing rather than an unqualified figure.
    expect(/lower bound/i.test(c)).toBe(true)
  })
})

describe('the config panel is honestly read-only', () => {
  it('sends no configuration write', () => {
    // The Apply button posted `{type:'config:update'}` and printed "Config
    // update sent to server". The socket handles only `ping` and `getState`,
    // so the button reported a success that could not happen. There is no auth
    // story for writes and the socket is localhost with `CORS: *`, so no write
    // path was added either — the control is gone, not re-pointed.
    const c = executableSource()
    expect(/config:update/.test(c)).toBe(false)
    expect(/config-apply/.test(html)).toBe(false)
    expect(html).not.toContain('Apply Config')
  })

  it('marks the config field and the panel read-only on their face', () => {
    // Not only that the handler is gone: the control says it cannot be typed
    // into and says why, so the absence is legible without reading the source.
    expect(/id="config-editor"[^>]*readonly/.test(html)).toBe(true)
    expect(/Read-only/.test(html)).toBe(true)
  })

  it('still offers the one action that needs no server: re-indenting', () => {
    // Format and Check are client-side only. Check is worth keeping because
    // the panel is the only surface that can say "the config in force is
    // missing a key" — and it is now written against the real key names, which
    // the old `budget.maxBudget` check was not, so it could never have fired.
    expect(html).toContain('id="config-format-btn"')
    expect(html).toContain('id="config-validate-btn"')
    expect(/maxTotalCost/.test(executableSource())).toBe(true)
  })
})

describe('the page uses the HTTP routes the server actually serves', () => {
  it('reads cost history from /api/costs rather than from live agents', () => {
    // `state.agents` is live only: `terminateAgent` deletes the agent, so
    // every completed or terminated agent's cost vanishes from the page while
    // the orchestrator still holds it. The chart got less accurate as the run
    // progressed. `/api/costs` carries the full history.
    const c = executableSource()
    expect(/fetch\('\/api\/costs'\)/.test(c)).toBe(true)
    expect(/byAgent/.test(c)).toBe(true)
    expect(/byModel/.test(c)).toBe(true)
  })

  it('reads server uptime from /api/health instead of the browser tab', () => {
    // The old "Uptime" was `startTime + a 1s interval` — the age of the tab,
    // presented as if it were the orchestrator's.
    const c = executableSource()
    expect(/fetch\('\/api\/health'\)/.test(c)).toBe(true)
    expect(/startTime/.test(c)).toBe(false)
  })

  it('normalises the cost bars against something meaningful', () => {
    // Normalising to the most expensive agent makes the top bar 100% by
    // construction, so the bars encode rank rather than budget consumption.
    // The page divides by the budget ceiling and says which it did.
    const c = executableSource()
    expect(/maxTotalCost/.test(c)).toBe(true)
    expect(/budget ceiling/i.test(c)).toBe(true)
  })
})

describe('the sessions view exists and makes the orphan case unmissable', () => {
  it('renders a sessions section the previous page did not have', () => {
    // Zero references to `sessions` before; the one case the whole state
    // contract was widened for was invisible on every layer.
    expect(html).toContain('id="sessions-container"')
    expect(html).toContain('id="session-count"')
    expect(html).toContain('id="orphan-banner"')
  })

  it('distinguishes an unowned session by more than a shade of colour', () => {
    // The brief's requirement, asserted as three separate marks so a single
    // `border-color` tweak cannot satisfy it: a spelled-out flag in the row, a
    // section-level banner, and a hard left rule on the row.
    expect(/No owning agent/.test(html)).toBe(true)
    expect(/\.session-row\.orphan/.test(html)).toBe(true)
    expect(/with no owning agent/.test(html)).toBe(true)
  })

  it('sorts the rows that matter to the top', () => {
    // An orphan and an abandoned session must not be below the fold of a long
    // list of healthy ones.
    const c = executableSource()
    expect(/function sessionRank/.test(c)).toBe(true)
    expect(/sessionRank/.test(c)).toBe(true)
  })

  it('is driven by the state field, not by a filter on the agent list', () => {
    expect(/\.sessions\b/.test(executableSource())).toBe(true)
  })

  it('keeps the "live agents only" caveat on the number it qualifies', () => {
    // The overview card's sub-line read "3 working · 0 not working" and
    // nothing else, which is a claim to be a complete census of the fleet. The
    // Agents SECTION carries the caveat permanently, so the information was on
    // the page — just nowhere near the number it qualifies, on a card of four,
    // above the fold, long before that section is reached. The caveat is now in
    // the sub-line itself.
    const c = executableSource()
    expect(/\(live agents only\)/.test(c)).toBe(true)
    // Both halves of the arithmetic come from `liveAgents`. `activeCount` was
    // already computed over it while the total was `agents.length`, so the
    // sub-line mixed two different lists and could not be added up by a reader.
    expect(/\(liveAgents\.length - activeCount\)/.test(c)).toBe(true)
    // And the headline number agrees with the caveat printed under it.
    expect(/\$statAgents\.textContent = String\(liveAgents\.length\)/.test(c)).toBe(true)
  })
})

describe('the dependency graph draws the graph rather than a pipeline', () => {
  it('draws an edge per reported dependency', () => {
    // The old page topologically sorted the tasks and drew an arrow between
    // each CONSECUTIVE pair, which renders as a linear pipeline whatever the
    // real graph is. The page now builds its edge list from
    // `tasks[].dependencies` and draws only those.
    const c = executableSource()
    expect(/edges\.push/.test(c)).toBe(true)
    expect(/\.dependencies\b/.test(c)).toBe(true)
  })

  it('says so when there is no graph to draw', () => {
    // A graph with no edges rendered as a row of boxes is indistinguishable
    // from a linear pipeline unless the page says the edges are absent.
    expect(/No task reports any dependency/.test(executableSource())).toBe(true)
  })

  it('reports the edges and nodes it could not draw', () => {
    // A dependency pointing at a task that is not in the snapshot, a task with
    // no id, and a dependency cycle are all cases where a layout can quietly
    // imply a structure the data does not have. Each is counted and said out
    // loud rather than dropped.
    const c = executableSource()
    expect(/dangling/.test(c)).toBe(true)
    expect(/idless/.test(c)).toBe(true)
    expect(/cycleCount/.test(c)).toBe(true)
    // A task listing ITSELF as a dependency, too. It was dropped from the
    // graph with no note, while every other undrawable edge beside it was
    // counted — and a self-edge is a data fault rather than a missing task: the
    // task is present, so it cannot be reported as dangling, and it will STALL
    // rather than fail, which is the version of this bug nobody notices.
    expect(/selfDep/.test(c)).toBe(true)
    expect(/list themselves as a dependency/.test(c)).toBe(true)
    // Counted separately rather than folded into `dangling`, because folding it
    // in would tell a reader chasing a bad id to look for a task that is right
    // there in the snapshot.
    expect(/dep === t\.id\) \{ selfDep\+\+; continue; \}/.test(c)).toBe(true)
  })

  it('does not claim the layout is optimal', () => {
    // Longest-path layering, not crossing-minimisation. The page says which,
    // so a reader who spots crossing edges knows it is the layout and not the
    // data.
    expect(/crossing-minimis/i.test(html)).toBe(true)
  })
})

describe('the auto-refresh is consistent with a getState the server answers', () => {
  it('polls with getState, which the socket replies to', () => {
    // Kept as a user-facing affordance, and it is what makes the README's
    // "auto-refresh every 5 seconds" true rather than aspirational.
    const c = executableSource()
    expect(/type: 'getState'/.test(c)).toBe(true)
    expect(/AUTO_REFRESH_INTERVAL = 5000/.test(c)).toBe(true)
  })

  it('labels the snapshot by its age rather than by when it asked', () => {
    // "Updated HH:MM:SS" was written when the request went out, so it claimed
    // a freshness the page had not yet confirmed.
    const c = executableSource()
    expect(/ago\)/.test(c)).toBe(true)
    expect(/STALE_AFTER_MS/.test(c)).toBe(true)
  })
})

/**
 * The unbilled figure, and the eviction block underneath it.
 *
 * This half EXECUTES the page's function rather than grepping it, because the
 * bug it pins is a missing branch — and a grep cannot tell a three-way
 * `if/else` from a two-way one. `uncollectedSummary()` always emits
 * `uncollected.evicted`, at zero, precisely so a consumer can distinguish
 * "nothing was dropped" from "this build does not report drops". The page
 * collapsed both into the same empty suffix, so a server that reported no
 * evictions at all rendered identically to one that had dropped nothing — and
 * the page is where a user decides whether the number in front of them is
 * complete.
 */
describe('the unbilled stat distinguishes "none evicted" from "not reported"', () => {
  /**
   * One named function's source, brace-matched out of the page.
   *
   * Brace counting is naive about braces inside string literals, which is a
   * real caveat and not a hypothetical one: the page's prose is full of `{`.
   * It is sound here because the functions pulled are the small numeric and
   * formatting helpers plus the two under test, none of which contain a brace
   * in a string — and because `extracted` is asserted to be non-empty below, so
   * a match that silently found the wrong span fails rather than passing.
   */
  function functionSource(name: string): string {
    const src = executableSource()
    const start = src.indexOf(`function ${name}(`)
    if (start === -1) throw new Error(`dashboard/index.html has no function ${name}`)
    let depth = 0
    let opened = false
    for (let i = start; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') { depth++; opened = true }
      else if (ch === '}') {
        depth--
        if (opened && depth === 0) return src.slice(start, i + 1)
      }
    }
    throw new Error(`unbalanced braces while extracting ${name}`)
  }

  /** A cost report with an `uncollected` block, at the given eviction count. */
  function reportWith(evicted: Record<string, number> | null): Record<string, unknown> {
    const uncollected: Record<string, unknown> = {
      sessions: 2,
      lastKnownTokens: 4000,
      observedUncollected: 0.05,
      taskIds: ['node-1', 'node-2'],
      entries: [],
    }
    // `null` means the key is DELETED, not set to null — the server's type
    // says the block is always present, so an absent key is exactly the
    // "older or non-conforming build" case the three-way rendering exists for.
    if (evicted !== null) uncollected.evicted = evicted
    return { totalSpent: 1, budgetRemaining: 9, uncollected }
  }

  /** Run the page's own `renderUnbilledStat` over a report; return what it wrote. */
  function render(report: Record<string, unknown>): { value: string; sub: string } {
    const deps = ['num', 'fmt$', 'asObject', 'evictedSuffix', 'renderUnbilledStat']
      .map(functionSource)
      .join('\n')
    const $statUnbilled = { textContent: '' }
    const $statUnbilledSub = { textContent: '' }
    // Non-vacuity: if extraction ever returns nothing, the function under test
    // is missing and this must not quietly pass on an empty string.
    expect(deps).toContain('function renderUnbilledStat')

    const make = new Function(
      '$statUnbilled', '$statUnbilledSub', 'costReport', 'costReportStatus',
      `${deps}\nreturn renderUnbilledStat;`,
    )
    const renderUnbilledStat = make($statUnbilled, $statUnbilledSub, report, 'ready')
    renderUnbilledStat()
    return { value: $statUnbilled.textContent, sub: $statUnbilledSub.textContent }
  }

  const ZERO = { sessions: 0, lastKnownTokens: 0, observedUncollected: 0, cap: 200 }
  const SOME = { sessions: 3, lastKnownTokens: 9000, observedUncollected: 0.21, cap: 200 }

  it('says the server does not report evictions when the block is absent', () => {
    const out = render(reportWith(null))
    // THE ASSERTION. Before the fix this was byte-identical to the zero case
    // below, which is the whole defect: a report that never mentioned drops
    // rendered as a report that said nothing was dropped.
    expect(out.sub).toContain('evictions NOT reported')
    expect(out.sub).not.toContain('0 evicted')
    // The figure itself is unaffected — only the claim about its completeness.
    expect(out.value).toBe('≥ $0.05')
  })

  it('says the itemised list is complete when the block is present and zero', () => {
    const out = render(reportWith({ ...ZERO }))
    expect(out.sub).toContain('0 evicted')
    expect(out.sub).toContain('list is complete')
    expect(out.sub).not.toContain('NOT reported')
  })

  it('says how many were evicted when the block is present and positive', () => {
    const out = render(reportWith({ ...SOME }))
    expect(out.sub).toContain('3 evicted')
    expect(out.sub).not.toContain('NOT reported')
    expect(out.sub).not.toContain('list is complete')
  })

  it('gives the three cases three DIFFERENT strings', () => {
    // The regression-guard form: pairwise distinct is what actually forbids
    // two of the branches collapsing back into one, which is how the original
    // bug got in.
    const absent = render(reportWith(null)).sub
    const zero = render(reportWith({ ...ZERO })).sub
    const positive = render(reportWith({ ...SOME })).sub
    expect(new Set([absent, zero, positive]).size).toBe(3)
  })

  it('reports the same three cases in the Accounting panel', () => {
    // That panel builds its rows inline rather than through `evictedSuffix`, so
    // it cannot share the executed test. Pinned at source level, with the
    // wording named so a reword that drops a state fails here too.
    const c = executableSource()
    expect(/not reported by this server/.test(c)).toBe(true)
    expect(/the itemised list is complete/.test(c)).toBe(true)
    // And the positive branch still reports the evicted MONEY, not just a
    // count — that figure is in no other block.
    expect(/of which evicted from the itemised list/.test(c)).toBe(true)
  })
})

// Note on what is deliberately NOT here: an assertion that the new element ids
// reach the served bytes. `dashboard-contract.test.ts` already greps every
// `getElementById` target out of this file and checks it against the server's
// response, so the ids added here — `sessions-container`, `session-count`,
// `orphan-banner`, `orch-status`, `stat-sessions`, `stat-unbilled`,
// `budget-alert`, `dag-note`, `cost-by-agent`, `cost-accounting`,
// `cost-status`, `cost-basis` — are covered by that check without this file
// binding a port of its own. Duplicating the server setup to assert the same
// thing a second time would be a test that passes for the wrong reason.
