import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnedAgent } from '../src/orchestrator'

// Same sandboxed-home dance as `test/spawn-subagent-tool.test.ts`, and for the
// same reason: under `bun test`, setting process.env.HOME does not move
// os.homedir(), so the module is mocked. This must happen before the modules
// under test load.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-variantref-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { Model } = await import('@opencode/plugin')
const { parseModelRef, formatModelRef } = await import('../src/model-ref')
const { CostForecaster } = await import('../src/forecast')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

const VARIANT_REF = 'anthropic/claude-sonnet-4-6#high'
const TWO_SLASH_REF = 'openrouter/anthropic/claude-sonnet-4-5#xhigh'

function createCtx(withToolDomain: boolean) {
  const subagentCalls: any[] = []
  const ctx: any = {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-variantref-project-')) },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_created' })),
      switchAgent: mock(() => Promise.resolve()),
      switchModel: mock(() => Promise.resolve()),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve()),
    },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
  }
  if (withToolDomain) {
    ctx.tool = {
      list: mock(() => Promise.resolve([{
        id: 'subagent',
        name: 'subagent',
        execute: mock((input: any, context: any) => (async () => {
          subagentCalls.push({ input, context })
          await context.progress({ sessionID: 'ses_child', status: 'running' })
          return { title: input.description, metadata: {} }
        })()),
      }])),
    }
  }
  return { ctx, subagentCalls }
}

const newOrchestrator = (ctx: any) => new NexusOrchestrator({
  budget: { maxTotalCost: 10, maxCostPerTask: 1, alertThreshold: 0.2, hardLimit: false },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** High complexity, so the quality term dominates and the top-quality candidate wins. */
const COMPLEXITY_HIGH = {
  overall: 90,
  factors: { fileCount: 20, codeLines: 4000, dependencyDepth: 4, domainKnowledge: 3, riskLevel: 'high' as const },
}

/**
 * Price every candidate in `selectBestModel`'s built-in list at the SAME rate,
 * so the cost term is constant across candidates and the quality term alone
 * decides the winner.
 *
 * Without it the free model on the fallback table wins on cost, and an
 * assertion about WHICH variant survives selection would really be an assertion
 * about the ranking — which is not what is under test and would break for an
 * unrelated reason.
 *
 * The map is ASSIGNED rather than merged through `setModelCosts`, because
 * `initialize` loads the real provider catalogue ASYNCHRONOUSLY: it resolves
 * before that load lands, and the load replaces `modelCosts` wholesale. A test
 * that merges into the map races it, and the winner then depends on timing.
 * `beforeEach` yields a macrotask so the load has settled before this runs.
 */
const priceAllCandidatesEqually = (orchestrator: any): void => {
  const FLAT = { tiers: [{ rates: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } }] }
  const REFS = [
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-opus-4-7',
    'openai/gpt-5-mini',
    'google/gemini-2.5-flash',
    'opencode/minimax-m2.5-free',
  ]
  orchestrator.modelCosts = new Map(REFS.map((ref) => [ref, FLAT]))
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn
  console.warn = mock(() => {})
  try { return await fn() } finally { console.warn = warn }
}

describe('the two spawn paths agree about a variant-bearing ref', () => {
  // THE assertion this whole change exists for. Before it, the
  // `ctx.session.create` path passed `{ providerID, id }` with the variant
  // still glued to the id, so `p/m#high` reached the host as the model
  // `"m#high"`, matched no ModelInfo, and the spawn SILENTLY ran on the default
  // model — while the sibling path, which hands the host the string, parsed the
  // same ref correctly. The two paths disagreed about one string and nothing
  // said so.
  for (const ref of [VARIANT_REF, TWO_SLASH_REF, 'google/gemini-2.5-flash']) {
    const withVariant = ref.includes('#')

    it(`agree on ${ref}`, async () => {
      // ── path A: ctx.session.create (no tool context) ──────────────
      const madeA = createCtx(false)
      const orchA = newOrchestrator(madeA.ctx)
      await orchA.initialize(madeA.ctx)
      const agentA = await quiet(() => orchA.spawnAgent({ role: 'coder', model: ref }))
      expect(agentA.spawnPath).toBe('session-create')

      // ── path B: the subagent tool (tool context) ──────────────────
      const madeB = createCtx(true)
      const orchB = newOrchestrator(madeB.ctx)
      await orchB.initialize(madeB.ctx)
      const agentB = await quiet(() => orchB.spawnAgent(
        { role: 'coder', model: ref },
        { toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator' }, task: 'do the thing' },
      ))
      expect(agentB.spawnPath).toBe('subagent-tool')

      // ── the comparison, from the two different argument shapes ────
      // Path A's model is the STRUCTURED object; path B's is a STRING that the
      // host parses. The host is the arbiter on both, so the structured object
      // is rebuilt into a ref and run through the host's own parser, and the two
      // answers are compared. Comparing two strings here would compare the two
      // call sites against each other and prove nothing about the host.
      //
      // The rebuild goes through `formatModelRef` rather than a template
      // literal, because a literal would drop the variant — which is the very
      // bug this suite exists to catch, and which an earlier draft of this test
      // reproduced.
      const createArg = madeA.ctx.session.create.mock.calls[0][0]
      const toolArg = madeB.subagentCalls[0].input
      expect(createArg.model).toBeDefined()
      expect(toolArg.model).toBe(ref)

      const fromStructured = Model.Ref.parse(formatModelRef(createArg.model))
      const fromString = Model.Ref.parse(toolArg.model)

      // `Model.Ref.parse` returns branded strings, so the values are widened to
      // plain strings before comparison — the brand is a compile-time guard for
      // the host's own callers and says nothing about the value.
      const widen = (ref: { providerID: string; id: string; variant?: string }) => ({
        providerID: String(ref.providerID),
        id: String(ref.id),
        variant: ref.variant === undefined ? undefined : String(ref.variant),
      })
      expect(widen(fromStructured)).toEqual(widen(fromString))
      expect(fromString.variant === undefined ? undefined : String(fromString.variant))
        .toBe(withVariant ? ref.split('#')[1] : undefined)
    })
  }

  it('session.create actually RECEIVES variant, asserted on the argument object', async () => {
    // Asserted on the object, not on a string: a stringified assertion passes
    // just as well if the variant is smuggled into the id instead, which is the
    // bug.
    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: VARIANT_REF }))

    const arg = made.ctx.session.create.mock.calls[0][0]
    expect(arg.model).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-4-6', variant: 'high' })
    // And the two halves are separate, so the host cannot mistake one for the
    // other: the id carries NO '#'.
    expect(arg.model.id).not.toContain('#')
    expect(arg.model.variant).toBe('high')
    // The metadata records the same spelling, so a reader comparing the record
    // against what was requested sees the same thing.
    expect(arg.metadata.nexusModel).toBe(VARIANT_REF)
  })

  it('carries a two-slash ref through both halves intact', async () => {
    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: TWO_SLASH_REF }))

    const arg = made.ctx.session.create.mock.calls[0][0]
    expect(arg.model).toEqual({ providerID: 'openrouter', id: 'anthropic/claude-sonnet-4-5', variant: 'xhigh' })
  })

  it('omits the variant key entirely when there is none', async () => {
    // Not `variant: undefined`: the object must be the one the code has always
    // passed, so a variant-free spawn is provably unchanged.
    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: 'anthropic/claude-sonnet-4-6' }))

    const arg = made.ctx.session.create.mock.calls[0][0]
    expect(arg.model).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-4-6' })
    expect('variant' in arg.model).toBe(false)
  })

  it('records the variant on the AGENT, which is the source of every cost key', async () => {
    // The agent record is the only place a `ModelSelection` for a spawned agent
    // is built, and `modelSpendKey`/`modelLabelKey` read it. A variant dropped
    // here never reaches the ledger, the metrics, the history or the snapshot —
    // which is the exact "kept in one place and dropped in another" shape this
    // change had to eliminate, so it is asserted at the source.
    const made = createCtx(false)
    // `any`, because `modelSpendKey`/`modelLabelKey` are private and this test
    // asserts on them deliberately — the same way the other blocks here reach
    // `scoreModel` and the private `selectQualifiedModel`. The point is the
    // VALUE those helpers derive from the agent record, not their visibility.
    const orchestrator: any = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    const agent: SpawnedAgent = await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: VARIANT_REF }))

    expect({ provider: agent.model.provider, model: agent.model.model, variant: agent.model.variant })
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', variant: 'high' })
    // And it flows from there into the keys, which is the point of asserting at
    // the source: the helpers read this field, so this is what makes every
    // downstream key carry the variant.
    expect(orchestrator.modelSpendKey(agent.model)).toBe('anthropic/claude-sonnet-4-6#high')
    expect(orchestrator.modelLabelKey(agent.model)).toBe('claude-sonnet-4-6#high')
  })

  it('leaves a variant-free agent record exactly as it was', async () => {
    const made = createCtx(false)
    const orchestrator: any = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    const agent: SpawnedAgent = await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: 'anthropic/claude-sonnet-4-6' }))

    expect('variant' in agent.model).toBe(false)
    expect(orchestrator.modelSpendKey(agent.model)).toBe('anthropic/claude-sonnet-4-6')
    expect(orchestrator.modelLabelKey(agent.model)).toBe('claude-sonnet-4-6')
  })
})

describe('a ref the host rejects fails loudly at spawn, not silently', () => {
  const REJECTED = [
    ['an empty variant', 'anthropic/claude-sonnet-4-6#'],
    ['a second # in the variant', 'anthropic/claude-sonnet-4-6#a#b'],
    ['a leading slash', '/leading-slash'],
  ] as const

  for (const [what, ref] of REJECTED) {
    it(`rejects ${what} and says so`, async () => {
      const made = createCtx(false)
      const orchestrator = newOrchestrator(made.ctx)
      await orchestrator.initialize(made.ctx)
      // MUST throw. If this resolved to a model, the host would answer with the
      // default model and the record would still say `#` — the silent failure
      // this change removes.
      let caught: any
      try {
        await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: ref }))
      } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(Error)
      expect(caught.message).toContain(ref)
      expect(caught.message).toContain('providerID/modelID#variant')
      expect(made.ctx.session.create).not.toHaveBeenCalled()
    })
  }
})

describe('selectModel carries the variant, and the spawn rejoins it', () => {
  let orchestrator: any
  let made: ReturnType<typeof createCtx>

  beforeEach(async () => {
    made = createCtx(false)
    orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    // `initialize` resolves BEFORE its asynchronous provider-catalogue load
    // lands, and that load replaces `modelCosts` wholesale. Yield a macrotask
    // so a test that sets prices afterwards is not racing it.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('surfaces the variant on ModelSelection and on the score that produced it', () => {
    const score = orchestrator.scoreModel(VARIANT_REF, 'coder', COMPLEXITY_HIGH)
    expect({ provider: score.provider, model: score.model, variant: score.variant })
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', variant: 'high' })
  })

  it('omits the variant from the score when the candidate has none', () => {
    const score = orchestrator.scoreModel('anthropic/claude-sonnet-4-6', 'coder', COMPLEXITY_HIGH)
    expect('variant' in score).toBe(false)
  })

  it('carries the winning score\'s variant onto the selection', () => {
    // The link between `scoreModel` and `selectBestModel`. `scoreModel` is
    // tested on its own and `selectQualifiedModel` is tested with a STUBBED
    // `selectModel`, so without this the one hop in between — the return
    // statement that assembles the `ModelSelection` — would be untested, and
    // dropping the variant there would break nothing.
    //
    // Every candidate is priced IDENTICALLY so the cost term is a constant and
    // the quality term alone decides. Without that, the free model on the
    // fallback table wins on cost and the assertion would be about the ranking
    // rather than about the variant.
    orchestrator.configManager.setModel('coder', 'anthropic/claude-opus-4-7#max')
    priceAllCandidatesEqually(orchestrator)

    const selection = orchestrator.selectModel('coder', COMPLEXITY_HIGH)
    // `claude-opus-4-7` is the highest-quality candidate in the built-in list
    // (`estimateModelQuality`), so it is the one that wins here.
    expect({ provider: selection.provider, model: selection.model, variant: selection.variant })
      .toEqual({ provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' })
  })

  it('omits the variant from the selection when the winner has none', () => {
    orchestrator.configManager.setModel('coder', 'anthropic/claude-opus-4-7')
    priceAllCandidatesEqually(orchestrator)
    const selection = orchestrator.selectModel('coder', COMPLEXITY_HIGH)
    expect(selection.model).toBe('claude-opus-4-7')
    expect('variant' in selection).toBe(false)
  })

  it('rejoins provider, model and variant into the reference spawnAgent needs', () => {
    // `selectQualifiedModel` is private, so it is reached the way the code
    // reaches it: through a stubbed `selectModel` and the public spawn, and the
    // rejoined string is read off what `session.create` was handed.
    orchestrator.selectModel = () => ({
      provider: 'anthropic', model: 'claude-sonnet-4-6', variant: 'high',
      estimatedCost: 0, estimatedQuality: 0.5, reasoning: 'test',
    })
    orchestrator.analyzeComplexity = () => COMPLEXITY_HIGH
    // Drive the private rejoin directly rather than the whole scheduler, so the
    // assertion is about the string and not about the task machinery.
    const ref = orchestrator.selectQualifiedModel({ task: { requiredRole: 'coder' } })
    expect(ref).toBe('anthropic/claude-sonnet-4-6#high')
  })

  it('rejoins a variant-free selection to the same string as before', () => {
    orchestrator.selectModel = () => ({
      provider: 'anthropic', model: 'claude-sonnet-4-6',
      estimatedCost: 0, estimatedQuality: 0.5, reasoning: 'test',
    })
    orchestrator.analyzeComplexity = () => COMPLEXITY_HIGH
    expect(orchestrator.selectQualifiedModel({ task: { requiredRole: 'coder' } })).toBe('anthropic/claude-sonnet-4-6')
  })
})

describe('a variant-bearing ref resolves to the REAL price, not unknown-model', () => {
  // The third silent failure. `getModelCost` used to try the exact ref and a
  // bare-id match; a `#` suffixed ref missed both, returned undefined, and
  // `CostForecaster.tiersFor` fell through to the 0.01/0.05 guess labelled
  // `unknown-model` — a MEASURED token count reported as a fabricated rate.
  const KEY = 'anthropic/claude-sonnet-4-6'
  const REAL_TIERS = { tiers: [{ rates: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } }] }

  const USAGE = { input: 1000, output: 500, reasoning: 200, cache: { read: 0, write: 0 } }

  it('getModelCost finds the price behind a variant', () => {
    const orchestrator: any = newOrchestrator({})
    orchestrator.modelCosts = new Map([[KEY, REAL_TIERS]])
    expect(orchestrator.getModelCost(VARIANT_REF)).toEqual(REAL_TIERS)
    expect(orchestrator.getModelCost(VARIANT_REF, 'anthropic')).toEqual(REAL_TIERS)
  })

  it('is EXACT about which provider it prices, not merely "a" price', () => {
    // This is the assertion that distinguishes the exact-key route from the
    // bare-id sweep. Two providers serve the same model id at different rates,
    // and the sweep deliberately returns the CHEAPEST across providers. So if
    // the variant were not stripped before the exact lookup, both lookups would
    // miss and the sweep would answer — with the wrong provider's price, and no
    // indication of it. Stripping first makes the lookup exact and the sweep
    // unreachable.
    const orchestrator: any = newOrchestrator({})
    const dear: any = { tiers: [{ rates: { input: 0.01, output: 0.05, cacheRead: 0, cacheWrite: 0 } }] }
    const cheap: any = { tiers: [{ rates: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 } }] }
    orchestrator.modelCosts = new Map([
      ['anthropic/claude-sonnet-4-6', dear],
      ['openrouter/claude-sonnet-4-6', cheap],
    ])

    // Variant-free, this was already exact, and must stay so.
    expect(orchestrator.getModelCost('anthropic/claude-sonnet-4-6')).toBe(dear)
    // Variant-bearing must give the same answer — the same provider, not the
    // cheapest one.
    expect(orchestrator.getModelCost('anthropic/claude-sonnet-4-6#high')).toBe(dear)
    // And with the provider passed explicitly, likewise.
    expect(orchestrator.getModelCost('claude-sonnet-4-6#high', 'anthropic')).toBe(dear)
  })

  it('a measured count is priced from the real table, and says so', () => {
    const orchestrator: any = newOrchestrator({})
    orchestrator.modelCosts = new Map([[KEY, REAL_TIERS]])
    // Wired the way the orchestrator wires it (`orchestrator.ts:1069`), so the
    // resolver under test is the real one rather than a stand-in.
    orchestrator.forecaster = new CostForecaster(
      (model: string, provider?: string) => orchestrator.getModelCost(model, provider),
    )

    const measured = orchestrator.forecaster.measureCost(USAGE, VARIANT_REF, 'anthropic')
    expect(measured.pricingSource).toBe('model-costs')

    // The number itself, computed from the real rate, so the test fails if the
    // source label and the arithmetic ever disagree.
    const expected = 1000 * 0.003 / 1000 + (500 + 200) * 0.015 / 1000
    expect(measured.cost).toBeCloseTo(expected, 10)

    // And it is demonstrably NOT the unknown-model guess, which would be
    // 0.01/0.05 per 1K.
    const unknown = 1000 * 0.01 / 1000 + (500 + 200) * 0.05 / 1000
    expect(measured.cost).not.toBeCloseTo(unknown, 10)
    expect(measured.tokens).toBe(USAGE.input + USAGE.output + USAGE.reasoning)
  })

  it('is unchanged for a variant-free ref, which is the behaviour-preservation claim', () => {
    const orchestrator: any = newOrchestrator({})
    orchestrator.modelCosts = new Map([[KEY, REAL_TIERS]])
    // Wired the way the orchestrator wires it (`orchestrator.ts:1069`), so the
    // resolver under test is the real one rather than a stand-in.
    orchestrator.forecaster = new CostForecaster(
      (model: string, provider?: string) => orchestrator.getModelCost(model, provider),
    )
    expect(orchestrator.forecaster.measureCost(USAGE, KEY, 'anthropic')).toEqual(
      orchestrator.forecaster.measureCost(USAGE, VARIANT_REF, 'anthropic'),
    )
  })

  it('reaches the fallback table through a variant too, not only the real one', () => {
    const orchestrator: any = newOrchestrator({})
    orchestrator.modelCosts = new Map()
    // Wired the way the orchestrator wires it (`orchestrator.ts:1069`), so the
    // resolver under test is the real one rather than a stand-in.
    orchestrator.forecaster = new CostForecaster(
      (model: string, provider?: string) => orchestrator.getModelCost(model, provider),
    )
    expect(orchestrator.forecaster.measureCost(USAGE, 'claude-sonnet-4-6#low').pricingSource).toBe('fallback-table')
  })
})

describe('the cost, performance and history keys carry the variant', () => {
  it('gives a variant its own costByModel bucket, deliberately', () => {
    // DELIBERATE, and stated here because it is a judgement call: `costByModel`
    // is a spend ledger keyed by what actually ran, and one run of `p/m` at
    // `low` and one at `xhigh` are different spending events with very
    // different token volumes. Merging them would hide the only thing an
    // effort-aware selection is trying to show. The buckets price IDENTICALLY,
    // because `ModelVariant` has no `cost` — that is the statement that effort
    // moves volume, not rate, and it is why the price lookup strips the
    // variant while the ledger keeps it.
    const orchestrator: any = newOrchestrator({})
    orchestrator.trackCost('agent-1', 'anthropic/claude-sonnet-4-6#low', 0.01, 100, { usage: 'measured', pricing: 'model-costs' })
    orchestrator.trackCost('agent-2', 'anthropic/claude-sonnet-4-6#xhigh', 0.05, 900, { usage: 'measured', pricing: 'model-costs' })
    orchestrator.trackCost('agent-3', 'anthropic/claude-sonnet-4-6', 0.02, 200, { usage: 'measured', pricing: 'model-costs' })

    const byModel = Object.fromEntries(orchestrator.costByModel)
    expect(byModel).toEqual({
      'anthropic/claude-sonnet-4-6#low': 0.01,
      'anthropic/claude-sonnet-4-6#xhigh': 0.05,
      'anthropic/claude-sonnet-4-6': 0.02,
    })
    // Three buckets, and the plain ref is still its own bucket — a variant does
    // not shadow the model it belongs to.
    expect(Object.keys(byModel)).toHaveLength(3)
    expect(orchestrator.totalSpent).toBeCloseTo(0.08, 10)
  })

  it('leaves a variant-free key exactly as it was', () => {
    const orchestrator: any = newOrchestrator({})
    orchestrator.trackCost('agent-1', 'anthropic/claude-sonnet-4-6', 0.01, 100, { usage: 'measured', pricing: 'model-costs' })
    expect(Object.fromEntries(orchestrator.costByModel)).toEqual({ 'anthropic/claude-sonnet-4-6': 0.01 })
  })

  it('builds the spend key and the label key from one helper each', () => {
    const orchestrator: any = newOrchestrator({})
    const variant = { provider: 'anthropic', model: 'claude-sonnet-4-6', variant: 'high', estimatedCost: 0, estimatedQuality: 0, reasoning: '' }
    const plain = { provider: 'anthropic', model: 'claude-sonnet-4-6', estimatedCost: 0, estimatedQuality: 0, reasoning: '' }
    expect(orchestrator.modelSpendKey(variant)).toBe('anthropic/claude-sonnet-4-6#high')
    expect(orchestrator.modelSpendKey(plain)).toBe('anthropic/claude-sonnet-4-6')
    expect(orchestrator.modelLabelKey(variant)).toBe('claude-sonnet-4-6#high')
    expect(orchestrator.modelLabelKey(plain)).toBe('claude-sonnet-4-6')
  })
})

describe('the spawn autocomplete matches the model id, not the second segment', () => {
  // Issue #85 was filed against `m?.split('/')[1] === modelConfig`, the pattern
  // `src/model-groups.ts:21-29` explicitly documents and refuses to make. It
  // was left alone in the PR that filed it to keep that PR scoped; that reason
  // lapsed here, because this change makes `provider/model#variant` a format
  // that line has to parse.
  //
  // WHAT THE FIX ACTUALLY BUYS, measured rather than assumed: the branch only
  // runs when the caller's input has no slash, so it can only ever match a
  // configured ref whose model id is itself slashless. A two-slash ref
  // (`openrouter/anthropic/claude-sonnet-4-5`) has a model id that CONTAINS a
  // slash, so no slashless input can ever name it and the old code's
  // `split('/')[1]` was wrong there but unreachable-in-effect. The real
  // regression the old comparison caused is the VARIANT one, and it is
  // reachable: a configured `opencode-go/mimo-v2.5#high` has a slashless model
  // id, so `mimo-v2.5` should complete to it — and under the old comparison it
  // threw.

  it('completes a bare id to a configured ref that carries a variant', async () => {
    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    orchestrator.configManager.setModel('coder', 'opencode-go/mimo-v2.5#high')
    orchestrator.configManager.getConfig().models = { 'opencode-go/mimo-v2.5#high': 'opencode-go/mimo-v2.5#high' }

    const agent = await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: 'mimo-v2.5' }))
    expect(made.ctx.session.create.mock.calls[0][0].model)
      .toEqual({ providerID: 'opencode-go', id: 'mimo-v2.5', variant: 'high' })
    expect(agent.sessionID).toBe('ses_created')
  })

  it('the old comparison could not do that, and says so', async () => {
    // The oracle, so the difference is shown rather than asserted. The old
    // expression compared the second SEGMENT, which for a variant-bearing ref
    // is `mimo-v2.5#high` — so it never equalled the bare id.
    const ref = 'opencode-go/mimo-v2.5#high'
    expect({ old: ref.split('/')[1], newId: parseModelRef(ref).id }).toEqual({ old: 'mimo-v2.5#high', newId: 'mimo-v2.5' })
  })

  it('still auto-completes a bare id against an ordinary single-slash ref', async () => {
    // The preservation claim for this line: for a single-slash VARIANT-FREE
    // ref, `split('/')[1]` and the parsed model id are the same string, so
    // every configuration that auto-completed before still does.
    for (const ref of ['opencode-go/mimo-v2.5', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5-mini']) {
      expect(parseModelRef(ref).id).toBe(ref.split('/')[1])
    }

    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    orchestrator.configManager.setModel('coder', 'opencode-go/mimo-v2.5')
    orchestrator.configManager.getConfig().models = { 'opencode-go/mimo-v2.5': 'opencode-go/mimo-v2.5' }
    const agent = await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: 'mimo-v2.5' }))
    expect(made.ctx.session.create.mock.calls[0][0].model)
      .toEqual({ providerID: 'opencode-go', id: 'mimo-v2.5' })
    expect(agent.sessionID).toBe('ses_created')
  })

  it('still refuses a two-slash ref named by its bare tail, as it always has', async () => {
    // Unchanged behaviour, pinned: `anthropic/claude-sonnet-4-5` is not the
    // model id of `openrouter/anthropic/claude-sonnet-4-5` — the id INCLUDES
    // the `anthropic/` namespace — so naming it by the tail is a request for a
    // model that does not exist and must fail loudly.
    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    orchestrator.configManager.setModel('coder', 'openrouter/anthropic/claude-sonnet-4-5')
    orchestrator.configManager.getConfig().models = { 'openrouter/anthropic/claude-sonnet-4-5': 'openrouter/anthropic/claude-sonnet-4-5' }
    let caught: any
    try {
      await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: 'claude-sonnet-4-5' }))
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect(made.ctx.session.create).not.toHaveBeenCalled()
  })

  it('does not complete a bare id that no configured ref names', async () => {
    const made = createCtx(false)
    const orchestrator = newOrchestrator(made.ctx)
    await orchestrator.initialize(made.ctx)
    orchestrator.configManager.getConfig().models = {}
    let caught: any
    try {
      await quiet(() => orchestrator.spawnAgent({ role: 'coder', model: 'no-such-model' }))
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect(caught.message).toContain('no-such-model')
    expect(made.ctx.session.create).not.toHaveBeenCalled()
  })
})
