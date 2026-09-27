import { describe, it, expect, afterAll, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `nexus.model.costs` with NO `model` argument — the branch that lists every
 * model — END TO END, through the real plugin.
 *
 * The grouping itself is `renderModelCostReport` (`src/index.ts`), which is
 * exercised directly here for the cases that are awkward to provoke through the
 * tool. What the boot exercises is the seam the unit tests cannot reach: that
 * `loadModelCosts` writes per-1K rates, that the per-million → per-1K →
 * per-million round trip the shared formatter requires survives it, and that the
 * bare-id bucket is reachable through the tool's OWN set branch rather than only
 * by poking the public map from a test.
 *
 * WHY THE CROSS-SURFACE TEST MATTERS MOST. The TUI picker and this tool read the
 * same catalogue through different lenses — `ModelInfo.cost` in raw
 * USD-per-million, `modelCosts` normalised to per-1K — and the only thing
 * keeping their numbers equal is that both go through `formatModelPrice`. A
 * future edit that passes per-1K numbers to it directly would print every price
 * 1000x too small (`$0.000003/1K tokens` for a $3/M model) and NO test written
 * against a literal string would catch it, because the expected value would move
 * with the bug. So the expectation is computed by calling `formatModelPrice` on
 * the RAW cost array — the same argument the picker passes — and compared for
 * byte equality.
 *
 * SANDBOXING: `setup()` writes the orchestrator agent file into the global
 * config directory, and `os.homedir()` does not follow `process.env.HOME` under
 * `bun test`, so the module is mocked before the plugin loads. Same pattern as
 * `test/git-check-tool.test.ts`.
 *
 * KNOWN DIVERGENCE, asserted rather than hidden. For a model that publishes ONLY
 * context tiers, the picker says "lowest tier … no base price" and this tool says
 * "tiered above N". The NUMBERS are identical; the annotation is not, and cannot
 * be: `normaliseTiers` has already replaced the missing base with a synthetic one
 * before the value is stored, and the two are structurally indistinguishable
 * afterwards. The test pins the numbers as equal and the annotation as inheriting
 * `normaliseTiers`, so a change in either is visible rather than silent.
 */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-costs-report-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { default: plugin, renderModelCostReport } = await import('../src/index')
const { formatModelPrice } = await import('../src/model-groups')

afterAll(() => {
  mock.module('node:os', () => realOs)
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

/** USD per MILLION, exactly as OpenCode reports them. */
const SONNET_RAW = [{ input: 3, output: 15 }]
/** A context tier and no untiered base, i.e. a model that publishes tiers only. */
const TIER_ONLY_RAW = [
  { tier: { type: 'context', size: 200000 }, input: 3, output: 6 },
  { tier: { type: 'context', size: 1000000 }, input: 9, output: 18 },
]

const CATALOGUE = [
  { providerID: 'opencode-go', id: 'space-bunny-free', name: 'Space Bunny', cost: [{ input: 0, output: 0 }] },
  { providerID: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', cost: SONNET_RAW },
  { providerID: 'anthropic', id: 'tier-only', name: 'Tier Only', cost: TIER_ONLY_RAW },
]

const PROVIDERS = [
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'anthropic', name: 'Anthropic' },
]

/**
 * Boot the real plugin over a catalogue and hand back its registered tools.
 *
 * `model.list()` feeds `loadModelCosts`; `provider.list()` supplies the display
 * names. The provider domain is optional on the context type and is what the
 * report degrades without, so the context mirrors the shape in
 * `test/git-check-tool.test.ts` plus these two.
 */
async function bootPlugin(models: unknown, providers: unknown = { data: PROVIDERS }) {
  const tools = new Map<string, { execute: (input: unknown) => Promise<{ content: string }> }>()
  const projectDir = mkdtempSync(join(tmpdir(), 'nexus-costs-report-'))
  // Held in a mutable holder so a test can change what the host WOULD report
  // after boot. The tool must not notice, and proving that needs the ability to
  // change it.
  const providerList: { current: unknown } = { current: providers }
  const ctx = {
    location: { directory: projectDir },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }) },
    storage: { set: () => Promise.resolve(), get: () => Promise.resolve(null) },
    model: { list: () => Promise.resolve({ data: models }) },
    provider: { list: () => Promise.resolve(providerList.current) },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          namespace: () => {},
          add: (tool: { name: string; execute: (input: unknown) => Promise<{ content: string }> }) => tools.set(tool.name, tool),
        })
      },
      list: () => Promise.resolve([]),
    },
    session: {
      create: () => Promise.resolve({ id: 'ses_x' }),
      prompt: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      context: () => Promise.resolve([]),
      background: () => Promise.resolve(),
      hook: () => Promise.resolve(),
    },
  }
  const cleanup = await plugin.setup(ctx as never)
  return { tools, cleanup: cleanup as () => void, providerList }
}

/** Call `nexus.model.costs` and return its text result. */
async function costs(
  booted: Awaited<ReturnType<typeof bootPlugin>>,
  input: Record<string, unknown> = {},
): Promise<string> {
  const tool = booted.tools.get('model.costs')
  if (!tool) throw new Error('nexus.model.costs is not registered')
  return (await tool.execute(input)).content
}

/** The heading lines of a report, i.e. the lines that are not indented rows. */
function headings(report: string): string[] {
  return report.split('\n').filter(line => line.length > 0 && !line.startsWith(' ') && !line.startsWith('(') && !line.startsWith('📊'))
}

describe('model.costs — the all-models report is grouped by provider', () => {
  it('renders two providers as two headings, ordered by display name', async () => {
    const booted = await bootPlugin(CATALOGUE)
    const report = await costs(booted)

    // Display name, not id: `opencode-go` sorts after `anthropic` by id, and
    // `Anthropic` sorts before `OpenCode Go` by name — the same order either way
    // here, so the ALPHABETICAL check that matters is asserted separately below.
    expect(headings(report)).toEqual(['Anthropic', 'OpenCode Go'])

    // Each provider's models are one contiguous block, which is the whole point:
    // the host picker groups by first appearance for the same reason.
    const lines = report.split('\n')
    const anthropic = lines.indexOf('Anthropic')
    const opencode = lines.indexOf('OpenCode Go')
    expect(anthropic).toBeGreaterThan(-1)
    expect(opencode).toBeGreaterThan(anthropic)
    expect(lines[anthropic + 1]).toContain('anthropic/claude-sonnet-4-6')
    expect(lines[anthropic + 2]).toContain('anthropic/tier-only')
    expect(lines[opencode + 1]).toContain('opencode-go/space-bunny-free')

    booted.cleanup()
  })

  it('orders providers by display name rather than by id', () => {
    // `zzz-first` is the alphabetically FIRST id and the LAST display name, so
    // the two orders disagree and the heading must follow the name.
    const report = renderModelCostReport(
      new Map([
        ['zzz-first/model', { tiers: [{ rates: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 } }] }],
        ['aaa-last/model', { tiers: [{ rates: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 } }] }],
      ]),
      [{ id: 'zzz-first', name: 'Aardvark' }, { id: 'aaa-last', name: 'Zebra' }],
    )
    expect(headings(report)).toEqual(['Aardvark', 'Zebra'])
  })

  it('sorts models by id within a provider', () => {
    const rates = { rates: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 } }
    const report = renderModelCostReport(
      new Map([
        ['anthropic/zeta', { tiers: [rates] }],
        ['anthropic/alpha', { tiers: [rates] }],
        ['anthropic/mid', { tiers: [rates] }],
      ]),
      [{ id: 'anthropic', name: 'Anthropic' }],
    )
    const rows = report.split('\n').filter(line => line.startsWith('  '))
    expect(rows.map(row => row.trim().split(':')[0])).toEqual([
      'anthropic/alpha',
      'anthropic/mid',
      'anthropic/zeta',
    ])
  })

  it('puts a bare-id key in the ungrouped bucket, still listed, under no fabricated provider', async () => {
    const booted = await bootPlugin(CATALOGUE)
    // The tool's own set branch, which documents bare ids as accepted keys. This
    // is the reachable path, not a test-only mutation of the public map.
    await costs(booted, { model: 'hand-priced', setInput: 0.01, setOutput: 0.05 })
    const report = await costs(booted)

    expect(headings(report)).toEqual(['No provider (bare model id)', 'Anthropic', 'OpenCode Go'])

    // Listed, with a real price, and not folded into either real provider.
    expect(report).toContain('  hand-priced: in=$0.01/1K tokens, out=$0.05/1K tokens')
    const ungroupedAt = report.indexOf('No provider (bare model id)')
    const ungroupedRow = report.slice(ungroupedAt).split('\n').findIndex(line => line.startsWith('  hand-priced'))
    expect(ungroupedRow).toBe(1)

    // The claim that matters: a bare id is never filed under a provider heading
    // it does not belong to. `providerIDFromRef` returns `undefined` for a
    // slashless ref rather than `slice(0, -1)`, which would have produced the
    // fabricated provider `hand-pric`.
    expect(report).not.toContain('hand-pric:')
    expect(report).not.toContain('hand-pric\n')

    booted.cleanup()
  })

  it('prints a price byte-identical to what the picker prints for the same model', async () => {
    const booted = await bootPlugin(CATALOGUE)
    const report = await costs(booted)

    // Computed from the RAW per-million cost array, which is exactly the argument
    // `src/tui.tsx` passes: `description: formatModelPrice(model.cost)`.
    const pickerText = formatModelPrice(SONNET_RAW)
    expect(pickerText).toBe('in=$0.003/1K tokens, out=$0.015/1K tokens')

    const line = report.split('\n').find(l => l.includes('anthropic/claude-sonnet-4-6'))
    expect(line).toBe(`  anthropic/claude-sonnet-4-6: ${pickerText}`)

    // And the unit survived the round trip the adapter performs: a $3/M model is
    // $0.003 per 1K, not $0.000003. A raw pass-through of the stored per-1K value
    // would render this line as `$0.000003/1K tokens`.
    expect(line).not.toContain('$0.000003')

    booted.cleanup()
  })

  it('renders a tier-only model with its rates and a threshold, never blank and never $0', async () => {
    const booted = await bootPlugin(CATALOGUE)
    const report = await costs(booted)

    const line = report.split('\n').find(l => l.includes('anthropic/tier-only')) ?? ''
    // The numbers match the picker's exactly, even though the annotation cannot:
    // `normaliseTiers` has already substituted a synthetic base by the time the
    // value is stored, so `hasBase` is indistinguishable from a published one.
    expect(line).toContain(`in=${'$0.003'}/1K tokens, out=${'$0.006'}/1K tokens`)
    expect(line).toContain('tiered above 200000 prompt tokens')

    // The falsifiable half: not blank, and not a false zero.
    expect(line.trim()).not.toBe('anthropic/tier-only:')
    expect(line).not.toContain('in=$0/1K tokens')
    expect(line).not.toContain('in=$0.000/1K tokens')
    // OpenCode's own fallback for this shape is a hard zero, which is the one
    // answer this report must never print.
    expect(line).not.toMatch(/in=\$0\/1K tokens, out=\$0\/1K tokens/)

    booted.cleanup()
  })

  it('distinguishes an empty price store from a populated one', async () => {
    const empty = await bootPlugin([])
    const emptyReport = await costs(empty)
    const populated = await bootPlugin(CATALOGUE)
    const populatedReport = await costs(populated)

    // The empty case says so in words and names the fallback it will use, so a
    // reader cannot mistake "nothing loaded" for "here is your pricing". The
    // populated case opens with a heading and rows. The two are told apart by the
    // text, not by the absence of a line, following the memory-store precedent.
    expect(emptyReport).toBe('No real pricing data loaded. Using labelled fallback estimates.')
    expect(emptyReport).not.toBe(populatedReport)
    expect(populatedReport).toContain('📊 Model Pricing')
    expect(populatedReport).toContain('anthropic/claude-sonnet-4-6')
    expect(emptyReport).not.toContain('📊 Model Pricing')

    empty.cleanup()
    populated.cleanup()
  })

  it('announces a truncation instead of hiding providers silently', () => {
    const models = new Map<string, { tiers: { rates: { input: number; output: number; cacheRead: number; cacheWrite: number } }[] }>()
    const providers = []
    // 20 providers, two models each: past the cap of 12.
    for (let i = 0; i < 20; i++) {
      const id = `p${String(i).padStart(2, '0')}`
      providers.push({ id, name: `P${i}` })
      for (let j = 0; j < 2; j++) {
        models.set(`${id}/m${j}`, { tiers: [{ rates: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 } }] })
      }
    }
    const report = renderModelCostReport(models, providers)

    expect(headings(report)).toHaveLength(12)
    // Silent truncation would satisfy the cap while defeating the point of it, so
    // the count is stated, in both units: the cap counts providers, the reader
    // counts models.
    expect(report).toContain('(showing 12 of 20 groups, 24 of 40 models')
    expect(report).toContain('not listed)')

    // A report that fits is NOT annotated, so the annotation cannot be mistaken
    // for decoration.
    const small = new Map([...models].slice(0, 4))
    expect(renderModelCostReport(small, providers)).not.toContain('showing')
  })

  // ── Where the display names come from ──
  //
  // These two tests are the executable form of the decision that the tool reads
  // the ORCHESTRATOR's provider catalogue rather than running its own
  // `ctx.provider.list()` per call. Before, the tool fetched live and the
  // dashboard read the boot-time snapshot, so a rename mid-session printed two
  // different headings for the same models. There is no test that can assert two
  // surfaces agree on data one of them does not fetch; what these assert is the
  // property that makes agreement possible — ONE snapshot, read from one place.

  it('reads the provider names the orchestrator loaded at boot, not a live fetch', async () => {
    const booted = await bootPlugin(CATALOGUE)
    const before = await costs(booted)
    expect(headings(before)).toEqual(['Anthropic', 'OpenCode Go'])

    // The host now reports something completely different. A per-call fetch
    // would print it; the shared snapshot must not.
    booted.providerList.current = { data: [{ id: 'anthropic', name: 'Renamed' }] }
    const after = await costs(booted)

    // Anchored to literals, not to `before`, so this cannot pass by both sides
    // being equally wrong.
    expect(headings(after)).toEqual(['Anthropic', 'OpenCode Go'])
    expect(after).not.toContain('Renamed')
    // The models and prices are untouched by the label snapshot, which is the
    // other half of the claim.
    expect(after).toContain('anthropic/claude-sonnet-4-6')

    booted.cleanup()
  })

  it('degrades a badly-named provider to its raw id, never to a blank heading', async () => {
    // The loader stores the row; `getProviderList` omits a name it cannot vouch
    // for; `providerLabels` resolves the rest. The chain is only worth anything
    // if the last link is tested, and this is the case that link exists for.
    const booted = await bootPlugin(
      [
        ...CATALOGUE,
        { providerID: 'opencode-go-2', id: 'extra', cost: SONNET_RAW },
        { providerID: 'openrouter', id: 'extra', cost: SONNET_RAW },
      ],
      {
        data: [
          { id: 'opencode-go', name: 'OpenCode Go' },
          { id: 'anthropic' },
          { id: 'opencode-go-2', name: '' },
          { id: 'openrouter', name: 42 },
        ],
      },
    )
    const report = await costs(booted)

    // The good name is used; the three bad ones are their own raw ids. No
    // provider is dropped, and none of them merges into a named group. Every one
    // of these providers has at least one model, so every one of them is a group:
    // a provider with no models produces no heading, which is why the fixture
    // gives each of the four a model to file.
    //
    // THE ORDER IS `localeCompare`, and that is worth stating rather than
    // absorbing: it puts `anthropic` BEFORE `OpenCode Go`, because locale
    // collation compares `a` to `O` as letters rather than as code units. The
    // dashboard page sorts the same labels by CODE UNIT and would put them the
    // other way round. The two surfaces therefore agree on the sort KEY (the
    // display label) and not on the collation — a real, now-demonstrated
    // divergence, and the reason `groupByProvider` in the page keeps a
    // code-unit comparator: the page is tested under Bun's ICU, not a browser's,
    // so a `localeCompare` there would pin the assertion to the wrong runtime.
    expect(headings(report)).toEqual(['anthropic', 'OpenCode Go', 'opencode-go-2', 'openrouter'])
    // Every heading is non-blank. A blank group header is strictly worse than an
    // ugly one: it cannot be told apart from "provider exists, name not loaded".
    for (const heading of headings(report)) expect(heading.trim()).not.toBe('')
    // And the models under a badly-named provider are still listed, with prices.
    expect(report).toContain('anthropic/claude-sonnet-4-6')
    expect(report).toContain('opencode-go-2/extra')
    expect(report).toContain('openrouter/extra')

    booted.cleanup()
  })

  it('leaves the single-model branch alone', async () => {
    const booted = await bootPlugin(CATALOGUE)
    const single = await costs(booted, { model: 'anthropic/claude-sonnet-4-6' })

    // Unchanged: the model is named, and the four-rate per-tier form is kept.
    // This branch is the one place cache rates remain visible, which is why the
    // grouped list dropping them loses nothing.
    expect(single).toContain('anthropic/claude-sonnet-4-6 (real pricing, from OpenCode)')
    expect(single).toContain('base: in=$0.003/1K tokens, out=$0.015/1K tokens, cache_read=$0/1K tokens, cache_write=$0/1K tokens')
    // No provider heading: the caller already named the model, and the argument
    // may be a bare id, which has no provider to label.
    expect(single).not.toContain('Anthropic\n')
    expect(single).not.toContain('📊 Model Pricing')

    booted.cleanup()
  })
})

describe('renderModelCostReport — the pure grouping', () => {
  const rates = { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 }

  it('falls back to the raw provider id when no provider list is available', () => {
    const report = renderModelCostReport(
      new Map([['opencode-go/m', { tiers: [{ rates }] }]]),
      undefined,
    )
    // A cosmetically worse heading about the same models: every model still
    // present, every price still right.
    expect(headings(report)).toEqual(['opencode-go'])
    expect(report).toContain('  opencode-go/m: in=$0.001/1K tokens, out=$0.002/1K tokens')
  })

  it('labels a model that published no price rather than printing a false zero or a blank', () => {
    // `loadModelCosts` skips such a model and `setModelCosts` always writes one
    // tier, so reaching this needs the public mutable map — but the row must
    // still be listed and still must not read as free.
    const report = renderModelCostReport(new Map([['acme/ghost', { tiers: [] }]]), [{ id: 'acme', name: 'Acme' }])
    expect(report).toContain('  acme/ghost: no published price')
    expect(report).not.toContain('$0/1K tokens')
    expect(report).not.toMatch(/acme\/ghost:\s*$/)
  })

  it('merges two providers that share a display name without losing a model', () => {
    const report = renderModelCostReport(
      new Map([
        ['one/shared', { tiers: [{ rates }] }],
        ['two/shared', { tiers: [{ rates }] }],
      ]),
      [{ id: 'one', name: 'Same Name' }, { id: 'two', name: 'Same Name' }],
    )
    expect(headings(report)).toEqual(['Same Name'])
    expect(report).toContain('one/shared')
    expect(report).toContain('two/shared')
  })

  it('keeps a two-slash ref whole, so the provider is the first segment only', () => {
    // `openrouter/anthropic/claude-sonnet-4-5` arrives through the
    // cloudflare-ai-gateway Unified-API loader. `split("/")` would file it under
    // `openrouter` with the model `claude-sonnet-4-5`; the ref helper slices on
    // the first slash, so the provider is `openrouter` and the row keeps its full
    // key.
    const report = renderModelCostReport(
      new Map([['openrouter/anthropic/claude-sonnet-4-5', { tiers: [{ rates }] }]]),
      [{ id: 'openrouter', name: 'OpenRouter' }],
    )
    expect(headings(report)).toEqual(['OpenRouter'])
    expect(report).toContain('openrouter/anthropic/claude-sonnet-4-5')
  })

  it('keeps the bare-id bucket exempt from the provider cap', () => {
    const models = new Map<string, { tiers: { rates: typeof rates }[] }>()
    const providers = []
    for (let i = 0; i < 20; i++) {
      const id = `p${String(i).padStart(2, '0')}`
      providers.push({ id, name: `P${i}` })
      models.set(`${id}/m`, { tiers: [{ rates }] })
    }
    models.set('hand-priced', { tiers: [{ rates: { input: 0.01, output: 0.05, cacheRead: 0, cacheWrite: 0 } }] })

    const report = renderModelCostReport(models, providers)
    // These are hand-priced entries the user most likely just set; a truncated
    // bucket is the one cap that would hide a price someone is looking for.
    expect(report).toContain('  hand-priced: in=$0.01/1K tokens, out=$0.05/1K tokens')
    // And the totals still add up with the bucket counted as its own group: 20
    // providers of one model each, plus the bare-id entry.
    expect(report).toContain('(showing 13 of 21 groups, 13 of 21 models')
  })

  it('treats an empty or absent map as the empty case, not as a crash', () => {
    const expected = 'No real pricing data loaded. Using labelled fallback estimates.'
    expect(renderModelCostReport(new Map(), PROVIDERS)).toBe(expected)
    expect(renderModelCostReport(undefined, PROVIDERS)).toBe(expected)
  })
})
