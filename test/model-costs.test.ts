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
 * `ModelInfo.cost[0]`) and, just as importantly, the UNITS: OpenCode reports
 * `ModelCost` in USD per MILLION tokens while `modelCosts` stores USD per 1K
 * tokens. Getting that conversion wrong is a 1000x error, so the unit
 * assertions below are deliberately written to fail on a raw pass-through.
 */

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
    // Keyed by "providerID/id", valued in USD per 1K tokens.
    expect(orchestrator.modelCosts.get('anthropic/claude-sonnet-4-6')).toEqual({
      input: 0.003,
      output: 0.015,
      cacheRead: 0.0003,
      cacheWrite: 0.00375,
    })
  })

  it('feeds a per-1K cost figure into model scoring, not a 1000x-inflated one', async () => {
    const { ctx } = makeCtx({
      data: [{
        providerID: 'anthropic',
        id: 'claude-sonnet-4-6',
        // $3/M in, $15/M out → (0.003 + 0.015) / 2 = 0.009 per 1K
        cost: [{ input: 3, output: 15 }],
      }],
    })
    await orchestrator.initialize(ctx as never)

    // `scoreModel` is public and normalises cost against a $15/1K ceiling.
    const scored = orchestrator.scoreModel('anthropic/claude-sonnet-4-6', 'coder', {
      overall: 20, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' },
    })
    expect(scored.costScore).toBeCloseTo(1 - 0.009 / 15, 9)

    // The pre-fix arithmetic was (3 * 1000 + 15 * 1000) / 2 = 9000.
    expect(scored.costScore).toBeGreaterThan(0.9)

    // And the budget filter in selectBestModel must not reject the model as
    // unaffordable — the inflated figure excluded every real-priced model.
    const selection = orchestrator.selectBestModel('coder', {
      overall: 20, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' },
    })
    expect(selection.estimatedCost).toBeLessThan(1)
  })

  it('uses the base context tier (cost[0]), not a later tier', async () => {
    const { ctx } = makeCtx({
      data: [{
        providerID: 'anthropic',
        id: 'tiered',
        cost: [
          { tier: { type: 'context', size: 200000 }, input: 1, output: 2 },
          { tier: { type: 'context', size: 1000000 }, input: 6, output: 12 },
        ],
      }],
    })

    await orchestrator.initialize(ctx as never)

    expect(orchestrator.modelCosts.get('anthropic/tiered')).toEqual({
      input: 0.001,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
    })
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
    expect(orchestrator.modelCosts.get('openai/paid')).toEqual({
      input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0,
    })
  })

  it('resolves pricing by "providerID/id" and by bare id', async () => {
    const { ctx } = makeCtx({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-6', cost: [{ input: 3, output: 15 }] }],
    })
    await orchestrator.initialize(ctx as never)

    expect(orchestrator.getModelCost('anthropic/claude-sonnet-4-6')).toEqual({
      input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0,
    })
    // A user typing the bare id (or a caller holding only the tail) still hits.
    expect(orchestrator.getModelCost('claude-sonnet-4-6')).toEqual({
      input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0,
    })
    // And with an explicit provider the qualified key is preferred.
    expect(orchestrator.getModelCost('claude-sonnet-4-6', 'anthropic')?.input).toBe(0.003)
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
    expect(orchestrator.getModelCost('shared')?.input).toBe(0.001)
    expect(orchestrator.getModelCost('shared', 'expensive')?.input).toBe(0.1)
  })

  describe('fallback to hardcoded pricing', () => {
    // The hardcoded table's own value for this model. Asserting the number (not
    // just "modelCosts is empty") means these tests fail if the hardcoded
    // table is deleted or corrupted.
    const HARDCODED_SONNET = 0.15

    it('when the model list is empty', async () => {
      const { ctx } = makeCtx({ data: [] })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator.modelCosts.size).toBe(0)
      expect(orchestrator['estimateModelCost']('claude-sonnet-4-6')).toBe(HARDCODED_SONNET)
    })

    it('when the model domain is absent', async () => {
      const { ctx } = makeCtx(undefined, { omitModel: true })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator.modelCosts.size).toBe(0)
      expect(orchestrator['estimateModelCost']('claude-sonnet-4-6')).toBe(HARDCODED_SONNET)
    })

    it('when the model API throws', async () => {
      const { ctx } = makeCtx(undefined, { listThrows: true })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator.modelCosts.size).toBe(0)
      expect(orchestrator['estimateModelCost']('claude-sonnet-4-6')).toBe(HARDCODED_SONNET)
    })

    it('for a model the hardcoded table does not know', async () => {
      const { ctx } = makeCtx({ data: [] })
      await orchestrator.initialize(ctx as never)

      expect(orchestrator['estimateModelCost']('some-unlisted-model')).toBe(0.10)
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
