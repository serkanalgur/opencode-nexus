import { describe, it, expect } from 'bun:test'
import { providerIDFromRef, providerLabels } from '../src/model-groups'
import { logEntryCap, extractInlineScript, readDashboardHtml } from './helpers/dashboard-page'
import {
  loadDashboardPage,
  PARSE_FAILURE,
  RENDER_FAILURE,
  type LoadedPage,
} from './helpers/dashboard-dom'

/**
 * The dashboard's two model tables, grouped by provider.
 *
 * This is the third of three surfaces that group models by provider, and the
 * first one that is a BROWSER PAGE rather than a module. The other two import
 * `src/model-groups.ts`. This one cannot: the page is a single hand-written
 * inline script with no build step and no module system, and it is inlined into
 * the server bundle as text (`src/dashboard.ts`), so there is no step at which
 * the copy inside it could be made to BE the shared module.
 *
 * That leaves a duplicated `providerIDFromRef`, which is exactly the "two copies
 * of a rule, neither checked against the other" defect class this repository
 * keeps finding. So the last describe block in this file is the one that matters
 * most: it drives the page's own renderer and compares what came out against
 * what `src/model-groups.ts` says for the same input, on refs chosen to include
 * the two cases that have broken a split before — a ref with a second slash
 * (`openrouter/anthropic/claude-sonnet-4-5`) and a bare id with no slash at all
 * (`slice(0, -1)` on which would eat a character and produce a plausible-looking
 * provider).
 *
 * WHY THESE ASSERT ON THE PAGE'S OWN ERROR LOG
 *
 * `ws.onmessage` catches render failures by design, so "nothing was thrown at
 * the harness" would pass on a page that failed to render every frame — that is
 * the mistake the `liveAgents` TDZ bug got away with, and the whole reason
 * `test/helpers/dashboard-dom.ts` exists. `failures()` below therefore reads the
 * log a user reads, exactly as `dashboard-page-execution.test.ts` does, and
 * fails on the two markers the page uses for "I could not draw this".
 */

const MAX_LOG_ENTRIES = logEntryCap(extractInlineScript(await readDashboardHtml()))

/**
 * Render failures the page logged since `from`, counting only new entries.
 *
 * A DELTA, and refusal to answer once the log is full, for the reason spelled out
 * at the `failuresSince` in `dashboard-page-execution.test.ts`: the activity log
 * evicts its oldest entries, so past the cap "nothing was logged" and "the
 * failure was evicted" are the same observation. Throwing is the honest answer.
 */
function failures(page: LoadedPage, from: number): string[] {
  const all = page.activityMessages()
  if (all.length >= MAX_LOG_ENTRIES) {
    throw new Error(
      `the activity log is full (${all.length}/${MAX_LOG_ENTRIES}) — a failure logged since the mark ` +
        'has already been evicted, so this probe cannot tell failure from silence. Load a fresh page.',
    )
  }
  return all
    .slice(0, all.length - from)
    .filter((m) => m.includes(RENDER_FAILURE) || m.includes(PARSE_FAILURE))
}

/** How many log entries exist now. Pass this to `failures` BEFORE acting. */
const mark = (page: LoadedPage): number => page.activityMessages().length

/**
 * A cost ledger whose `byModel` keys INTERLEAVE once sorted by spend.
 *
 * The interleaving is the point, not decoration. `renderCost` sorts by spend
 * before grouping, so on this input a renderer that did not regroup would emit
 * `anthropic`, `openai`, `anthropic` — two headers for one provider, which is
 * the failure the TUI task found in the host's own first-appearance grouping.
 * Nothing in the payload asks for grouping; the page has to do it.
 */
const BY_MODEL: Record<string, number> = {
  'anthropic/claude-sonnet-4-6': 3.0,
  'openai/gpt-5-mini': 1.5,
  'anthropic/claude-haiku-4-5': 1.0,
  // Two slashes. The provider is `openrouter` and the model id keeps its
  // `anthropic/` namespace; `split("/")` would report the model as
  // `claude-sonnet-4-5` and lose it.
  'openrouter/anthropic/claude-sonnet-4-5': 0.5,
  // A bare id: a real model the server billed under, with no provider half.
  'mystery-model': 0.25,
}

const TOTAL = 6.25

/** `/api/costs`, with `byModel` above and a budget ceiling to scale against. */
const COST_ROUTES = {
  '/api/costs': {
    totalSpent: TOTAL,
    budgetRemaining: 3.75,
    measuredSpend: 5.0,
    estimatedSpend: 1.25,
    measuredEntries: 7,
    estimatedEntries: 2,
    byAgent: { 'agent-1': TOTAL },
    byModel: BY_MODEL,
    tokensByModel: {
      'anthropic/claude-sonnet-4-6': 20_000,
      'openai/gpt-5-mini': 4_000,
      'anthropic/claude-haiku-4-5': 3_000,
      'openrouter/anthropic/claude-sonnet-4-5': 1_200,
      'mystery-model': 90,
    },
    uncollected: { sessions: 0, lastKnownTokens: 0, observedUncollected: 0, entries: [], evicted: null },
  },
  '/api/health': { uptime: 1_000 },
}

/** A state snapshot carrying only what the config panel reads. */
function stateWithModels(models: Record<string, unknown>): unknown {
  return {
    running: true,
    paused: false,
    lastUpdated: '2026-01-01T12:00:00.000Z',
    agents: [],
    tasks: [],
    sessions: [],
    totalSpent: TOTAL,
    budgetRemaining: 3.75,
    config: { models, budget: { maxTotalCost: 10 } },
  }
}

// ── Reading the chart back out of the page's markup ──────────────────────────

/** One thing the page drew: a provider header, or a bar. */
type ChartEvent =
  | { readonly kind: 'header'; readonly provider: string }
  | {
      readonly kind: 'bar'
      readonly label: string
      readonly dollars: number
      readonly widthPct: number
      readonly color: string
    }

/**
 * The `#cost-by-model` chart as an ordered list of headers and bars.
 *
 * Parsed from the rendered markup rather than from any structure the page was
 * never told about, so what is under test is the output a user would see. The
 * two markers are matched in ONE pass so that order is read off document
 * position, which is the only thing that makes "one contiguous run per provider"
 * a checkable statement rather than a count.
 */
function readChart(html: string): ChartEvent[] {
  const events: ChartEvent[] = []
  const marker = /<div class="provider-group-title">([^<]*)<\/div>|<div class="cost-bar-row">/g
  let found = marker.exec(html)
  while (found !== null) {
    if (found[1] !== undefined) {
      events.push({ kind: 'header', provider: found[1] })
    } else {
      // A row's own markup runs to the next row or to the total footer; both are
      // top-level markers, so neither can be swallowed by the slice.
      const rest = html.slice(found.index)
      const next = rest.slice(1).search(/<div class="(?:cost-bar-row|cost-total-row)">/)
      const row = next === -1 ? rest : rest.slice(0, next + 1)
      const label = /class="cost-bar-label" title="([^"]*)"/.exec(row)
      const value = /class="cost-bar-value">\$([\d,]+(?:\.\d+)?)/.exec(row)
      const width = /cost-bar-fill" style="width:([\d.]+)%/.exec(row)
      const colour = /background:(#[0-9a-fA-F]+)/.exec(row)
      if (label === null || value === null || width === null || colour === null) {
        throw new Error(`a bar row in the chart is not in the shape this reader knows:\n${row}`)
      }
      events.push({
        kind: 'bar',
        label: label[1] as string,
        dollars: Number((value[1] as string).replace(/,/g, '')),
        widthPct: Number(width[1]),
        color: colour[1] as string,
      })
    }
    found = marker.exec(html)
  }
  return events
}

const headersOf = (events: readonly ChartEvent[]): string[] =>
  events.filter((e) => e.kind === 'header').map((e) => (e.kind === 'header' ? e.provider : ''))

type ChartBar = Extract<ChartEvent, { kind: 'bar' }>

const barsOf = (events: readonly ChartEvent[]): ChartBar[] =>
  events.filter((e): e is ChartBar => e.kind === 'bar')

/**
 * Load the page, hand it the ledger above, and return the chart it drew.
 *
 * `providers` is the `getCostReport().providers` catalogue. It defaults to
 * ABSENT, which is deliberate: every pre-existing test in this file then
 * exercises the raw-id fallback, so the "no names available" path stays the
 * default rather than becoming a case nothing reaches.
 */
async function chartFor(
  byModel: Record<string, number>,
  providers?: Array<{ id: string; name?: string }>,
): Promise<{
  page: LoadedPage
  events: ChartEvent[]
  logged: string[]
}> {
  const payload: Record<string, unknown> = {
    ...(COST_ROUTES['/api/costs'] as Record<string, unknown>),
    byModel,
  }
  if (providers !== undefined) payload.providers = providers
  const page = await loadDashboardPage({
    routes: {
      '/api/costs': payload,
      '/api/health': { uptime: 1_000 },
    },
  })
  page.open()
  await page.settle()
  const before = mark(page)
  // A state frame is what drives `renderConfig`; delivered here too so the
  // failure probe covers every renderer the page ran, not just the chart's.
  page.deliver({ type: 'orchestrator:state', data: stateWithModels({}), timestamp: 'now' })
  await page.settle()
  return { page, events: readChart(page.html('cost-by-model')), logged: failures(page, before) }
}

// ── The chart ─────────────────────────────────────────────────────────────────

describe('the By Model chart is grouped by provider without changing a number', () => {
  it('draws one header per provider, in provider order, and the page logs nothing', async () => {
    const { events, logged } = await chartFor(BY_MODEL)
    expect(logged).toEqual([])
    // Alphabetical by provider id, which is what the other two surfaces do, and
    // `mystery-model` is NOT among them: it has no provider to name.
    expect(headersOf(events)).toEqual(['anthropic', 'openai', 'openrouter'])
  })

  it('gives every provider exactly ONE contiguous run, even when the data interleaves', async () => {
    const { events } = await chartFor(BY_MODEL)
    // The provider each bar is actually under, read off the header above it.
    const under: Array<{ provider: string | null; label: string }> = []
    let current: string | null = null
    for (const event of events) {
      if (event.kind === 'header') current = event.provider
      else under.push({ provider: current, label: event.label })
    }
    // Spend order interleaves the two anthropic bars around openai's, so this
    // is a real assertion about the regroup and not about a sorted fixture.
    expect(under.map((r) => r.label)).toEqual([
      'mystery-model',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5-mini',
      'openrouter/anthropic/claude-sonnet-4-5',
    ])
    // Each provider seen once, and its bars never split by another provider.
    expect(headersOf(events).length).toBe(new Set(headersOf(events)).size)
    for (const provider of headersOf(events)) {
      const runs = under.filter((r) => r.provider === provider).length
      expect(runs).toBeGreaterThan(0)
      const first = under.findIndex((r) => r.provider === provider)
      const last = under.map((r) => r.provider).lastIndexOf(provider)
      expect(last - first + 1).toBe(runs)
    }
  })

  it('still bills every bar its own cost, and the footer still sums them all', async () => {
    const { page, events } = await chartFor(BY_MODEL)
    const bars = barsOf(events)
    // Every key drawn, exactly once, and each bar worth what the ledger says.
    // A grouping that folded a bar into a group total, dropped one, or
    // re-scaled a width would fail here even though the headers all looked
    // right — which is the failure that matters on a cost chart.
    expect(bars.map((b) => b.label).sort()).toEqual(Object.keys(BY_MODEL).sort())
    for (const bar of bars) {
      expect({ label: bar.label, dollars: bar.dollars }).toEqual({
        label: bar.label,
        dollars: BY_MODEL[bar.label as string],
      })
    }
    // Bar length is still each entry's share of the $10 ceiling — unchanged by
    // grouping, which moved rows and nothing else.
    for (const bar of bars) {
      expect(bar.widthPct).toBeCloseTo(((BY_MODEL[bar.label as string] as number) / 10) * 100, 1)
    }
    const summed = bars.reduce((total, b) => total + b.dollars, 0)
    expect(summed).toBeCloseTo(TOTAL, 10)
    expect(page.html('cost-by-model')).toContain(
      `<span class="cost-total-value">$${TOTAL.toFixed(2)}</span>`,
    )
  })

  it('puts a model with no provider in the ungrouped bucket, drawn and unheaded', async () => {
    const { events } = await chartFor(BY_MODEL)
    // FIRST, so it cannot read as belonging to the group above it — there is
    // nothing above it. The TUI picker reaches the same place by sorting an
    // uncategorised option under the empty category.
    expect(events[0]?.kind).toBe('bar')
    expect(barsOf(events)[0]?.label).toBe('mystery-model')
    // And no header anywhere claims a provider for it: every header is a
    // provider some OTHER ref in this ledger actually has.
    const realProviders = Object.keys(BY_MODEL)
      .map((ref) => providerIDFromRef(ref))
      .filter((id): id is string => id !== undefined)
    for (const header of headersOf(events)) expect(realProviders).toContain(header)
    expect(headersOf(events)).not.toContain('mystery')
  })

  it('draws no group header for an empty ledger', async () => {
    const { page, events, logged } = await chartFor({})
    expect(logged).toEqual([])
    expect(page.html('cost-by-model')).toContain('Nothing recorded yet')
    expect(page.html('cost-by-model')).not.toContain('provider-group-title')
    expect(events).toEqual([])
  })

  it('keeps a single-model chart, and a one-provider chart, honest', async () => {
    const single = await chartFor({ 'anthropic/claude-sonnet-4-6': 2 })
    expect(headersOf(single.events)).toEqual(['anthropic'])
    expect(barsOf(single.events).map((b) => b.dollars)).toEqual([2])

    // Two models, one provider: ONE header, not one per bar. The failure a
    // per-key header would produce.
    const twoSameProvider = await chartFor({
      'anthropic/claude-sonnet-4-6': 2,
      'anthropic/claude-haiku-4-5': 1,
    })
    expect(headersOf(twoSameProvider.events)).toEqual(['anthropic'])
    expect(barsOf(twoSameProvider.events).length).toBe(2)
  })
})

// ── The role table ───────────────────────────────────────────────────────────

/**
 * Roles whose ALPHABETICAL order interleaves providers.
 *
 * `architect` and `documenter` are anthropic, `coder` and `explorer` are openai,
 * and alphabetically that is anthropic, openai, anthropic, openai — so a page
 * that emitted the provider once per role would interleave its own headers, and
 * a page that never regrouped at all would have nothing to assert against.
 */
const ROLE_MODELS: Record<string, unknown> = {
  architect: 'anthropic/claude-sonnet-4-6',
  coder: 'openai/gpt-5-mini',
  documenter: 'anthropic/claude-haiku-4-5',
  explorer: 'openai/gpt-4o',
  // A bare id, and a role whose model was not reported at all. Neither has a
  // provider, so neither may be given one.
  tester: 'mystery-model',
  documenter2: null,
}

/** `#config-models` as an ordered list of headers and role keys. */
function readRolePanel(html: string): Array<{ header: string | null; key: string | null }> {
  const events: Array<{ header: string | null; key: string | null }> = []
  const marker =
    /<div class="config-group-head provider-group-title">([^<]*)<\/div>|<span class="config-key">([^<]*)<\/span>/g
  let found = marker.exec(html)
  while (found !== null) {
    if (found[1] !== undefined) events.push({ header: found[1], key: null })
    else events.push({ header: null, key: found[2] })
    found = marker.exec(html)
  }
  return events
}

/** Load the page, deliver the role map above, and return what it drew. */
async function rolePanelFor(
  models: Record<string, unknown>,
  providers?: Array<{ id: string; name?: string }>,
): Promise<{
  page: LoadedPage
  events: ReturnType<typeof readRolePanel>
  logged: string[]
}> {
  const payload = { ...(COST_ROUTES['/api/costs'] as Record<string, unknown>) }
  if (providers !== undefined) payload.providers = providers
  const page = await loadDashboardPage({
    routes: { '/api/costs': payload, '/api/health': { uptime: 1_000 } },
  })
  page.open()
  await page.settle()
  const before = mark(page)
  page.deliver({
    type: 'orchestrator:state',
    data: stateWithModels(models),
    timestamp: 'now',
  })
  await page.settle()
  return { page, events: readRolePanel(page.html('config-models')), logged: failures(page, before) }
}

describe('the Models per Role panel groups by provider and still shows every role', () => {
  it('draws one header per provider, in provider order, and the page logs nothing', async () => {
    const { events, logged } = await rolePanelFor(ROLE_MODELS)
    expect(logged).toEqual([])
    const headers = events.filter((e) => e.header !== null).map((e) => e.header)
    expect(headers).toEqual(['anthropic', 'openai'])
  })

  it('nests each role under its own provider, contiguously, and every role exactly once', async () => {
    const { page, events } = await rolePanelFor(ROLE_MODELS)
    const under: Array<{ provider: string | null; key: string | null }> = []
    let current: string | null = null
    for (const event of events) {
      if (event.header !== null) current = event.header
      else under.push({ provider: current, key: event.key })
    }
    // Unreported-model and bare-id roles lead, unheaded; then the providers, each
    // one run, roles alphabetical within their run.
    expect(under.map((r) => [r.provider, r.key])).toEqual([
      [null, '🤖 documenter2'],
      [null, '🧪 tester'],
      ['anthropic', '🏗️ architect'],
      ['anthropic', '📝 documenter'],
      ['openai', '💻 coder'],
      ['openai', '🔭 explorer'],
    ])
    // Every configured role is still present, and the map still maps it to the
    // FULL ref — grouping did not shorten a value or merge two roles into one.
    const rows = page.configRows('config-models')
    expect(Object.keys(rows).length).toBe(Object.keys(ROLE_MODELS).length)
    expect(rows['🏗️ architect']).toBe('anthropic/claude-sonnet-4-6')
    expect(rows['💻 coder']).toBe('openai/gpt-5-mini')
    expect(rows['🔭 explorer']).toBe('openai/gpt-4o')
    expect(rows['🧪 tester']).toBe('mystery-model')
    expect(rows['🤖 documenter2']).toBe('not reported')
  })

  it('gives a role with no provider no heading, and draws the empty state unchanged', async () => {
    const bare = await rolePanelFor({ tester: 'mystery-model' })
    // The single role is drawn, and it is the first thing drawn — so there is
    // no heading above it inventing a provider for a bare id.
    expect(bare.events).toEqual([{ header: null, key: '🧪 tester' }])
    expect(bare.page.html('config-models')).not.toContain('provider-group-title')

    // The two pre-existing empty/unreported branches are untouched by grouping.
    const empty = await rolePanelFor({})
    expect(empty.page.html('config-models')).toContain('empty')
    expect(empty.page.html('config-models')).not.toContain('provider-group-title')
    expect(empty.logged).toEqual([])

    const noConfig = await loadDashboardPage({ routes: COST_ROUTES })
    noConfig.open()
    await noConfig.settle()
    const before = mark(noConfig)
    noConfig.deliver({
      type: 'orchestrator:state',
      data: { ...(stateWithModels({}) as Record<string, unknown>), config: null },
      timestamp: 'now',
    })
    expect(failures(noConfig, before)).toEqual([])
    expect(noConfig.html('config-models')).toContain('state.config not reported')
    expect(noConfig.html('config-models')).not.toContain('provider-group-title')
  })

  it('says out loud that the headers are display names, and when they fall back to ids', async () => {
    // Stated on the page rather than left for a reader to trip over. Static
    // markup, so it is asserted on the markup.
    //
    // COMMENTS ARE STRIPPED BEFORE THE PROBE, and that is load-bearing rather
    // than tidiness. The paragraph sits directly below an explanatory HTML
    // comment that quotes the same tokens (`/api/costs`, `opencode-go`,
    // `OpenCode Go`), and a probe run over the raw capture satisfied every
    // assertion below from the COMMENT while the sentence a user reads could say
    // the opposite. A test that guards a sentence must read the sentence.
    const html = await readDashboardHtml()
    const group = /<div class="config-group">\s*<div class="config-group-title">🤖 Models per Role<\/div>([\s\S]*?)<\/div>\s*<div class="config-group">/.exec(
      html,
    )
    expect(group).not.toBeNull()
    const note = (group?.[1] ?? '').replace(/<!--[\s\S]*?-->/g, '')
    // The claim under test: headers are DISPLAY NAMES now, sourced from the
    // cost payload, matching the TUI picker — and a provider we could not name
    // keeps its raw id rather than going blank.
    expect(note).toContain('Grouped by provider')
    expect(note).toContain('display names')
    expect(note).toContain('providers')
    expect(note).toContain('/api/costs')
    expect(note).toContain('opencode-go')
    expect(note).toContain('OpenCode Go')
    expect(note).toMatch(/raw ID|raw id/)
    // And the now-FALSE claim is gone: this payload does carry names, so saying
    // otherwise would be the defect.
    expect(note).not.toContain("reports a provider's display name")
    expect(note).not.toMatch(/neither\s+<code>\/api/)
  })
})

// ── The duplicated rule, checked against the shared one ──────────────────────

describe('the page\'s provider split agrees with src/model-groups.ts', () => {
  /**
   * Refs chosen to break a split rather than to please one.
   *
   * `providerIDFromRef` returns `undefined` for a bare id precisely so that a
   * caller can tell "no provider" from "provider exists, name unknown". The page
   * has no `undefined` to distinguish, so it returns `null` — and this block
   * asserts the two agree on WHERE the boundary is, which is the part a careless
   * rewrite (`ref.split('/')[0]`) would get wrong for three of the five.
   */
  const REFS = [
    'anthropic/claude-sonnet-4-6',
    'openrouter/anthropic/claude-sonnet-4-5',
    'mystery-model',
    'a/b/c/d',
    '/leading-slash',
    'trailing/',
  ] as const

  it('places every ref under the provider the shared helper names', async () => {
    const byModel: Record<string, number> = {}
    // Descending spend, so the ORDER the page receives them in is the reverse of
    // the assertion order and grouping cannot be an accident of insertion.
    REFS.forEach((ref, i) => {
      byModel[ref] = REFS.length - i
    })
    const { events } = await chartFor(byModel)

    const under: Array<{ provider: string | null; label: string }> = []
    let current: string | null = null
    for (const event of events) {
      if (event.kind === 'header') current = event.provider
      else under.push({ provider: current, label: event.label })
    }
    expect(under.map((r) => r.label).sort()).toEqual([...REFS].sort())
    // One assertion per ref, and DELIBERATELY not written as
    // `expect({page, shared}).toEqual({page, shared})` — an earlier draft built
    // both sides from the same two expressions, so it compared the page against
    // itself and passed on a page whose split was `ref.split('/')[0]`. The two
    // sides must come from different sources or the check is decoration.
    for (const row of under) {
      expect({ ref: row.label, drawnUnder: row.provider }).toEqual({
        ref: row.label,
        drawnUnder: providerIDFromRef(row.label) ?? null,
      })
    }
  })

  // NAMED FOR WHAT IT CHECKS, which is the PAGE's ordering and nothing else.
  // It used to be called "orders the groups the way the shared helper's sort
  // would", and `src/model-groups.ts` HAS NO SORT — the claim was never true.
  // Ordering is the one rule the three surfaces cannot share verbatim, because
  // they do not even share a comparator: the tool and the picker use the
  // locale-dependent `localeCompare`, and this page uses a code-unit comparison.
  // So this is a page-local assertion, deliberately NOT a parity check, and the
  // reason is worth keeping in the name: the SPLIT rule and the LABEL rule above
  // ARE copies of shared rules and are checked against the shared functions;
  // the ORDER is a shared DECISION with three implementations, and pinning it to
  // one collation would pin CI's ICU to a user's browser.
  //
  // Every provider in this fixture is unnamed, so label and id are the same
  // string and the order is unambiguous under either comparator. That is
  // deliberate — it keeps this test about the ungrouped bucket and the split, and
  // out of a collation argument it cannot settle. `Émile` would be the provider
  // that breaks it.
  it('leads with the no-provider rows, then orders the named groups by provider id', async () => {
    const { events } = await chartFor(Object.fromEntries(REFS.map((r, i) => [r, i + 1])))
    // Built from `providerIDFromRef` itself rather than restated, so this
    // compares the page against the shared SPLIT rule instead of against a third
    // copy of it living in a test. There is no shared ORDER to build from.
    const providers = REFS.map((ref) => providerIDFromRef(ref)).filter((id) => id !== undefined)
    expect(headersOf(events)).toEqual([...new Set(providers)].sort())
    // And the refs with no provider lead, with no header of their own — and they
    // are the two the shared helper calls `undefined`: a bare id, and one whose
    // only slash is at index 0. (`trailing/` DOES have a provider here — the
    // slice is on the first slash, and index 8 is > 0.)
    const ungrouped = REFS.filter((ref) => providerIDFromRef(ref) === undefined)
    expect(ungrouped.length).toBeGreaterThan(1)
    // In the order the page receives them: this fixture's spend is `i + 1`, so
    // the incoming order is REFS reversed. Derived rather than restated.
    const incoming = [...REFS].reverse()
    expect(barsOf(events).slice(0, ungrouped.length).map((b) => b.label)).toEqual(
      incoming.filter((ref) => ungrouped.includes(ref)),
    )
    for (const ref of ungrouped) expect(headersOf(events)).not.toContain(ref)
  })

  it('labels every group the way providerLabels would, from the same catalogue', async () => {
    // The display name is a SECOND copy of a shared rule, so it gets the same
    // parity check the split does. `providerLabels` is the function the TUI
    // picker calls, fed the SAME catalogue the page was fed — so if the page's
    // copy and the helper ever diverge, one of these two sides moves and the
    // comparison fails.
    const { events, logged } = await chartFor(BY_MODEL, PROVIDERS)
    expect(logged).toEqual([])
    const label = providerLabels(PROVIDERS)

    // Built from the shared helper, and DERIVED from each header's own refs
    // rather than restated — no literal provider list on this side.
    const under: Array<{ label: string; drawnHeader: string }> = []
    let current: string | null = null
    for (const event of events) {
      if (event.kind === 'header') current = event.provider
      else under.push({ label: event.label, drawnHeader: current ?? '' })
    }
    expect(under.length).toBe(Object.keys(BY_MODEL).length)
    for (const row of under) {
      expect({ ref: row.label, drawnHeader: row.drawnHeader }).toEqual({
        ref: row.label,
        drawnHeader: label(providerIDFromRef(row.label)) ?? '',
      })
    }
  })
})

// ── Display names ────────────────────────────────────────────────────────────

/**
 * What the host reports, including the shapes that must degrade.
 *
 * `opencode-go` → `OpenCode Go` is verified live against models.dev. The
 * remaining entries are the cases `providerLabels` in `src/model-groups.ts`
 * exists for: a provider with no name, a provider whose name is empty, and a
 * provider the host never mentioned at all. All three must render.
 */
const PROVIDERS: Array<{ id: string; name?: string }> = [
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'nameless' },
  { id: 'blank', name: '' },
]

/**
 * A ledger that actually CONTAINS a provider the catalogue names.
 *
 * `BY_MODEL` cannot be reused for the name tests: it holds anthropic, openai
 * and openrouter, none of which `PROVIDERS` names, so every heading would come
 * out the same with and without a catalogue and the tests would prove nothing.
 * Two providers is the minimum that also gives the contiguity and ordering
 * rules something to do.
 */
const NAMED_BY_MODEL: Record<string, number> = {
  'opencode-go/minimax-m2.5-free': 2,
  'anthropic/claude-sonnet-4-6': 1,
}

/** The catalogue that names `NAMED_BY_MODEL`'s providers, plus the degenerate ones. */
const NAMED_CATALOGUE: Array<{ id: string; name?: string }> = [
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'nameless' },
  { id: 'blank', name: '' },
]

describe('the page resolves provider display names from the cost payload', () => {
  it('prints the display name as the group heading, where it used to print the id', async () => {
    const { events, logged } = await chartFor(NAMED_BY_MODEL, NAMED_CATALOGUE)
    expect(logged).toEqual([])
    // THE headline: the same provider the TUI calls `OpenCode Go`.
    expect(headersOf(events)).toContain('OpenCode Go')
    expect(headersOf(events)).toContain('Anthropic')
    // …and the raw id is gone from the headings entirely, which is the whole
    // inconsistency this closes.
    expect(headersOf(events)).not.toContain('opencode-go')
    expect(headersOf(events)).not.toContain('anthropic')
  })

  it('falls back to the raw id for a provider with a missing or empty name', async () => {
    const { events, logged } = await chartFor(
      {
        'nameless/model-one': 2,
        'blank/model-two': 1,
        'opencode-go/minimax-m2.5-free': 0.5,
      },
      NAMED_CATALOGUE,
    )
    expect(logged).toEqual([])
    // Expected order is DERIVED, not restated: grouped and sorted by the LABEL
    // the page prints, which is the shared rule, with the raw id as the
    // tie-break. Restating the literals would sort them by DISPLAY name in this
    // test's own collation (and `Intl` collation is not the page's), which is
    // the mistake the test that follows this one used to encode.
    const label = providerLabels(NAMED_CATALOGUE)
    const expected = [
      ...new Set(
        Object.keys({
          'nameless/model-one': 0,
          'blank/model-two': 0,
          'opencode-go/minimax-m2.5-free': 0,
        }).map((ref) => providerIDFromRef(ref)),
      ),
    ]
      // `providerLabels` is typed `string | undefined` because `undefined` is
      // its answer for "no provider"; every id here came from
      // `providerIDFromRef`, so a name is guaranteed. Asserted rather than
      // filtered, so a helper that started returning `undefined` here would
      // fail instead of quietly shrinking the expected list to match.
      .map((id) => {
        const resolved = label(id)
        expect(resolved).toBeTypeOf('string')
        return resolved as string
      })
      // Code-unit, to match the page's comparator. `localeCompare` here would
      // order these differently (`OpenCode Go` before `blank`) and would be
      // asserting this test runner's ICU rather than the page's rule.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    // `OpenCode Go` really does lead under code-unit order, which is the whole
    // point: the label decides, and `opencode-go` is not what is being compared.
    expect(headersOf(events)).toEqual(expected)
    expect(expected).toEqual(['OpenCode Go', 'blank', 'nameless'])
    expect(expected).toContain('nameless')
    expect(expected).toContain('blank')
    // A missing or empty name must never become a BLANK heading, and must never
    // borrow another provider's name. Both would be worse than the ugly id.
    for (const header of headersOf(events)) {
      expect(header.trim()).not.toBe('')
    }
    expect(headersOf(events)).not.toContain('')
    // Scoped to the two degenerate providers rather than the whole header list:
    // `opencode-go` really IS named `OpenCode Go`, so a blanket
    // `not.toContain('OpenCode Go')` would be asserting a falsehood. What must
    // not happen is `nameless` or `blank` BORROWING a name — so each must still
    // be present under its own raw id, and appear exactly once.
    const degenerate = headersOf(events).filter((h) => h === 'nameless' || h === 'blank')
    expect(degenerate.sort()).toEqual(['blank', 'nameless'])
  })

  it('falls back to the raw id for a provider the host never mentioned', async () => {
    const { events, logged } = await chartFor({ 'never-heard-of-it/m': 1 }, NAMED_CATALOGUE)
    expect(logged).toEqual([])
    expect(headersOf(events)).toEqual(['never-heard-of-it'])
  })

  it('names the role panel from the same catalogue as the chart', async () => {
    const { events, logged } = await rolePanelFor(
      { architect: 'opencode-go/minimax-m2.5-free', coder: 'anthropic/claude-sonnet-4-6' },
      [{ id: 'opencode-go', name: 'OpenCode Go' }, { id: 'anthropic', name: 'Anthropic' }],
    )
    expect(logged).toEqual([])
    const headers = events.filter((e) => e.header !== null).map((e) => e.header)
    // Sorted by raw id: anthropic before opencode-go.
    expect(headers).toEqual(['Anthropic', 'OpenCode Go'])
  })

  it('re-renders the role panel when the names arrive after its state frame', async () => {
    // The role panel is driven by the socket while the names ride the cost
    // fetch, so without an explicit re-render the two panels disagree for up to
    // one refresh cycle. The frame is delivered FIRST here, so the page has
    // already drawn raw ids before it learns any names.
    const page = await loadDashboardPage({
      routes: {
        '/api/costs': {
          ...(COST_ROUTES['/api/costs'] as Record<string, unknown>),
          byModel: { 'opencode-go/minimax-m2.5-free': 1 },
          providers: [{ id: 'opencode-go', name: 'OpenCode Go' }],
        },
        '/api/health': { uptime: 1_000 },
      },
    })
    page.open()
    // The cost fetch is what populates the names; hold it back by delivering
    // the state frame first, then letting the fetch settle.
    page.deliver({
      type: 'orchestrator:state',
      data: stateWithModels({ architect: 'opencode-go/minimax-m2.5-free' }),
      timestamp: 'now',
    })
    await page.settle()

    const headers = readRolePanel(page.html('config-models'))
      .filter((e) => e.header !== null)
      .map((e) => e.header)
    expect(headers).toEqual(['OpenCode Go'])
  })
})

describe('a provider list changes nothing numeric on the page', () => {
  it('draws identical bars, widths and totals with and without names', async () => {
    const named = await chartFor(NAMED_BY_MODEL, NAMED_CATALOGUE)
    const unnamed = await chartFor(NAMED_BY_MODEL)

    // The headings differ, which is the only difference there should be.
    expect(headersOf(named.events)).not.toEqual(headersOf(unnamed.events))
    expect(headersOf(named.events)).toContain('OpenCode Go')

    // Bars, compared as whole objects: label, dollars, width AND colour. A
    // width or a value that moved with the presence of a label would be the
    // exact regression this file is here to prevent.
    expect(barsOf(named.events)).toEqual(barsOf(unnamed.events))
    expect(named.logged).toEqual([])
    expect(unnamed.logged).toEqual([])

    // And the footer total, read from the markup rather than recomputed, so a
    // page that stopped rendering it fails instead of quietly agreeing.
    const totalOf = (p: LoadedPage): string | undefined =>
      /<span class="cost-total-value">\$([\d,.]+)<\/span>/.exec(p.html('cost-by-model'))?.[1]
    expect(totalOf(named.page)).toBe(totalOf(unnamed.page))
    // The footer's own meaning is "Sum of these entries", so the expected value
    // is the sum of the BARS, derived from the fixture — not the report's
    // `totalSpent`, which is a different number on purpose (this fixture bills
    // less into `byModel` than the ledger's headline).
    const barSum = Object.values(NAMED_BY_MODEL).reduce((a, b) => a + b, 0)
    expect(totalOf(named.page)).toBe(barSum.toFixed(2))

    // Bar widths really are each entry's share of the ceiling, with names on.
    for (const bar of barsOf(named.events)) {
      expect(bar.widthPct).toBeCloseTo(
        ((NAMED_BY_MODEL[bar.label as string] as number) / 10) * 100,
        1,
      )
    }
  })

  it('orders the groups by display name even when the ids would sort differently', async () => {
    // `zeta` is labelled `Alpha` and `alpha` is labelled `Zeta`, so the two
    // orders are opposites. The page follows the LABEL, which is what
    // `renderModelCostReport` and `buildModelOptions` both do — this used to
    // follow the id, and it was the one rule the three surfaces did not share.
    const { events } = await chartFor(
      { 'zeta/m': 2, 'alpha/m': 1 },
      [
        { id: 'zeta', name: 'Alpha' },
        { id: 'alpha', name: 'Zeta' },
      ],
    )
    expect(headersOf(events)).toEqual(['Alpha', 'Zeta'])

    // …and the name is still not a GROUPING key. Two providers, two headers,
    // each with its own model: a display name may order providers, never merge
    // them. Asserted here because this is the test that moves furthest from
    // "id is the only thing that matters".
    expect(headersOf(events)).toHaveLength(new Set(headersOf(events)).size)
    expect(barsOf(events).map((b) => b.label).sort()).toEqual(['alpha/m', 'zeta/m'])
  })
})
