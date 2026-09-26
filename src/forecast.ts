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
 * Real pricing for one model, in **USD per 1K tokens**. Structurally the same
 * as the orchestrator's `NexusModelCost`, so the orchestrator's `modelCosts`
 * map can be handed over without conversion — see `PricingResolver`.
 */
export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Which table a price came from. Only `model-costs` is real pricing; the other
 * two are stand-ins and must never be presented as a billed figure.
 */
export type PricingSource = 'model-costs' | 'fallback-table' | 'unknown-model'

/** How a token count was obtained: read from the session, or predicted. */
export type UsageSource = 'measured' | 'estimated'

/**
 * Resolves USD-per-1K pricing for a model reference. Returns `undefined` when
 * the model is unknown. The orchestrator injects its `modelCosts` lookup here so
 * there is exactly ONE price source in the plugin.
 */
export type PricingResolver = (model: string, provider?: string) => ModelPricing | undefined

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

/**
 * FALLBACK ONLY — USD per 1K tokens, used when the orchestrator's `modelCosts`
 * has no entry for a model (pricing not loaded yet, or OpenCode exposes no cost
 * data for it). Converted from the historical per-token table by ×1000 so the
 * unit is identical to `modelCosts`; the old table was 1000× away and was never
 * reconciled with the real prices. Never preferred over `model-costs`.
 *
 * `minimax-m2.5-free` is present and priced at zero on purpose: a genuinely
 * free model must stay selectable in the budget filter even when the real price
 * table is unavailable.
 */
const FALLBACK_PRICING_PER_1K: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': per1kPricing(0.015, 0.075),
  'claude-opus-4-7': per1kPricing(0.075, 0.375),
  'claude-haiku-4-5': per1kPricing(0.001, 0.005),
  'gpt-5-mini': per1kPricing(0.00015, 0.0006),
  'gpt-5': per1kPricing(0.0025, 0.01),
  'gemini-2.5-flash': per1kPricing(0.000075, 0.0003),
  'minimax-m2.5-free': per1kPricing(0, 0),
}

/**
 * Price assumed for a model no table knows — a guess, and the weakest figure in
 * this file. Equivalent to the old hardcoded per-token default
 * (0.00001 in / 0.00005 out) converted to per-1K. Reported as
 * `unknown-model` so it is never mistaken for a real price.
 */
const UNKNOWN_PRICING_PER_1K: ModelPricing = per1kPricing(0.01, 0.05)

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
 * NOTE: `SessionInfo.cost` is deliberately not read as an input. It is
 * provider-billed against a context-size-dependent tier, while these rates are
 * a single base tier; mixing the two would make the plugin's spend disagree
 * with the bill. Tokens × our per-1K rates is the one unit-consistent path.
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
   * USD-per-1K pricing for a model reference, plus which table answered.
   * Real pricing first, then the labelled fallback table, then the
   * unknown-model guess. `provider` is optional because references are
   * usually already provider-qualified.
   */
  priceFor(model: string, provider?: string): { pricing: ModelPricing; source: PricingSource } {
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
   */
  measureCost(usage: TokenUsage, model: string, provider?: string): MeasuredCost {
    const { pricing, source } = this.priceFor(model, provider)
    return {
      cost: priceTokens(usage, pricing).total,
      tokens: totalTokens(usage),
      pricingSource: source,
      // Only a real price on a real count is certain.
      ...(source === 'model-costs' ? { confidence: 1 } : {}),
    }
  }

  /** Cost of a token count, in USD, ignoring which table priced it. */
  costOf(usage: TokenUsage, model: string, provider?: string): number {
    return priceTokens(usage, this.priceFor(model, provider).pricing).total
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
    const { pricing, source } = this.priceFor(modelId)
    // A prediction cannot know the cache hit rate, so no cache terms are
    // estimated — an unpriced cache read would understate a real run.
    const breakdown = priceTokens({ input, output, reasoning: 0, cache: { read: 0, write: 0 } }, pricing)

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
