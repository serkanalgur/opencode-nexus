import { describe, it, expect, mock, afterAll } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `initialize` loads config from homedir(); sandbox it so this suite never
// touches the developer's real global config. Must run before the import.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { CostForecaster, priceTokens, totalTokens, selectTier } = await import('../src/forecast')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * Cost accounting used to be fabricated: `executeTask` assigned a USD
 * **per-1K rate** to `TaskResult.cost` — the now-deleted
 * `estimateModelCost(model, provider)`, or its mean of a real rate and a
 * hand-tuned relative figure — and left `tokensUsed` at 0 with a "Would need
 * to parse" TODO. A run's spend was therefore a sum of rates with no
 * relationship to tokens consumed, and `costByModel` was never populated
 * because `trackCost` had no callers.
 *
 * These tests pin the replacement: real session token usage priced with the
 * orchestrator's per-1K `modelCosts` at the context tier that usage selects,
 * one accounting path, and a budget filter that compares like with like.
 *
 * The token conventions are OpenCode's, not ours. From the installed server
 * binary, `SessionInfo.tokens` is projected as
 *   input = nonCachedInputTokens, output = visibleOutputTokens,
 *   reasoning = reasoningTokens, cache.read/write = cache{Read,Write}InputTokens
 * with `visibleOutputTokens = max(0, outputTokens - reasoningTokens)`.
 * So `input` EXCLUDES cache (cache terms are additive) and `reasoning` is
 * DISJOINT from `output` (it is billed on top of it).
 */

/** Per-1K rates, i.e. exactly the unit `modelCosts` stores. */
const SONNET_PER_1K = { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 }

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

/**
 * A ctx whose finished session reports `tokens` (or throws / omits `get`).
 * `getThrows` and `omitGet` drive the estimate-fallback paths; `promptThrows`
 * drives the failed-task path.
 */
function makeCtx(opts: {
  tokens?: Tokens
  getThrows?: boolean
  omitGet?: boolean
  promptThrows?: boolean
  output?: string
} = {}) {
  const session: Record<string, unknown> = {
    create: mock(() => Promise.resolve({ id: 'ses_child' })),
    prompt: mock(() => opts.promptThrows ? Promise.reject(new Error('provider refused')) : Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve(opts.output
      ? [{ type: 'assistant', content: [{ type: 'text', text: opts.output }] }]
      : [])),
  }
  if (!opts.omitGet) {
    session.get = mock(() => opts.getThrows
      ? Promise.reject(new Error('session unavailable'))
      // `cost` is deliberately present and non-zero: the implementation must
      // ignore it and derive cost from tokens, or the two paths would disagree.
      : Promise.resolve({ id: 'ses_child', cost: 42, tokens: opts.tokens }))
  }
  return {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    model: { list: mock(() => Promise.resolve({ data: [] })) },
    session,
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve([])) },
  }
}

const COMPLEXITY = {
  overall: 50,
  factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const },
}

const MODEL = 'anthropic/claude-sonnet-4-6'

interface TaskNode {
  id: string
  status: string
  result?: { success: boolean; cost: number; tokensUsed: number; costProvenance?: { usage: string; pricing: string } }
  task: Record<string, unknown>
}

/**
 * Run one task end to end through `executeTask` and return the recorded result
 * plus the orchestrator (already shut down). `pricing` defaults to sonnet's
 * per-1K rates; pass `null` to leave the model unpriced.
 */
async function runTask(
  ctx: ReturnType<typeof makeCtx>,
  { model = MODEL, pricing = SONNET_PER_1K, onReady }: {
    model?: string
    pricing?: typeof SONNET_PER_1K | null
    onReady?: (orchestrator: NexusOrchestrator) => void
  } = {}
) {
  // Self-healing off: a retry would spawn a second session and re-enter
  // executeTask, which is a different test.
  const orchestrator = new NexusOrchestrator({ selfHealing: { enabled: false } })
  await orchestrator.initialize(ctx as never)
  if (pricing) orchestrator.setModelCosts({ [model]: pricing })
  onReady?.(orchestrator)

  const node: TaskNode = {
    id: 'node-1',
    status: 'running',
    task: {
      id: 'task-1',
      name: 't',
      description: 'd',
      requiredRole: 'coder',
      timeout: 1000,
      files: { include: [] },
      complexity: COMPLEXITY,
    },
  }
  let completed = false
  // Mirrors the real DAG: markComplete stores the result on the node, and
  // markFailed only sets status (executeTask assigns node.result itself).
  orchestrator['dag'] = {
    markComplete: (_id: string, result: NonNullable<TaskNode['result']>) => {
      node.result = result
      completed = true
    },
    markFailed: () => { completed = true },
  }

  const agent = await orchestrator.spawnAgent({ role: 'coder', model }, { task: 'Do the thing' })
  await orchestrator['executeTask'](agent, node as never)

  const costReport = JSON.parse(orchestrator.getCostReport())
  const result = node.result
  const totalSpent = orchestrator.totalSpent
  await orchestrator.shutdown()
  return { result, costReport, totalSpent, marked: completed }
}

describe('per-task cost from real session usage', () => {
  it('prices measured tokens at the per-1K rates, billing reasoning additively and cache on top of non-cached input', async () => {
    const usage: Tokens = { input: 1000, output: 2000, reasoning: 500, cache: { read: 10_000, write: 2000 } }
    const { result } = await runTask(makeCtx({ tokens: usage }))

    // Exact arithmetic, asserted rather than "greater than zero". Term for term
    // with opencode's own cost function, in per-1K rather than per-million:
    //   input            1000 / 1K * 0.003   = 0.003
    //   output+reasoning 2500 / 1K * 0.015   = 0.0375
    //   cacheRead       10000 / 1K * 0.0003  = 0.003
    //   cacheWrite       2000 / 1K * 0.00375 = 0.0075
    // = 0.051
    expect(result?.cost).toBeCloseTo(0.051, 12)
    expect(result?.cost).toBeCloseTo(priceTokens(usage, SONNET_PER_1K).total, 12)

    // tokensUsed counts every token opencode bills, reasoning included.
    expect(result?.tokensUsed).toBe(1000 + 2000 + 500 + 10_000 + 2000)
    expect(result?.tokensUsed).toBe(totalTokens(usage))
  })

  it('bills a reasoning-heavy turn where reasoning exceeds visible output, additively rather than clamped', async () => {
    // The case a formula that treats reasoning as a subset of output gets wrong:
    // for gpt-5 / o-series / extended-thinking models reasoning dominates. With
    // `output` already net of reasoning, the output bill is (1000 + 20000)/1K.
    const usage: Tokens = { input: 0, output: 1000, reasoning: 20_000, cache: { read: 0, write: 0 } }
    const { result } = await runTask(makeCtx({ tokens: usage }))

    expect(result?.cost).toBeCloseTo(0.015 * 21, 12)
    expect(result?.cost).toBeCloseTo(0.315, 12)
    // Not clamped to, and not dominated by, the visible output alone.
    expect(result?.cost).toBeGreaterThan(0.015 * 1000 / 1000)
    expect(result?.tokensUsed).toBe(21_000)
  })

  it('bills a cache-only session at the cacheRead rate alone', async () => {
    // The shape a real long-context session has: essentially all of the usage
    // is cache reads, and the prompt/cache split must not double count.
    const usage: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 1_000_000, write: 0 } }
    const { result } = await runTask(makeCtx({ tokens: usage }))

    expect(result?.cost).toBeCloseTo(0.0003 * 1000, 12)
    expect(result?.cost).toBeCloseTo(0.3, 12)
    expect(result?.tokensUsed).toBe(1_000_000)
  })

  it('charges a free model zero, even though the session reported a non-zero provider cost', async () => {
    // `makeCtx` reports cost: 42 on the session. The implementation must ignore
    // it: a free model's real cost is 0 via a zero rate, and using the
    // provider-billed figure would make our numbers disagree with our own
    // pricing table.
    const usage: Tokens = { input: 5000, output: 1000, reasoning: 3000, cache: { read: 0, write: 0 } }
    const { result, costReport } = await runTask(makeCtx({ tokens: usage }), {
      model: 'opencode/minimax-m2.5-free',
      // No real price for a free model: the forecaster's fallback prices it 0.
      pricing: null,
    })

    expect(result?.cost).toBe(0)
    expect(costReport.totalSpent).toBe(0)
  })

  it('records the provenance on the TaskResult the DAG node holds', async () => {
    const usage: Tokens = { input: 1000, output: 2000, reasoning: 500, cache: { read: 0, write: 0 } }
    const { result } = await runTask(makeCtx({ tokens: usage }))

    // An agent reading `node.result` can tell a measurement from an estimate.
    expect(result?.costProvenance).toEqual({ usage: 'measured', pricing: 'model-costs' })
  })
})

describe('one accounting path — trackCost', () => {
  it('populates costByModel keyed the same way as modelCosts, plus tokens and provenance', async () => {
    const usage: Tokens = { input: 1000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } }
    const { result, costReport, totalSpent } = await runTask(makeCtx({ tokens: usage }))

    // "providerID/id" — the modelCosts key format, so price and spend join up.
    expect(Object.keys(costReport.byModel)).toEqual([MODEL])
    expect(costReport.byModel[MODEL]).toBeCloseTo(result?.cost as number, 12)
    expect(costReport.tokensByModel[MODEL]).toBe(3000)
    expect(costReport.provenance[MODEL]).toEqual({
      usage: 'measured',
      pricing: 'model-costs',
      measuredEntries: 1,
      estimatedEntries: 0,
      measuredSpend: result?.cost as number,
      estimatedSpend: 0,
    })
    expect(costReport.measuredEntries).toBe(1)
    expect(costReport.estimatedEntries).toBe(0)

    // The three totals agree: nothing was accumulated by a second, inline path.
    expect(costReport.totalSpent).toBeCloseTo(result?.cost as number, 12)
    expect(totalSpent).toBeCloseTo(result?.cost as number, 12)
  })

  it('keys costByModel by the qualified ref even when pricing is a bare id', async () => {
    const usage: Tokens = { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
    const { costReport } = await runTask(makeCtx({ tokens: usage }))
    expect(Object.keys(costReport.byModel)).toEqual(['anthropic/claude-sonnet-4-6'])
  })

  it('keeps the measured/estimated split when one model has charges of both kinds', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx() as never)
    orchestrator.trackCost('a1', 'p/m', 1.00, 10, { usage: 'measured', pricing: 'model-costs' })
    orchestrator.trackCost('a1', 'p/m', 0.25, 10, { usage: 'estimated', pricing: 'model-costs' })

    const report = JSON.parse(orchestrator.getCostReport())
    // Last-write-wins alone would report the whole model as 'estimated' and
    // hide that 1.00 of the 1.25 is a real measurement.
    expect(report.provenance['p/m']).toEqual({
      usage: 'estimated',
      pricing: 'model-costs',
      measuredEntries: 1,
      estimatedEntries: 1,
      measuredSpend: 1,
      estimatedSpend: 0.25,
    })
    expect(report.measuredEntries).toBe(1)
    expect(report.estimatedEntries).toBe(1)
    await orchestrator.shutdown()
  })
})

describe('fallback to the forecaster estimate', () => {
  it('falls back and records usage=estimated when the session read throws', async () => {
    const { result, costReport } = await runTask(makeCtx({ getThrows: true }))

    // estimateTokens: complexity 50 → multiplier 1 + 50/100*3 = 2.5,
    // 0 files → 1x, so input = 700 * 2.5 = 1750 and output = 875.
    //   1750 / 1K * 0.003  = 0.00525
    //    875 / 1K * 0.015  = 0.013125
    expect(result?.cost).toBeCloseTo(0.018375, 12)
    expect(result?.tokensUsed).toBe(1750 + 875)
    expect(result?.costProvenance).toEqual({ usage: 'estimated', pricing: 'model-costs' })
    expect(costReport.provenance[MODEL].estimatedEntries).toBe(1)
  })

  it('falls back when the session API exposes no get at all', async () => {
    const { result, costReport } = await runTask(makeCtx({ omitGet: true }))

    expect(result?.cost).toBeCloseTo(0.018375, 12)
    expect(costReport.provenance[MODEL].usage).toBe('estimated')
  })

  it('does not fall back when the session reports real usage', async () => {
    const usage: Tokens = { input: 1000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } }
    const { costReport } = await runTask(makeCtx({ tokens: usage }))
    expect(costReport.provenance[MODEL].usage).toBe('measured')
  })

  it('bills an honest zero when the session was read but consumed nothing', async () => {
    // "read failed" and "read succeeded, the model was never called" are
    // different facts. Only the first justifies an estimate; the second must
    // stay zero rather than be charged a fabricated token estimate.
    const zero: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const { result, costReport } = await runTask(makeCtx({ tokens: zero }))

    expect(result?.cost).toBe(0)
    expect(result?.tokensUsed).toBe(0)
    expect(result?.costProvenance).toEqual({ usage: 'measured', pricing: 'model-costs' })
    expect(costReport.totalSpent).toBe(0)
    expect(costReport.measuredEntries).toBe(1)
    expect(costReport.estimatedEntries).toBe(0)
  })
})

describe('an unpriced model is labelled, not passed off as billed', () => {
  it('reports fallback-table for a model only the labelled fallback knows', async () => {
    const usage: Tokens = { input: 1000, output: 1000, reasoning: 0, cache: { read: 100_000, write: 0 } }
    const { result, costReport } = await runTask(makeCtx({ tokens: usage }), {
      model: 'anthropic/claude-opus-4-7',
      pricing: null,
    })

    // The tokens are real; the RATE is a fallback guess. Both facts survive.
    expect(result?.costProvenance).toEqual({ usage: 'measured', pricing: 'fallback-table' })
    expect(costReport.provenance['anthropic/claude-opus-4-7'].pricing).toBe('fallback-table')
    // Opus fallback rates: 0.075 in, 0.375 out, 0.0075 read, 0.09375 write.
    //   1000/1K  * 0.075   = 0.075
    //   1000/1K  * 0.375   = 0.375
    //  100000/1K * 0.0075  = 0.75
    // The cache term is charged, not dropped — this is the shape that used to
    // bill $0.
    expect(result?.cost).toBeCloseTo(0.075 + 0.375 + 0.75, 12)
  })

  it('reports unknown-model when no table knows the model at all', async () => {
    const usage: Tokens = { input: 1000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }
    const { result, costReport } = await runTask(makeCtx({ tokens: usage }), {
      model: 'opencode/space-bunny-free',
      pricing: null,
    })

    // The weakest figure in the plugin, and it says so.
    expect(result?.costProvenance).toEqual({ usage: 'measured', pricing: 'unknown-model' })
    expect(costReport.provenance['opencode/space-bunny-free'].pricing).toBe('unknown-model')
    // 1000/1K * 0.01 + 1000/1K * 0.05
    expect(result?.cost).toBeCloseTo(0.06, 12)
  })
})

describe('a partial or non-finite token projection cannot poison totalSpent', () => {
  it('bills the other terms when `reasoning` is missing, rather than producing NaN', async () => {
    // `SessionInfo.tokens` is a projection the installed server always fills,
    // but an older build or a different provider adapter could omit a field.
    // `output + undefined` is NaN, and NaN in `totalSpent` makes every
    // `checkBudget` comparison false — the budget alarm goes silent for the
    // rest of the process while every reported cost reads NaN.
    const partial = { input: 1000, output: 2000, cache: { read: 0, write: 0 } }
    const { result, costReport, totalSpent } = await runTask(
      makeCtx({ tokens: partial as unknown as Tokens })
    )

    //   1000/1K * 0.003  = 0.003
    //   2000/1K * 0.015  = 0.03
    expect(result?.cost).toBeCloseTo(0.033, 12)
    expect(result?.tokensUsed).toBe(3000)
    expect(result?.costProvenance).toEqual({ usage: 'measured', pricing: 'model-costs' })
    expect(Number.isFinite(totalSpent)).toBe(true)
    expect(costReport.totalSpent).toBeCloseTo(0.033, 12)
  })

  it('treats a non-finite or negative field as zero rather than propagating it', async () => {
    const corrupt = {
      input: 1000, output: 2000, reasoning: Number.NaN,
      cache: { read: Number.POSITIVE_INFINITY, write: -1 },
    }
    const { result, totalSpent } = await runTask(makeCtx({ tokens: corrupt as unknown as Tokens }))

    // NaN and Infinity are dropped, and a negative count cannot subtract from
    // reported spend.
    expect(Number.isFinite(result?.cost)).toBe(true)
    expect(result?.cost).toBeCloseTo(0.033, 12)
    expect(Number.isFinite(totalSpent)).toBe(true)
  })
})

describe('accounting failures cannot fail the task', () => {
  it('keeps a completed task successful with its real output when costing throws', async () => {
    // Cost accounting must not be able to discard a task's real output, mark it
    // failed, and let the per-node handler overwrite its result with cost: 0.
    const usage: Tokens = { input: 1000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } }
    const { result, costReport, marked } = await runTask(
      makeCtx({ tokens: usage, output: 'the real answer' }),
      {
        onReady: (orchestrator) => {
          orchestrator.forecaster.measureCost = () => { throw new Error('pricing exploded') }
        },
      }
    )

    expect(marked).toBe(true)
    expect(result?.success).toBe(true)
    expect((result as unknown as { output?: string }).output).toBe('the real answer')
    // We lost the number, not the task — and the zero is labelled so it is
    // never read as a measured $0.
    expect(result?.cost).toBe(0)
    expect(result?.tokensUsed).toBe(0)
    expect(result?.costProvenance).toEqual({ usage: 'estimated', pricing: 'unknown-model' })
    expect(costReport.provenance[MODEL].usage).toBe('estimated')
  })
})

describe('a failed task still costs real money', () => {
  it('records the failed session\'s tokens and cost, and moves totalSpent', async () => {
    // The session burned tokens before the prompt failed. With self-healing on,
    // a retry spawns a NEW session, so without this the abandoned session's
    // usage is never seen — and spend outside totalSpent never triggers
    // checkBudget either.
    const usage: Tokens = { input: 4000, output: 1000, reasoning: 500, cache: { read: 20_000, write: 0 } }
    const { result, costReport, totalSpent, marked } = await runTask(
      makeCtx({ tokens: usage, promptThrows: true })
    )

    expect(marked).toBe(true)
    expect(result?.success).toBe(false)
    //   4000/1K * 0.003   = 0.012
    //  (1000+500)/1K*0.015 = 0.0225
    //  20000/1K * 0.0003  = 0.006
    expect(result?.cost).toBeCloseTo(0.0405, 12)
    expect(result?.tokensUsed).toBe(4000 + 1000 + 500 + 20_000)
    expect(result?.costProvenance).toEqual({ usage: 'measured', pricing: 'model-costs' })

    // The budget sees it.
    expect(totalSpent).toBeCloseTo(0.0405, 12)
    expect(costReport.totalSpent).toBeCloseTo(0.0405, 12)
    expect(costReport.byModel[MODEL]).toBeCloseTo(0.0405, 12)
  })
})

describe('budget filter compares estimated task cost against remaining budget', () => {
  /** Select a model with `maxTotalCost` spent against and the given prices. */
  async function selectionFor(maxTotalCost: number, costs: Record<string, typeof SONNET_PER_1K>) {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx({ omitGet: true }) as never)
    orchestrator.budget = { ...orchestrator.budget, maxTotalCost }
    orchestrator.setModelCosts(costs)
    const selection = orchestrator.selectBestModel('coder', COMPLEXITY)
    const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent
    const estimate = orchestrator.forecaster.estimateCost(COMPLEXITY, selection.model, selection.provider)
    await orchestrator.shutdown()
    return { selection, remaining, estimate }
  }

  it('rejects a model whose per-task estimate exceeds the remaining budget, even though its per-1K rate would have fit', async () => {
    // Remaining budget $0.02; sonnet priced at $0.02 per 1K in and out.
    // The old filter compared the $0.02 RATE against the $0.02 remaining total,
    // accepted it (0.02 <= 0.02), and picked it. The real per-task estimate is
    // 1750/1K * 0.02 + 875/1K * 0.02 = $0.0525, which does not fit.
    const { selection, estimate, remaining } = await selectionFor(0.02, {
      [MODEL]: { input: 0.02, output: 0.02, cacheRead: 0, cacheWrite: 0 },
    })
    expect(selection.model).not.toBe('claude-sonnet-4-6')
    // Whatever was chosen genuinely fits what is left.
    expect(estimate).toBeLessThanOrEqual(remaining)
  })

  it('does not reject a model that fits when the budget is comfortable', async () => {
    // Every candidate is comfortably inside a $10 budget, so the filter must
    // not exclude anything and the winner is decided purely on score.
    //
    // MODEL SELECTION FLIPPED HERE, deliberately, and this is the test that
    // pinned the old answer. The cost term is now the per-task USD estimate
    // rather than a mean per-1K rate compared against a fixed $15/1K ceiling,
    // so real relative prices finally carry weight. At complexity 50 with
    // fallback prices the winner is `gemini-2.5-flash`, not sonnet:
    //
    //   per-task estimate = 1750/1K * input + 875/1K * output
    //     sonnet   0.015 / 0.075 → $0.091875
    //     gemini 0.000075/0.0003 → $0.000394   (233x cheaper)
    //     free        0 / 0       → $0
    //   score = quality*0.4 + (1 - estimate/maxEstimate)*0.6
    //     sonnet  0.85*0.4 + 0.000*0.6 = 0.340
    //     gemini  0.78*0.4 + 0.996*0.6 = 0.909   ← winner
    //
    // The old term divided by 15.00, a ceiling calibrated to the deleted
    // relative table, under which every real price scored ≈1 and sonnet's
    // quality decided it. Quality and speed inputs are untouched by this
    // change, so the flip is caused by the cost term alone.
    const { selection, estimate, remaining } = await selectionFor(10, {})
    expect(selection.model).toBe('gemini-2.5-flash')
    expect(estimate).toBeLessThanOrEqual(remaining)
  })

  it('keeps a model explicitly priced at zero selectable with no budget left at all', async () => {
    // An explicit `{input: 0, output: 0}` entry in modelCosts — the real-price
    // path for a free model, as opposed to the fallback table. Its estimated
    // task cost is 0, so the `estimate === 0` escape hatch must keep it
    // selectable however little budget is left.
    const { selection, estimate } = await selectionFor(0, {
      [MODEL]: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'anthropic/claude-haiku-4-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'openai/gpt-5-mini': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'google/gemini-2.5-flash': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'opencode/minimax-m2.5-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(selection.model).toBe('minimax-m2.5-free')
    expect(estimate).toBe(0)
  })

  it('keeps a genuinely free model selectable with no budget left at all', async () => {
    // Same, via the fallback table rather than a real price entry.
    const { selection } = await selectionFor(0, {
      [MODEL]: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'anthropic/claude-haiku-4-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'openai/gpt-5-mini': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'google/gemini-2.5-flash': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    expect(selection.model).toBe('minimax-m2.5-free')
  })

  it('falls back to all candidates when none is affordable', async () => {
    // No budget left AND the nominally-free model is really priced, so the
    // candidate set is genuinely infeasible. Selection must still succeed
    // rather than fail or return nothing.
    const { selection, estimate, remaining } = await selectionFor(0, {
      [MODEL]: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'opencode/minimax-m2.5-free': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    expect(selection.model).toBeTruthy()
    // Proof the fallback branch ran: the winner is a paid model whose estimate
    // does NOT fit the budget, i.e. selection ignored affordability entirely.
    expect(estimate).toBeGreaterThan(remaining)
    expect(selection.model).not.toBe('minimax-m2.5-free')
  })
})

describe('one price source — the forecaster and the orchestrator agree', () => {
  it('resolves a priced model to the same per-1K rates the orchestrator holds', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx({ omitGet: true }) as never)
    orchestrator.setModelCosts({ [MODEL]: SONNET_PER_1K })

    expect(orchestrator.forecaster.priceFor(MODEL)).toEqual({
      pricing: SONNET_PER_1K,
      source: 'model-costs',
    })
    // Same object of truth, both sides of the plugin — compared through the
    // tier list, since a `modelCosts` entry is now a tiered price list and
    // `priceFor` returns the base tier's rates.
    expect(orchestrator.forecaster.priceFor(MODEL).pricing)
      .toEqual(selectTier(orchestrator.getModelCost(MODEL)!.tiers, 0).rates)

    const usage: Tokens = { input: 2000, output: 4000, reasoning: 1000, cache: { read: 1000, write: 500 } }
    const rates = selectTier(orchestrator.getModelCost(MODEL)!.tiers, 0).rates
    const expected = (rates.input * 2000
      + rates.output * (4000 + 1000)
      + rates.cacheRead * 1000
      + rates.cacheWrite * 500) / 1000
    expect(orchestrator.forecaster.costOf(usage, MODEL)).toBeCloseTo(expected, 12)

    await orchestrator.shutdown()
  })

  it('picks up prices loaded from OpenCode, not a hardcoded table', async () => {
    const orchestrator = new NexusOrchestrator()
    const ctx = makeCtx({ omitGet: true })
    ctx.model.list = mock(() => Promise.resolve({
      data: [{ providerID: 'anthropic', id: 'claude-opus-4-7', cost: [{ input: 15, output: 75, cache: { read: 1.5, write: 18.75 } }] }],
    }))
    await orchestrator.initialize(ctx as never)

    // Per-million from OpenCode → per-1K here and in the forecaster.
    expect(orchestrator.forecaster.priceFor('anthropic/claude-opus-4-7')).toEqual({
      pricing: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
      source: 'model-costs',
    })
    await orchestrator.shutdown()
  })

  it('falls back to a unit-consistent table only for models the real table does not know', () => {
    const forecaster = new CostForecaster()
    const resolved = forecaster.priceFor('claude-sonnet-4-6')
    expect(resolved.source).toBe('fallback-table')
    // The old table stored 0.000015 PER TOKEN; the per-1K rate is 0.015, i.e.
    // 1000x larger. Asserting the per-1K figure pins the unit.
    expect(resolved.pricing.input).toBe(0.015)
    expect(resolved.pricing.output).toBe(0.075)
    // Cache is priced too, not silently zero: a cache-heavy run on a
    // fallback-priced model would otherwise bill $0 for its whole cache term.
    // Derived from this row's own input rate (0.1x read, 1.25x write).
    expect(resolved.pricing.cacheRead).toBe(0.0015)
    expect(resolved.pricing.cacheWrite).toBe(0.01875)

    const unknown = forecaster.priceFor('who/knows')
    expect(unknown.source).toBe('unknown-model')
    // 0.01 input → 0.001 read, 0.0125 write.
    expect(unknown.pricing.cacheRead).toBe(0.001)
    expect(unknown.pricing.cacheWrite).toBe(0.0125)
  })

  it('derives the fallback cache rates by the relation the real prices follow', () => {
    // Provenance for the fallback table's cache numbers: they are derived from
    // each row's input rate by the 0.1x / 1.25x relation, and that relation is
    // exactly what the two verified real prices obey.
    const realSonnet = { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 }
    const realOpus = { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 }
    for (const real of [realSonnet, realOpus]) {
      expect(real.input * 0.1).toBeCloseTo(real.cacheRead, 12)
      expect(real.input * 1.25).toBeCloseTo(real.cacheWrite, 12)
    }

    // And the free model stays genuinely free through the same derivation.
    expect(new CostForecaster().priceFor('opencode/minimax-m2.5-free').pricing)
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('keeps the free model priced at zero in the fallback table', () => {
    const forecaster = new CostForecaster()
    expect(forecaster.priceFor('opencode/minimax-m2.5-free').pricing).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    })
  })

  it('claims confidence only for a real measurement at a real price', async () => {
    const usage: Tokens = { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }

    const real = new CostForecaster(() => ({ tiers: [{ rates: SONNET_PER_1K }] }))
    expect(real.measureCost(usage, MODEL)).toEqual({
      cost: 100 / 1000 * 0.003 + 100 / 1000 * 0.015,
      tokens: 200,
      pricingSource: 'model-costs',
      confidence: 1,
    })

    // A measured count at a guessed rate is not certain, so no confidence.
    const guessing = new CostForecaster()
    expect(guessing.measureCost(usage, MODEL).confidence).toBeUndefined()
  })

  it('produces a deterministic forecast with no fabricated confidence', () => {
    const forecaster = new CostForecaster()
    const task = {
      id: 't', name: 'n', description: 'd', requiredRole: 'coder',
      files: { include: [] }, complexity: COMPLEXITY,
      dependencies: [], priority: 'normal' as const, status: 'pending' as const,
    }
    const first = forecaster.forecastTask(task, 'coder', MODEL, COMPLEXITY)
    const second = forecaster.forecastTask(task, 'coder', MODEL, COMPLEXITY)
    expect(first.confidence).toBeUndefined()
    expect(first).toEqual(second)
    expect(first.source).toBe('estimated')
    expect(first.breakdown.cacheCost).toBe(0)
  })
})
