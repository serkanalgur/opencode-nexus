import { describe, it, expect, mock, afterAll } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `initialize` loads config from homedir(); sandbox it so this suite never
// touches the developer's real global config. Must run before the import.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-providers-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
import { providerLabels } from '../src/model-groups'
import type { CostProvenance } from '../src/types'

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * The cost report carries provider DISPLAY NAMES, and carries no cost.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * `getCostReport()` is the one payload the dashboard reads for its cost charts,
 * and it is also the payload documented as the record of where pricing came
 * from (`provenance`, `measuredSpend` / `estimatedSpend`, `measuredEntries` /
 * `estimatedEntries`, and the README's "Pricing provenance" section). Adding a
 * provider catalogue to it therefore has to be provably inert with respect to
 * money, or the one document a reader trusts to reconcile spend has become a
 * document where a label can move a number.
 *
 * So the central assertion here is not "the report has a `providers` key" — it
 * is that two orchestrators holding an IDENTICAL ledger, differing only in
 * whether the host reported provider names, produce reports whose every numeric
 * field is equal. That is asserted by diffing the parsed reports field by
 * field, with the `providers` key removed first, so a future field added to the
 * report is covered by default rather than by remembering to list it here.
 *
 * ── WHY THE LEDGER IS BUILT WITH `trackCost` ──
 *
 * `trackCost` is public and deterministic: it is pure arithmetic over its
 * arguments plus `checkBudget()` / `notifyStateChange()`. Driving a real
 * `execute()` instead would put wall-clock durations and async session reads in
 * the comparison, so the two reports would differ for reasons that have nothing
 * to do with the field under test, and the assertion would be quietly weakened
 * into "close enough".
 */

const MEASURED: CostProvenance = { usage: 'measured', pricing: 'model-costs' }
const ESTIMATED: CostProvenance = { usage: 'estimated', pricing: 'fallback-table' }

/** What the host reports for `opencode-go` — verified live against models.dev. */
const NAMED_PROVIDERS = [
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
]

/**
 * A context whose `provider` domain is either present with `providers`, absent
 * entirely, or present but throwing.
 *
 * All three are real: `ProviderDomain` is optional on nothing (the host's
 * `Context` always declares it), but this suite's job is to prove the loader is
 * defensive about the ways it can come back empty, since a `ctx` from an older
 * host has no `provider` at all.
 */
function makeCtx(provider: 'named' | 'absent' | 'throws' | 'malformed') {
  const ctx: Record<string, unknown> = {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-providers-')) },
    model: { list: mock(() => Promise.resolve({ data: [] })) },
    session: { create: mock(() => Promise.resolve({ id: 'ses_x' })) },
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve([])) },
  }
  if (provider === 'absent') return ctx
  if (provider === 'throws') {
    ctx.provider = { list: mock(() => Promise.reject(new Error('provider API unavailable'))) }
  } else if (provider === 'malformed') {
    ctx.provider = {
      list: mock(() =>
        Promise.resolve({
          data: [
            { id: 'opencode-go', name: 'OpenCode Go' },
            { id: 'nameless' },
            { id: 'blank', name: '' },
            { id: 'wrongname', name: 42 },
            { id: '', name: 'No Id' },
            null,
            'not-an-object',
          ],
        }),
      ),
    }
  } else {
    ctx.provider = { list: mock(() => Promise.resolve({ data: NAMED_PROVIDERS })) }
  }
  return ctx
}

/** The identical ledger both orchestrators are given. Provider never appears. */
const LEDGER: ReadonlyArray<readonly [string, string, number, number, CostProvenance]> = [
  ['agent-1', 'opencode-go/minimax-m2.5-free', 0, 500, ESTIMATED],
  ['agent-1', 'anthropic/claude-sonnet-4-6', 1.25, 20_000, MEASURED],
  ['agent-2', 'openai/gpt-5-mini', 0.75, 4_000, MEASURED],
  ['agent-2', 'anthropic/claude-haiku-4-5', 0.5, 3_000, MEASURED],
  // A bare id: no provider half, so it cannot be given a heading by a name.
  ['agent-3', 'mystery-model', 0.25, 90, MEASURED],
]

async function reportFor(
  provider: 'named' | 'absent' | 'throws' | 'malformed',
): Promise<Record<string, unknown>> {
  const orchestrator = new NexusOrchestrator({
    schedulerInterval: 1,
    selfHealing: {
      enabled: false,
      maxRetries: 3,
      retryDelay: 0,
      contextTransfer: false,
    },
  })
  await orchestrator.initialize(makeCtx(provider) as never)
  for (const [agentId, model, cost, tokens, provenance] of LEDGER) {
    orchestrator.trackCost(agentId, model, cost, tokens, provenance)
  }
  const report = JSON.parse(orchestrator.getCostReport()) as Record<string, unknown>
  await orchestrator.shutdown()
  return report
}

/** The report with the label catalogue removed — i.e. the money. */
function moneyOf(report: Record<string, unknown>): Record<string, unknown> {
  const { providers: _providers, ...rest } = report
  return rest
}

describe('the cost report carries provider display names', () => {
  it('reports the host\'s names, and only providers the host actually named', async () => {
    const report = await reportFor('named')
    // The catalogue the host reported, verbatim: `opencode-go` resolves to
    // `OpenCode Go`, which is the whole reason this payload exists.
    expect(report.providers).toEqual([
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'openai', name: 'OpenAI' },
    ])
  })

  it('keeps a provider whose name the host got wrong, and omits the name rather than storing it', async () => {
    const report = await reportFor('malformed')
    // The loader does NOT filter the name: deciding what counts as a usable label
    // belongs to `providerLabels`, and restating that rule here is exactly what
    // produced two loaders that could disagree. So `nameless`, `blank` and
    // `wrongname` are STORED — with no `name` at all, because `getProviderList`
    // omits one it cannot vouch for. Asserting the exact array pins all three
    // properties at once: the rows survive, the name is never `""` or `42`, and
    // nothing is invented.
    expect(report.providers).toEqual([
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'nameless' },
      { id: 'blank' },
      { id: 'wrongname' },
    ])
    // No entry may carry a name that is not a non-empty string. This is the
    // "never a blank heading" property stated over the WHOLE catalogue rather
    // than over the three rows it happens to apply to.
    for (const entry of report.providers as Array<{ id: string; name?: unknown }>) {
      if ('name' in entry) expect(entry.name).toBeTypeOf('string')
      if (typeof entry.name === 'string') expect(entry.name.length).toBeGreaterThan(0)
    }
    // And the rows with no usable KEY are still dropped, because a `Map` keyed on
    // `undefined` is a broken data structure rather than a formatting
    // preference: `{ id: '' }`, `null` and `'not-an-object'` are all absent above.
    const ids = (report.providers as Array<{ id: string }>).map((p) => p.id)
    expect(ids).not.toContain('')
  })

  // The chain the previous test sets up, end to end: a row the host named badly
  // reaches the consumer through the shared resolver and still produces a USABLE
  // label. The failure this guards is a blank group header, which is strictly
  // worse than an ugly raw id because it cannot be told apart from "provider
  // exists but has no name yet".
  it('resolves a malformed row to a usable label, never a blank heading', async () => {
    const report = await reportFor('malformed')
    const label = providerLabels(report.providers as Array<{ id: string; name?: string }>)

    expect(label('opencode-go')).toBe('OpenCode Go')
    // The three badly-named rows each fall back to their own id: present,
    // non-blank, and unmistakably a provider.
    for (const id of ['nameless', 'blank', 'wrongname']) {
      expect(label(id)).toBe(id)
      expect(label(id)?.length).toBeGreaterThan(0)
    }
  })

  it('reports an empty catalogue — never a crash — when the host has no provider API', async () => {
    const absent = await reportFor('absent')
    const threw = await reportFor('throws')
    // An ABSENT `providers` key would be worse than an empty one: the page
    // distinguishes "no catalogue" from "no value" only by the key being there.
    expect(Object.hasOwn(absent, 'providers')).toBe(true)
    expect(absent.providers).toEqual([])
    expect(threw.providers).toEqual([])
  })

  it('resolves through the shared helper, so the page and the picker cannot disagree', async () => {
    const report = await reportFor('named')
    // The catalogue is consumed by the SAME resolver the TUI picker uses, and
    // the types line up without a cast: `ProviderLabelSource` is exactly
    // `{ readonly id: string; readonly name?: string }`.
    const label = providerLabels(report.providers as Array<{ id: string; name?: string }>)
    expect(label('opencode-go')).toBe('OpenCode Go')
    // The fallback is the shared rule's, not a new one invented here.
    expect(label('never-heard-of-it')).toBe('never-heard-of-it')
    expect(label(undefined)).toBeUndefined()
  })
})

describe('a provider list changes no number in the cost report', () => {
  it('leaves every figure identical, field for field, to a report with no names', async () => {
    const withNames = await reportFor('named')
    const withoutNames = await reportFor('absent')

    // The catalogues genuinely differ, so the comparison below is not vacuous.
    expect(withNames.providers).not.toEqual(withoutNames.providers)

    // THE assertion that matters. Diffed as whole objects rather than field by
    // field, so any figure added to the report later is covered automatically —
    // a hand-written list of keys is a list that silently goes stale.
    expect(moneyOf(withNames)).toEqual(moneyOf(withoutNames))
  })

  it('leaves the spend split and the provenance block byte-identical', async () => {
    const withNames = await reportFor('named')
    const withoutNames = await reportFor('absent')

    // Named explicitly because these are the fields the README documents as the
    // record of where pricing came from, and because a plausible-looking
    // mistake is for a label lookup to be folded into a measured/estimated sum.
    for (const key of [
      'totalSpent',
      'measuredSpend',
      'estimatedSpend',
      'measuredEntries',
      'estimatedEntries',
      'provenance',
      'byAgent',
      'byModel',
      'tokensByModel',
      'uncollected',
      'budgetRemaining',
    ] as const) {
      expect({ key, value: withNames[key] }).toEqual({ key, value: withoutNames[key] })
    }
    // And the split still reconciles, so the equality above is not two reports
    // that are both wrong in the same way.
    expect(
      (withNames.measuredSpend as number) + (withNames.estimatedSpend as number),
    ).toBeCloseTo(withNames.totalSpent as number, 12)
  })

  it('does not put a provider into a total by way of a model ref', async () => {
    const report = await reportFor('named')
    // `byModel` is keyed by the raw `"provider/id"` ref and is not regrouped or
    // relabelled: a name is a heading, never a key.
    expect(Object.keys(report.byModel as Record<string, number>).sort()).toEqual(
      LEDGER.map(([, model]) => model).sort(),
    )
    const sum = Object.values(report.byModel as Record<string, number>).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(report.totalSpent as number, 12)
  })
})
