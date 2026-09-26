import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `loadModelCosts` runs inside `initialize`, which also loads config from
// homedir(). Mock it so the suite never reads or writes the developer's real
// global config. This must run before the module under test is loaded.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { selectTier } = await import('../src/forecast')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * `loadModelCosts` used to try two V1-era paths that do not exist in the
 * server plugin context — a `client.model.list()` call and a
 * `data.location.model` call. Both were always skipped, so real pricing never
 * loaded and every cost number came from the hardcoded table.
 *
 * These tests pin the real V2 path (`ctx.model.list()` → `{ data }` →
 * `ModelInfo.cost[]`) and, just as importantly, the UNITS: OpenCode reports
 * `ModelCost` in USD per MILLION tokens while `modelCosts` stores USD per 1K
 * tokens. Getting that conversion wrong is a 1000x error, so the unit
 * assertions below are deliberately written to fail on a raw pass-through.
 *
 * An entry is now a TIERED price list, `{ tiers: [{ threshold?, rates }] }`,
 * because OpenCode bills each model call at the tier its own prompt falls into.
 * `baseRates` reads the untiered base row — which is what these unit tests are
 * about — without indexing `tiers[0]`, so they keep testing the same thing if
 * the ordering guarantee is ever changed.
 */

/** The untiered base row's rates, i.e. the price below every context tier. */
function baseRates(cost: { tiers: readonly { threshold?: number; rates: { input: number; output: number; cacheRead: number; cacheWrite: number } }[] } | undefined) {
  return selectTier(cost?.tiers ?? [], 0).rates
}

function makeCtx(list: unknown, opts: { listThrows?: boolean; omitModel?: boolean } = {}) {
  const models = {
    list: mock(() => opts.listThrows
      ? Promise.reject(new Error('model API unavailable'))
      : Promise.resolve(list)),
  }
  return {
    ctx: {
      location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
      ...(opts.omitModel ? {} : { model: models }),
      session: {
        create: mock(() => Promise.resolve({ id: 'ses_mock' })),
        prompt: mock(() => Promise.resolve()),
        wait: mock(() => Promise.resolve()),
        context: mock(() => Promise.resolve([])),
      },
      storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    },
    listMock: models.list,
  }
}

describe('loadModelCosts — real pricing via ctx.model.list()', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>

  beforeEach(() => {
    orchestrator = new NexusOrchestrator()
  })

  // initialize() starts a 300s cleanup interval; without this the suite leaks
  // live timers for every test.
  afterEach(async () => {
    await orchestrator.shutdown()
  })

  it('converts per-million prices to per-1K when storing them', async () => {
    const { ctx, listMock } = makeCtx({
      data: [{
        providerID: 'anthropic',
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        cost: [{
          tier: { type: 'context', size: 200000 },
          // USD per MILLION tokens, exactly as OpenCode reports them.
          input: 3,
          output: 15,
          cache: { read: 0.3, write: 3.75 },
        }],
      }],
    })

    await orchestrator.initialize(ctx as never)

    expect(listMock).toHaveBeenCalled()
    // Keyed by "providerID/id", valued in USD per 1K tokens. The source row is
    // a CONTEXT tier, so it is kept as one — and because no untiered base was
    // published, a synthetic base is added from cost[0] (see the T6 test).
    expect(orchestrator.modelCosts.get('anthropic/claude-sonnet-4-6')).toEqual({
      tiers: [
        { rates: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } },
        { threshold: 200000, rates: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } },
      ],
    })
    // The per-million → per-1K conversion on a context tier, which is the part
    // that used to be skipped: a raw pass-through would read 3 / 15 here.
    expect(selectTier(orchestrator.modelCosts.get('anthropic/claude-sonnet-4-6')!.tiers, 300_000).rates)
      .toEqual({ input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 })
  })

  it('feeds a per-1K cost figure into the price the ranker uses, not a 1000x-inflated one', async () => {
    const { ctx } = makeCtx({
      data: [{
        providerID: 'anthropic',
        id: 'claude-sonnet-4-6',
        // $3/M in, $15/M out.
        cost: [{ input: 3, output: 15 }],
      }],
    })
    await orchestrator.initialize(ctx as never)

    // The real price reaches the forecaster, in per-1K. This is the load-path
    // assertion that matters: the pre-fix arithmetic kept the per-million figure
    // (or a 1000x-inflated average of it), and everything downstream — the
    // budget filter, the ranker, spend — read that wrong number.
    const resolved = orchestrator.forecaster.priceFor('anthropic/claude-sonnet-4-6')
    expect(resolved.source).toBe('model-costs')
    expect(resolved.pricing.input).toBe(0.003)
    expect(resolved.pricing.output).toBe(0.015)

    // Per-task estimate at complexity 20 (1750/1K in, 875/1K out would be
    // complexity 50; 20 → multiplier 1.6, so 1120 in / 560 out):
    //   1120 / 1K * 0.003 = 0.00336
    //    560 / 1K * 0.015 = 0.0084
    const complexity = {
      overall: 20, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const },
    }
    expect(orchestrator.forecaster.estimateCost(complexity, 'claude-sonnet-4-6', 'anthropic'))
      .toBeCloseTo(0.01176, 12)
    // A 1000x-inflated rate would be ~11.76 here, not 0.01176.
    expect(orchestrator.forecaster.estimateCost(complexity, 'claude-sonnet-4-6', 'anthropic'))
      .toBeLessThan(1)

    // And the budget filter in selectBestModel must not reject the model as
    // unaffordable — the inflated figure excluded every real-priced model.
    const selection = orchestrator.selectBestModel('coder', complexity)
    expect(selection.estimatedCost).toBeLessThan(1)
  })

  it('retains EVERY context tier, base first and ascending, each converted to per-1K', async () => {
    const { ctx } = makeCtx({
      data: [{
        providerID: 'anthropic',
        id: 'tiered',
        // Deliberately out of order, and with a non-context tier mixed in, to
        // pin that normalisation is on WRITE and not a courtesy of the input.
        cost: [
          { tier: { type: 'context', size: 1000000 }, input: 6, output: 12 },
          { tier: { type: 'some-future-type', size: 500 }, input: 99, output: 99 },
          { input: 1, output: 2 },
          { tier: { type: 'context', size: 200000 }, input: 3, output: 6 },
        ],
      }],
    })

    await orchestrator.initialize(ctx as never)

    // Untiered base first, then ascending by threshold. The non-context tier is
    // dropped: OpenCode's cost function only consults `type === "context"` rows
    // and only ever falls back to an untiered one, so keeping it would let a
    // rate the bill never applies compete for selection.
    expect(orchestrator.modelCosts.get('anthropic/tiered')).toEqual({
      tiers: [
        { rates: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 } },
        { threshold: 200000, rates: { input: 0.003, output: 0.006, cacheRead: 0, cacheWrite: 0 } },
        { threshold: 1000000, rates: { input: 0.006, output: 0.012, cacheRead: 0, cacheWrite: 0 } },
      ],
    })
  })

  it('synthesises a base from cost[0] when a model publishes only context tiers', async () => {
    // OpenCode's own fallback here is a hard ZERO, i.e. "this model bills
    // nothing" — the one answer that cannot be right for a model that published
    // prices. A synthetic base keeps it billable instead of reporting a
    // measured $0.
    const { ctx } = makeCtx({
      data: [{
        providerID: 'anthropic',
        id: 'tier-only',
        cost: [
          { tier: { type: 'context', size: 200000 }, input: 3, output: 6 },
          { tier: { type: 'context', size: 1000000 }, input: 9, output: 18 },
        ],
      }],
    })

    await orchestrator.initialize(ctx as never)

    const tiers = orchestrator.modelCosts.get('anthropic/tier-only')!.tiers
    expect(tiers[0].threshold).toBeUndefined()
    expect(tiers[0].rates.input).toBe(0.003)
    // A small prompt bills at the synthetic base rather than nothing.
    expect(selectTier(tiers, 1000).rates.input).toBe(0.003)
    // Over 200k the 200k tier applies — which happens to share cost[0]'s rate,
    // because that is where the synthetic base came from.
    expect(selectTier(tiers, 300000).rates.input).toBe(0.003)
    // Only past 1M does the dearer tier take over.
    expect(selectTier(tiers, 1_000_001).rates.input).toBe(0.009)
  })

  it('skips models with an empty cost array or no cost field', async () => {
    const { ctx } = makeCtx({
      data: [
        { providerID: 'local', id: 'free-model', cost: [] },
        { providerID: 'local', id: 'no-cost-field' },
        { providerID: 'openai', id: 'paid', cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] },
      ],
    })

    await orchestrator.initialize(ctx as never)

    expect(orchestrator.modelCosts.has('local/free-model')).toBe(false)
    expect(orchestrator.modelCosts.has('local/no-cost-field')).toBe(false)
    expect(baseRates(orchestrator.modelCosts.get('openai/paid')))
      .toEqual({ input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 })
  })

  it('resolves pricing by "providerID/id" and by bare id', async () => {
    const { ctx } = makeCtx({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-6', cost: [{ input: 3, output: 15 }] }],
    })
    await orchestrator.initialize(ctx as never)

    const expected = { rates: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } }
    expect(orchestrator.getModelCost('anthropic/claude-sonnet-4-6')).toEqual({ tiers: [expected] })
    // A user typing the bare id (or a caller holding only the tail) still hits.
    expect(orchestrator.getModelCost('claude-sonnet-4-6')).toEqual({ tiers: [expected] })
    // And with an explicit provider the qualified key is preferred.
    expect(baseRates(orchestrator.getModelCost('claude-sonnet-4-6', 'anthropic')).input).toBe(0.003)
  })

  it('keeps both providers when they share a bare model id, cheapest wins on a bare lookup', async () => {
    const { ctx } = makeCtx({
      data: [
        { providerID: 'expensive', id: 'shared', cost: [{ input: 100, output: 100 }] },
        { providerID: 'cheap', id: 'shared', cost: [{ input: 1, output: 1 }] },
      ],
    })
    await orchestrator.initialize(ctx as never)

    // No silent collision — both are addressable.
    expect(orchestrator.modelCosts.has('expensive/shared')).toBe(true)
    expect(orchestrator.modelCosts.has('cheap/shared')).toBe(true)
    // A bare lookup resolves deterministically to the cheaper price instead of
    // whichever provider happened to be written last.
    expect(baseRates(orchestrator.getModelCost('shared')).input).toBe(0.001)
    expect(baseRates(orchestrator.getModelCost('shared', 'expensive')).input).toBe(0.1)
  })

  describe('fallback to the labelled pricing tables', () => {
    // OpenCode bills a model with an empty `cost` array at a hard ZERO. We skip
    // it instead and price it from the labelled fallback table, so the figure
    // says "estimate" rather than reporting a measured $0. These tests pin both
    // halves: the table is reached, and the source label says so.
    const SONNET_FALLBACK = { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 }

    it('when the model list is empty', async () => {
      const { ctx } = makeCtx({ data: [] })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator.modelCosts.size).toBe(0)
      const resolved = orchestrator.forecaster.priceFor('anthropic/claude-sonnet-4-6')
      expect(resolved.source).toBe('fallback-table')
      expect(resolved.pricing).toEqual(SONNET_FALLBACK)
    })

    it('when the model domain is absent', async () => {
      const { ctx } = makeCtx(undefined, { omitModel: true })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator.modelCosts.size).toBe(0)
      const resolved = orchestrator.forecaster.priceFor('anthropic/claude-sonnet-4-6')
      expect(resolved.source).toBe('fallback-table')
      expect(resolved.pricing).toEqual(SONNET_FALLBACK)
    })

    it('when the model API throws', async () => {
      const { ctx } = makeCtx(undefined, { listThrows: true })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator.modelCosts.size).toBe(0)
      const resolved = orchestrator.forecaster.priceFor('anthropic/claude-sonnet-4-6')
      expect(resolved.source).toBe('fallback-table')
      expect(resolved.pricing).toEqual(SONNET_FALLBACK)
    })

    it('for a model the fallback table does not know', async () => {
      const { ctx } = makeCtx({ data: [] })
      await orchestrator.initialize(ctx as never)

      // The unknown-model guess, labelled. It replaced the deleted relative
      // table's `costs[model] || 0.10` default, which was a bare number with
      // no unit and no provenance.
      const resolved = orchestrator.forecaster.priceFor('who/some-unlisted-model')
      expect(resolved.source).toBe('unknown-model')
      expect(resolved.pricing).toEqual({ input: 0.01, output: 0.05, cacheRead: 0.001, cacheWrite: 0.0125 })
    })
  })

  it('ignores V1-shaped client / data members instead of consulting them', async () => {
    const { ctx } = makeCtx({ data: [] })
    await orchestrator.initialize(ctx as never)

    const v1Shaped = {
      ...ctx,
      client: { model: { list: mock(() => Promise.resolve({ data: { data: [{ id: 'ghost', cost: [{ input: 1, output: 1 }] }] } })) } },
      data: { location: { model: { sync: mock(() => Promise.resolve()), list: () => [{ id: 'ghost2', cost: [{ input: 1, output: 1 }] }] }, default: () => ({}) } },
    }
    const other = new NexusOrchestrator()
    await other.initialize(v1Shaped as never)
    await other.shutdown()

    expect(other.modelCosts.has('ghost')).toBe(false)
    expect(other.modelCosts.has('ghost2')).toBe(false)
  })
})
