import { describe, it, expect, afterAll, mock } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `initialize` loads config from homedir(); sandbox it so this suite never
// touches the developer's real global config. Must run before the import.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * The cost term of `scoreModel`, and the model selection it drives.
 *
 * It used to be `1 - estimateModelCost(model) / 15.00`, where
 * `estimateModelCost` returned EITHER a real per-1K rate OR a hand-tuned
 * relative figure. Two different scales, so:
 *  - the `15.00` ceiling was calibrated to the invented table, which made every
 *    REAL price score ≈1 — cost did not discriminate at all once pricing loaded;
 *  - two identically-priced models could still score differently, because one
 *    was priced from `modelCosts` and the other from the relative table.
 *
 * The cost term is now the per-task USD estimate, normalised against the most
 * expensive candidate in the same `selectBestModel` pass, and both the budget
 * filter and the ranker read that one map. These tests pin that they agree, and
 * that the deleted table cannot come back in disguise.
 */

const C = (overall: number) => ({
  overall,
  factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const },
})

const COMPLEXITY = C(50)

function makeCtx(models: unknown[] = []) {
  return {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    model: { list: mock(() => Promise.resolve({ data: models })) },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_child' })),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
    },
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
  }
}

async function orchestratorWith(models: unknown[] = []) {
  const orchestrator = new NexusOrchestrator()
  await orchestrator.initialize(makeCtx(models) as never)
  return orchestrator
}

/** Per-task estimates for the hardcoded candidate list, at `complexity`. */
function estimates(orchestrator: InstanceType<typeof NexusOrchestrator>, complexity = COMPLEXITY) {
  const map = new Map<string, number>()
  for (const ref of [
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-haiku-4-5',
    'openai/gpt-5-mini',
    'google/gemini-2.5-flash',
    'opencode/minimax-m2.5-free',
  ]) {
    const [provider, ...parts] = ref.split('/')
    map.set(ref, orchestrator.forecaster.estimateCost(complexity, parts.join('/'), provider))
  }
  return map
}

describe('the cost term is a per-task estimate, normalised within the pass', () => {
  it('R1 — normalises against the most expensive candidate, not a fixed ceiling', async () => {
    const orchestrator = await orchestratorWith()
    const map = estimates(orchestrator)
    const max = Math.max(...map.values())

    // The most expensive candidate scores 0 on cost and the cheapest 1, whatever
    // the absolute dollars are. A fixed ceiling cannot do this: these figures
    // are ~1e-2 and ~1e-4, so `1 - cost/15` was ≈1 for all of them.
    const dearest = orchestrator.scoreModel('anthropic/claude-sonnet-4-6', 'coder', COMPLEXITY, map)
    const cheapest = orchestrator.scoreModel('opencode/minimax-m2.5-free', 'coder', COMPLEXITY, map)
    expect(dearest.costScore).toBeCloseTo(0, 12)
    expect(cheapest.costScore).toBeCloseTo(1, 12)

    // Every candidate's costScore is 1 - its own share of the dearest one.
    for (const [ref, estimate] of map) {
      const scored = orchestrator.scoreModel(ref, 'coder', COMPLEXITY, map)
      expect(scored.costScore).toBeCloseTo(1 - estimate / max, 12)
    }
    await orchestrator.shutdown()
  })

  it('R2 — two identically-priced models on DIFFERENT sources score identically', async () => {
    // The regression guard for the whole change. `gemini-2.5-flash` is priced by
    // the fallback table and `my-org/twin` is priced from a real `modelCosts`
    // entry set to the same rates. Under the old scheme one of them came from
    // the relative table and the other from `modelCosts`, and the two were
    // compared on different scales.
    const orchestrator = await orchestratorWith([
      { providerID: 'my-org', id: 'twin', cost: [{ input: 0.075, output: 0.3, cache: { read: 0.0075, write: 0.09375 } }] },
    ])
    orchestrator.setModelCosts({ 'my-org/twin': { input: 0.000075, output: 0.0003, cacheRead: 0.0000075, cacheWrite: 0.00009375 } })

    // The two really are the same price, reached by two different routes.
    // (Cache rates compared with a tolerance: the fallback DERIVES them by
    // 0.1x / 1.25x, so 0.000075 * 0.1 is not bit-identical to 0.0000075.)
    const real = orchestrator.forecaster.priceFor('my-org/twin')
    const fallback = orchestrator.forecaster.priceFor('google/gemini-2.5-flash')
    expect(real.source).toBe('model-costs')
    expect(fallback.source).toBe('fallback-table')
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      expect(real.pricing[field]).toBeCloseTo(fallback.pricing[field], 15)
    }

    // Same shared normalisation reference, so the cost term must match exactly.
    // Both are near 1 because this reference (1) is far above their estimate
    // (~$0.0004); what matters is that the two agree to the last bit.
    const reference = new Map([['x', 1]])
    const a = orchestrator.scoreModel('my-org/twin', 'coder', COMPLEXITY, reference)
    const b = orchestrator.scoreModel('google/gemini-2.5-flash', 'coder', COMPLEXITY, reference)
    expect(a.costScore).toBe(b.costScore)
    expect(a.costScore).toBeGreaterThan(0.999)
    await orchestrator.shutdown()
  })

  it('R3 — an all-free candidate set produces no NaN anywhere and still returns a model', async () => {
    // `maxEstimate === 0` is the dangerous case: `1 - 0/0` is NaN, NaN flows
    // into overallScore, and the sort comparator then returns NaN, whose sign
    // is falsy — so the sort silently becomes a no-op and the FIRST candidate
    // wins for reasons unrelated to cost.
    const orchestrator = await orchestratorWith()
    orchestrator.setModelCosts({
      'anthropic/claude-sonnet-4-6': { input: 0, output: 0 },
      'anthropic/claude-haiku-4-5': { input: 0, output: 0 },
      'openai/gpt-5-mini': { input: 0, output: 0 },
      'google/gemini-2.5-flash': { input: 0, output: 0 },
      'opencode/minimax-m2.5-free': { input: 0, output: 0 },
    })

    const map = estimates(orchestrator)
    expect(Math.max(...map.values())).toBe(0)
    for (const ref of map.keys()) {
      const scored = orchestrator.scoreModel(ref, 'coder', COMPLEXITY, map)
      expect(Number.isFinite(scored.costScore)).toBe(true)
      expect(Number.isFinite(scored.overallScore)).toBe(true)
      // Every candidate is equally free, so cost must not separate them at all.
      expect(scored.costScore).toBe(1)
    }

    // And a real model comes back, ranked on quality alone.
    const selection = orchestrator.selectBestModel('coder', COMPLEXITY)
    expect(selection.model).toBeTruthy()
    expect(selection.estimatedCost).toBe(0)
    // With cost flat, the winner is the highest-quality listed model: sonnet
    // 0.85 beats gemini 0.78. Proving the sort RAN rather than no-op'd.
    expect(selection.model).toBe('claude-sonnet-4-6')
    await orchestrator.shutdown()
  })

  it('R3b — a standalone `scoreModel` with no comparison set scores cost as 1', async () => {
    // No map means no reference, so price is not a discriminator and must not
    // be scored as one — rather than `1 - estimate/0` → NaN.
    const orchestrator = await orchestratorWith()
    const scored = orchestrator.scoreModel('anthropic/claude-opus-4-7', 'coder', COMPLEXITY)
    expect(Number.isFinite(scored.costScore)).toBe(true)
    expect(scored.costScore).toBe(1)
    // At complexity 50 the weights are quality 0.4 / cost 0.6, so with the cost
    // term pinned at 1 the overall score is the quality term plus the full cost
    // weight. Asserted as the weighted sum rather than a bare number so the
    // assertion still means something if the weights move.
    expect(scored.overallScore).toBeCloseTo(scored.qualityScore * 0.4 + 1 * 0.6, 12)
    await orchestrator.shutdown()
  })

  it('R4 — pins the intended winner at complexity 50 with fallback prices', async () => {
    // MODEL SELECTION FLIPPED HERE, deliberately. This is the test the next
    // person to touch the weights needs to find, so the new answer is asserted
    // explicitly rather than left implicit.
    //
    //   per-task estimate = 1750/1K * input + 875/1K * output
    //     sonnet  0.015  / 0.075  → $0.091875
    //     haiku   0.001  / 0.005  → $0.006125
    //     gpt-5-mini 0.00015 / 0.0006 → $0.0007875
    //     gemini  0.000075 / 0.0003 → $0.00039375
    //     minimax 0 / 0            → $0
    //
    //   score = quality*0.4 + (1 - estimate/0.091875)*0.6
    //     sonnet  0.340    gemini 0.9094  ← winner
    //     haiku   0.860    gpt-5-mini 0.8749   minimax 0.800
    //
    // The deleted relative table put sonnet at 0.15 and gemini at 0.075 — a 2x
    // gap — against a real 233x gap, and `maxCost = 15.00` made every one of
    // them score ≈1 anyway, so quality alone decided and sonnet won.
    const orchestrator = await orchestratorWith()
    const selection = orchestrator.selectBestModel('coder', COMPLEXITY)

    expect(selection.model).toBe('gemini-2.5-flash')
    expect(selection.provider).toBe('google')
    // A per-task USD figure, not a per-1K rate: 1750/1K*0.000075 + 875/1K*0.0003.
    expect(selection.estimatedCost).toBeCloseTo(0.00039375, 12)
    expect(selection.estimatedQuality).toBe(0.78)

    // The whole scoreboard, so a weight change has to be made deliberately.
    const map = estimates(orchestrator)
    const scores = [...map.keys()]
      .map(ref => ({ ref, score: orchestrator.scoreModel(ref, 'coder', COMPLEXITY, map) }))
      .sort((a, b) => b.score.overallScore - a.score.overallScore)
    expect(scores.map(s => s.ref)).toEqual([
      'google/gemini-2.5-flash',
      'openai/gpt-5-mini',
      'anthropic/claude-haiku-4-5',
      'opencode/minimax-m2.5-free',
      'anthropic/claude-sonnet-4-6',
    ])
    await orchestrator.shutdown()
  })

  it('R5 — the cost term dominates the fallback table at EVERY complexity, quality lead included', async () => {
    // Worth pinning because it is the strongest consequence of the change, and
    // it is easy to assume the complexity weighting rescues quality. It does
    // not: at complexity 90 (quality 0.6 / cost 0.4) gemini still wins, because
    // its real per-task price is 233x lower and 0.6*0.78 + 0.4*0.996 = 0.866
    // against sonnet's 0.6*0.85 + 0.4*0 = 0.51. Before the change sonnet DID win
    // at complexity 90, because the ceiling made every costScore ≈1.
    const orchestrator = await orchestratorWith()
    expect(orchestrator.selectBestModel('coder', C(90)).model).toBe('gemini-2.5-flash')

    // Sonnet's higher quality is still visible in its score — it is the cost
    // term, not a regression in the quality table.
    const map = estimates(orchestrator, C(90))
    const sonnet = orchestrator.scoreModel('anthropic/claude-sonnet-4-6', 'coder', C(90), map)
    const gemini = orchestrator.scoreModel('google/gemini-2.5-flash', 'coder', C(90), map)
    expect(sonnet.qualityScore).toBeGreaterThan(gemini.qualityScore)
    expect(sonnet.costScore).toBe(0)
    expect(gemini.costScore).toBeGreaterThan(0.99)
    await orchestrator.shutdown()
  })

  it('R5b — with prices EQUAL, quality decides the winner', async () => {
    // The control for R5: the weighting does work, it is just outgunned by a
    // 233x price gap. Pin two candidates at the same price and the higher
    // quality one must win.
    const orchestrator = await orchestratorWith()
    orchestrator.setModelCosts({
      'anthropic/claude-sonnet-4-6': { input: 0.001, output: 0.001 },
      'anthropic/claude-haiku-4-5': { input: 0.001, output: 0.001 },
      'openai/gpt-5-mini': { input: 0.001, output: 0.001 },
      'google/gemini-2.5-flash': { input: 0.001, output: 0.001 },
      'opencode/minimax-m2.5-free': { input: 0.001, output: 0.001 },
    })
    const selection = orchestrator.selectBestModel('coder', COMPLEXITY)
    // sonnet 0.85 is the highest listed quality; the free model is now priced,
    // so it competes on quality alone (0.50) and loses.
    expect(selection.model).toBe('claude-sonnet-4-6')
    await orchestrator.shutdown()
  })
})

describe('the budget filter and the ranker read the same numbers', () => {
  it('R6 — the figure the filter compares is the figure reported, for every candidate', async () => {
    // The two used to be separate `estimateCost` calls. They agreed only by
    // coincidence; now the filter, the ranker and the returned `estimatedCost`
    // all read one map, so they cannot drift.
    const orchestrator = await orchestratorWith()
    const selection = orchestrator.selectBestModel('coder', COMPLEXITY)
    const expected = orchestrator.forecaster.estimateCost(COMPLEXITY, selection.model, selection.provider)
    expect(selection.estimatedCost).toBeCloseTo(expected, 15)
    await orchestrator.shutdown()
  })

  it('R7 — a model excluded by the budget never wins, and a free one always stays selectable', async () => {
    const orchestrator = await orchestratorWith()
    orchestrator.setModelCosts({
      'google/gemini-2.5-flash': { input: 1000, output: 1000 },
      'openai/gpt-5-mini': { input: 1000, output: 1000 },
      'anthropic/claude-haiku-4-5': { input: 1000, output: 1000 },
      'anthropic/claude-sonnet-4-6': { input: 1000, output: 1000 },
    })
    // No budget left, and the free model stays free.
    orchestrator.budget = { ...orchestrator.budget, maxTotalCost: 0 }
    const selection = orchestrator.selectBestModel('coder', COMPLEXITY)
    expect(selection.model).toBe('minimax-m2.5-free')
    expect(selection.estimatedCost).toBe(0)
    await orchestrator.shutdown()
  })

  it('R8 — a user-set price replaces the whole entry, so no premium tier survives it', async () => {
    // A user who types one rate means "this is the rate". Merging it into an
    // entry that already had a 200k premium would leave them believing they had
    // priced a model that still bills at the premium above that size.
    const orchestrator = await orchestratorWith([
      {
        providerID: 'anthropic',
        id: 'tiered',
        cost: [
          { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
          { tier: { type: 'context', size: 200000 }, input: 18, output: 90, cache: { read: 1.8, write: 22.5 } },
        ],
      },
    ])
    expect(orchestrator.modelCosts.get('anthropic/tiered')!.tiers).toHaveLength(2)

    orchestrator.setModelCosts({ 'anthropic/tiered': { input: 0.5, output: 0.5 } })

    const entry = orchestrator.modelCosts.get('anthropic/tiered')!
    // Replaced outright, and the 200k tier is gone.
    expect(entry.tiers).toHaveLength(1)
    expect(entry.tiers[0].threshold).toBeUndefined()
    expect(entry.tiers[0].rates.input).toBe(0.5)
    // So a session far past the old 200k threshold bills at the user's rate.
    // Authoritative at every prompt size. Prompt tokens rather than cache,
    // because `setModelCosts` has no cache arguments (see below).
    const huge = { input: 30_000_000, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(orchestrator.forecaster.costOf(huge, 'anthropic/tiered'))
      .toBeCloseTo(30_000 * 0.5 + 1_000 * 0.5, 6)

    // DOCUMENTED GAP, pinned rather than fixed: `setModelCosts` has no cache
    // fields, so they default to 0 and a cache-heavy session on a manually
    // priced model bills nothing for its cache. Pre-existing and deliberately
    // unchanged — inventing a rate would silently override the provider's real
    // one whenever it is known. Asserted so it cannot change by accident.
    const cacheHeavy = { input: 0, output: 0, reasoning: 0, cache: { read: 23_033_722, write: 0 } }
    expect(orchestrator.forecaster.costOf(cacheHeavy, 'anthropic/tiered')).toBe(0)
    await orchestrator.shutdown()
  })
})
