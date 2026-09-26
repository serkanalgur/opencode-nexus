import { describe, it, expect } from 'bun:test'

import {
  selectTier,
  promptSizeOf,
  priceTokens,
  priceUsage,
  totalTokens,
  CostForecaster,
  type ModelPricing,
  type ModelPricingTiers,
  type ModelPricingTier,
  type TokenUsage,
} from '../src/forecast'

/**
 * Context-tier pricing. OpenCode bills each model CALL at the tier that call's
 * own prompt falls into, and accumulates:
 *
 *   const promptSize = tokens.input + tokens.cache.read + tokens.cache.write
 *   const tier = tiers
 *     .filter(c => c.tier?.type === "context" && promptSize > c.tier.size)
 *     .toSorted((c, p) => (p.tier?.size ?? 0) - (c.tier?.size ?? 0))[0]
 *     ?? tiers.find(c => c.tier === void 0)
 *
 * Before this, the plugin kept only `cost[0]` — the base tier — and priced
 * every session at it, so a long-context, cache-heavy session (the 23M-token
 * one) was billed at roughly half its real cost. These tests pin the selection
 * rule term for term.
 *
 * The rates below are per-1K throughout, which is what `ModelPricing` holds.
 */

/** A rates row. Kept terse because the tests are about *which* row is picked. */
function rates(input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelPricing {
  return { input, output, cacheRead, cacheWrite }
}

/** A tiered price list. `threshold` absent = opencode's `tier === undefined`. */
function list(...tiers: ModelPricingTier[]): ModelPricingTiers {
  return { tiers }
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    ...over,
  }
}

describe('promptSizeOf — the quantity tiers are a function of', () => {
  // T12
  it('is input + cache.read + cache.write, and EXCLUDES output and reasoning', () => {
    const u = usage({ input: 1000, output: 500_000, reasoning: 400_000, cache: { read: 20_000, write: 2_000 } })

    expect(promptSizeOf(u)).toBe(1000 + 20_000 + 2_000)
    // Not `totalTokens`. Output is produced AFTER the tier is chosen and is not
    // part of the context the tier depends on; conflating the two is the
    // easiest way to get tier selection subtly wrong, and it only shows up on
    // long-context runs — exactly where the answer matters.
    expect(promptSizeOf(u)).not.toBe(totalTokens(u))
    expect(promptSizeOf(u)).toBe(23_000)
    expect(totalTokens(u)).toBe(923_000)
  })

  it('ignores output and reasoning entirely', () => {
    const base = usage({ input: 1000, cache: { read: 2000, write: 3000 } })
    const noisy = usage({ input: 1000, output: 999_999, reasoning: 999_999, cache: { read: 2000, write: 3000 } })
    expect(promptSizeOf(noisy)).toBe(promptSizeOf(base))
  })
})

describe('selectTier — opencode\'s predicate, term for term', () => {
  it('T3 — a prompt EXACTLY equal to a threshold uses the tier below, not that tier', () => {
    // The comparison is strict `>`. A `>=` implementation fails exactly here.
    const pricing = list(
      { rates: rates(1, 1) },
      { threshold: 200_000, rates: rates(6, 6) },
    )

    expect(selectTier(pricing.tiers, 199_999).rates.input).toBe(1)
    expect(selectTier(pricing.tiers, 200_000).rates.input).toBe(1)
    expect(selectTier(pricing.tiers, 200_001).rates.input).toBe(6)
  })

  it('T2 — the LARGEST matching threshold wins, not the first match in array order', () => {
    // Shuffled input array, ascending output. Selection must be by threshold,
    // so array order cannot change the answer.
    const shuffled = list(
      { rates: rates(1, 1) },
      { threshold: 1_000_000, rates: rates(30, 30) },
      { threshold: 200_000, rates: rates(6, 6) },
      { threshold: 400_000, rates: rates(12, 12) },
    )

    expect(selectTier(shuffled.tiers, 300_000).rates.input).toBe(6)
    expect(selectTier(shuffled.tiers, 500_000).rates.input).toBe(12)
    expect(selectTier(shuffled.tiers, 5_000_000).rates.input).toBe(30)
  })

  // T5 — the one an implementer is most likely to "fix".
  it('T5 — a context tier wins even when it is CHEAPER than the base', () => {
    // There is no "cheapest tier" step in opencode's selection. Providers do
    // publish discounted long-context rates, so an implementation that adds a
    // price comparison here would silently under-bill exactly the runs that
    // dominate spend.
    const discounted = list(
      { rates: rates(10, 10) },
      { threshold: 200_000, rates: rates(1, 1) },
    )

    const chosen = selectTier(discounted.tiers, 250_000)
    expect(chosen.threshold).toBe(200_000)
    expect(chosen.rates.input).toBe(1)
    // And the full arithmetic follows the cheap tier, not the dear base: at the
    // base rate this session would cost 10.
    expect(priceUsage(usage({ input: 1_000_000 }), discounted).total).toBe(1000)
  })

  it('falls back to the untiered base when no threshold is crossed', () => {
    const pricing = list(
      { threshold: 200_000, rates: rates(6, 6) },
      { rates: rates(1, 1) },
    )
    // Base is second in the array and still wins below the first threshold.
    expect(selectTier(pricing.tiers, 0).threshold).toBeUndefined()
    expect(selectTier(pricing.tiers, 199_999).rates.input).toBe(1)
  })

  // T6
  it('T6 — a list with context tiers but NO untiered base still bills, via the synthetic base', () => {
    // `loadModelCosts` synthesises the base from cost[0]; this is that base
    // reaching selection. OpenCode's own fallback in this shape is a hard
    // ZERO, i.e. "this model bills nothing" — which cannot be right for a
    // model that published prices.
    const synthetic = list(
      { rates: rates(3, 6) },
      { threshold: 1_000_000, rates: rates(9, 18) },
    )
    expect(selectTier(synthetic.tiers, 1_000).rates.input).toBe(3)
    expect(selectTier(synthetic.tiers, 1_000_001).rates.input).toBe(9)
  })

  it('T7 — is TOTAL: an empty tier list yields a zero bill, never undefined', () => {
    // `undefined` would become a TypeError inside `accountTaskCost`, and
    // `safeAccountTaskCost` swallows that into a silent $0 — a wrong answer
    // with no trace. An empty list is a data error; the honest response to it
    // is a zero rate, not a crash.
    const chosen = selectTier([], 1_000_000)
    expect(chosen).toBeDefined()
    expect(chosen.rates).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(priceUsage(usage({ input: 1_000_000 }), { tiers: [] }).total).toBe(0)
  })

  it('handles a zero-size threshold, a single tier, and prompt size 0', () => {
    expect(selectTier(list({ rates: rates(1, 1) }).tiers, 0).rates.input).toBe(1)
    const zeroThreshold = list({ rates: rates(1, 1) }, { threshold: 0, rates: rates(9, 9) })
    // promptSize 0 is NOT > 0, so the base still wins at exactly zero.
    expect(selectTier(zeroThreshold.tiers, 0).rates.input).toBe(1)
    expect(selectTier(zeroThreshold.tiers, 1).rates.input).toBe(9)
  })
})

describe('priceUsage — tier selection reaches the arithmetic', () => {
  // T1 — the real observed session.
  it('T1 — the 23M-token cache-heavy session selects the long-context tier and is billed on it, term for term', () => {
    // Real observed usage: prompt 80_127 tokens, 23_033_722 cache reads. Under
    // the old `cost[0]`-only behaviour this was billed at the base tier, which
    // is why reported spend roughly halves on cache-heavy sessions.
    const u = usage({ input: 80_127, output: 12_000, reasoning: 3_000, cache: { read: 23_033_722, write: 0 } })
    expect(promptSizeOf(u)).toBe(23_113_849)

    // Base 0.003/0.015/0.0003/0.00375, long-context 6x across the board.
    const pricing = list(
      { rates: rates(0.003, 0.015, 0.0003, 0.00375) },
      { threshold: 200_000, rates: rates(0.018, 0.09, 0.0018, 0.0225) },
    )
    const upper = pricing.tiers[1].rates

    const breakdown = priceUsage(u, pricing)
    // The UPPER tier's arithmetic, term for term, in per-1K:
    //   input              80_127 / 1K * 0.018  = 1.442286
    //   output+reasoning  15_000 / 1K * 0.09   = 1.35
    //   cacheRead    23_033_722 / 1K * 0.0018 = 41.4606996
    const expectedInput = 80_127 / 1000 * upper.input
    const expectedOutput = 15_000 / 1000 * upper.output
    const expectedCache = 23_033_722 / 1000 * upper.cacheRead

    expect(breakdown.inputCost).toBeCloseTo(expectedInput, 9)
    expect(breakdown.outputCost).toBeCloseTo(expectedOutput, 9)
    expect(breakdown.cacheCost).toBeCloseTo(expectedCache, 9)
    expect(breakdown.total).toBeCloseTo(expectedInput + expectedOutput + expectedCache, 9)
    expect(breakdown.total).toBeCloseTo(44.2529856, 6)

    // Explicitly NOT the base tier — that is the regression this pins. Every
    // rate is 6x higher, so the base figure is exactly 1/6 of the real one, and
    // the old `cost[0]`-only behaviour under-reported this session by 6x.
    const atBase = priceTokens(u, pricing.tiers[0].rates).total
    expect(atBase).toBeCloseTo(7.3754976, 6)
    expect(breakdown.total / atBase).toBeCloseTo(6, 9)
  })

  it('is byte-for-byte `priceTokens` at the selected tier, and nothing more', () => {
    // `priceTokens` is the arithmetic and stays independently testable; the
    // wrapper adds tier selection and nothing else.
    const pricing = list(
      { rates: rates(0.003, 0.015, 0.0003, 0.00375) },
      { threshold: 200_000, rates: rates(0.018, 0.09, 0.0018, 0.0225) },
    )
    for (const size of [0, 1000, 200_000, 500_000]) {
      const u = usage({ input: size, output: 999, cache: { read: 0, write: 0 } })
      const chosen = selectTier(pricing.tiers, promptSizeOf(u)).rates
      expect(priceUsage(u, pricing)).toEqual(priceTokens(u, chosen))
    }
  })

  it('T4 — a small prompt on a tiered model is billed at the base, not the premium', () => {
    const pricing = list(
      { rates: rates(0.003, 0.015, 0.0003, 0.00375) },
      { threshold: 200_000, rates: rates(0.018, 0.09, 0.0018, 0.0225) },
    )
    const u = usage({ input: 1750, output: 875, cache: { read: 0, write: 0 } })

    expect(priceUsage(u, pricing)).toEqual(priceTokens(u, pricing.tiers[0].rates))
    // 1750/1K * 0.003 + 875/1K * 0.015
    expect(priceUsage(u, pricing).total).toBeCloseTo(0.018375, 12)
  })
})

describe('the forecaster selects a tier for a measured count', () => {
  // T8
  it('T8 — `measureCost` prices a long-context session at the long-context tier', () => {
    const pricing: ModelPricingTiers = list(
      { rates: rates(0.003, 0.015, 0.0003, 0.00375) },
      { threshold: 200_000, rates: rates(0.018, 0.09, 0.0018, 0.0225) },
    )
    const forecaster = new CostForecaster(() => pricing)

    const small = forecaster.measureCost(usage({ input: 1000, output: 1000 }), 'p/m')
    const large = forecaster.measureCost(
      usage({ input: 1000, output: 1000, cache: { read: 1_000_000, write: 0 } }), 'p/m')

    // Identical token counts, but the large one crossed the threshold, so every
    // term is billed at 6x:
    //   small: 1000/1K*0.003   + 1000/1K*0.015                 = 0.018
    //   large: 1000/1K*0.018   + 1000/1K*0.09 + 1_000_000/1K*0.0018
    //                                              = 0.108 + 1.8
    expect(small.cost).toBeCloseTo(0.018, 12)
    expect(large.cost).toBeCloseTo(1.908, 9)
    expect(small.pricingSource).toBe('model-costs')
    expect(large.pricingSource).toBe('model-costs')
    // Token counts are the whole total regardless of tier.
    expect(large.tokens).toBe(1000 + 1000 + 1_000_000)
  })

  // T9
  it('T9 — `costOf` agrees with `measureCost` and with `priceUsage`', () => {
    const pricing: ModelPricingTiers = list(
      { rates: rates(0.003, 0.015, 0.0003, 0.00375) },
      { threshold: 200_000, rates: rates(0.018, 0.09, 0.0018, 0.0225) },
    )
    const forecaster = new CostForecaster(() => pricing)
    const u = usage({ input: 5000, output: 5000, cache: { read: 900_000, write: 1000 } })

    expect(forecaster.costOf(u, 'p/m')).toBe(priceUsage(u, pricing).total)
    expect(forecaster.costOf(u, 'p/m')).toBe(forecaster.measureCost(u, 'p/m').cost)
  })

  // T10
  it('T10 — a prediction resolves the BASE tier, so `priceFor` with no prompt size is correct', () => {
    const pricing: ModelPricingTiers = list(
      { rates: rates(0.003, 0.015, 0.0003, 0.00375) },
      { threshold: 200_000, rates: rates(0.018, 0.09, 0.0018, 0.0225) },
    )
    const forecaster = new CostForecaster(() => pricing)

    expect(forecaster.priceFor('p/m').pricing).toEqual(pricing.tiers[0].rates)
    // `estimateTokensFor` tops out around 2800 prompt tokens at complexity 100,
    // so no prediction can reach a real threshold. Asserted so the claim the
    // design rests on is pinned rather than assumed.
    const biggest = forecaster.estimateTokensFor(
      { overall: 100, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'high' } },
      0)
    expect(promptSizeOf(usage({ input: biggest.input }))).toBeLessThan(200_000)

    // With a prompt size supplied, the premium tier comes back.
    expect(forecaster.priceFor('p/m', undefined, 300_000).pricing).toEqual(pricing.tiers[1].rates)
  })

  // T11
  it('T11 — the fallback and unknown tables are single untiered rows, at every prompt size', () => {
    // No synthetic 200k premium: that would invent a tier no provider
    // published, on a table whose whole virtue is that it says what it knows.
    const forecaster = new CostForecaster()
    for (const model of ['claude-sonnet-4-6', 'opencode/minimax-m2.5-free', 'who/knows']) {
      const atZero = forecaster.priceFor(model, undefined, 0)
      const atHuge = forecaster.priceFor(model, undefined, 10_000_000)
      expect(atHuge.pricing).toEqual(atZero.pricing)
      expect(forecaster.tiersFor(model).pricing.tiers).toHaveLength(1)
      expect(forecaster.tiersFor(model).pricing.tiers[0].threshold).toBeUndefined()
    }
  })
})

describe('a user-set price is authoritative at every prompt size', () => {
  // T13 — the orchestrator half of this lives in model-ranking.test.ts; what is
  // pinned here is that the forecaster honours a single untiered tier even when
  // the prompt is enormous, i.e. no tier is invented for it.
  it('bills a flat rate for a huge prompt when the list has only a base', () => {
    const flat: ModelPricingTiers = list({ rates: rates(0.003, 0.015, 0.0003, 0.00375) })
    const forecaster = new CostForecaster(() => flat)
    const huge = usage({ input: 1_000, output: 1_000, cache: { read: 50_000_000, write: 0 } })

    expect(forecaster.measureCost(huge, 'p/m').cost)
      .toBe(priceTokens(huge, flat.tiers[0].rates).total)
  })
})
