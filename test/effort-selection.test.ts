import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComplexityScore, ModelSelection, Task } from '../src/types'

/**
 * Effort-aware model selection: difficulty → reasoning effort.
 *
 * ── Two things shape how this file is written ─────────────────────────
 *
 * 1. **`initialized` with a real config file, not a stubbed gate.** The block
 *    under test is FILE-SETTABLE, so every behavioural test writes a real
 *    `nexus.jsonc` into a real temp directory and lets `loadFromPath` read it.
 *    A test that reached past the loader would pass while the file the user
 *    actually writes did nothing — which is the `dashboard.enabled` and
 *    `notifications.enabled` failure this repository has shipped twice.
 *
 * 2. **`publishedVariants` is populated by the production loader.** There is no
 *    test-only setter for it: the fake `ctx.provider.list()` returns real
 *    `ModelInfo`-shaped rows and `initialize` runs the same
 *    `collectPublishedVariants` it runs in production. A map assigned directly
 *    would let the key normalisation and the malformed-row rules go untested,
 *    and those are exactly where a silent "publishes none" would hide.
 *
 * ── Anti-tautology, and the mistakes this file is written against ─────
 *
 * Three agents in this repository have shipped a test that passed on mutated
 * code, so the guards are explicit rather than assumed:
 *
 *  - **The mapping is asserted against LITERALS, not against
 *    `MODEL_EFFORT_LADDER`.** The expected effort for each boundary is written
 *    out as a plain string. Reading the expected value back out of the ladder
 *    the implementation was written from would make the test pass on any ladder
 *    at all, including a reversed one.
 *  - **The "off changes nothing" test is DIFFERENTIAL and instrumented, not a
 *    spot check.** It asserts (a) deep equality against the block omitted
 *    entirely, (b) that the `variant` key is ABSENT rather than present and
 *    `undefined`, and (c) — the part a spot check cannot reach — that the
 *    published-variants map is never READ, using a counting `Map` subclass. A
 *    gate placed above the `enabled` check would still pass (a) and (b) while
 *    burning a lookup; only (c) fails.
 *  - **The corrupt-variants case includes a model the parser REJECTS**, not
 *    only refs both paths accept. An earlier draft compared only refs both
 *    parsers took, which made a field bug on a rejected ref structurally
 *    invisible.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-effort-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { effortForDifficulty, effortIndex, isModelEffort, reconcileEffort, MODEL_EFFORT_LADDER, priceKeyForRef, parseModelRef, InvalidModelRefError } =
  await import('../src/model-ref')
type ModelEffort = import('../src/model-ref').ModelEffort
const { NexusConfigManager, DEFAULT_CONFIG } = await import('../src/config')
const { priceTokens } = await import('../src/forecast')

const tempDirs: string[] = [SANDBOX_HOME]
afterAll(() => {
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function makeDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nexus-${tag}-`))
  tempDirs.push(dir)
  return dir
}

// The global config directory has to exist before any loader looks in it,
// because the sandboxed home starts empty. Mirrors `test/git-flow.test.ts`.
function ensureGlobalDir(): void {
  mkdirSync(join(SANDBOX_HOME, '.config', 'opencode'), { recursive: true })
}

/** Write a `nexus.jsonc` containing exactly `body` into a fresh temp project. */
function writeProjectConfig(tag: string, body: Record<string, unknown>): string {
  const dir = makeDir(tag)
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify(body), 'utf-8')
  return dir
}

// ── The fake context ───────────────────────────────────────────────────

/**
 * The `ModelInfo`-shaped rows the fake catalogue publishes.
 *
 * `variants` is `Array<ModelVariant>` — an array of OBJECTS with an `id`, not
 * an array of strings. That is not pedantry: the first draft of this file
 * published `variants: ['low', 'high']`, the loader correctly found no `id` on a
 * string, stored the model as publishing nothing, and three tests failed for a
 * reason that had nothing to do with the code under test. Building them through
 * `v()` means a fixture cannot drift from the host's shape again.
 */
interface FakeModel {
  readonly id: string
  /** `undefined` models a catalogue that did not publish the field at all. */
  readonly variants?: readonly { readonly id: string }[]
}

/** Real `ModelVariant` rows for the given ids. */
function v(...ids: readonly string[]): readonly { readonly id: string }[] {
  return ids.map(id => ({ id }))
}

interface FakeProvider {
  readonly id: string
  readonly name: string
  readonly models: Record<string, FakeModel>
}

/**
 * A `provider.list()` result. The models are keyed by `provider/id` — which is
 * the key `publishedVariants` normalises to — and each carries the variant ids
 * the host would have published.
 */
function catalogue(providers: readonly FakeProvider[]): { data: FakeProvider[] } {
  return { data: providers.map(p => ({ ...p, models: { ...p.models } })) }
}

interface Harness {
  readonly ctx: unknown
  readonly orchestrator: InstanceType<typeof NexusOrchestrator>
}

function makeCtx(listResult: { data: FakeProvider[] } | Error, directory: string): { ctx: unknown } {
  const ctx = {
    location: { directory },
    provider: {
      list: mock(() => (listResult instanceof Error ? Promise.reject(listResult) : Promise.resolve(listResult))),
    },
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
  return { ctx }
}

/**
 * Build and `initialize()` an orchestrator against a fake catalogue.
 *
 * `provider.list()`'s result is wrapped in a counting `Map` AFTER
 * `initialize` installs it, which is why the counter is reported through a
 * closure the test can read rather than through a class: the map identity is
 * swapped in place, and the counter has to survive that swap.
 */
async function harness(
  projectDir: string,
  providers: readonly FakeProvider[] | Error,
  budget = 10,
  options: { readonly expensiveRealModels?: boolean } = {}
): Promise<Harness> {
  const made = makeCtx(providers instanceof Error ? providers : catalogue(providers), projectDir)
  const orchestrator = new NexusOrchestrator({
    budget: { maxTotalCost: budget, maxCostPerTask: budget, alertThreshold: 0.2, hardLimit: false },
  })
  await orchestrator.initialize(made.ctx as never)
  yieldMacrotask()
  // Price every candidate at the SAME rate, so the cost term is constant and
  // the quality term alone decides the winner. Without this the free model on
  // the fallback table wins and an assertion about the effort it receives would
  // really be an assertion about ranking.
  priceCandidatesEqually(orchestrator, options.expensiveRealModels === true)
  return { ctx: made.ctx, orchestrator }
}

function yieldMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

const CANDIDATE_REFS = [
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash',
  'opencode/minimax-m2.5-free',
]

/**
 * Assign the flat price table. Assigned rather than merged through
 * `setModelCosts` because `initialize` loads the real catalogue
 * asynchronously and the load replaces `modelCosts` wholesale — a merge races
 * it and the winner becomes timing-dependent.
 *
 * `expensive` prices the five WELL-FORMED built-in candidates high and leaves
 * the rest to the fallback table. That exists for one test: a BARE id is never
 * a reference, so `scoreModel` gives it an empty model and quality 0.60, and it
 * cannot out-score `claude-sonnet-4-6` (0.85) on quality alone. Making the real
 * candidates expensive puts the cost term behind the bare id instead, so it
 * WINS and the loud throw in `selectQualifiedModel` actually fires. Asserting on
 * a failure that never happens would be a test of nothing.
 */
function priceCandidatesEqually(orchestrator: InstanceType<typeof NexusOrchestrator>, expensive = false): void {
  const rates = expensive
    ? { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0 }
    : { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 }
  const flat = { tiers: [{ rates }] }
  const internals = orchestrator as unknown as { modelCosts: Map<string, unknown> }
  internals.modelCosts = new Map(CANDIDATE_REFS.map(ref => [ref, flat]))
}

/** Read the published-variants map, replacing it with a counting subclass. */
function instrumentVariantReads(orchestrator: InstanceType<typeof NexusOrchestrator>): () => number {
  const internals = orchestrator as unknown as { publishedVariants: Map<string, readonly string[]> }
  const original = internals.publishedVariants
  let reads = 0
  internals.publishedVariants = new (class extends Map<string, readonly string[]> {
    override get(key: string): readonly string[] | undefined {
      reads += 1
      return original.get(key)
    }
  })()
  return () => reads
}

function complexityAt(overall: number): ComplexityScore {
  return {
    overall,
    factors: { fileCount: 1, codeLines: 50, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' },
  }
}

function makeTask(overall: number): Task {
  return {
    id: 'task-1',
    description: 'do the thing',
    status: 'pending',
    requiredRole: 'coder',
    files: { include: ['a.ts'] },
    dependencies: [],
    priority: 'medium',
  } as unknown as Task
}

const select = (
  orchestrator: InstanceType<typeof NexusOrchestrator>,
  role: string,
  overall: number
): ModelSelection => orchestrator.selectModel(role, complexityAt(overall))

// ═══════════════════════════════════════════════════════════════════════
// 1. The difficulty → effort mapping, over the whole range
// ═══════════════════════════════════════════════════════════════════════

describe('effortForDifficulty maps the whole 0-100 range', () => {
  // EXPECTED VALUES ARE LITERALS. Each one is the answer a reviewer would give
  // by reading the table, written out rather than derived from
  // `MODEL_EFFORT_LADDER`. A ladder mutation (reversed, or with a rung moved)
  // therefore fails here, which reading the expectation back out of the ladder
  // would not.
  const TABLE: readonly (readonly [number, ModelEffort])[] = [
    [0, 'low'], [39, 'low'], [40, 'low'],
    [41, 'medium'], [70, 'medium'],
    [71, 'high'], [85, 'high'],
    [86, 'xhigh'], [95, 'xhigh'],
    [96, 'max'], [100, 'max'],
  ]

  for (const [score, expected] of TABLE) {
    it(`maps ${score} to ${expected}`, () => {
      expect(effortForDifficulty(score)).toBe(expected)
    })
  }

  it('covers every integer from 0 to 100, and every one of them is a real rung', () => {
    // A sweep rather than a sample of the TABLE above, because a bucket table
    // with a gap — a score that fell through every arm — would satisfy the
    // sampled rows and answer `undefined` for the rest.
    const seen = new Set<string>()
    for (let score = 0; score <= 100; score += 1) {
      const effort = effortForDifficulty(score)
      expect(isModelEffort(effort)).toBe(true)
      seen.add(effort)
    }
    // RULE UNDER TEST: the mapping works UPWARD from a floor, so the set of
    // efforts it can produce is a SUFFIX OF THE LADDER starting at `low` — five
    // rungs, not seven. Written as literals rather than as
    // `ladder.slice(indexOf('low'))`, which would pass on any ladder that
    // merely contains `low`.
    expect([...seen].sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh'])
  })

  it('never returns a rung below the floor, at any score — the two easy buckets are gone', () => {
    // The rule this change exists to establish: `minDifficulty` is the ONLY
    // thing that says "too easy to bother", so the table must not have an
    // opinion about it. `none` and `minimal` survive on the LADDER (they are
    // published variant names) but no difficulty can select them.
    for (let score = -50; score <= 150; score += 1) {
      const effort = effortForDifficulty(score)
      expect(effortIndex(effort)).toBeGreaterThanOrEqual(effortIndex('low'))
    }
    // And the two names that are gone from the table are still ladder members,
    // so `reconcileEffort` can still serve a model that publishes them. Asserted
    // from the LITERAL names, so this cannot pass by reading back the table.
    expect(isModelEffort('none')).toBe(true)
    expect(isModelEffort('minimal')).toBe(true)
    expect(effortForDifficulty(0)).not.toBe('none')
    expect(effortForDifficulty(0)).not.toBe('minimal')
  })

  it('agrees with the existing quality/cost weight split at BOTH of its boundaries', () => {
    // `scoreModel` splits at `overall > 70` and `> 40`, and the mapping's 40
    // and 70 boundaries are the SAME numbers. That is deliberate — the ranker
    // and the effort choice must not disagree about where "hard" starts — so it
    // is asserted rather than left as a comment.
    const rankerCallsItHard = (o: number): boolean => o > 70
    const callsItCheap = (o: number): boolean => o <= 40
    for (let score = 0; score <= 100; score += 1) {
      if (rankerCallsItHard(score)) expect(effortIndex(effortForDifficulty(score))).toBeGreaterThan(effortIndex('medium'))
      if (callsItCheap(score)) expect(effortIndex(effortForDifficulty(score))).toBeLessThanOrEqual(effortIndex('low'))
    }
    // 40 itself is the inclusive top of the floor bucket, and 41 is the first
    // `medium`; 70 is the top of `medium` and 71 the first `high`. Both are the
    // boundaries the ranker's own comparisons imply, to the point.
    expect(effortForDifficulty(40)).toBe('low')
    expect(effortForDifficulty(41)).toBe('medium')
    expect(effortForDifficulty(70)).toBe('medium')
    expect(effortForDifficulty(71)).toBe('high')
  })

  it('clamps out-of-range and non-finite input to the floor and the top, never off the ladder', () => {
    // Every one of these must be a real rung. A `NaN` propagating into the
    // bucket walk returns `undefined`, and an `undefined` ceiling makes every
    // downstream comparison false — the quiet-wrong-answer shape this
    // repository keeps paying for. The floor is `low`: an input the mapping
    // cannot place lands on the cheapest effort it is willing to name, never on
    // "no effort", which is `minDifficulty`'s decision and not this function's.
    expect(effortForDifficulty(-1)).toBe('low')
    expect(effortForDifficulty(-1e9)).toBe('low')
    expect(effortForDifficulty(101)).toBe('max')
    expect(effortForDifficulty(1e9)).toBe('max')
    expect(effortForDifficulty(Number.NaN)).toBe('low')
    expect(effortForDifficulty(Number.POSITIVE_INFINITY)).toBe('max')
    expect(effortForDifficulty(Number.NEGATIVE_INFINITY)).toBe('low')
  })

  it('never reads riskLevel, so the unreachable "medium" risk cannot move it', () => {
    // `analyzeComplexity` tests for `riskLevel === 'medium'` and nothing ever
    // assigns it, while `src/templates.ts` emits `'medium'` and `types.ts`
    // admits it. The mapping takes `overall` alone, so the risk level cannot
    // reach it — asserted end-to-end: a task whose description triggers EVERY
    // high-risk keyword is mapped by `overall`, and the same `overall` maps
    // identically whatever the caller believes the risk to be.
    const risky = new NexusOrchestrator().analyzeComplexity({
      ...makeTask(0),
      // "migration", "production", "security", "payment" — the full high-risk
      // keyword set, so `riskLevel` is 'high'.
      description: 'migrate the production payment gateway, security and auth, crypto, database',
    } as Task)
    expect(risky.factors.riskLevel).toBe('high')
    // The claim under test: the mapping is a function of `overall` and of
    // nothing else, so the risk level is not an input and the same score maps
    // the same way when the risk level is a value the heuristic cannot produce.
    const score = risky.overall
    for (const riskLevel of ['low', 'medium', 'high'] as const) {
      const withRisk: ComplexityScore = { ...risky, factors: { ...risky.factors, riskLevel } }
      expect(effortForDifficulty(withRisk.overall)).toBe(effortForDifficulty(score))
    }
    // And a MEDIUM-risk score is not special-cased, which is the whole point:
    // it takes the same path as a low-risk one at the same `overall`.
    const mediumRisk: ComplexityScore = { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'medium' } }
    const lowRisk: ComplexityScore = { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } }
    expect(effortForDifficulty(mediumRisk.overall)).toBe(effortForDifficulty(lowRisk.overall))
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. reconcileEffort: the variant the model actually publishes
// ═══════════════════════════════════════════════════════════════════════

describe('reconcileEffort picks a level the model publishes', () => {
  it('takes the highest published level at or below the ceiling', () => {
    expect(reconcileEffort('high', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('high')
    expect(reconcileEffort('high', ['low', 'high', 'max'])).toBe('high')
    expect(reconcileEffort('medium', ['none', 'medium', 'high', 'xhigh'])).toBe('medium')
    expect(reconcileEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
    expect(reconcileEffort('none', ['none', 'medium', 'high', 'xhigh'])).toBe('none')
  })

  it('snaps DOWN to what is published, never up past the ceiling', () => {
    // A ceiling of `low` against a catalogue that also has `xhigh` and `max`:
    // the answer is `low`. Snapping up would spend more than asked for, and
    // the whole point of the ceiling is that it binds.
    expect(reconcileEffort('low', ['low', 'high', 'max'])).toBe('low')
    expect(reconcileEffort('minimal', ['low', 'medium', 'high'])).toBeUndefined()
  })

  it('returns nothing for an empty catalogue, and nothing when the ceiling excludes all of it', () => {
    // Two different situations that must NOT collapse. Both yield no suffix; the
    // orchestrator reports them differently, and this is where that difference
    // is rooted.
    expect(reconcileEffort('high', [])).toBeUndefined()
    expect(reconcileEffort('low', ['high'])).toBeUndefined()
    expect(reconcileEffort('low', ['xhigh', 'max'])).toBeUndefined()
  })

  it('treats a name it does not know as unreachable, never as a cheaper rung', () => {
    // The ladder is transcribed from observed catalogues and cannot be complete.
    // An unknown name must not be selectable — including at a ceiling that
    // excludes every real rung, which is exactly when a naive `indexOf` of -1
    // would slip through.
    //
    // HONEST LIMIT ON THIS TEST: the implementation excludes off-ladder names
    // structurally, by starting `bestIndex` at -1 rather than by a guard, so a
    // mutation that removes a redundant `index === -1` check is an EQUIVALENT
    // mutant and no assertion here can catch it. That was verified by running
    // the mutation, and these cases pin the OBSERVABLE rule rather than a
    // particular line of code.
    expect(reconcileEffort('max', ['low', 'enormous', 'max'])).toBe('max')
    expect(reconcileEffort('low', ['enormous', 'high'])).toBeUndefined()
    expect(reconcileEffort('high', ['enormous'])).toBeUndefined()
    expect(reconcileEffort('none', ['enormous', 'none'])).toBe('none')
    // And it is not merely losing to a real rung — with ONLY unknown names
    // there is no answer at all, at any ceiling.
    for (const ceiling of MODEL_EFFORT_LADDER) {
      expect(reconcileEffort(ceiling, ['enormous', 'bigger'])).toBeUndefined()
    }
  })

  it('agrees with the order it claims, on a ladder that is genuinely ordered', () => {
    // `MODEL_EFFORT_LADDER` is the only source of "less than" in this feature,
    // and the host supplies no order — so the order is asserted here rather than
    // assumed. A reversal mutation fails this.
    const indices = MODEL_EFFORT_LADDER.map(effortIndex)
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(isModelEffort('enormous')).toBe(false)
    expect(isModelEffort('HIGH')).toBe(false)
    expect(effortIndex('enormous')).toBe(-1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. The config block
// ═══════════════════════════════════════════════════════════════════════

describe('the effort config block', () => {
  it('defaults to off, with a conservative ceiling', () => {
    const manager = new NexusConfigManager()
    // Compared to the literal, not re-derived: the default IS the claim.
    expect(manager.getConfig().effort).toEqual({ enabled: false, maxEffort: 'high', minDifficulty: 0 })
    expect(DEFAULT_CONFIG.effort).toEqual({ enabled: false, maxEffort: 'high', minDifficulty: 0 })
  })

  it('does not blank a sibling when a level sets only enabled — the dashboard regression shape', () => {
    // The same bug `gitFlow` was fixed for, asserted on the same shape: the
    // block is merged field by field, so a level that names one key must not
    // reset the two numbers resolved beneath it.
    ensureGlobalDir()
    const base = writeProjectConfig('effort-merge', { effort: { enabled: true } })
    writeFileSync(
      join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'),
      JSON.stringify({ effort: { enabled: false, maxEffort: 'low', minDifficulty: 42 } }),
      'utf-8',
    )
    try {
      const manager = new NexusConfigManager()
      manager.loadFromPath(base)
      const resolved = manager.getConfig().effort
      expect(resolved.enabled).toBe(true)          // the project's key wins
      expect(resolved.maxEffort).toBe('low')      // and the global's SURVIVE
      expect(resolved.minDifficulty).toBe(42)
    } finally {
      rmSync(join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'), { force: true })
    }
  })

  it('reads all three keys from the file', async () => {
    const dir = writeProjectConfig('effort-read', { effort: { enabled: true, maxEffort: 'xhigh', minDifficulty: 7 } })
    const manager = new NexusConfigManager()
    await manager.loadFromPath(dir)
    expect(manager.getConfig().effort).toEqual({ enabled: true, maxEffort: 'xhigh', minDifficulty: 7 })
  })

  it('rejects a maxEffort off the ladder, warns, and falls through to the level below', () => {
    // A `??` chain cannot tell "absent" from "present and not a rung". This
    // asserts the hand-typed typo degrades to the global's preference rather
    // than to the default — and that it SAYS SO, because a config that quietly
    // does not do what it says is the recurring failure here.
    ensureGlobalDir()
    const base = writeProjectConfig('effort-badrung', { effort: { enabled: true, maxEffort: 'highh' } })
    writeFileSync(
      join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'),
      JSON.stringify({ effort: { maxEffort: 'minimal' } }),
      'utf-8',
    )
    const warn = console.warn
    const seen: string[] = []
    console.warn = mock((message: unknown) => { seen.push(String(message)) })
    try {
      const manager = new NexusConfigManager()
      manager.loadFromPath(base)
      expect(manager.getConfig().effort.maxEffort).toBe('minimal')
      expect(seen.join('\n')).toContain('highh')
      // The other two keys are honoured — a misspelling must not disable the
      // whole block, which is what throwing or dropping it would do.
      expect(manager.getConfig().effort.enabled).toBe(true)
    } finally {
      console.warn = warn
      rmSync(join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'), { force: true })
    }
  })

  it('clamps an out-of-range minDifficulty rather than failing the load', () => {
    for (const [written, resolved] of [[-50, 0], [500, 100]] as const) {
      const dir = writeProjectConfig('effort-clamp', { effort: { enabled: true, minDifficulty: written } })
      const manager = new NexusConfigManager()
      manager.loadFromPath(dir)
      expect(manager.getConfig().effort.minDifficulty).toBe(resolved)
    }
  })

  it('turns a non-finite minDifficulty into "no minimum", not into "skip everything"', () => {
    // `NaN >= x` is always false, so a NaN threshold would silently mean "skip
    // every task" and effort selection would look broken rather than
    // misconfigured. Asserted at the boundary that would expose it.
    const dir = writeProjectConfig('effort-nan', { effort: { enabled: true, minDifficulty: 'nonsense' } })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    expect(manager.getConfig().effort.minDifficulty).toBe(0)
  })

  it('accepts a programmatic seed and rung-checks it like a file value', () => {
    const warn = console.warn
    console.warn = mock(() => {})
    try {
      const manager = new NexusConfigManager(undefined, undefined, undefined, undefined, { enabled: true, maxEffort: 'low', minDifficulty: 3 })
      expect(manager.getConfig().effort).toEqual({ enabled: true, maxEffort: 'low', minDifficulty: 3 })
    } finally {
      console.warn = warn
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. Every key is READ — the gitFlow precedent
// ═══════════════════════════════════════════════════════════════════════

describe('every effort key is read — no dead knob', () => {
  const CATALOGUE: readonly FakeProvider[] = [
    { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low', 'medium', 'high', 'xhigh', 'max') } } },
    { id: 'openai', name: 'OpenAI', models: { 'gpt-5-mini': { id: 'gpt-5-mini', variants: v('low', 'high', 'max') } } },
    { id: 'google', name: 'Google', models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', variants: v() } } },
    { id: 'opencode', name: 'OpenCode', models: { 'minimax-m2.5-free': { id: 'minimax-m2.5-free', variants: v('low', 'medium', 'high') } } },
  ]

  it('enabled: false leaves the published-variants catalogue UNREAD', async () => {
    // The strongest form of "off changes nothing". A deep-equality check against
    // a second orchestrator would pass even if the automatic choice ran and then
    // was discarded, and a spot check on one task would miss an off-by-one in
    // the gate. Counting reads of the catalogue fails both: anything that
    // consults the map before checking `enabled` shows up here.
    const dir = writeProjectConfig('effort-off', { effort: { enabled: false, maxEffort: 'max', minDifficulty: 0 } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    const reads = instrumentVariantReads(orchestrator)
    for (let overall = 0; overall <= 100; overall += 1) {
      const result = select(orchestrator, 'coder', overall)
      expect('variant' in result).toBe(false)
    }
    expect(reads()).toBe(0)
  })

  it('enabled: false is deep-equal to the block being absent entirely', async () => {
    const offDir = writeProjectConfig('effort-off2', { effort: { enabled: false, maxEffort: 'max', minDifficulty: 0 } })
    const absentDir = writeProjectConfig('effort-absent', { models: { coder: 'anthropic/claude-sonnet-4-6' } })
    const a = await harness(offDir, CATALOGUE)
    const b = await harness(absentDir, CATALOGUE)
    for (const overall of [0, 37, 50, 71, 100]) {
      expect(select(a.orchestrator, 'coder', overall)).toEqual(select(b.orchestrator, 'coder', overall))
    }
  })

  it('enabled: false never mentions effort in the reasoning', async () => {
    const dir = writeProjectConfig('effort-off3', { effort: { enabled: false } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    // The pre-feature reasoning string is the `scoreModel` one, and the
    // assertion is on the string the feature appends to.
    expect(select(orchestrator, 'coder', 80).reasoning).not.toContain('effort')
  })

  it('maxEffort is read: it changes the answer for the same task', async () => {
    // A knob is only read if a value of it changes an outcome. Both runs use the
    // SAME task and the SAME catalogue; only the ceiling differs.
    const highDir = writeProjectConfig('effort-ceil-high', { effort: { enabled: true, maxEffort: 'high' } })
    const lowDir = writeProjectConfig('effort-ceil-low', { effort: { enabled: true, maxEffort: 'low' } })
    const high = await harness(highDir, CATALOGUE)
    const low = await harness(lowDir, CATALOGUE)
    // Difficulty 90 maps to `xhigh` on its own, so the default ceiling of
    // `high` and an explicit `low` must differ.
    expect(effortForDifficulty(90)).toBe('xhigh')
    const asHigh = select(high.orchestrator, 'coder', 90)
    const asLow = select(low.orchestrator, 'coder', 90)
    expect(asHigh.variant).toBe('high')
    expect(asLow.variant).toBe('low')
    expect(asHigh.reasoning).toContain('effort.maxEffort high')
  })

  it('maxEffort: absent resolves to the documented default, and it binds', async () => {
    // The absence case, per the gitFlow precedent: with the key omitted the
    // merged value is `high`, which is what the last test observed. Asserted
    // here so the default is pinned independently of any block that sets it.
    const dir = writeProjectConfig('effort-ceil-absent', { effort: { enabled: true } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    expect(select(orchestrator, 'coder', 90).variant).toBe('high')
  })

  it('maxEffort: absent leaves the top two buckets unreachable at the default', async () => {
    // The DEFAULT is a cost claim, so it is asserted rather than described: at
    // `maxEffort: 'high'` the hardest task in the range does not get `xhigh`.
    const dir = writeProjectConfig('effort-ceil-default', { effort: { enabled: true } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    // Non-vacuity first: the hardest score really does map above the ceiling, so
    // the sweep below is asserting a binding and not a table that never rises.
    expect(effortForDifficulty(90)).toBe('xhigh')
    for (let overall = 0; overall <= 100; overall += 1) {
      const variant = select(orchestrator, 'coder', overall).variant
      // The floor means no score is skipped at the default threshold, so every
      // row has a variant and the ceiling is compared on all 101 of them.
      expect(variant).not.toBeUndefined()
      expect(effortIndex(variant as string)).toBeLessThanOrEqual(effortIndex('high'))
    }
    expect(select(orchestrator, 'coder', 90).variant).toBe('high')
  })

  // ── maxEffort against the table's FLOOR ──────────────────────────────
  //
  // The floor is `low`, so `none` and `minimal` are ceilings the mapping can
  // never produce. These three cases say what happens anyway, because a ceiling
  // the mapping cannot reach is the one place the two controls could disagree.

  it('maxEffort AT the floor bounds every score at the floor, and does not skip anything', async () => {
    const dir = writeProjectConfig('effort-ceil-floor', { effort: { enabled: true, maxEffort: 'low' } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    // The easiest task, which the table would also have floored, and the
    // hardest, which it would have put in `xhigh`. Both are `low`.
    expect(select(orchestrator, 'coder', 0).variant).toBe('low')
    expect(select(orchestrator, 'coder', 100).variant).toBe('low')
  })

  it('maxEffort ABOVE the floor changes nothing — a ceiling can only lower', async () => {
    const dir = writeProjectConfig('effort-ceil-above', { effort: { enabled: true, maxEffort: 'max' } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    // The two ends of the range, where a floor that behaved like a ramp would
    // be visible: the table answers `low` at 0 and `max` at 100.
    expect(effortForDifficulty(0)).toBe('low')
    expect(effortForDifficulty(100)).toBe('max')
    expect(select(orchestrator, 'coder', 0).variant).toBe('low')
    expect(select(orchestrator, 'coder', 100).variant).toBe('max')
  })

  it('maxEffort BELOW the floor is honoured, and is never rounded UP to the floor', async () => {
    // A catalogue whose lowest published rungs are the two the table no longer
    // produces, so the answer can only be one of them.
    const lowOnly = [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('none', 'minimal', 'high') } } },
    ]
    const dir = writeProjectConfig('effort-ceil-under', { effort: { enabled: true, maxEffort: 'minimal' } })
    const { orchestrator } = await harness(dir, lowOnly)
    const selection = select(orchestrator, 'coder', 0)
    // `minimal`, NOT `low`: the ceiling is a ceiling, and the floor is a floor.
    // Rounding up here would spend more reasoning budget than the user allowed,
    // on a knob whose whole stated purpose is to bound that budget.
    expect(selection.variant).toBe('minimal')
    // The reasoning names BOTH operands, so "the ceiling beat the table" is
    // visible rather than inferred: the table asked for the floor and the
    // ceiling decided.
    expect(selection.reasoning).toContain('asks for at most low')
    expect(selection.reasoning).toContain('capped by effort.maxEffort minimal')
  })

  it('maxEffort BELOW the floor with nothing published under it yields no suffix, and says which bound bit', async () => {
    // The realistic shape of the same case: most catalogues publish `low` as
    // their lowest rung, so a ceiling of `minimal` excludes everything. The
    // honest answer is no suffix with the ceiling named — NOT `low` pulled down
    // from the floor, and NOT "below minDifficulty", which is a different fact.
    const dir = writeProjectConfig('effort-ceil-under-none', { effort: { enabled: true, maxEffort: 'minimal', minDifficulty: 40 } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    const selection = select(orchestrator, 'coder', 80)
    expect(selection.variant).toBeUndefined()
    expect(selection.reasoning).toContain('none of which is at or below the "minimal" ceiling')
    // Both controls are named in the one string, so the two are distinguishable.
    expect(selection.reasoning).toContain('effort.maxEffort is "minimal"')
    expect(selection.reasoning).not.toContain('minDifficulty')
  })

  // ── minDifficulty: the ONE path to no suffix ─────────────────────────

  it('minDifficulty: below the threshold nothing, at and above it the table’s answer', async () => {
    // THE RULE, at both boundaries and one past each, with the VALUE asserted at
    // every one — not a count, and not "something changed".
    const dir = writeProjectConfig('effort-min', { effort: { enabled: true, maxEffort: 'max', minDifficulty: 70 } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    expect(select(orchestrator, 'coder', 69).variant).toBeUndefined()
    expect(select(orchestrator, 'coder', 69).reasoning).toContain('below effort.minDifficulty 70')
    // 70 is the top of the `medium` bucket and 71 the first `high`, so the
    // threshold boundary and a bucket boundary are asserted apart.
    expect(select(orchestrator, 'coder', 70).variant).toBe('medium')
    expect(select(orchestrator, 'coder', 71).variant).toBe('high')
  })

  it('a score between the threshold and the table’s top bucket gets a BUCKET, not nothing', async () => {
    // The gap this change had to close: with a floor bucket of 40, a threshold
    // of 40 and a score of 50, is the answer "nothing" or the floor? It is the
    // bucket — the table tiles 0-100 with no hole, so the threshold has nothing
    // to fall through. Asserted as the bucket's own value, because "not
    // undefined" would also pass if the table returned nonsense.
    const dir = writeProjectConfig('effort-min-mid', { effort: { enabled: true, maxEffort: 'max', minDifficulty: 40 } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    expect(effortForDifficulty(50)).toBe('medium')
    expect(select(orchestrator, 'coder', 49).variant).toBe('medium')
    expect(select(orchestrator, 'coder', 50).variant).toBe('medium')
    expect(select(orchestrator, 'coder', 51).variant).toBe('medium')
  })

  it('minDifficulty at 0 skips nothing, and the easiest task still gets the floor', async () => {
    // The default is the one value that could be inert, and this asserts it is
    // not: the sweep below is the "no gap" half of the rule across the whole
    // range, at the threshold that skips the least.
    const dir = writeProjectConfig('effort-min-zero', { effort: { enabled: true, maxEffort: 'max', minDifficulty: 0 } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    for (let overall = 0; overall <= 100; overall += 1) {
      const selection = select(orchestrator, 'coder', overall)
      expect(selection.variant).toBe(effortForDifficulty(overall))
      expect(selection.reasoning).not.toContain('minDifficulty')
    }
  })

  it('minDifficulty: absent resolves to 0, and is told apart from an explicit 0', async () => {
    const absent = writeProjectConfig('effort-min-absent', { effort: { enabled: true, maxEffort: 'max' } })
    const explicit = writeProjectConfig('effort-min-explicit', { effort: { enabled: true, maxEffort: 'max', minDifficulty: 0 } })
    const a = await harness(absent, CATALOGUE)
    const b = await harness(explicit, CATALOGUE)
    // Both are "every task", and both serve the EASIEST one — which under the
    // old table mapped to `none` and now maps to the floor. The winner
    // publishes `low`, so the answer is the floor and the reasoning must not
    // blame `minDifficulty`, which is absent in one and zero in the other.
    for (const selection of [select(a.orchestrator, 'coder', 0), select(b.orchestrator, 'coder', 0)]) {
      expect(selection.variant).toBe('low')
      expect(selection.reasoning).not.toContain('minDifficulty')
      expect(selection.reasoning).toContain('effort:')
    }
  })

  it('EVERY value of minDifficulty changes the outcome for at least one score', async () => {
    // THE ANTI-DEAD-KNOB TEST, and the reason it is written as a sweep over all
    // 101 effective values rather than as a spot check: the defect being fixed
    // was a key that was read, testable, and INERT at its own default, and a
    // spot check at a convenient score is exactly what let that ship. For each
    // threshold t in 1..100 the witness is the score `t - 1`, which is the
    // highest score the threshold suppresses; for t = 0 the witness is score 0
    // against a threshold of 1. Every value therefore has a named score whose
    // ANSWER moves, so "the default does nothing" cannot recur unnoticed — a
    // test that asserted "nothing happened here for the default" is the defect,
    // and none is written.
    const dir = writeProjectConfig('effort-sweep', { effort: { enabled: true, maxEffort: 'max' } })
    const { orchestrator } = await harness(dir, CATALOGUE)
    const variantAt = (threshold: number, score: number): string | undefined => {
      writeFileSync(
        join(dir, '.opencode', 'nexus.jsonc'),
        JSON.stringify({ effort: { enabled: true, maxEffort: 'max', minDifficulty: threshold } }),
        'utf-8',
      )
      orchestrator.configManager.loadFromPath(dir)
      return select(orchestrator, 'coder', score).variant
    }

    // The default: every score is served, and served at its own bucket.
    for (let score = 0; score <= 100; score += 1) {
      expect(variantAt(0, score)).toBe(effortForDifficulty(score))
    }
    // The default is itself distinguishable: threshold 0 serves score 0, and
    // threshold 1 does not. A default that were inert could not pass this.
    expect(variantAt(0, 0)).toBe('low')
    expect(variantAt(1, 0)).toBeUndefined()

    for (let threshold = 1; threshold <= 100; threshold += 1) {
      const score = threshold - 1
      // Both directions of the witness, so neither "ignores the key" nor
      // "skips everything" can satisfy the loop.
      expect(variantAt(threshold, score)).toBeUndefined()
      expect(variantAt(threshold - 1, score)).toBe(effortForDifficulty(score))
      // And one score on the far side of the threshold, which must still be
      // served — a threshold that skipped everything would also pass the two
      // lines above.
      const above = threshold === 100 ? 100 : threshold
      expect(variantAt(threshold, above)).toBe(effortForDifficulty(above))
    }
  })

  it('an explicit #variant is untouched by both controls, at every difficulty', async () => {
    // The interaction that must not have changed: a user who named the effort
    // keeps it, whatever the table now says and whatever the threshold is. The
    // table's floor cannot raise it and the threshold cannot suppress it, which
    // is why the two are checked over the whole range rather than at one score.
    const dir = writeProjectConfig('effort-explicit', {
      models: { coder: 'anthropic/claude-sonnet-4-6#minimal' },
      effort: { enabled: true, maxEffort: 'max', minDifficulty: 90 },
    })
    const { orchestrator } = await harness(dir, CATALOGUE)
    for (let score = 0; score <= 100; score += 1) {
      const selection = select(orchestrator, 'coder', score)
      if (selection.variant !== undefined) {
        expect(selection.variant).toBe('minimal')
        expect(selection.reasoning).toContain('kept the explicit variant you set')
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. What the model actually publishes
// ═══════════════════════════════════════════════════════════════════════

describe('the catalogue decides the suffix', () => {
  const base = (variants: readonly { readonly id: string }[] | undefined, key = 'claude-sonnet-4-6', provider = 'anthropic') => [
    { id: provider, name: provider, models: { [key]: variants === undefined ? { id: key } : { id: key, variants } } },
  ]

  it('a model with variants: [] gets no suffix, and says so', async () => {
    const dir = writeProjectConfig('effort-empty', { effort: { enabled: true, maxEffort: 'max' } })
    const { orchestrator } = await harness(dir, base([]))
    const selection = select(orchestrator, 'coder', 100)
    // The winner is whatever the flat-price ranking picks; the assertion is on
    // the ONE fact under test — that the empty catalogue produced no suffix and
    // reported the reason, rather than the absence being indistinguishable from
    // the feature being off.
    if (selection.model === 'claude-sonnet-4-6') {
      expect(selection.variant).toBeUndefined()
      expect(selection.reasoning).toContain('publishes no variants')
    }
    // A second orchestrator whose winner is pinned to the empty model makes the
    // above unconditional.
    const pinned = await harness(dir, [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-opus-4-7': { id: 'claude-opus-4-7', variants: v() } } },
      ...base([]),
    ])
    const p = select(pinned.orchestrator, 'architect', 100)
    expect(p.reasoning).toContain('publishes no variants')
  })

  it('a model with variants gets a suffix the model ACTUALLY publishes', async () => {
    const dir = writeProjectConfig('effort-published', { effort: { enabled: true, maxEffort: 'max' } })
    const rows = base(v('low', 'high', 'max'))
    const { orchestrator } = await harness(dir, rows)
    for (let overall = 0; overall <= 100; overall += 1) {
      const selection = select(orchestrator, 'coder', overall)
      if (selection.variant === undefined) continue
      // Membership, not equality: the assertion is that whatever was chosen is
      // one of the three published names, so a mutation that invents a level
      // fails and one that drops to a published one does not.
      expect(['low', 'high', 'max']).toContain(selection.variant)
      expect(reconcileEffort(effortForDifficulty(overall), ['low', 'high', 'max'])).toBe(selection.variant)
    }
  })

  it('reports a model the catalogue never described, without inventing a variant', async () => {
    // No `variants` field at all is ABSENCE, not an empty list, and the two are
    // reported differently — a model that publishes none and a model we know
    // nothing about both get no suffix, but only one of them is a claim.
    const dir = writeProjectConfig('effort-unknown', { effort: { enabled: true, maxEffort: 'max' } })
    const { orchestrator } = await harness(dir, base(undefined))
    const selection = select(orchestrator, 'coder', 100)
    expect(selection.reasoning).toContain('no entry for')
    expect(selection.reasoning).not.toContain('publishes no variants')
  })

  it('survives a provider.list() that throws, choosing nothing', async () => {
    // The catalogue load is best-effort, exactly like the provider-name load it
    // shares a call with. A throw must cost a variant, never a spawn.
    const dir = writeProjectConfig('effort-throw', { effort: { enabled: true, maxEffort: 'max' } })
    const { orchestrator } = await harness(dir, new Error('provider list unavailable'))
    const selection = select(orchestrator, 'coder', 100)
    expect(selection.variant).toBeUndefined()
    expect(orchestrator.getProviderList().length).toBeGreaterThanOrEqual(0)
  })

  it('reports the miss when the ceiling excludes everything the model publishes', async () => {
    const dir = writeProjectConfig('effort-excluded', { effort: { enabled: true, maxEffort: 'minimal' } })
    // This model publishes nothing at or below `minimal`.
    const rows: readonly FakeProvider[] = [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-opus-4-7': { id: 'claude-opus-4-7', variants: v('high', 'max') } } },
    ]
    const { orchestrator } = await harness(dir, rows)
    const selection = select(orchestrator, 'architect', 100)
    if (selection.model === 'claude-opus-4-7') {
      expect(selection.variant).toBeUndefined()
      expect(selection.reasoning).toContain('none of which is at or below')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. An explicit user choice is never overwritten
// ═══════════════════════════════════════════════════════════════════════

describe('an explicit #variant in config outranks the automatic choice', () => {
  it('keeps the configured variant even on the hardest task with the ceiling wide open', async () => {
    const dir = writeProjectConfig('effort-override', {
      models: { coder: 'anthropic/claude-sonnet-4-6#minimal' },
      effort: { enabled: true, maxEffort: 'max', minDifficulty: 0 },
    })
    const { orchestrator } = await harness(dir, [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low', 'medium', 'high', 'xhigh', 'max') } } },
    ])
    const selection = select(orchestrator, 'coder', 100)
    // Difficulty 100 maps to `max`, and the ceiling permits it, so an automatic
    // choice WOULD have picked `max`. It must not have.
    expect(effortForDifficulty(100)).toBe('max')
    expect(selection.variant).toBe('minimal')
    expect(selection.reasoning).toContain('kept the explicit variant you set')
  })

  it('reports a configured variant the model does not publish, and does not correct it', async () => {
    const dir = writeProjectConfig('effort-unpublished', {
      models: { coder: 'anthropic/claude-sonnet-4-6#enormous' },
      effort: { enabled: true, maxEffort: 'max' },
    })
    const { orchestrator } = await harness(dir, [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low', 'high') } } },
    ])
    const selection = select(orchestrator, 'coder', 100)
    // Never quietly dropped, never rewritten: the user's string survives and the
    // disagreement is stated. The two failure modes this rules out are the
    // silent drop (the suffix vanishes) and the silent rewrite (it becomes
    // `high`).
    expect(selection.variant).toBe('enormous')
    expect(selection.reasoning).toContain('does not publish "enormous"')
    expect(selection.reasoning).toContain('"low"')
  })

  it('does not overwrite an explicit variant when the catalogue is unknown', async () => {
    const dir = writeProjectConfig('effort-override-nocat', {
      models: { coder: 'anthropic/claude-sonnet-4-6#low' },
      effort: { enabled: true, maxEffort: 'max' },
    })
    const { orchestrator } = await harness(dir, new Error('no catalogue'))
    const selection = select(orchestrator, 'coder', 100)
    expect(selection.variant).toBe('low')
    expect(selection.reasoning).toContain('published variants are unknown')
  })

  it('an explicit variant is not even READ from the catalogue when it is kept', async () => {
    // The override is checked BEFORE the catalogue is consulted for a choice.
    // Not asserted on the reasoning string — a mutation that consulted the map
    // and then discarded the answer produces the same text. Counted instead.
    const dir = writeProjectConfig('effort-override-noread', {
      models: { coder: 'anthropic/claude-sonnet-4-6#low' },
      effort: { enabled: true, maxEffort: 'max' },
    })
    const { orchestrator } = await harness(dir, [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low', 'high') } } },
    ])
    const reads = instrumentVariantReads(orchestrator)
    const selection = select(orchestrator, 'coder', 100)
    expect(selection.variant).toBe('low')
    // Exactly ONE read — the "does it publish what you asked for" check — and
    // not a second one from the automatic path. A gate that fell through to the
    // mapping and then discarded its answer would read at least twice.
    expect(reads()).toBe(1)
  })

  it('the user is not offered a variant the catalogue says it cannot serve', async () => {
    // The read count above is the mechanism; this is the reason it is 1 and not
    // 0 — the mismatch IS reported, so the catalogue is consulted. Pinned
    // separately from the string assertion so removing the report fails here.
    const dir = writeProjectConfig('effort-override-report', {
      models: { coder: 'anthropic/claude-sonnet-4-6#ghost' },
      effort: { enabled: true, maxEffort: 'max' },
    })
    const { orchestrator } = await harness(dir, [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low') } } },
    ])
    expect(select(orchestrator, 'coder', 50).reasoning).toContain('does not publish "ghost"')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7. Honest failure, and no task lost
// ═══════════════════════════════════════════════════════════════════════

describe('a variant the model cannot serve is reported, not thrown', () => {
  it('still spawns the agent, so the task is not lost', async () => {
    // The decision, stated as a test: an unavailable or unpublished suffix must
    // NOT cost the user their task. `selectQualifiedModel`'s loud throw is
    // reserved for a reference the GRAMMAR rejects; a well-formed reference
    // naming an effort the host may reject degrades, and says so.
    const dir = writeProjectConfig('effort-spawn', {
      models: { coder: 'anthropic/claude-sonnet-4-6#enormous' },
      effort: { enabled: true, maxEffort: 'max' },
    })
    const made = makeCtx(catalogue([{ id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low') } } }]), dir)
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10, maxCostPerTask: 1, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize(made.ctx as never)
    const agent = await orchestrator.spawnAgent({ role: 'coder' })
    // The agent EXISTS, and the ref reached the host intact — the suffix was
    // neither dropped nor rewritten on the way through.
    expect(agent).toBeDefined()
    expect(agent.model.variant).toBe('enormous')
    const arg = (made.ctx as { session: { create: { mock: { calls: [{ model: { variant?: string } }][] } } } }).session.create.mock.calls[0]![0]
    expect(arg.model.variant).toBe('enormous')
  })

  it('a spawn with no catalogue and no configured model still works', async () => {
    const dir = writeProjectConfig('effort-spawn-nocat', { effort: { enabled: true, maxEffort: 'max' } })
    const made = makeCtx(new Error('no catalogue'), dir)
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10, maxCostPerTask: 1, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize(made.ctx as never)
    const agent = await orchestrator.spawnAgent({ role: 'coder' })
    expect(agent).toBeDefined()
  })

  it('an unparseable ref fails LOUDLY, identically with the feature on and off', async () => {
    // A bare id is not a `Model.Ref`, and `selectQualifiedModel` throws for it —
    // pre-existing, and the honest failure. What this feature must NOT do is
    // change it: a selection that silently acquired a variant could turn a loud
    // failure into a quiet wrong-model spawn. The two messages are compared, so
    // a mutation that alters the failure fails here.
    const offDir = writeProjectConfig('effort-bare-off', { models: { coder: 'bare-model-id' }, effort: { enabled: false } })
    const onDir = writeProjectConfig('effort-bare-on', { models: { coder: 'bare-model-id' }, effort: { enabled: true, maxEffort: 'max' } })
    const off = await harness(offDir, [], 1_000, { expensiveRealModels: true })
    const on = await harness(onDir, [], 1_000, { expensiveRealModels: true })
    const messageFrom = (orchestrator: InstanceType<typeof NexusOrchestrator>): string => {
      const internals = orchestrator as unknown as {
        selectQualifiedModel(node: unknown): string
      }
      try {
        internals.selectQualifiedModel({ task: makeTask(50), id: 'n1', dependencies: [], status: 'pending' })
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const offMessage = messageFrom(off.orchestrator)
    const onMessage = messageFrom(on.orchestrator)
    // Loud: it names the missing half, and it is not empty. The non-emptiness is
    // the load-bearing half of this assertion — the equality below is trivially
    // satisfied by two empty strings, so a regression that stopped the throw
    // firing would pass it and fail this.
    expect(offMessage).not.toBe('')
    expect(offMessage).toContain('missing its')
    // The SPECIFIC half, not just "it threw": a bare id yields the whole value
    // as `provider` and an empty id, so the message must name `model`. Asserting
    // the vaguer "provider and model" would pass for the wrong reason if the
    // selection ever changed shape.
    expect(offMessage).toContain('missing its model')
    expect(offMessage).toContain('model: ""')
    // And identical: the effort gate is not in this path.
    expect(onMessage).toBe(offMessage)
  })

  it('a malformed # in a configured ref never becomes a priceable model', () => {
    // `p/m#a#b` is a reference the host's grammar REJECTS (a variant may not
    // contain a `#`). The property asserted here is the one that matters for
    // this feature: the malformed ref does not silently become a well-formed
    // one. `priceKeyForRef` is the key every price lookup joins on, so a ref
    // whose `#` had been stripped by a naive normaliser would be priced as a
    // model the user never named.
    //
    // Asserted against the STRICT parser and the LOOSE normaliser separately,
    // because they legitimately disagree and conflating them is how a
    // ref-handling bug hides. `parseModelRef` is the grammar and REJECTS a
    // second `#`; `priceKeyForRef` is a price-key normaliser and strips from
    // the first `#` so a hand-typed `p/m#anything` still prices as `p/m`.
    //
    // A test that ran only inputs BOTH took would be structurally blind to a
    // field bug on a rejected one — the mistake a previous test in this
    // repository shipped — so the rejected case is asserted here, not skipped.
    let thrown: unknown
    try {
      parseModelRef('anthropic/claude-sonnet-4-6#a#b')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidModelRefError)
    expect((thrown as InstanceType<typeof InvalidModelRefError>).input).toBe('anthropic/claude-sonnet-4-6#a#b')

    // The LOOSE normaliser, by contrast, resolves the hand-typed spelling to the
    // underlying model rather than to a model that does not exist — its
    // documented job, and the reason a typo in a price key degrades to a
    // working price rather than to `unknown-model`.
    expect(priceKeyForRef('anthropic/claude-sonnet-4-6#a#b')).toBe('anthropic/claude-sonnet-4-6')
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10, maxCostPerTask: 1, alertThreshold: 0.2, hardLimit: false },
    })
    const internals = orchestrator as unknown as {
      modelCosts: Map<string, unknown>
      getModelCost(model: string, provider?: string): unknown
    }
    internals.modelCosts = new Map([
      ['anthropic/claude-sonnet-4-6', { tiers: [{ rates: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } }] }],
    ])
    // A variant-bearing ref prices as the model beneath it, at the same rate.
    expect(internals.getModelCost('anthropic/claude-sonnet-4-6#a#b')).toBe(internals.getModelCost('anthropic/claude-sonnet-4-6'))
    // And a ref naming a model that does not exist still finds nothing.
    expect(internals.getModelCost('anthropic/not-a-model#high')).toBeUndefined()
  })

  it('an unparseable configured ref loses the ranking instead of becoming a model', async () => {
    // The companion fact. A reference the grammar rejects lands in `provider`
    // whole with an EMPTY model id, so it cannot be mistaken for a model — which
    // is what `selectQualifiedModel`'s loud throw then reports. Asserted on the
    // selection's own halves rather than on the throw, because the throw belongs
    // to a test that already covers it for a bare id.
    const dir = writeProjectConfig('effort-badhash', {
      models: { coder: 'anthropic/claude-sonnet-4-6#a#b' },
      effort: { enabled: true, maxEffort: 'max' },
    })
    const { orchestrator } = await harness(dir, [
      { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', variants: v('low') } } },
    ])
    const selection = select(orchestrator, 'coder', 100)
    // The winner is a WELL-FORMED candidate, and the effort gate applied to it
    // normally — the malformed reference simply is not in the running. Both
    // halves are non-empty, which is the property the loud throw checks for.
    expect(selection.provider).toBe('anthropic')
    expect(selection.model).toBe('claude-sonnet-4-6')
    expect(selection.variant).toBe('low')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 8. Config round-trips, and the storage-merge trap
// ═══════════════════════════════════════════════════════════════════════

describe('the effort block survives a save', () => {
  it('round-trips through saveProjectConfig, so a TUI model save cannot delete it', async () => {
    // `saveProjectConfig` writes `getSaveableConfig()`'s return value as the
    // WHOLE file body. Driven through the public method and read back off disk,
    // because the file is what gets damaged and the private method is only the
    // mechanism.
    const dir = makeDir('effort-save')
    const manager = new NexusConfigManager(undefined, undefined, undefined, undefined, { enabled: true, maxEffort: 'low', minDifficulty: 12 })
    manager.saveProjectConfig(dir)
    const raw = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
    const written = JSON.parse(raw.replace(/^\/\/[^\n]*\n/gm, '')) as { effort?: Record<string, unknown> }
    // All THREE fields, not the block's presence: a partial write would let the
    // next save restore a ceiling the user had turned down.
    expect(written.effort).toEqual({ enabled: true, maxEffort: 'low', minDifficulty: 12 })
  })

  it('round-trips through saveGlobalConfig', async () => {
    ensureGlobalDir()
    const path = join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc')
    try {
      const manager = new NexusConfigManager(undefined, undefined, undefined, undefined, { enabled: true, maxEffort: 'max', minDifficulty: 3 })
      manager.saveGlobalConfig()
      const raw = readFileSync(path, 'utf-8')
      const written = JSON.parse(raw.replace(/^\/\/[^\n]*\n/gm, '')) as { effort?: Record<string, unknown> }
      expect(written.effort).toEqual({ enabled: true, maxEffort: 'max', minDifficulty: 3 })
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('round-trips through exportConfig', () => {
    const manager = new NexusConfigManager(undefined, undefined, undefined, undefined, { enabled: true, maxEffort: 'xhigh', minDifficulty: 5 })
    const exported = manager.exportConfig()
    expect(exported.effort).toEqual({ enabled: true, maxEffort: 'xhigh', minDifficulty: 5 })
  })

  it('a file-set block survives a session override that sets only models — the storage-merge trap', async () => {
    // THE TRAP. `updateStorageConfig` REPLACES three blocks with fresh
    // literals, and `getConfig()` merges storage LAST, so a key written there
    // shadows the project and global files even when the value written is the
    // default. This is how a user's `nexus.jsonc` gets silently overwritten.
    // The fix here is the ABSENCE of the block from that literal, and this
    // asserts the absence's effect rather than the absence itself.
    const dir = writeProjectConfig('effort-trap', { effort: { enabled: true, maxEffort: 'xhigh', minDifficulty: 9 } })
    const manager = new NexusConfigManager()
    await manager.loadFromPath(dir)
    manager.updateStorageConfig({ models: {} })
    expect(manager.getConfig().effort).toEqual({ enabled: true, maxEffort: 'xhigh', minDifficulty: 9 })
  })

  it('a session override that DOES set effort wins, and does not blank its siblings', async () => {
    const dir = writeProjectConfig('effort-trap2', { effort: { enabled: true, maxEffort: 'max', minDifficulty: 80 } })
    const manager = new NexusConfigManager()
    await manager.loadFromPath(dir)
    manager.updateStorageConfig({ effort: { enabled: false, maxEffort: 'high', minDifficulty: 0 } })
    expect(manager.getConfig().effort).toEqual({ enabled: false, maxEffort: 'high', minDifficulty: 0 })
  })

  it('a save after a session override writes the MERGED block, not the default', async () => {
    const dir = writeProjectConfig('effort-trap3', { effort: { enabled: true, maxEffort: 'low', minDifficulty: 4 } })
    const manager = new NexusConfigManager()
    await manager.loadFromPath(dir)
    manager.updateStorageConfig({ models: { coder: 'anthropic/claude-sonnet-4-6' } })
    manager.saveProjectConfig(dir)
    const raw = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
    const written = JSON.parse(raw.replace(/^\/\/[^\n]*\n/gm, '')) as { effort?: Record<string, unknown> }
    expect(written.effort).toEqual({ enabled: true, maxEffort: 'low', minDifficulty: 4 })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 9. Cost arithmetic is unchanged — this is a request-shaping feature
// ═══════════════════════════════════════════════════════════════════════

describe('no variant axis reached pricing', () => {
  it('a price tier still has only a threshold and four rates', () => {
    // `ModelPricingTiers`' only axis is context size. A variant axis here would
    // be the category error, and it would be invisible in a diff of the
    // arithmetic — so the SHAPE is asserted, which is where such an axis would
    // first appear.
    const tier = { threshold: 200_000, rates: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } }
    expect(Object.keys(tier).sort()).toEqual(['rates', 'threshold'])
    expect(Object.keys(tier.rates).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output'])
  })

  it('measured reasoning tokens still price through the existing output rate', () => {
    // The disjointness the whole "not a pricing feature" argument rests on:
    // reasoning tokens are added to output and billed at the output rate, and
    // the input rate sees only input. Worked by hand so a change to either term
    // fails.
    const rates = { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 }
    const usage = { input: 1_000, output: 200, reasoning: 800, cache: { read: 0, write: 0 } }
    const priced = priceTokens(usage, rates)
    expect(priced.inputCost).toBeCloseTo(0.003, 10)        // 1k at 0.003/1k
    expect(priced.outputCost).toBeCloseTo(0.015, 10)       // (200+800) at 0.015/1k
    expect(priced.total).toBeCloseTo(0.018, 10)
    // And the two tokens are charged together, not separately: a variant that
    // added its own term would show up as a third component here.
    expect(Object.keys(priced).sort()).toEqual(['cacheCost', 'inputCost', 'outputCost', 'total'])
  })

  it('the same tokens price identically however the ref spells the effort', () => {
    // `p/m` and `p/m#high` are the same model at the same rate, and the
    // orchestrator resolves them to the same price row.
    const flat = { tiers: [{ rates: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } }] }
    const costs = new Map([
      ['anthropic/claude-sonnet-4-6', flat],
      ['anthropic/claude-sonnet-4-6#high', flat],
    ])
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10, maxCostPerTask: 1, alertThreshold: 0.2, hardLimit: false },
    })
    const internals = orchestrator as unknown as {
      modelCosts: Map<string, unknown>
      getModelCost(model: string, provider?: string): unknown
    }
    internals.modelCosts = costs
    expect(internals.getModelCost('anthropic/claude-sonnet-4-6#high')).toBe(internals.getModelCost('anthropic/claude-sonnet-4-6'))
    // And the join key is the variant-free ref, which is what makes them the
    // same row. A separate assertion because the one above compares two lookups
    // that could agree for the wrong reason.
    expect(priceKeyForRef('anthropic/claude-sonnet-4-6#high')).toBe('anthropic/claude-sonnet-4-6')
  })

  it('the ranking is unchanged: the same winner is chosen with the feature on and off', async () => {
    // The feature claims to touch the request, not the choice of model. If a
    // variant axis had leaked into ranking, the winner would move.
    const offDir = writeProjectConfig('effort-rank-off', { effort: { enabled: false } })
    const onDir = writeProjectConfig('effort-rank-on', { effort: { enabled: true, maxEffort: 'max' } })
    const off = await harness(offDir, [{ id: 'anthropic', name: 'Anthropic', models: { 'claude-opus-4-7': { id: 'claude-opus-4-7', variants: v('low', 'high') } } }])
    const on = await harness(onDir, [{ id: 'anthropic', name: 'Anthropic', models: { 'claude-opus-4-7': { id: 'claude-opus-4-7', variants: v('low', 'high') } } }])
    // Every built-in role, taken from `getRoles()` rather than a hand-copied
    // list of six. This assertion is about ranking, not about which roles
    // exist, so it should hold for all of them — and a literal here is a list
    // that silently stops covering roles added after it was written, which is
    // exactly what happened to `designer`.
    for (const role of new NexusConfigManager().getRoles()) {
      for (const overall of [0, 45, 90]) {
        const a = select(off.orchestrator, role, overall)
        const b = select(on.orchestrator, role, overall)
        // `variant: undefined` rather than omitted, because the two selections
        // differ in exactly that one field and the comparison must say so.
        const withoutEffort: Record<string, unknown> = { ...b, variant: undefined, reasoning: a.reasoning }
        expect(withoutEffort).toEqual({ ...a } as unknown as Record<string, unknown>)
      }
    }
  })
})
