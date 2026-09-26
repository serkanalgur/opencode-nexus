import { describe, it, expect, mock, afterAll } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `initialize` loads config from homedir(); sandbox it so this suite never
// touches the developer's real global config. Must run before the import.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { PerformanceTracker } = await import('../src/performance')
const { NexusOrchestrator } = await import('../src/orchestrator')
const { ExecutionHistory } = await import('../src/history')
type CostProvenance = import('../src/types').CostProvenance

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * Cost provenance reached the cost report in v2.5.0 and stopped there. Three
 * consumers downstream still handled a bare `cost` as if it were a bill:
 *
 *  - `PerformanceTracker` derived 30% of a model's `overallScore` from a mixed
 *    average. `costScore` saturates at 1, so a group whose recorded costs were
 *    mostly cheap ESTIMATES pinned at a perfect cost score and the ceiling hid
 *    it — indistinguishable from a model with a genuinely cheap real profile,
 *    and used to rank models.
 *  - `ExecutionRecord` persisted `cost: number` with no statement of how it was
 *    arrived at, and `ExecutionResult.totalCost` — the headline
 *    `nexus.execute` hands back — summed measured and predicted charges into one
 *    number.
 *
 * These tests pin the replacement: cost terms computed from measured entries
 * only, coverage visible on the score, and a labelled figure everywhere a cost
 * reaches a caller.
 */

const MEASURED: CostProvenance = { usage: 'measured', pricing: 'model-costs' }
const ESTIMATED: CostProvenance = { usage: 'estimated', pricing: 'fallback-table' }

/**
 * Costs are in the hundreds of dollars on purpose. `costScore =
 * min(1, costEfficiency * 100)` saturates whenever measured successes per
 * measured dollar reach 0.01 — i.e. for any cost under ~$100 — so a
 * realistic-looking fixture would give every group the same perfect cost score
 * and prove nothing. The scale here keeps the term off its ceiling so the
 * measured figure is actually visible in `overallScore`.
 */
function entry(cost: number, usage: 'measured' | 'estimated') {
  return {
    model: 'm',
    role: 'coder',
    success: true,
    duration: 0,
    cost,
    costProvenance: usage === 'measured' ? MEASURED : ESTIMATED,
    tokensUsed: 0,
  }
}

function trackerWith(...costs: Array<[number, 'measured' | 'estimated']>): InstanceType<typeof PerformanceTracker> {
  const tracker = new PerformanceTracker()
  for (const [cost, usage] of costs) tracker.record(entry(cost, usage))
  return tracker
}

describe('PerformanceTracker scores cost from measured entries only', () => {
  it('ignores a cheap estimate when a measured cost is in the group', () => {
    const score = trackerWith([1, 'estimated'], [1000, 'measured']).getScores()[0]

    // The estimate is $1, the measurement is $1000. Averages over both would
    // report 500.50 and score 1 success per 500.50 dollars; the cost terms must
    // reflect the $1000 alone.
    expect(score.avgCost).toBeCloseTo(500.5, 12)
    expect(score.costEfficiency).toBeCloseTo(1 / 1000, 12)
    // 40 (success) + 30 (speed, zero duration) + 30 * min(1, 0.1)
    expect(score.overallScore).toBeCloseTo(73, 9)
  })

  it('ignores an expensive estimate when a cheap measured cost is in the group', () => {
    const score = trackerWith([1000, 'estimated'], [1, 'measured']).getScores()[0]

    // The mirror image: the prediction must not be able to drag the score down
    // either. Measured successes per measured dollar saturates the cost term.
    expect(score.costEfficiency).toBeCloseTo(1, 12)
    expect(score.overallScore).toBeCloseTo(100, 9)
  })

  it('does not let a group of cheap estimates outscore one expensive measurement', () => {
    // The regression this exists for. Before, the all-estimated group's cost
    // term was 1/0.0001 = 10000 successes per dollar, clamped to a perfect
    // 30 points — a higher cost score than a real $1000 measurement could ever
    // earn, on the strength of a guess.
    const guessed = trackerWith([0.0001, 'estimated'], [0.0001, 'estimated']).getScores()[0]
    const billed = trackerWith([1000, 'measured'], [1000, 'measured']).getScores()[0]

    expect(billed.overallScore).toBeGreaterThan(guessed.overallScore)
  })

  it('leaves success and speed untouched by provenance', () => {
    const measured = trackerWith([1000, 'measured'], [1000, 'measured'], [1000, 'measured']).getScores()[0]
    const estimated = trackerWith([0.0001, 'estimated'], [0.0001, 'estimated'], [0.0001, 'estimated']).getScores()[0]

    expect(estimated.successRate).toBe(measured.successRate)
    expect(estimated.avgDuration).toBe(measured.avgDuration)
  })
})

describe('a group with no measured entries', () => {
  const guesses = trackerWith([0.0001, 'estimated'], [0.0001, 'estimated'], [0.0001, 'estimated']).getScores()[0]

  it('states that the cost terms rest on no measurement', () => {
    expect(guesses.costBasis).toBe('none')
    expect(guesses.measuredTasks).toBe(0)
    expect(guesses.estimatedTasks).toBe(3)
    // Stated absence of signal, not a measurement of an expensive model.
    expect(guesses.costEfficiency).toBe(0)
  })

  it('produces a finite score that is neither NaN nor a perfect cost score', () => {
    expect(Number.isFinite(guesses.overallScore)).toBe(true)
    expect(Number.isNaN(guesses.overallScore)).toBe(false)
    // 40 (success) + 30 (speed) + 0 (no cost evidence) — the cost third is
    // charged but not earned, and the 0-100 scale is unchanged.
    expect(guesses.overallScore).toBeCloseTo(70, 9)
    expect(guesses.overallScore).toBeLessThan(100)
  })

  it('is distinguishable from a group with cheap MEASURED costs', () => {
    const billed = trackerWith([0.0001, 'measured'], [0.0001, 'measured'], [0.0001, 'measured']).getScores()[0]

    expect(billed.costBasis).toBe('measured')
    expect(billed.measuredTasks).toBe(3)
    expect(billed.overallScore).toBeCloseTo(100, 9)
    expect(guesses.overallScore).not.toBeCloseTo(billed.overallScore, 9)
  })

  it('still ranks by the same 0-100 scale as a measured group, not a renormalised one', () => {
    // Renormalising the vacated 30 points up to 70 would let a group with no
    // cost evidence reach 100 on success and speed alone, and outrank a
    // fully-measured group that merely looked expensive. The scale is held
    // fixed so the ranking compares like with like.
    const guessesFirst = trackerWith([0.0001, 'estimated'], [0.0001, 'estimated'])
    guessesFirst.record({ ...entry(0.0001, 'measured'), model: 'zzz-billed', success: true, cost: 1e9 })
    const top = guessesFirst.getScores()[0]

    expect(top.model).toBe('zzz-billed')
    expect(top.overallScore).toBeLessThan(100)
  })
})

describe('score coverage counters', () => {
  it('count measured and estimated entries of a mixed group', () => {
    const tracker = new PerformanceTracker()
    tracker.record(entry(1, 'estimated'))
    tracker.record(entry(1, 'estimated'))
    tracker.record(entry(1, 'estimated'))
    tracker.record(entry(1, 'measured'))
    tracker.record(entry(1, 'measured'))

    const score = tracker.getScores()[0]
    expect(score.totalTasks).toBe(5)
    expect(score.measuredTasks).toBe(2)
    expect(score.estimatedTasks).toBe(3)
    expect(score.measuredTasks + score.estimatedTasks).toBe(score.totalTasks)
    expect(score.costBasis).toBe('measured')
  })

  it('make a score from one measurement visibly thinner than one from fifty', () => {
    const thin = trackerWith([1000, 'measured'])
    const thick = new PerformanceTracker()
    for (let i = 0; i < 50; i++) thick.record(entry(1000, 'measured'))

    const a = thin.getScores()[0]
    const b = thick.getScores()[0]
    // Same score — the cost term is identical — but the coverage says how much
    // is behind it.
    expect(a.overallScore).toBeCloseTo(b.overallScore, 9)
    expect(a.measuredTasks).toBe(1)
    expect(b.measuredTasks).toBe(50)
  })
})

// === Orchestrator surfaces ===

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

const TOKENS: Tokens = { input: 1000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } }

function makeCtx(opts: { getThrows?: boolean } = {}) {
  const session: Record<string, unknown> = {
    create: mock(() => Promise.resolve({ id: 'ses_child' })),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([])),
  }
  session.get = mock(() => opts.getThrows
    ? Promise.reject(new Error('session unavailable'))
    : Promise.resolve({ id: 'ses_child', tokens: TOKENS }))
  return {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    model: { list: mock(() => Promise.resolve({ data: [] })) },
    session,
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve([])) },
  }
}

const TASK = {
  id: 'task-1',
  name: 'do the thing',
  description: 'd',
  requiredRole: 'coder',
  dependencies: [],
  priority: 'normal' as const,
  status: 'pending' as const,
  timeout: 1000,
  files: { include: [] },
  complexity: {
    overall: 50,
    factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const },
  },
}

/** Run one task through `execute` and return the result, the history and the report. */
async function runExecute({ getThrows = false, price = false }: { getThrows?: boolean; price?: boolean } = {}) {
  const orchestrator = new NexusOrchestrator({
    schedulerInterval: 1,
    selfHealing: { enabled: false, maxRetries: 3, retryDelay: 0, backoffMultiplier: 2, contextTransfer: false },
  })
  await orchestrator.initialize(makeCtx({ getThrows }) as never)
  // `price` installs real per-1K rates, so the pricing source resolves to
  // `model-costs`; without it the forecaster's labelled fallback table is used
  // and the record says so.
  if (price) orchestrator.setModelCosts(Object.fromEntries(PRICED_MODELS))
  const result = await orchestrator.execute({ tasks: [TASK] })
  const records = orchestrator.executionHistory.getAll()
  const report = JSON.parse(orchestrator.getCostReport())
  await orchestrator.shutdown()
  return { result, records, report }
}

/** Per-1K rates, i.e. exactly the unit `modelCosts` stores. */
const SONNET_PER_1K = { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 }

/**
 * Every model the default role map can select, priced. `price` exists so the
 * pricing source resolves to `model-costs`; which model a task actually lands
 * on is the selector's decision, so all of them are priced rather than
 * hard-coding one and hoping.
 */
const PRICED_MODELS = [
  'anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-4-1', 'anthropic/claude-haiku-4-5',
  'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'opencode/minimax-m2.5-free',
].map(id => [id, SONNET_PER_1K] as const)

describe('execute carries the spend split', () => {
  it('reports a fully measured run as all measurement', async () => {
    const { result, report } = await runExecute({ price: true })

    expect(result.success).toBe(true)
    expect(result.totalCost).toBeGreaterThan(0)
    expect(result.measuredSpend).toBeCloseTo(result.totalCost, 12)
    expect(result.estimatedSpend).toBe(0)
    // Same figures as the cost report — one accounting, not two.
    expect(report.measuredSpend).toBeCloseTo(result.measuredSpend, 12)
    expect(report.estimatedSpend).toBeCloseTo(result.estimatedSpend, 12)
  })

  it('reports a run whose session could not be read as all prediction', async () => {
    const { result } = await runExecute({ getThrows: true })

    expect(result.success).toBe(true)
    expect(result.totalCost).toBeGreaterThan(0)
    expect(result.measuredSpend).toBe(0)
    expect(result.estimatedSpend).toBeCloseTo(result.totalCost, 12)
  })

  it('keeps the halves summing to the headline', async () => {
    const { result } = await runExecute({ price: true })
    expect(result.measuredSpend + result.estimatedSpend).toBeCloseTo(result.totalCost, 12)
  })
})

describe('execution history retains provenance through a round trip', () => {
  it('records measured usage and the real price source', async () => {
    const { records } = await runExecute({ price: true })

    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.cost).toBeGreaterThan(0)
    expect(record.costProvenance.usage).toBe('measured')
    expect(record.costProvenance.pricing).toBe('model-costs')
  })

  it('records estimated usage and the fallback price source', async () => {
    const { records } = await runExecute({ getThrows: true })

    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.cost).toBeGreaterThan(0)
    expect(record.costProvenance.usage).toBe('estimated')
    expect(record.costProvenance.pricing).toBe('fallback-table')
  })

  it('splits getStats totalCost by provenance', async () => {
    const history = new ExecutionHistory()
    const base = {
      taskId: 't', taskName: 'n', role: 'coder', model: 'm',
      status: 'success' as const, duration: 10, tokensUsed: 0,
      startedAt: new Date(0), completedAt: new Date(10),
    }
    history.record({ ...base, cost: 0.25, costProvenance: MEASURED })
    history.record({ ...base, cost: 0.75, costProvenance: ESTIMATED })

    const stats = history.getStats()
    expect(stats.totalCost).toBeCloseTo(1, 12)
    expect(stats.costSplit.measuredCost).toBeCloseTo(0.25, 12)
    expect(stats.costSplit.estimatedCost).toBeCloseTo(0.75, 12)
    expect(stats.costSplit.measuredEntries).toBe(1)
    expect(stats.costSplit.estimatedEntries).toBe(1)
  })
})

describe('the status surface labels a mixed total', () => {
  it('reports the split alongside totalCost', async () => {
    const { report } = await runExecute({ price: true })
    expect(report.measuredSpend).toBeGreaterThan(0)
    expect(report).toHaveProperty('estimatedSpend')
  })
})
