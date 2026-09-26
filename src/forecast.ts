import type { Task, ComplexityScore } from "./types"

/**
 * Token usage for a finished session, in exactly the shape OpenCode projects
 * it onto (`SessionInfo.tokens`).
 *
 * The field meanings are OpenCode's, not ours, and they are load-bearing:
 * opencode builds this object from provider usage like so
 *
 *   input     = usage.nonCachedInputTokens     // NON-cached prompt tokens
 *   output    = usage.visibleOutputTokens      // NOT the total output
 *   reasoning = usage.reasoningTokens
 *   cache.read  = usage.cacheReadInputTokens
 *   cache.write = usage.cacheWriteInputTokens
 *
 * where `visibleOutputTokens = max(0, outputTokens - reasoningTokens)`. So:
 *
 *  - `input` EXCLUDES cache, which is why the cache terms are ADDITIVE below;
 *  - `reasoning` is DISJOINT from `output`, not a subset of it, and must be
 *    billed on top of it.
 */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/**
 * One tier's rates, in **USD per 1K tokens**. This is a *single* row of rates,
 * not a whole model: a model with a long-context premium is several of these.
 */
export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One context tier of a model's price list.
 *
 * `threshold` mirrors OpenCode's `ModelCost.tier.size`: a prompt at or below
 * this size is NOT billed at these rates. Absent `threshold` means the
 * untiered base row (`tier === undefined` in OpenCode), which every prompt size
 * falls back to. The two are deliberately the same field rather than a
 * separate `base` slot: a second field would be a second source of truth and
 * would need an invariant about which one wins, and the two cannot disagree
 * without the selection below silently billing the wrong rate.
 */
export interface ModelPricingTier {
  threshold?: number
  rates: ModelPricing
}

/**
 * A model's complete price list, in USD per 1K tokens. Ascending, with the
 * untiered base first — `loadModelCosts` normalises order on write so a
 * hand-edited or merged array cannot change which rate is selected.
 */
export interface ModelPricingTiers {
  tiers: readonly ModelPricingTier[]
}

/**
 * Which table a price came from. Only `model-costs` is real pricing; the other
 * two are stand-ins and must never be presented as a billed figure.
 */
export type PricingSource = 'model-costs' | 'fallback-table' | 'unknown-model'

/** How a token count was obtained: read from the session, or predicted. */
export type UsageSource = 'measured' | 'estimated'

/**
 * Resolves a model's full tiered USD-per-1K price list. Returns `undefined`
 * when the model is unknown. The orchestrator injects its `modelCosts` lookup
 * here so there is exactly ONE price source in the plugin.
 */
export type PricingResolver = (model: string, provider?: string) => ModelPricingTiers | undefined

/**
 * Cache rates as a multiple of a row's own input rate.
 *
 * Anthropic-family pricing bills a cache READ at 0.1× the input rate and a cache
 * WRITE at 1.25×. Both real prices verified in `test/model-costs.test.ts` follow
 * that relation exactly — sonnet input 0.003 → cacheRead 0.0003 / cacheWrite
 * 0.00375, opus input 0.015 → 0.0015 / 0.01875 — so deriving them reproduces a
 * genuine price wherever one is known, and gives a correctly scaled, non-zero
 * cache bill where none is.
 *
 * Zero would be wrong in the same way a missing term is wrong: it silently
 * drops a whole term of the cost formula, so a cache-heavy run on a
 * fallback-priced model bills $0 for its entire cache bill. An unknown model is
 * exactly where that hurts most — unusual local models are the likeliest to be
 * missing from `modelCosts` and the likeliest to be cache-heavy.
 *
 * These are ESTIMATES derived from the input rate, not provider-sourced
 * numbers; a provider that does not bill cache writes separately is approximated
 * here. Any real `modelCosts` entry overrides this table completely.
 */
const CACHE_READ_MULTIPLE = 0.1
const CACHE_WRITE_MULTIPLE = 1.25

/** One priced row, with its cache rates derived from its own input rate. */
function per1kPricing(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheRead: input * CACHE_READ_MULTIPLE,
    cacheWrite: input * CACHE_WRITE_MULTIPLE,
  }
}

/** A whole-model price list consisting of one untiered base row. */
function untiered(rates: ModelPricing): ModelPricingTiers {
  return { tiers: [{ rates }] }
}

/**
 * FALLBACK ONLY — USD per 1K tokens, used when the orchestrator's `modelCosts`
 * has no entry for a model (pricing not loaded yet, or OpenCode exposes no cost
 * data for it). Converted from the historical per-token table by ×1000 so the
 * unit is identical to `modelCosts`; the old table was 1000× away and was never
 * reconciled with the real prices. Never preferred over `model-costs`.
 *
 * Every row is a single UNTIRED tier. That is the honest shape: these are
 * invented numbers with no tier structure behind them, and giving them a
 * synthetic 200k premium tier would manufacture a tier that no provider
 * published — on a table whose entire virtue is that it says what it knows.
 *
 * `minimax-m2.5-free` is present and priced at zero on purpose: a genuinely
 * free model must stay selectable in the budget filter even when the real price
 * table is unavailable.
 */
const FALLBACK_PRICING_PER_1K: Record<string, ModelPricingTiers> = {
  'claude-sonnet-4-6': untiered(per1kPricing(0.015, 0.075)),
  'claude-opus-4-7': untiered(per1kPricing(0.075, 0.375)),
  'claude-haiku-4-5': untiered(per1kPricing(0.001, 0.005)),
  'gpt-5-mini': untiered(per1kPricing(0.00015, 0.0006)),
  'gpt-5': untiered(per1kPricing(0.0025, 0.01)),
  'gemini-2.5-flash': untiered(per1kPricing(0.000075, 0.0003)),
  'minimax-m2.5-free': untiered(per1kPricing(0, 0)),
}

/**
 * Price assumed for a model no table knows — a guess, and the weakest figure in
 * this file. Equivalent to the old hardcoded per-token default
 * (0.00001 in / 0.00005 out) converted to per-1K. Reported as
 * `unknown-model` so it is never mistaken for a real price.
 */
const UNKNOWN_PRICING_PER_1K: ModelPricingTiers = untiered(per1kPricing(0.01, 0.05))

/** USD per 1K tokens → USD for a token count. */
const per1k = (rate: number, tokens: number): number => (rate * tokens) / 1000

/**
 * "provider/id" → "id"; a bare id is returned unchanged (indexOf is -1 when
 * there is no "/", and slice(0) is the whole string). The single copy of this
 * key-normalisation rule in the plugin.
 */
export function bareModelId(ref: string): string {
  return ref.slice(ref.indexOf('/') + 1)
}

export interface CostBreakdown {
  inputCost: number
  outputCost: number
  cacheCost: number
}

export interface CostEstimate {
  taskId: string
  taskName: string
  role: string
  model: string
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCost: number
  /** Where the token count came from. */
  source: UsageSource
  /** Which price table priced it. */
  pricingSource: PricingSource
  /**
   * Only set for a measurement taken from real usage AND priced from
   * `modelCosts`. A predicted count has no honest confidence value, and a
   * measured count at a guessed rate is not certain either — so this is
   * deliberately `undefined` in both of those cases rather than a fabricated
   * number dressed up as a quality signal.
   */
  confidence?: number
  breakdown: CostBreakdown
}

export interface ForecastResult {
  estimates: CostEstimate[]
  totalEstimatedCost: number
  budgetRemaining: number
  withinBudget: boolean
}

/** A cost derived from real session usage. */
export interface MeasuredCost {
  cost: number
  tokens: number
  pricingSource: PricingSource
  confidence?: number
}

/** Total tokens for a session. See `TokenUsage` for the field conventions. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
}

/**
 * The "prompt size" tier SELECTION is keyed on: `input + cache.read +
 * cache.write`. It is a property of which rate applies, not of the cost
 * arithmetic — `selectTier(tiers, promptSizeOf(usage))` is the whole of it, and
 * the same quantity reaches the base rate via `selectTier(tiers, 0)`.
 *
 * NOT `totalTokens`. Output and reasoning are EXCLUDED — they are produced
 * after the tier is chosen and are not part of the context the tier depends on.
 * Conflating the two is the single easiest way to get tier selection subtly
 * wrong, and it would only show up on long-context runs, which is precisely
 * where the answer matters.
 */
export function promptSizeOf(usage: TokenUsage): number {
  return usage.input + usage.cache.read + usage.cache.write
}

/** Rates that cost nothing. Only reached in the unreachable branch below. */
const ZERO_RATES: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Pick the tier that OpenCode would bill a prompt of `promptSize` tokens at.
 *
 * Reproduces the selection in OpenCode's own cost function, and each part of
 * it is load-bearing:
 *
 *   const tier = tiers
 *     .filter(c => c.tier?.type === "context" && promptSize > c.tier.size)
 *     .toSorted((c, p) => (p.tier?.size ?? 0) - (c.tier?.size ?? 0))[0]
 *     ?? tiers.find(c => c.tier === void 0)
 *
 *  - the comparison is STRICT `>`, so a prompt exactly equal to a threshold
 *    gets the *cheaper* row below it, not the premium row;
 *  - the LARGEST matching threshold wins (descending sort, first element), not
 *    the first match in array order;
 *  - a matching context tier wins EVEN IF IT IS CHEAPER THAN THE BASE. There is
 *    no "cheapest tier" step. Providers do publish discounted long-context
 *    rates, so an implementer must not "fix" this into a price comparison;
 *  - an untiered base is the fallback, not a competitor.
 *
 * TOTAL, by design. `undefined` would turn into a `TypeError` inside
 * `accountTaskCost`, and `safeAccountTaskCost` would swallow that into a
 * silent, unlabelled `$0` — a wrong answer with no trace. An empty tier list
 * is a data error, and the honest response to it is a zero bill, not a crash.
 *
 * TWO PLACES WHERE THIS IS NOT `Ng`, and a reader auditing "term for term"
 * will find two rather than one:
 *  1. NO UNTIERED BASE. `Ng` falls back to `tiers.find(c => c.tier ===
 *     void 0)` and, finding none, returns ZERO for the whole call. We return
 *     the zero-rate tier above, which coincides with `Ng` in that case — but
 *     only because `loadModelCosts` synthesises an untiered base from `cost[0]`
 *     for exactly this shape. Hand this function a tier-only list and `Ng`
 *     would bill 0 where we bill the lowest published rate.
 *  2. A TIER WHOSE `size` IS NOT A FINITE NUMBER. `loadModelCosts` keeps such a
 *     row (so it stays visible in the price list) but omits its `threshold`,
 *     which makes it the untiered base. `Ng` would keep the `tier` object and
 *     never match it, so it is inert there and load-bearing here.
 */
export function selectTier(tiers: readonly ModelPricingTier[], promptSize: number): ModelPricingTier {
  let best: ModelPricingTier | undefined
  let bestThreshold = Number.NEGATIVE_INFINITY
  for (const tier of tiers) {
    const { threshold } = tier
    if (threshold === undefined) continue
    if (!(promptSize > threshold)) continue
    if (threshold > bestThreshold) {
      best = tier
      bestThreshold = threshold
    }
  }
  if (best) return best
  const base = tiers.find(t => t.threshold === undefined)
  return base ?? { rates: ZERO_RATES }
}

/**
 * Price a token count against a model's FULL price list, selecting the tier
 * from the prompt's own size.
 *
 * A thin wrapper: the arithmetic stays in `priceTokens` and nothing is added
 * here, so the formula remains independently testable without constructing a
 * tier list around it.
 */
export function priceUsage(
  usage: TokenUsage,
  pricing: ModelPricingTiers
): CostBreakdown & { total: number } {
  return priceTokens(usage, selectTier(pricing.tiers, promptSizeOf(usage)).rates)
}

/**
 * Price a token count at USD-per-1K rates.
 *
 * This mirrors opencode's own cost function term for term, so a measured cost
 * here reproduces the provider-billed `SessionInfo.cost` rather than quietly
 * disagreeing with it:
 *
 *   opencode: (input * tier.input
 *            + (output + reasoning) * tier.output
 *            + cache.read * tier.cacheRead
 *            + cache.write * tier.cacheWrite) / 1e6
 *
 * Divided by 1e3 rather than 1e6 because our rates are per-1K, not per-million.
 *
 * Two conventions that are easy to get backwards, both inherited from
 * `SessionInfo.tokens` (see `TokenUsage`):
 *  - `input` is the NON-cached prompt, so `cache.read` / `cache.write` are
 *    additive rather than already contained in it.
 *  - `output` is VISIBLE output (`outputTokens - reasoningTokens`), so
 *    `reasoning` is disjoint from it and is billed at the output rate on top.
 *
 * NOTE: `SessionInfo.cost` is deliberately not read as an input, and the
 * reason is granularity, not unit. OpenCode prices each model CALL at the tier
 * that call's own prompt falls into, and accumulates. We are handed one SESSION
 * TOTAL and make ONE tier selection for it (see `priceUsage`). Tokens × our
 * per-1K rates is the unit-consistent path, but it will not tie exactly to
 * `SessionInfo.cost` and must not be read as a reconciliation of it.
 *
 * THE DIRECTION OF THE ERROR IS NOT KNOWABLE HERE, and an earlier version of
 * this comment claimed otherwise. It is tempting to say a single session-wide
 * selection can only over-report, because a session sum is always at least as
 * large as any one of its calls' prompts. That holds ONLY while rates are
 * monotonically non-decreasing in threshold:
 *
 *   - Monotone rates (the common case — a premium tier costs more). The sum
 *     reaches at least as high a tier as any single call did, so we bill at
 *     the same or a HIGHER rate: we OVER-report.
 *   - A provider publishing a DISCOUNTED long-context tier — Gemini's
 *     long-context pricing is exactly this shape, and T5 pins it as base 10 /
 *     200k threshold rate 1. Several sub-threshold calls then sum PAST the
 *     threshold while each was billed at the base rate. OpenCode bills
 *     2 × (150k/1k × 10) = $3.00; we bill (300k/1k × 1) = $0.30. A 10x
 *     UNDER-report, by the ratio between base and discounted rate.
 *
 * So on precisely the long-context sessions this change exists to price
 * correctly, a discounted tier inverts the sign. There is no cheap fix at
 * session-total granularity — recovering opencode's figure needs the
 * per-call breakdown, which is the thing we are not given — which is the
 * honest reason the code makes a single selection and labels it. Treat the
 * sign as unknown, not as safe.
 */
export function priceTokens(usage: TokenUsage, pricing: ModelPricing): CostBreakdown & { total: number } {
  const inputCost = per1k(pricing.input, usage.input)
  const outputCost = per1k(pricing.output, usage.output + usage.reasoning)
  const cacheCost = per1k(pricing.cacheRead, usage.cache.read) + per1k(pricing.cacheWrite, usage.cache.write)
  return { inputCost, outputCost, cacheCost, total: inputCost + outputCost + cacheCost }
}

export class CostForecaster {
  /**
   * The one price source. When injected (the orchestrator always does, with its
   * `modelCosts` lookup) real per-1K pricing wins; the labelled fallback table
   * is only consulted for models the real table does not know.
   */
  private readonly resolvePricing: PricingResolver | undefined

  constructor(pricing?: PricingResolver) {
    this.resolvePricing = pricing
  }

  /**
   * The USD-per-1K rates a model bills at for a prompt of `promptSize` tokens,
   * plus which table answered. Real pricing first, then the labelled fallback
   * table, then the unknown-model guess. `provider` is optional because
   * references are usually already provider-qualified.
   *
   * `promptSize` is optional and defaults to the base tier, which is correct
   * for every prediction: `estimateTokensFor` produces at most ~2800 prompt
   * tokens and zero cache, far below any real context threshold. Only a
   * measured session needs it, and `measureCost` supplies it.
   */
  priceFor(
    model: string,
    provider?: string,
    promptSize?: number
  ): { pricing: ModelPricing; source: PricingSource } {
    const { pricing, source } = this.tiersFor(model, provider)
    return { pricing: selectTier(pricing.tiers, promptSize ?? 0).rates, source }
  }

  /**
   * The whole price list a model bills under, plus which table answered.
   * Real pricing first, then the labelled fallback table, then the
   * unknown-model guess. This is the one resolution path; `priceFor` is the
   * flattened view of it and a measured count prices against it directly,
   * because the tier has to be chosen from the token count itself, which a flat
   * result cannot express.
   *
   * The fallback and unknown tables are single untiered rows by construction
   * (see `FALLBACK_PRICING_PER_1K`), so `selectTier` on them is the identity
   * and the `source` label stays the honest one.
   */
  tiersFor(model: string, provider?: string): { pricing: ModelPricingTiers; source: PricingSource } {
    const real = this.resolvePricing?.(model, provider)
    if (real) return { pricing: real, source: 'model-costs' }

    const bare = bareModelId(model)
    const fallback = FALLBACK_PRICING_PER_1K[model] ?? FALLBACK_PRICING_PER_1K[bare]
    if (fallback) return { pricing: fallback, source: 'fallback-table' }

    return { pricing: UNKNOWN_PRICING_PER_1K, source: 'unknown-model' }
  }

  /**
   * Cost of a *measured* token count, in USD, and the tokens it covers.
   * Zero tokens legitimately cost zero — a session that was read successfully
   * but never called the model is a real zero, not a missing measurement.
   *
   * The tier is selected from THIS usage's prompt size (see `priceUsage`), so
   * a cache-heavy long-context session is billed at the long-context rate
   * rather than the base one. See the note on `priceTokens` for why our
   * per-session total still will not tie exactly to `SessionInfo.cost`.
   */
  measureCost(usage: TokenUsage, model: string, provider?: string): MeasuredCost {
    const { pricing, source } = this.tiersFor(model, provider)
    return {
      cost: priceUsage(usage, pricing).total,
      tokens: totalTokens(usage),
      pricingSource: source,
      // Only a real price on a real count is certain.
      ...(source === 'model-costs' ? { confidence: 1 } : {}),
    }
  }

  /** Cost of a token count, in USD, ignoring which table priced it. */
  costOf(usage: TokenUsage, model: string, provider?: string): number {
    return priceUsage(usage, this.tiersFor(model, provider).pricing).total
  }

  /**
   * Estimate tokens needed for a task based on complexity and file count.
   * `fileCount` is separate so callers holding only a complexity score (e.g. the
   * budget filter in `selectBestModel`) can reuse the same estimator.
   *
   * NOTE: the budget filter estimates with `fileCount = 0`, so it prices the
   * low end of what the real estimator would produce for a task with files in
   * scope. That makes the filter optimistic, never pessimistic; a fuller
   * forecast would need the task, which model selection does not have.
   */
  estimateTokensFor(complexity: ComplexityScore, fileCount: number): { input: number; output: number } {
    // Base: system prompt ~500 tokens, task description ~200 tokens
    const baseInput = 700
    // Scale by complexity
    const complexityMultiplier = 1 + (complexity.overall / 100) * 3  // 1x to 4x
    // Scale by file count
    const fileMultiplier = 1 + (fileCount * 0.2)
    // Output: roughly proportional to input but smaller
    const input = Math.round(baseInput * complexityMultiplier * fileMultiplier)
    const output = Math.round(input * 0.5)  // Output is typically 30-70% of input
    return { input, output }
  }

  /**
   * Estimate tokens needed for a task based on complexity
   */
  estimateTokens(task: Task, complexity: ComplexityScore): { input: number; output: number } {
    return this.estimateTokensFor(complexity, task.files.include.length)
  }

  /**
   * Predicted cost of running one task of this complexity on this model, in USD.
   * This is the figure the budget filter compares against the remaining budget —
   * a per-task total, commensurate with `maxTotalCost - totalSpent`, unlike the
   * per-1K rate it used to compare.
   */
  estimateCost(complexity: ComplexityScore, model: string, provider?: string): number {
    const { input, output } = this.estimateTokensFor(complexity, 0)
    return this.costOf(
      { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
      model,
      provider
    )
  }

  /**
   * Forecast cost for a single task
   */
  forecastTask(task: Task, role: string, modelId: string, complexity: ComplexityScore): CostEstimate {
    const { input, output } = this.estimateTokens(task, complexity)
    const { pricing, source } = this.tiersFor(modelId)
    // A prediction cannot know the cache hit rate, so no cache terms are
    // estimated — an unpriced cache read would understate a real run. The
    // prompt is a few thousand tokens, so `priceUsage` selects the base tier
    // here; it is used rather than `priceTokens` only so this path cannot drift
    // away from the measured one.
    const breakdown = priceUsage({ input, output, reasoning: 0, cache: { read: 0, write: 0 } }, pricing)

    return {
      taskId: task.id,
      taskName: task.name,
      role,
      model: modelId,
      estimatedInputTokens: input,
      estimatedOutputTokens: output,
      estimatedCost: breakdown.total,
      source: 'estimated',
      pricingSource: source,
      // No confidence: the old `0.6 + Math.random() * 0.3` was fabricated noise
      // that made every forecast non-deterministic and untestable.
      confidence: undefined,
      breakdown: {
        inputCost: breakdown.inputCost,
        outputCost: breakdown.outputCost,
        cacheCost: breakdown.cacheCost
      }
    }
  }

  /**
   * Forecast cost for multiple tasks
   */
  forecastAll(tasks: Array<{ task: Task; role: string; model: string; complexity: ComplexityScore }>, budgetRemaining: number): ForecastResult {
    const estimates = tasks.map(t => this.forecastTask(t.task, t.role, t.model, t.complexity))
    const totalEstimatedCost = estimates.reduce((sum, e) => sum + e.estimatedCost, 0)

    return {
      estimates,
      totalEstimatedCost,
      budgetRemaining,
      withinBudget: totalEstimatedCost <= budgetRemaining
    }
  }
}
