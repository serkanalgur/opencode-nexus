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
const {
  CostForecaster, priceTokens, priceUsage, priceUsageAtSettledTier, totalTokens, selectTier, promptSizeOf,
} = await import('../src/forecast')

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
 *
 * The extra controls below exist for the timed-out-cost-delta tests, which need
 * a session that behaves over TIME rather than answering once. All of them
 * default to today's behaviour — a session whose `wait` resolves at once and
 * whose `get` always answers the same — so every pre-existing test is
 * unaffected.
 */
function makeCtx(opts: {
  tokens?: Tokens
  getThrows?: boolean
  omitGet?: boolean
  promptThrows?: boolean
  output?: string
  /** Successive `session.get` snapshots. The last one repeats once exhausted. */
  tokenSequence?: Tokens[]
  /** Zero-based indices of `session.get` calls that should reject. */
  getThrowsOn?: number[]
  /** `time.idle` reported per `session.get` call; the last repeats. */
  idleSequence?: Array<number | undefined>
  /** Never settle `session.wait`: a genuinely stuck session. */
  waitNever?: boolean
  /** Resolve `session.wait` after this long — a session that idles late. */
  waitResolvesAfterMs?: number
  /** Reject `session.wait` after this long — a poll that dies mid-flight. */
  waitRejectsAfterMs?: number
} = {}) {
  let gets = 0
  /** The `n`th value of `seq`, holding the last one once exhausted. */
  const at = <T>(seq: T[] | undefined, n: number, fallback: T): T =>
    seq && seq.length > 0 ? (seq[Math.min(n, seq.length - 1)] as T) : fallback

  const session: Record<string, unknown> = {
    create: mock(() => Promise.resolve({ id: 'ses_child' })),
    prompt: mock(() => opts.promptThrows ? Promise.reject(new Error('provider refused')) : Promise.resolve()),
    wait: mock((): Promise<void> => {
      if (opts.waitNever) return new Promise<void>(() => {})
      if (opts.waitRejectsAfterMs !== undefined) {
        return new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('SessionNotFoundError')), opts.waitRejectsAfterMs))
      }
      if (opts.waitResolvesAfterMs !== undefined) {
        return new Promise<void>(resolve => setTimeout(resolve, opts.waitResolvesAfterMs))
      }
      return Promise.resolve()
    }),
    context: mock(() => Promise.resolve(opts.output
      ? [{ type: 'assistant', content: [{ type: 'text', text: opts.output }] }]
      : [])),
  }
  if (!opts.omitGet) {
    session.get = mock(() => {
      const call = gets++
      const idle = at(opts.idleSequence, call, undefined)
      if (opts.getThrows || (opts.getThrowsOn?.includes(call) ?? false)) {
        return Promise.reject(new Error('session unavailable'))
      }
      // `cost` is deliberately present and non-zero: the implementation must
      // ignore it and derive cost from tokens, or the two paths would disagree.
      return Promise.resolve({
        id: 'ses_child',
        cost: 42,
        time: { created: 0, updated: 0, ...(idle === undefined ? {} : { idle }) },
        tokens: at(opts.tokenSequence, call, opts.tokens as Tokens),
      })
    })
  }
  return {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    model: { list: mock(() => Promise.resolve({ data: [] })) },
    session,
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve([])) },
    getCalls: () => gets,
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
 *
 * The delta tests need to observe the orchestrator BETWEEN the timeout and the
 * settlement of the abandoned session, so `settle` chooses who drives that:
 * `'none'` (the default, and the pre-existing behaviour — `shutdown` does it
 * last) or `'flush'` to discharge the outstanding collection first.
 * `taskTimeoutMs` and `graceMs` keep the timing-bearing paths to milliseconds
 * rather than the production 30s floor.
 */
async function runTask(
  ctx: ReturnType<typeof makeCtx>,
  { model = MODEL, pricing = SONNET_PER_1K, tiers, onReady, afterTask, settle = 'none', taskTimeoutMs = 1000, graceMs, selfHealing }: {
    model?: string
    pricing?: typeof SONNET_PER_1K | null
    /** A full tiered price list, written straight into `modelCosts`. */
    tiers?: { tiers: readonly { threshold?: number; rates: typeof SONNET_PER_1K }[] }
    onReady?: (orchestrator: NexusOrchestrator) => void
    /** Runs after `executeTask` returns and before anything is read back. */
    afterTask?: (orchestrator: NexusOrchestrator) => unknown
    settle?: 'none' | 'flush'
    taskTimeoutMs?: number
    graceMs?: number
    /** Self-healing is off unless a test needs `handleFailure` to run. */
    selfHealing?: boolean
  } = {}
) {
  // Self-healing off: a retry would spawn a second session and re-enter
  // executeTask, which is a different test.
  const orchestrator = new NexusOrchestrator({
    selfHealing: { enabled: selfHealing ?? false },
    ...(graceMs === undefined ? {} : { cost: { timeoutDeltaGraceMs: graceMs } }),
  })
  await orchestrator.initialize(ctx as never)
  if (pricing) orchestrator.setModelCosts({ [model]: pricing })
  if (tiers) orchestrator.modelCosts.set(model, tiers)
  onReady?.(orchestrator)

  const node: TaskNode = {
    id: 'node-1',
    status: 'running',
    task: {
      id: 'task-1',
      name: 't',
      description: 'd',
      requiredRole: 'coder',
      timeout: taskTimeoutMs,
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

  const after = await afterTask?.(orchestrator)
  if (settle === 'flush') await orchestrator['flushTimeoutDeltas']()

  // Read every assertion target BEFORE the shutdown, so `afterTask` is free to
  // drive the teardown itself and the numbers reported here are the ones the
  // test asked about.
  const costReport = JSON.parse(orchestrator.getCostReport())
  const result = node.result
  const totalSpent = orchestrator.totalSpent
  await orchestrator.shutdown()
  return { result, costReport, totalSpent, marked: completed, after, orchestrator, agent }
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

// === The timed-out cost delta ===
//
// `executeTask` raced the task's completion against a timeout and billed the
// tokens read AT THAT INSTANT, while the session was never aborted and kept
// generating and spending. The task that timed out was billed for the work it
// had done when the clock ran out and nothing after — so the most expensive
// case, a hung or slow task, was the one billed the cheapest possible snapshot.
//
// The signal needed to fix it was already in hand and already being discarded:
// `Promise.race` does not cancel its loser, so the `session.wait` promise is
// still live after the timeout and still resolves later, at exactly the moment
// wanted. `session.wait` is documented server-side as "wait for a session agent
// loop to become idle" and the TUI uses it as its "the turn is over" primitive.

/** Usage snapshot helper — `0` everywhere but the fields named. */
const usage = (n: Partial<Tokens>): Tokens => ({
  input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...n,
})

  // A DISCOUNTED long-context tier: base {0.01,0.01} per 1K, and anything over
  // a 200k prompt bills at {0.001,0.001}. This is Gemini's published shape and
  // it is the one that inverts the direction of the error.
  //
  // UNITS: `modelCosts` and `priceTokens` are USD per 1K, so the design's
  // worked figures (a base of "10", an increment of "$1.10") are per-MILLION
  // rates — OpenCode's own unit — and are reproduced here 1000x smaller. The
  // dollars are identical either way; only the scale of the rate differs.
  const DISCOUNTED = {
    tiers: [
      { rates: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 } },
      { threshold: 200_000, rates: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 } },
    ],
  }
  // A MONOTONE price list: base {0.001,0.001}, premium {0.006,0.006} above
  // 200k. The common case, where the arithmetic telescopes exactly.
  const MONOTONE = {
    tiers: [
      { rates: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 } },
      { threshold: 200_000, rates: { input: 0.006, output: 0.006, cacheRead: 0, cacheWrite: 0 } },
    ],
  }

describe('the settled tier — pricing an increment, not a session', () => {

  it('bills a $1.10 increment at $0.11, not at the base rate it appears to be', () => {
    // The two readings, side by side. `promptSizeOf(increment)` is a
    // meaningless number: the increment's tokens were generated by calls whose
    // prompt was the FULL context at that moment, not the increment.
    const atTimeout = usage({ input: 150_000, output: 10_000 })
    const atSettlement = usage({ input: 250_000, output: 20_000 })
    const increment = usage({ input: 100_000, output: 10_000 })

    // What the timeout charge was: 150k at the base rate plus 10k out.
    //   150/1K * 10 + 10/1K * 10 = 1.50 + 0.10 = $1.60
    expect(priceUsage(atTimeout, DISCOUNTED).total).toBeCloseTo(1.60, 12)
    // The ideal, for reference: one selection over the whole settled session.
    //   250/1K * 1 + 20/1K * 1 = 0.25 + 0.20 = $0.27
    expect(priceUsage(atSettlement, DISCOUNTED).total).toBeCloseTo(0.27, 12)
    // The trap: the increment's own prompt size is 100k, under the threshold,
    // so `priceUsage` selects the BASE row and prices it at $1.10.
    expect(promptSizeOf(increment)).toBe(100_000)
    expect(priceUsage(increment, DISCOUNTED).total).toBeCloseTo(1.10, 12)
    // The rule: the tier comes from the CUMULATIVE usage at settlement.
    //   100/1K * 1 + 10/1K * 1 = 0.10 + 0.01 = $0.11
    expect(priceUsageAtSettledTier(increment, DISCOUNTED, atSettlement).total).toBeCloseTo(0.11, 12)
  })

  it('is EXACT on a monotone price list: the increment plus the timeout charge re-sums to the session', () => {
    // The same shape with rates that do not invert. Here the arithmetic
    // telescopes, and the correction is exact to the cent.
    const atTimeout = usage({ input: 250_000 })
    const atSettlement = usage({ input: 300_000 })
    const increment = usage({ input: 50_000 })

    // 250k is over the 200k threshold, so even the TIMEOUT charge is at {6,6}.
    //   250/1K * 6 = $1.50
    expect(priceUsage(atTimeout, MONOTONE).total).toBeCloseTo(1.50, 12)
    //   300/1K * 6 = $1.80
    expect(priceUsage(atSettlement, MONOTONE).total).toBeCloseTo(1.80, 12)
    // The trap: the increment's own prompt size is 50k, under the threshold, so
    //   50/1K * 1 = $0.05 — off by 6x on a $0.30 correction.
    expect(priceUsage(increment, MONOTONE).total).toBeCloseTo(0.05, 12)
    // The rule, at the settled tier:
    //   50/1K * 6 = $0.30
    const delta = priceUsageAtSettledTier(increment, MONOTONE, atSettlement).total
    expect(delta).toBeCloseTo(0.30, 12)
    // EXACTLY the whole session, to the cent. This is the property that makes
    // the rule right rather than merely better: on a monotone price list the
    // two independently-tiered halves re-sum to a single-tiered total.
    expect(priceUsage(atTimeout, MONOTONE).total + delta)
      .toBeCloseTo(priceUsage(atSettlement, MONOTONE).total, 12)
  })
})

/**
 * Collect `cost:delta` events. Registered from `afterTask`, which runs a few
 * milliseconds after `executeTask` returns and well before the abandoned
 * session settles, and awaited via `first` so nothing depends on a sleep
 * being long enough.
 */
function watchDeltas(o: NexusOrchestrator) {
  const deltas: Array<Record<string, unknown>> = []
  let resolveFirst: () => void = () => {}
  const first = new Promise<void>(r => { resolveFirst = r })
  o.on('cost:delta', (d: Record<string, unknown>) => { deltas.push(d); resolveFirst() })
  return {
    deltas,
    /** Resolve on the first delta, or after a ceiling that should never be hit. */
    settle: async () => {
      await Promise.race([first, Bun.sleep(2000)])
      // A beat past the first event, so a SECOND one would have been seen.
      await Bun.sleep(40)
    },
  }
}

describe('a timed-out task is billed for what its session did afterwards', () => {

  it('prices the increment at the settled tier, not at the base rate its size appears to select', async () => {
    // The whole point, end to end. A discounted long-context tier, a session
    // that idles 30ms after its deadline, and the assertion that the reported
    // total is $1.71 and not the $2.70 the naive scheme produces.
    const atTimeout = usage({ input: 150_000, output: 10_000 })
    const atSettlement = usage({ input: 250_000, output: 20_000 })
    const { costReport, totalSpent, after } = await runTask(
      makeCtx({ tokenSequence: [atTimeout, atSettlement], waitResolvesAfterMs: 60 }),
      {
        pricing: null, tiers: DISCOUNTED,
        taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        afterTask: async (o) => { const w = watchDeltas(o); await w.settle(); return w },
      }
    )
    const { deltas } = after as ReturnType<typeof watchDeltas>

    // Charged at the timeout: 150k at the base rate plus 10k out.
    //   150/1K * 0.01 + 10/1K * 0.01 = 1.50 + 0.10 = $1.60
    expect(priceUsage(atTimeout, DISCOUNTED).total).toBeCloseTo(1.60, 12)
    // The increment, at the tier the SETTLED cumulative usage selects:
    //   100/1K * 0.001 + 10/1K * 0.001 = 0.10 + 0.01 = $0.11
    expect(priceUsageAtSettledTier(
      usage({ input: 100_000, output: 10_000 }), DISCOUNTED, atSettlement).total).toBeCloseTo(0.11, 12)
    // NOT $2.70. Under the naive rule — `priceUsage(increment)`, which selects
    // the base row because the increment's own prompt size is 100k — the total
    // would be 1.60 + 1.10.
    expect(totalSpent).toBeCloseTo(1.71, 12)
    expect(costReport.totalSpent).toBeCloseTo(1.71, 12)
    expect(deltas).toHaveLength(1)
    expect(deltas[0].deltaCost).toBeCloseTo(0.11, 12)
    expect(deltas[0].deltaTokens).toBe(110_000)
    expect(deltas[0].reason).toBe('session-idle')
  })

  it('is exact on a monotone price list: the delta is $0.30, not $0.05, and the total re-sums to the session', async () => {
    const atTimeout = usage({ input: 250_000 })
    const atSettlement = usage({ input: 300_000 })
    const { costReport, totalSpent, after } = await runTask(
      makeCtx({ tokenSequence: [atTimeout, atSettlement], waitResolvesAfterMs: 60 }),
      {
        pricing: null, tiers: MONOTONE,
        taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        afterTask: async (o) => { const w = watchDeltas(o); await w.settle(); return w },
      }
    )
    const { deltas } = after as ReturnType<typeof watchDeltas>

    //   timeout  250/1K * 0.006 = $1.50
    //   delta     50/1K * 0.006 = $0.30   (naively 50/1K * 0.001 = $0.05)
    //   total                   = $1.80
    expect(deltas).toHaveLength(1)
    expect(deltas[0].deltaCost).toBeCloseTo(0.30, 12)
    expect(deltas[0].deltaTokens).toBe(50_000)
    expect(totalSpent).toBeCloseTo(1.80, 12)
    // EXACTLY the whole session priced in one selection. On a monotone price
    // list the two independently-tiered halves telescope, and this is the
    // assertion that says so to the cent.
    expect(costReport.totalSpent).toBeCloseTo(priceUsage(atSettlement, MONOTONE).total, 12)
  })

  it('never reports less than the charge already taken at the timeout', async () => {
    // Monotonicity as its own assertion, over BOTH price-list shapes.
    //
    // Prices are non-negative, so billing the remainder can only move a total
    // up: this is a strict improvement over the timeout-only charge under
    // either pricing scheme, including the naive one. Pinned separately
    // because it is the property that must survive any future re-pricing of
    // the increment — a scheme that could come in UNDER the timeout charge
    // would be a regression to a silent under-bill, and nothing else here would
    // notice.
    for (const [name, tiers, atTimeout, atSettlement] of [
      ['discounted', DISCOUNTED, usage({ input: 150_000, output: 10_000 }), usage({ input: 250_000, output: 20_000 })],
      ['monotone', MONOTONE, usage({ input: 250_000 }), usage({ input: 300_000 })],
    ] as const) {
      const { totalSpent } = await runTask(
        makeCtx({ tokenSequence: [atTimeout, atSettlement], waitResolvesAfterMs: 60 }),
        { pricing: null, tiers, taskTimeoutMs: 30, graceMs: 400, settle: 'flush' }
      )
      const chargedAtTimeout = priceUsage(atTimeout, tiers).total
      expect(totalSpent).toBeGreaterThanOrEqual(chargedAtTimeout)
      expect(totalSpent).toBeGreaterThan(chargedAtTimeout)
      // And the total equals the sum of the two independently-priced halves,
      // so nothing else moved.
      expect(totalSpent).toBeCloseTo(
        chargedAtTimeout + priceUsageAtSettledTier(
          {
            input: atSettlement.input - atTimeout.input,
            output: atSettlement.output - atTimeout.output,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          tiers,
          atSettlement
        ).total,
        12
      )
    }
  })
})

describe('the collection is idempotent, and reports what it could not collect', () => {
  it('changes NOTHING at all when the session is reported idle again having spent nothing more', async () => {
    // NOT "charge $0". A $0 charge is not a no-op: `trackCost` would grow
    // `costHistory`, add a provenance entry, run the budget check and fire a
    // state change. So the assertion is that none of those moved, which is what
    // proves `trackCost` was never called.
    const atTimeout = usage({ input: 40_000, output: 2_000 })
    const { costReport, totalSpent, after, orchestrator } = await runTask(
      // The session idles late, and has not been billed for anything since the
      // timeout: the increment is genuinely empty.
      makeCtx({ tokenSequence: [atTimeout], waitResolvesAfterMs: 60 }),
      {
        taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        afterTask: async (o) => {
          const w = watchDeltas(o)
          await w.settle()
          return {
            ...w,
            costHistory: o['costHistory'].length,
            entries: o['costHistory'].map(e => ({ ...e })),
          }
        },
      }
    )
    const { deltas, costHistory, entries } = after as {
      deltas: Array<Record<string, unknown>>; costHistory: number; entries: Array<{ cost: number }>
    }

    // One charge total: the timeout snapshot, and nothing since.
    expect(totalSpent).toBeCloseTo(priceTokens(atTimeout, SONNET_PER_1K).total, 12)
    expect(costHistory).toBe(1)
    expect(entries[0].cost).toBeCloseTo(totalSpent, 12)
    expect(costReport.provenance[MODEL]).toEqual({
      usage: 'measured', pricing: 'model-costs',
      measuredEntries: 1, estimatedEntries: 0,
      measuredSpend: totalSpent, estimatedSpend: 0,
    })
    // The event is still emitted, so a caller waiting on settlement is told.
    // What is not emitted is a charge.
    expect(deltas).toHaveLength(1)
    expect(deltas[0].deltaCost).toBe(0)
    expect(deltas[0].deltaTokens).toBe(0)
    expect(deltas[0].reason).toBe('session-idle')
    // And the ledger is gone, so a second handler — a duplicate event, a late
    // timer, the shutdown flush — has nothing to charge even if it fires.
    expect(orchestrator['deltaLedgers'].size).toBe(0)
    // Provoke the second handler explicitly: no charge, no history growth.
    await orchestrator['flushTimeoutDeltas']()
    expect(orchestrator['costHistory'].length).toBe(1)
    expect(orchestrator.totalSpent).toBeCloseTo(totalSpent, 12)
  })

  it('adjusts the history and performance records in place rather than appending a second one', async () => {
    // Both record types are append-only and both call sites discard the
    // `record` return value, so an append-based correction would double
    // `totalCost`, show two history rows for one task, double `totalTasks`
    // (halving every mean and putting a phantom task into the success-rate
    // denominator) and overstate `measuredTasks`.
    const atTimeout = usage({ input: 250_000 })
    const atSettlement = usage({ input: 300_000 })
    const { orchestrator } = await runTask(
      makeCtx({ tokenSequence: [atTimeout, atSettlement], waitResolvesAfterMs: 60 }),
      {
        pricing: null, tiers: MONOTONE,
        taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        afterTask: async (o) => { await watchDeltas(o).settle() },
      }
    )
    const history = orchestrator.executionHistory
    const performance = orchestrator.performanceTracker

    // One record, one entry — before and after the correction alike.
    expect(history.getStats().total).toBe(1)
    expect(performance.getStats().totalEntries).toBe(1)
    expect(performance.getScores()[0].totalTasks).toBe(1)
    expect(performance.getScores()[0].measuredTasks).toBe(1)
    expect(history.getAll()).toHaveLength(1)

    // The cost fields moved to the corrected total, in both places.
    const total = orchestrator.totalSpent
    expect(total).toBeCloseTo(1.80, 12)
    expect(history.getStats().totalCost).toBeCloseTo(total, 12)
    expect(history.getStats().costSplit.measuredCost).toBeCloseTo(total, 12)
    expect(history.getAll()[0].cost).toBeCloseTo(total, 12)
    expect(history.getAll()[0].tokensUsed).toBe(300_000)
    expect(performance.getScores()[0].avgCost).toBeCloseTo(total, 12)

    // And NOTHING ELSE did. The task genuinely did fail at the timeout; a cost
    // correction is accounting, not progress.
    const record = history.getAll()[0]
    expect(record.status).toBe('failed')
    expect(record.error).toBe('Task timed out')
    expect(record.tokensUsed).toBe(300_000)
    expect(orchestrator.performanceTracker.getScores()[0].successRate).toBe(0)
    // Provenance of the ORIGINAL charge is untouched: the correction reaches
    // `totalSpent` through its own `measured` `trackCost` entry, so the split
    // still accounts for the whole amount.
    expect(record.costProvenance).toEqual({ usage: 'measured', pricing: 'model-costs' })
  })

  it('reports an abandoned session as a BOUND, charges nothing for it, and leaves no timer behind', async () => {
    // The session never goes idle and `time.idle` never advances, so the
    // deadline probe finds nothing to reconcile and the collection is dropped.
    const atTimeout = usage({ input: 150_000, output: 10_000 })
    const atProbe = usage({ input: 400_000, output: 30_000 })
    const { costReport, totalSpent, after, orchestrator } = await runTask(
      makeCtx({ tokenSequence: [atTimeout, atProbe], waitNever: true }),
      {
        pricing: null, tiers: DISCOUNTED, taskTimeoutMs: 30, graceMs: 40,
        // Read the leak counters HERE, while the orchestrator is still live and
        // `shutdown` has not swept the set on its way out. Asserting them after
        // teardown would pass even with no removal at all.
        afterTask: async (o) => {
          const w = watchDeltas(o)
          await w.settle()
          return { ...w, timers: o['deltaTimers'].size, ledgers: o['deltaLedgers'].size }
        },
      }
    )
    const { deltas, timers, ledgers } = after as {
      deltas: Array<Record<string, unknown>>; timers: number; ledgers: number
    }

    // Nothing was charged for the uncollected remainder. `totalSpent` is still
    // the timeout snapshot and nothing else.
    expect(totalSpent).toBeCloseTo(priceUsage(atTimeout, DISCOUNTED).total, 12)
    expect(costReport.totalSpent).toBeCloseTo(1.60, 12)

    // But the remainder is RECORDED rather than dropped. `upperBound` is the
    // priced increment between the last charge and the last read, and it is
    // deliberately NOT in `totalSpent`: adding an estimate to a measured total
    // is the conflation `CostProvenance` exists to prevent. A reader gets "we
    // are under-counting by at most $X", not a total containing a guess.
    expect(costReport.uncollected).toEqual({
      sessions: 1,
      lastKnownTokens: 430_000,
      upperBound: priceUsageAtSettledTier(
        usage({ input: 250_000, output: 20_000 }), DISCOUNTED, atProbe).total,
      taskIds: ['node-1'],
    })
    // 400k is over the 200k threshold, so the bound is priced at the
    // discounted tier: 250/1K * 0.001 + 20/1K * 0.001 = $0.27.
    expect(costReport.uncollected.upperBound).toBeCloseTo(0.27, 12)
    expect(totalSpent).toBeLessThan(1.60 + costReport.uncollected.upperBound)

    expect(deltas).toHaveLength(1)
    expect(deltas[0].reason).toBe('abandoned')
    expect(deltas[0].deltaCost).toBe(0)

    // THE LEAK ASSERTION. One timer per timed-out task, removed in its own
    // `finally`, and one ledger per session, removed when its collection
    // settles: neither set is left holding anything after the fact.
    expect(timers).toBe(0)
    expect(ledgers).toBe(0)
    expect(orchestrator['deltaTimers'].size).toBe(0)
  })

  it('reconciles for free when the deadline probe finds the session had in fact settled', async () => {
    // The timer and the wait are two independent observations of the same
    // fact, and losing that race is not evidence the session never settled. The
    // server's own `time.idle` is what settles it, and a session that reports
    // an idle stamp newer than the timeout snapshot's is billed rather than
    // abandoned.
    const atTimeout = usage({ input: 250_000 })
    const atProbe = usage({ input: 300_000 })
    const { costReport, totalSpent, after } = await runTask(
      makeCtx({
        tokenSequence: [atTimeout, atProbe],
        // Never settles through `wait`; only `time.idle` says it finished.
        waitNever: true,
        idleSequence: [1_000, 2_000],
      }),
      {
        pricing: null, tiers: MONOTONE, taskTimeoutMs: 30, graceMs: 40, settle: 'flush',
        afterTask: async (o) => { const w = watchDeltas(o); await w.settle(); return w },
      }
    )
    const { deltas } = after as { deltas: Array<Record<string, unknown>> }

    expect(deltas).toHaveLength(1)
    // Settled, not abandoned — even though the wait never resolved and the
    // deadline is what woke us up.
    expect(deltas[0].reason).toBe('session-idle')
    expect(deltas[0].deltaCost).toBeCloseTo(0.30, 12)
    expect(totalSpent).toBeCloseTo(1.80, 12)
    expect(costReport.uncollected.sessions).toBe(0)
  })
})

describe('a delta read that fails is retried, and never becomes an estimate', () => {
  it('retries a failed read and charges the recovered increment as measured', async () => {
    // A delta whose read failed is not a delta — it is an abandoned collection.
    // Routing it through `safeAccountTaskCost` would launder the failure into
    // `forecastTask` as `estimated`, reporting a guess as a correction to a
    // measurement. So: three attempts, and on the one that lands, `measured`.
    const atTimeout = usage({ input: 250_000 })
    const atSettlement = usage({ input: 300_000 })
    const ctx = makeCtx({
      tokenSequence: [atTimeout, atSettlement],
      waitResolvesAfterMs: 60,
      // Reads 1 and 2 are the delta read's first two attempts. Read 0 is the
      // original charge and must succeed, or there would be no measured
      // baseline to correct.
      getThrowsOn: [1, 2],
    })
    const { costReport, totalSpent, after, orchestrator } = await runTask(
      ctx,
      {
        pricing: null, tiers: MONOTONE, taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        onReady: (o) => { o['deltaReadBackoffMs'] = [1, 1, 1] },
        afterTask: async (o) => { const w = watchDeltas(o); await w.settle(); return w },
      }
    )
    const { deltas } = after as { deltas: Array<Record<string, unknown>> }

    // It got there, and what it charged is real.
    expect(deltas).toHaveLength(1)
    expect(deltas[0].deltaCost).toBeCloseTo(0.30, 12)
    expect(totalSpent).toBeCloseTo(1.80, 12)
    // The recovered charge is `measured`, like every other charge here.
    expect(costReport.provenance[MODEL]).toEqual({
      usage: 'measured', pricing: 'model-costs',
      measuredEntries: 2, estimatedEntries: 0,
      measuredSpend: totalSpent, estimatedSpend: 0,
    })
    expect(costReport.uncollected.sessions).toBe(0)
    // Three attempts, and it stopped at the one that worked rather than
    // burning the remaining two: four reads in total — the original charge plus
    // two failures and one success.
    expect(ctx.getCalls()).toBe(4)
    expect(orchestrator.totalSpent).toBeCloseTo(1.80, 12)
  })

  it('abandons the collection when every retry fails, and never invents the missing tokens', async () => {
    const atTimeout = usage({ input: 250_000 })
    const { costReport, totalSpent, after, orchestrator } = await runTask(
      makeCtx({
        tokenSequence: [atTimeout],
        waitResolvesAfterMs: 60,
        // Every attempt of the delta read fails.
        getThrowsOn: [1, 2, 3],
      }),
      {
        pricing: null, tiers: MONOTONE, taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        onReady: (o) => { o['deltaReadBackoffMs'] = [1, 1, 1] },
        afterTask: async (o) => {
          const w = watchDeltas(o)
          await w.settle()
          return { ...w, timers: o['deltaTimers'].size }
        },
      }
    )
    const { deltas, timers } = after as { deltas: Array<Record<string, unknown>>; timers: number }

    // The failure is a retryable condition, and after three attempts it is an
    // abandoned collection. What is NOT what happens: a `forecastTask`
    // estimate appearing as a correction. `estimatedEntries` stays at 0 and
    // `totalSpent` is still the timeout charge.
    expect(deltas).toHaveLength(1)
    expect(deltas[0].reason).toBe('abandoned')
    expect(deltas[0].deltaCost).toBe(0)
    expect(costReport.provenance[MODEL].estimatedEntries).toBe(0)
    expect(costReport.estimatedEntries).toBe(0)
    expect(totalSpent).toBeCloseTo(priceUsage(atTimeout, MONOTONE).total, 12)
    expect(costReport.uncollected.sessions).toBe(1)
    expect(costReport.uncollected.taskIds).toEqual(['node-1'])
    // No increment was ever observed, so there is no observed increment to
    // bound by, and the bound says so rather than inventing a figure.
    expect(costReport.uncollected.upperBound).toBe(0)
    // The deadline timer had not fired yet, so it is the SHUTDOWN sweep that has
    // to clear it — and the sweep runs before anything is read back here.
    expect(timers).toBe(1)
    expect(orchestrator['deltaTimers'].size).toBe(0)
  })
})

describe('only a timeout arms a collection', () => {
  it('arms nothing for an ordinary failure, so nothing dangles behind it', async () => {
    const deltas: Array<Record<string, unknown>> = []
    const { costReport, after, orchestrator } = await runTask(
      makeCtx({
        tokens: usage({ input: 4000, output: 1000 }),
        promptThrows: true,
        // A `wait` that would go on to resolve if anything were listening.
        waitResolvesAfterMs: 20,
      }),
      {
        taskTimeoutMs: 10_000, graceMs: 40,
        afterTask: async (o) => {
          o.on('cost:delta', (d: Record<string, unknown>) => deltas.push(d))
          await Bun.sleep(120)
          return { timers: o['deltaTimers'].size, ledgers: o['deltaLedgers'].size }
        },
      }
    )

    // The prompt failed, not the clock. There is no dangling session to
    // collect from, so there is no ledger, no timer, and no event.
    expect(deltas).toEqual([])
    expect((after as { timers: number; ledgers: number }).timers).toBe(0)
    expect((after as { timers: number; ledgers: number }).ledgers).toBe(0)
    expect(orchestrator['deltaLedgers'].size).toBe(0)
    expect(orchestrator['deltaTimers'].size).toBe(0)
    expect(costReport.uncollected).toEqual({
      sessions: 0, lastKnownTokens: 0, upperBound: 0, taskIds: [],
    })
    // The original charge is untouched by any of this.
    expect(costReport.totalSpent).toBeCloseTo(
      4000 / 1000 * SONNET_PER_1K.input + 1000 / 1000 * SONNET_PER_1K.output, 12)
  })

  it('arms nothing when the initial read failed, because a predicted delta is meaningless', async () => {
    // There is no measurement to correct. Billing a delta against a forecast
    // would be a correction to a guess, and would then be reported as
    // `measured` because the delta's own tokens are real.
    const deltas: Array<Record<string, unknown>> = []
    const { costReport, after, orchestrator } = await runTask(
      makeCtx({ waitNever: true }),
      {
        taskTimeoutMs: 30, graceMs: 40,
        // `getThrows` is `getThrowsOn` here so the failure lands on the DELTA
        // read, not on the initial charge. To make the INITIAL read fail too,
        // every read fails — which is what `getThrows` does.
        onReady: (o) => { o['deltaReadBackoffMs'] = [1, 1, 1] },
        afterTask: async (o) => {
          o.on('cost:delta', (d: Record<string, unknown>) => deltas.push(d))
          await Bun.sleep(120)
          return { timers: o['deltaTimers'].size, ledgers: o['deltaLedgers'].size }
        },
      }
    )
    // With no measured baseline, `cost.usage` is null and nothing is armed.
    expect(deltas).toEqual([])
    expect((after as { timers: number; ledgers: number }).timers).toBe(0)
    expect((after as { timers: number; ledgers: number }).ledgers).toBe(0)
    expect(orchestrator['deltaLedgers'].size).toBe(0)
    expect(orchestrator['deltaTimers'].size).toBe(0)
    expect(costReport.uncollected.sessions).toBe(0)
    expect(costReport.provenance[MODEL].usage).toBe('estimated')
  })
})

describe('teardown between the timeout and the idle', () => {
  it('flushes the collection, clears every timer, and raises no unhandled rejection', async () => {
    // The abandoned `session.wait` is an open long-poll with no `AbortSignal`
    // and no `catch`. It was safe only because `Promise.race` happened to
    // attach a rejection handler; the moment a `.then()` is added for the
    // delta, a mid-poll failure becomes a real unhandled rejection. So the
    // guard is asserted with an actual listener attached.
    const unhandled: unknown[] = []
    const deltas: Array<Record<string, unknown>> = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    const atTimeout = usage({ input: 250_000 })
    const atSettlement = usage({ input: 300_000 })
    try {
      const { totalSpent, after, orchestrator } = await runTask(
        makeCtx({ tokenSequence: [atTimeout, atSettlement], waitNever: true }),
        {
          pricing: null, tiers: MONOTONE,
          // A grace window long enough that only the teardown can end this.
          taskTimeoutMs: 30, graceMs: 10_000,
          afterTask: async (o) => {
            o.on('cost:delta', (d: Record<string, unknown>) => deltas.push(d))
            await o.shutdown()
            // The flush reads the session once more and bills it, because a
            // session that outlives the orchestrator is still spending.
            return {
              timers: o['deltaTimers'].size,
              ledgers: o['deltaLedgers'].size,
              spent: o.totalSpent,
            }
          },
        }
      )
      const { timers, ledgers } = after as { timers: number; ledgers: number; spent: number }

      expect(timers).toBe(0)
      expect(ledgers).toBe(0)
      expect(totalSpent).toBeCloseTo(1.80, 12)
      expect(deltas).toHaveLength(1)
      expect(deltas[0].reason).toBe('shutdown')
      // And nothing is left registered on the orchestrator itself.
      expect(orchestrator['deltaTimers'].size).toBe(0)
    } finally {
      // Give the runtime a chance to report anything that was going to.
      await Bun.sleep(50)
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

describe('a timeout is typed, and the typing does not fork the learning store', () => {
  it('keys the failure pattern on exactly "Task timed out"', async () => {
    // `handleFailure` records `error.message` as the learning store's failure
    // pattern, and that string is the KEY those patterns are stored and looked
    // up under. Replacing the bare `new Error("Task timed out")` with a
    // `TaskTimeoutError` is worth doing — a caller can tell a task that ran out
    // of budget from one that threw — and it is only safe if the message is
    // preserved byte for byte. Nothing else in the suite pins these keys, so
    // without this a subclass name, a `cause`, or a prefix would silently
    // fork every timeout's failure history away from the ones already stored.
    const { after, orchestrator } = await runTask(
      makeCtx({ waitNever: true }),
      {
        taskTimeoutMs: 30, graceMs: 40, selfHealing: true,
        // `handleFailure` must actually run to record the pattern, so
        // self-healing is on — but every escalation step is neutralised so it
        // records and then stops, rather than respawning a second session.
        onReady: (o) => {
          o['escalationPolicy'] = {
            maxRetries: 0, retryDelay: 1, backoffMultiplier: 2,
            enableRespawn: false, fallbackModels: [],
          }
        },
        afterTask: async (o) => {
          await o.shutdown()
          // `getEntries`, not `findSolutions`: a fresh pattern starts at
          // confidence 0.3 and is below the module's `minConfidence`, so
          // `findSolutions` filters it out by design. The KEY is what is under
          // test here, not the module's reliability threshold.
          return o.learning.getEntries().map(e => e.pattern)
        },
      }
    )
    // Exactly one pattern, keyed on the exact string the old bare
    // `new Error("Task timed out")` produced.
    expect(after).toEqual(['Task timed out'])
    // And the error object itself is the right TYPE, with the right message.
    const { TaskTimeoutError } = await import('../src/orchestrator')
    const err = new TaskTimeoutError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TaskTimeoutError')
    expect(err.message).toBe('Task timed out')
    // The record and the event carry the same string the key is built from.
    expect(orchestrator.executionHistory.getAll()[0].error).toBe('Task timed out')
  })
})

describe('adjust reports an unknown id rather than half-applying', () => {
  it('returns false from ExecutionHistory.adjust for an evicted or absent record', async () => {
    const { ExecutionHistory } = await import('../src/history')
    const history = new ExecutionHistory()
    const record = history.record({
      taskId: 't', taskName: 'n', role: 'coder', model: 'm', status: 'success',
      cost: 1, costProvenance: { usage: 'measured', pricing: 'model-costs' },
      duration: 5, tokensUsed: 10,
      startedAt: new Date(), completedAt: new Date(),
    })
    expect(history.adjust(record.id, { cost: 0.25, tokensUsed: 5 })).toBe(true)
    expect(history.getAll()[0].cost).toBeCloseTo(1.25, 12)
    expect(history.getAll()[0].tokensUsed).toBe(15)

    // History trims to 500 records, so eviction is real and a caller must be
    // able to tell "corrected" from "not there" instead of assuming the first.
    expect(history.adjust('exec-does-not-exist', { cost: 0.25 })).toBe(false)
    expect(history.getAll()).toHaveLength(1)
    expect(history.getAll()[0].cost).toBeCloseTo(1.25, 12)
  })

  it('returns false from PerformanceTracker.adjust for an evicted or absent entry', async () => {
    const { PerformanceTracker } = await import('../src/performance')
    const tracker = new PerformanceTracker()
    const id = tracker.record({
      model: 'm', role: 'coder', success: true, duration: 5, cost: 1,
      costProvenance: { usage: 'measured', pricing: 'model-costs' }, tokensUsed: 10,
    })
    expect(tracker.adjust(id, { cost: 0.25 })).toBe(true)
    // The mean moved, and the count did not: the whole point of adjusting.
    expect(tracker.getScores()[0].avgCost).toBeCloseTo(1.25, 12)
    expect(tracker.getScores()[0].totalTasks).toBe(1)
    expect(tracker.adjust('perf-does-not-exist', { cost: 0.25 })).toBe(false)
    expect(tracker.getScores()[0].totalTasks).toBe(1)
    expect(tracker.getStats().totalEntries).toBe(1)
  })
})

describe('a session.wait that dies mid-poll is not a session that went idle', () => {
  it('takes the probe path without an unhandled rejection, and abandons if the server agrees it is still busy', async () => {
    // The long-poll is open with no `AbortSignal` and no `catch` of its own. It
    // has only been safe because `Promise.race` happened to attach a handler —
    // which is exactly the assumption that stops holding once a `.then()` is
    // added for the delta. A poll that DIES is also not a settlement, so it must
    // probe rather than bill.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const atTimeout = usage({ input: 150_000, output: 10_000 })
      const atProbe = usage({ input: 400_000, output: 30_000 })
      const { costReport, totalSpent, after, orchestrator } = await runTask(
        makeCtx({
          tokenSequence: [atTimeout, atProbe],
          waitRejectsAfterMs: 60,
          idleSequence: [undefined, undefined],
        }),
        {
          pricing: null, tiers: DISCOUNTED, taskTimeoutMs: 30, graceMs: 400,
          afterTask: async (o) => {
            const w = watchDeltas(o)
            await w.settle()
            return { ...w, timers: o['deltaTimers'].size, ledgers: o['deltaLedgers'].size }
          },
        }
      )
      const { deltas, timers, ledgers } = after as {
        deltas: Array<Record<string, unknown>>; timers: number; ledgers: number
      }

      expect(deltas).toHaveLength(1)
      expect(deltas[0].reason).toBe('abandoned')
      // Still the timeout charge, with the remainder reported as a bound.
      expect(totalSpent).toBeCloseTo(1.60, 12)
      expect(costReport.uncollected.sessions).toBe(1)
      // Live counters: the deadline had not fired, so `shutdown` is what swept
      // the timer, and the ledger was removed the moment collection settled.
      expect(timers).toBe(1)
      expect(ledgers).toBe(0)
      expect(orchestrator['deltaTimers'].size).toBe(0)
      expect(orchestrator['deltaLedgers'].size).toBe(0)
    } finally {
      await Bun.sleep(50)
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

describe('a re-entrant collection attempt bills nothing', () => {
  it('refuses a second collection for the same session, from inside a cost:delta subscriber', async () => {
    // THE RE-ENTRANCY HAZARD, exercised from the outside.
    //
    // `trackCost` ends in `checkBudget()` and `emit()`, and `emit` reaches
    // arbitrary plugin subscribers SYNCHRONOUSLY. A subscriber that calls back
    // into the orchestrator therefore re-enters the collection while it is
    // still charging. That is the reason the cumulative snapshot is written
    // back before the charge and not after it.
    //
    // WHAT IS ACTUALLY LOAD-BEARING, and this test is precise about it: the
    // `pending` flag, not the write-back. `pending` is set before the window
    // opens and cleared only in the `finally` after it closes, so it
    // intercepts every re-entrant path BEFORE a delta is ever computed — and
    // the ledger deletion, which happens before the flag is cleared, is a
    // second independent block. The write-back is a third and innermost layer
    // whose necessity is NOT observable from here: swapping it past the charge
    // fails no test, and so does swapping it together with removing `pending`.
    // The mutation check for that is recorded in the comment on
    // `settleTimeoutDelta`, so the claim is not taken on trust here.
    const atTimeout = usage({ input: 250_000 })
    const atSettlement = usage({ input: 300_000 })
    const events: Array<Record<string, unknown>> = []
    let reentered: Promise<unknown> | null = null
    let spentAtReentry = 0
    let costHistoryAtReentry = 0

    const { costReport, totalSpent, orchestrator } = await runTask(
      makeCtx({ tokenSequence: [atTimeout, atSettlement], waitResolvesAfterMs: 60 }),
      {
        pricing: null, tiers: MONOTONE, taskTimeoutMs: 30, graceMs: 400, settle: 'flush',
        onReady: (o) => {
          o.on('cost:delta', (d: Record<string, unknown>) => {
            events.push(d)
            // Re-enter on the FIRST event only. A listener that re-entered
            // unconditionally would recurse for ever under a broken guard,
            // which would hang the suite rather than fail an assertion.
            if (reentered) return
            const ledger = o['deltaLedgers'].get(d.sessionID as string)
            if (!ledger) return
            // Snapshot the accounting as it stands at the moment of re-entry.
            spentAtReentry = o.totalSpent
            costHistoryAtReentry = o['costHistory'].length
            reentered = o['settleTimeoutDelta'](ledger, 'session-idle')
          })
        },
      }
    )
    // `emit` is synchronous and ignores handler return values, so the
    // re-entrant call's promise is awaited here rather than in the listener.
    await reentered

    // The re-entrant attempt was REFUSED, and refused completely: no second
    // charge, no second history entry, no second provenance entry, and no
    // second event. A refusal that still emitted a $0 delta would be a
    // half-applied adjustment, and the absence of a second event is what
    // distinguishes "the guard stopped it" from "it computed a zero delta".
    expect(events).toHaveLength(1)
    expect(events[0].deltaCost).toBeCloseTo(0.30, 12)

    // Nothing about the accounting moved between re-entry and the end.
    expect(spentAtReentry).toBeCloseTo(totalSpent, 12)
    expect(orchestrator.totalSpent).toBeCloseTo(totalSpent, 12)
    expect(totalSpent).toBeCloseTo(1.80, 12)
    expect(costHistoryAtReentry).toBe(2)
    expect(orchestrator['costHistory'].length).toBe(2)
    expect(costReport.provenance[MODEL].measuredEntries).toBe(2)
    expect(costReport.estimatedEntries).toBe(0)
    expect(costReport.uncollected.sessions).toBe(0)

    // And the session is finished with: both blocks are down, so a further
    // attempt from anywhere has nothing left to bill against.
    expect(orchestrator['deltaLedgers'].size).toBe(0)
  })
})
