/**
 * The ONE place a model reference is taken apart.
 *
 * ── Where the parser runs, and who checks it ───────────────────────
 * THE LOCAL PARSER IN THIS FILE IS THE SINGLE RUNTIME IMPLEMENTATION. The
 * host's own `Model.Ref.parse` is the ORACLE it is continuously checked
 * against, and it is reached ONLY from `test/model-ref.test.ts` — never from
 * `src/`.
 *
 * That direction is deliberate, and it is stronger than importing the host's
 * parser, not weaker. `@opencode/plugin`'s entrypoint re-exports the entire
 * schema barrel — `Agent`, `Command`, `Connection`, `Credential`,
 * `Integration`, `Location`, `Mcp`, `Model`, `PersistentPty`, `Provider`,
 * `Reference`, `Rpc`, `Skill`, `Vcs`, `WebSearch`, `Worktree` — plus the Effect
 * runtime, and `@opencode/schema` uses Effect too. Measured in this repo:
 *
 *   import { Model } from "@opencode/plugin"   → 147 modules, 0.27 MB
 *   import { Model } from "@opencode/schema/model" → 113 modules, 196 KB
 *   no such import                                →   1 module,  35 B
 *
 * There is no cheap version of that import; the Effect runtime dominates
 * either way. And this module is not peripheral — `src/model-groups.ts`
 * re-exports `providerIDFromRefLoose` from here, `src/tui.tsx` imports
 * `src/model-groups.ts`, and the TUI build externalises only the OpenTUI and
 * Solid packages, so the import was inlined into `dist/tui.js` and took it from
 * 51 KB to 0.32 MB. Paying 0.27 MB — a 6.3x increase — for a parser that is
 * twenty lines of string slicing was a bad trade.
 *
 * Sharing the import also only ever gave the ILLUSION of agreement: a
 * re-export cannot be wrong, so nothing was ever checked. A local parser
 * checked field-for-field against the real `Model.Ref.parse` on every test run
 * is a stronger guarantee than trusting a transitive re-export, and it costs
 * the bundle nothing. Tests are not bundled, so the oracle is free.
 *
 * ── The format ─────────────────────────────────────────────────────
 * A model reference is `providerID/modelID` or `providerID/modelID#variant`.
 * The delimiter is a HASH, and that is not a convention of ours: it is what
 * OpenCode's own `Model.Ref` schema parses, re-exported from `@opencode/schema`
 * through `@opencode/plugin` (see `dist/promise/index.d.ts`, which does
 * `export { Model } from "@opencode/schema/model"`). `splitModelRef` below is
 * a transcription of that parser — see its own comment for the exact source it
 * mirrors — so a ref that names a real model here names the same real model to
 * the host.
 *
 * An AT-SIGN is not a variant delimiter here. Nothing in this repository or in
 * the host looks for `@`, so `provider/model@high` parses as the model id
 * `"model@high"` — a model that does not exist — rather than as a variant. It is
 * not rejected either, which is why the hash is the only spelling that works.
 *
 * ── What `Model.Ref.parse` rejects, and why we care ────────────────
 * A bare id (`claude-sonnet-4-6`) throws: the host's grammar has no "no
 * provider" production, because a `Model.Ref` is defined as a provider plus an
 * id. This repository genuinely holds bare ids — a user types one into the
 * `model.costs` tool, and `modelCosts` is keyed by bare ids when a user sets
 * them by hand — so the bare-id case is handled HERE, explicitly, rather than
 * by letting the host's absence of that production leak into five call sites.
 * See `tryParseModelRef` for the three-way answer it returns.
 *
 * ── The one place a variant is deliberately dropped ────────────────
 * `ModelVariant` is `{ id, settings?, headers?, body? }` and carries NO cost;
 * `cost` lives on `Model.Info`. So a variant changes the REQUEST — in practice
 * `settings.reasoningEffort` — and not the rate. Effort moves token volume, not
 * price, and this repository already bills reasoning tokens separately and
 * disjointly from output (`priceTokens`), so once a ref resolves, the measured
 * path is already correct. That is why `ParsedModelRef.key` is variant-free:
 * it is the key the price table is joined on, and the table has no variant axis
 * to join against.
 *
 * ── And the one place a variant is chosen ────────────────────────────
 *
 * Everything above takes a reference apart. The block near the bottom goes the
 * other way: given a difficulty and the variants a model actually publishes, it
 * decides which one to ask for (`effortForDifficulty`, `reconcileEffort`), and
 * the caller in `src/orchestrator.ts` (`selectBestModel`) is the single place
 * that acts on it. It lives here rather than in a new module because a variant
 * is what these functions produce, this file is already the variant authority,
 * and `src/tui.tsx` already reaches it transitively through
 * `src/model-groups.ts` — so the ladder costs the TUI bundle nothing, which a
 * new file would have had to earn.
 */

/** A model reference taken apart, with both spellings rebuilt. */
export interface ParsedModelRef {
  /** The provider half. Never a bare id — that is not a `Model.Ref`. */
  readonly providerID: string
  /**
   * The model half, WITHOUT the variant. May itself contain slashes: a
   * two-slash ref such as `openrouter/anthropic/claude-sonnet-4-5` is real
   * (OpenCode's `cloudflare-ai-gateway` Unified-API loader produces them) and
   * its `anthropic/` namespace is part of the id, not a second provider.
   */
  readonly id: string
  /** The effort/variant after `#`, or `undefined` when the ref carries none. */
  readonly variant?: string
  /**
   * `providerID/modelID` — the VARIANT-FREE ref. This is the key `modelCosts`
   * is keyed by and the key every price lookup joins on, because
   * `ModelVariant` has no cost and a variant therefore cannot change it.
   */
  readonly key: string
  /**
   * `providerID/modelID#variant`, or the bare `key` when there is no variant.
   * This is the spelling the host parses back, so it is what a caller should
   * hand to anything that will re-parse the string (the `subagent` tool's
   * `model` argument, session titles, agent records, cost keys).
   */
  readonly ref: string
}

/**
 * Thrown for a reference the host's grammar rejects.
 *
 * A named error so callers that want to degrade can catch exactly this and
 * nothing else — an `InvalidModelRefError` means "this string is not a model
 * reference", which is a user-input fact, not an internal failure.
 */
export class InvalidModelRefError extends Error {
  override readonly name = "InvalidModelRefError"
  /** The input that was rejected, verbatim. */
  readonly input: string

  constructor(input: string, reason: string) {
    super(`Invalid model reference "${input}": ${reason}`)
    this.input = input
  }
}

/** Rebuild `providerID/modelID#variant` from parts. */
export function formatModelRef(parts: { readonly providerID: string; readonly id: string; readonly variant?: string }): string {
  const key = `${parts.providerID}/${parts.id}`
  return parts.variant ? `${key}#${parts.variant}` : key
}

/**
 * Parse a `providerID/modelID[#variant]` reference, or throw.
 *
 * This is the strict form, for the places where continuing without a correct
 * reference is worse than failing: spawning an agent, building a price key.
 * The delimiter and the rejection set are the host's, not ours — see the module
 * comment and `splitModelRef` — so anything this accepts, OpenCode accepts, and
 * vice versa, and `test/model-ref.test.ts` checks that claim against the real
 * `Model.Ref.parse` rather than taking it on trust.
 */
export function parseModelRef(input: string): ParsedModelRef {
  const split = splitModelRef(input)
  // The host's message is `Invalid model reference: <input>`, which repeats the
  // input this error already carries; the reason comes from the split itself so
  // the message says WHAT was wrong rather than only echoing what was given.
  if (!split.ok) throw new InvalidModelRefError(input, split.reason)
  const { providerID, id, variant } = split
  return {
    providerID,
    id,
    variant,
    key: `${providerID}/${id}`,
    ref: formatModelRef({ providerID, id, variant }),
  }
}

/** The outcome of `splitModelRef`: a valid ref, or why the string is not one. */
type RefSplit =
  | { readonly ok: true; readonly providerID: string; readonly id: string; readonly variant?: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The ref grammar, transcribed from the host's own parser.
 *
 * Mirrors `Model.Ref.parse`'s `statics` block in
 * `node_modules/@opencode/schema/dist/model.js` (reached at runtime through
 * `@opencode/plugin`), which reads:
 *
 * ```js
 * const providerEnd = input.indexOf("/")
 * if (providerEnd <= 0) throw ...
 * const providerID = input.slice(0, providerEnd)
 * const variantStart = input.indexOf("#", providerEnd + 1)
 * const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
 * const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
 * if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) throw ...
 * ```
 *
 * The ordering and the three rejection clauses are kept exactly as they are,
 * including the detail that the variant is searched for only AFTER the first
 * slash — so a `#` inside a provider half is not the delimiter, but does make
 * the ref invalid. Only the branded `Schema` wrappers (`Provider.ID.make` etc.)
 * are dropped: they are compile-time type constructors that pass their input
 * through untouched, so there is no runtime behaviour to reproduce.
 *
 * Acceptance and the rejection REASON come from one ladder rather than two, so
 * the error message cannot describe a different input than the one that was
 * rejected — the failure mode the old two-ladder version had to be careful
 * about. That reason is why this returns a discriminated union instead of
 * throwing and being caught: it is the only honest way to keep the decision
 * and its explanation from drifting apart.
 *
 * `test/model-ref.test.ts` runs the whole corpus through the REAL
 * `Model.Ref.parse` and asserts field-for-field agreement on both outcomes, so
 * this transcription cannot silently diverge from the host.
 */
function splitModelRef(input: string): RefSplit {
  const providerEnd = input.indexOf("/")
  if (providerEnd <= 0) {
    return { ok: false, reason: `expected "providerID/modelID", and a bare id is not a reference (got ${JSON.stringify(input)})` }
  }
  const providerID = input.slice(0, providerEnd)
  const variantStart = input.indexOf("#", providerEnd + 1)
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
  if (!id) return { ok: false, reason: `the model id is empty (got ${JSON.stringify(input)})` }
  if (providerID.includes("#")) return { ok: false, reason: `the provider must not contain "#" (got ${JSON.stringify(input)})` }
  if (variant !== undefined && (!variant || variant.includes("#"))) {
    return { ok: false, reason: `the variant must be non-empty and must not contain "#" (got ${JSON.stringify(input)}, variant ${JSON.stringify(variant)})` }
  }
  return { ok: true, providerID, id, variant }
}

/**
 * Parse a reference, or report why it is not one. Three-way on purpose:
 *
 *  - a valid ref                  → the parsed ref
 *  - a BARE id (`claude-sonnet-4-6`, `claude-sonnet-4-6#high`) → `undefined`
 *  - anything malformed           → `undefined`
 *
 * The middle case is not an error and must not be treated as the third: a bare
 * id names a real model with no provider, and the surfaces that group models by
 * provider keep it as an explicit ungrouped bucket rather than dropping the row
 * or inventing a provider for it. Callers that need to tell those two apart ask
 * `providerIDFromRef`, which is the one place that distinction is load-bearing.
 * A bare id and a malformed ref collapse to the same `undefined` here because
 * neither IS a `Model.Ref`, and the two callers that care about the difference
 * (spawning, and the price lookup) can recover it from the string.
 */
export function tryParseModelRef(input: string): ParsedModelRef | undefined {
  try {
    return parseModelRef(input)
  } catch {
    return undefined
  }
}

/**
 * The model id half of a reference, with any variant removed.
 *
 * TOTAL by design — it never throws. The price and display paths call it on
 * values that cross a wire and may be malformed, and a pricing lookup that
 * threw would be a worse failure than one that finds nothing.
 *
 * For a well-formed input this is exactly the historical "first slash, take
 * the tail" slice, so every variant-free reference that resolved before
 * resolves to the same id now; `test/model-ref.test.ts` proves that
 * differentially against the old implementation kept there as an oracle.
 *
 * The differences are confined to inputs the old slice answered wrongly:
 *   - `p/m#high` yielded `"m#high"` (no model by that name) and yields `"m"`.
 *   - an input the host rejects yields the whole string, which matches no model
 *     and so degrades to the `unknown-model` guess rather than to a WRONG model.
 *     A bare id is the one such input that is legitimate, and it is returned
 *     unchanged, because a bare id is a model name and not a reference.
 */
export function bareModelId(ref: string): string {
  const parsed = tryParseModelRef(ref)
  if (parsed) return parsed.id
  const hash = ref.indexOf("#")
  return hash === -1 ? ref : ref.slice(0, hash)
}

/**
 * The provider half of a reference, or `undefined` when it names none.
 *
 * `undefined` is a real answer, not a failure, and it is the whole point of
 * this function: the TUI picker, the `model.costs` tool and the dashboard all
 * treat "no provider" as an explicit ungrouped bucket rather than dropping the
 * row, and `test/tui-model-picker.test.ts` and
 * `test/dashboard-model-groups.test.ts` pin that a bare id never lands under a
 * fabricated provider. `slice(0, -1)` on a slashless ref would chop the last
 * character, hence the explicit `undefined`.
 *
 * Because the host's grammar has no bare-id production, this cannot be
 * `tryParseModelRef(...)?.providerID` alone — that would report `undefined` for
 * `openrouter/anthropic/x` correctly but would have nothing to say about the
 * bare ids the ungrouped bucket is built from. The fallback below therefore
 * reproduces the previous implementation's answer EXACTLY, and
 * `test/model-ref.test.ts` pins that differentially against the old code as an
 * oracle. Re-exported from `src/model-groups.ts`, which is where its callers
 * and its tests live.
 *
 * The fallback is deliberately NOT tightened. An earlier draft of this change
 * added guards so that `"trailing/"` would stop reporting a provider called
 * `trailing`, which reads like an improvement, and it broke
 * `test/dashboard-model-groups.test.ts`: the dashboard page carries its own
 * copy of this split (it cannot import it — it is HTML) and that test asserts
 * the two agree on WHERE the boundary is, with `'/leading-slash'` and
 * `'trailing/'` in the corpus for exactly that reason. Changing this function's
 * answer for a malformed ref is therefore not a local decision — it is a
 * contract with a page this change does not own. The three-valued behaviour is
 * preserved instead, and the parse above is what removes the duplication that
 * actually mattered.
 */
export function providerIDFromRefLoose(ref: string): string | undefined {
  const parsed = tryParseModelRef(ref)
  if (parsed) return parsed.providerID
  // Unchanged from the previous implementation, and load-bearing: a bare id
  // yields `undefined` here rather than a fabricated provider, and a slash at
  // position 0 does too.
  const slash = ref.indexOf("/")
  return slash > 0 ? ref.slice(0, slash) : undefined
}

// ── Choosing a variant ────────────────────────────────────────────────

/**
 * The effort levels, ordered from least to most reasoning.
 *
 * TRANSCRIBED from the host, not invented: the shipped `@opencode/client`
 * declaration gives the variant ids as a bare `Array<ModelVariant>` with no
 * enum of its own, and the effort levels observed in real published `variants`
 * arrays (`["low","medium","high","xhigh","max"]`, `["low","high","max"]`,
 * `["none","medium","high","xhigh"]`) are the vocabulary. `max` is taken from
 * the effort enum the shipped CLI's variant builder injects as
 * `settings.reasoningEffort`.
 *
 * The ORDER is the load-bearing part. `maxEffort` and the difficulty mapping
 * are both stated as ceilings over this ladder, and the whole point of a
 * ceiling over an ordered scale is that "less than" is decidable. The host
 * gives no such order, so it is asserted here and pinned by
 * `test/effort-selection.test.ts` against the literals — the test does not
 * read this tuple back, because a test that compares a function to the constant
 * it was written from verifies nothing.
 */
export const MODEL_EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One rung of {@link MODEL_EFFORT_LADDER}. */
export type ModelEffort = (typeof MODEL_EFFORT_LADDER)[number]

/** A rung's position, with `-1` for anything off the ladder. Total, never throws. */
export function effortIndex(effort: string): number {
  return (MODEL_EFFORT_LADDER as readonly string[]).indexOf(effort)
}

/** Whether a string is a published effort name. Total, never throws. */
export function isModelEffort(effort: string): effort is ModelEffort {
  return effortIndex(effort) !== -1
}

/**
 * The difficulty buckets, as `overall` cut points, LOWEST FIRST and each one
 * the INCLUSIVE upper bound of its bucket.
 *
 * The 40 and 70 boundaries are the existing ones: `scoreModel` already splits
 * its quality/cost weight at `overall > 70` and `> 40`, so the effort choice
 * and the ranking agree about where "hard" starts. A model the ranker treats
 * as quality-favoured above 70 also gets the most effort below it. The interior
 * boundaries are new; what they cost is discussed on `effortForDifficulty`.
 */
const DIFFICULTY_BUCKETS: readonly { readonly atMost: number; readonly effort: ModelEffort }[] = [
  { atMost: 20, effort: 'none' },
  { atMost: 40, effort: 'minimal' },
  { atMost: 55, effort: 'low' },
  { atMost: 70, effort: 'medium' },
  { atMost: 85, effort: 'high' },
  { atMost: 95, effort: 'xhigh' },
  { atMost: 100, effort: 'max' },
]

/**
 * The effort a task of this difficulty is CEILINGED at, from `overall` alone.
 *
 * PURE, and that is the reason it lives here rather than inside the ranker: it
 * is a total function of one number, so it can be tested across the whole
 * `0-100` range including both boundaries, and it is the same function in the
 * tests and in production rather than a re-derivation of it.
 *
 * ── Why `overall` is reused, and what that costs ────────────────────
 *
 * Reusing `analyzeComplexity`'s `overall` is right for a reason stronger than
 * cost: the number is ALREADY the orchestrator's answer to "how hard is this
 * task", and it already decides the quality/cost weight split in `scoreModel`.
 * A second difficulty signal would be a second definition of the same question
 * in the same file, and the two could disagree about the same task — which is
 * worse than either being crude.
 *
 * What it costs is real and is stated rather than hidden:
 *
 *  1. `overall` is a WEIGHTING key, not a difficulty measurement. It was tuned
 *     so that a split at 40/70 balances quality against price. Now it also
 *     chooses how much a model thinks. Those are correlated but not identical
 *     objectives, and the interior boundaries above are therefore a policy
 *     claim: "at 56 this task deserves `low`" is a decision, not a measurement.
 *     Changing the weight split to taste would silently move them.
 *  2. `codeLines` is SYNTHETIC — `fileCount * 50` at `analyzeComplexity`, with
 *     no file read — and contributes `codeLines / 10`, i.e. `fileCount * 5`, to
 *     `overall`. So a task listing more files scores higher, and half of that
 *     is a guess wearing a measurement's name. Inherited, not fixed here: the
 *     honest repair is to read the files, and a `ComplexityScore` built from
 *     real line counts is a different change with its own cost.
 *  3. `riskLevel` contributes 0, 15 or 30 — the `'medium'` arm is a real 15
 *     points in that score — but it is still unreachable, and NOT for the reason
 *     this comment used to give. It said the mapping "inherits NONE" of the
 *     `riskLevel` effect, which was the wrong reason for a right conclusion: the
 *     15-point `'medium'` arm is in the expression, so a reader who believed the
 *     comment would not see anything to change here and could reintroduce the
 *     path and the effect together. The arm is unreachable because nothing ever
 *     produces `'medium'`: `analyzeComplexity` assigns only `'low'` or `'high'`,
 *     and `src/templates.ts` DOES emit `'medium'` for template tasks — but
 *     `selectQualifiedModel` recomputes `analyzeComplexity(node.task)` rather
 *     than reading `task.complexity`, so the value on the template is discarded
 *     before it reaches a score. Two independent reasons it never lands here, and
 *     a third (`analyzeComplexity` only ever assigns the two ends) that would
 *     hold on its own. This function reads `overall` and nothing else, so
 *     difficulty here is `overall` alone, and a template task's declared risk
 *     level cannot change the effort it gets.
 *
 * The input is CLAMPED rather than trusted: a negative or >100 `overall`
 * resolves to the bottom and top buckets instead of falling off the ladder,
 * the infinities clamp to those same ends, and `NaN` — which every comparison
 * against it rejects — resolves to the bottom.
 */
export function effortForDifficulty(overall: number): ModelEffort {
  // `NaN` is the only value `Math.min`/`Math.max` cannot place, and it is the
  // dangerous one: every `<=` against it is false, so the loop below would fall
  // off the end and return the TOP rung for a task whose difficulty was never
  // computed. `NaN` resolves to the bottom instead — the conservative end, and
  // the one that cannot spend more than the user asked for.
  if (Number.isNaN(overall)) return DIFFICULTY_BUCKETS[0]!.effort
  // The infinities need no special case: `Math.max(0, Infinity)` is `Infinity`
  // and `Math.min(100, …)` makes it `100`, and likewise `-Infinity` clamps to
  // `0`. An infinite difficulty is a very hard task, not an absent one.
  const score = Math.min(100, Math.max(0, overall))
  for (const bucket of DIFFICULTY_BUCKETS) {
    if (score <= bucket.atMost) return bucket.effort
  }
  return DIFFICULTY_BUCKETS[DIFFICULTY_BUCKETS.length - 1]!.effort
}

/**
 * The variant to actually ask for: the HIGHEST published level at or below
 * `ceiling`.
 *
 * Three decisions, each argued:
 *
 *  - **Highest at or below, not nearest to.** Snapping UP to the ceiling would
 *    spend more than the difficulty asked for; snapping DOWN would leave a
 *    published `max` unused on the hardest tasks. Below is the direction that
 *    cannot burn the user's budget on a level nothing asked for, so a
 *    conservative map is the default and the ceiling is how a user asks for
 *    more.
 *  - **`undefined` when nothing qualifies is NOT "use the top".** A model
 *    publishing only `["xhigh"]` under a `low` ceiling has no legal answer, and
 *    both alternatives are claims: `xhigh` spends more than the ceiling allows,
 *    and the lowest published spends more than the ceiling allows too. `undefined`
 *    asks for no variant at all, which is the host's own default and the only
 *    answer that does not assert an effort nobody chose. The caller reports the
 *    miss rather than absorbing it.
 *  - **A published name off the ladder is compared, not rejected.** The ladder
 *    above is transcribed from observed catalogues, and a provider may publish
 *    an id this file has never heard of. Such a name carries index `-1` and is
 *    excluded BY CONSTRUCTION rather than by a guard of its own: `bestIndex`
 *    starts at `-1` and only a strictly greater index replaces it, so no
 *    off-ladder name can ever become the answer. That is deliberate — an
 *    unknown level is not a cheaper one — and it is stated here because the
 *    obvious-looking `if (index === -1) continue` would be a second copy of a
 *    rule already in force. A mutation that deletes it was run against the test
 *    suite and is an EQUIVALENT mutant, which is the evidence that the exclusion
 *    is structural and not a branch the tests happen to cover.
 *
 * `published` is the model's OWN array. An empty one means the model publishes
 * no variants at all, and `undefined` is then the only answer; the caller
 * distinguishes that from "the ceiling excluded everything" by reading the list
 * itself, and both cases are reported in `ModelSelection.reasoning`.
 */
export function reconcileEffort(ceiling: ModelEffort, published: readonly string[]): string | undefined {
  if (published.length === 0) return undefined
  const limit = effortIndex(ceiling)
  let best: string | undefined
  // Starts at -1 rather than 0, which is what excludes an off-ladder name: only
  // a strictly greater index can win, and no index is less than -1.
  let bestIndex = -1
  for (const name of published) {
    const index = effortIndex(name)
    if (index > limit || index <= bestIndex) continue
    best = name
    bestIndex = index
  }
  return best
}

/**
 * The variant-free spelling of a reference, for anything that is a PRICE key.
 *
 * Strips a trailing `#variant` from a string that is not otherwise a valid
 * reference, so a hand-typed `p/m#high` still resolves against a `modelCosts`
 * table keyed `p/m`. Purely a key normaliser: it never invents a provider or an
 * id, and it never throws.
 */
export function priceKeyForRef(ref: string): string {
  const parsed = tryParseModelRef(ref)
  if (parsed) return parsed.key
  // Same delimiter rule the host uses, so this agrees with `parseModelRef` even
  // on the inputs `parseModelRef` rejects: the variant starts at the first `#`
  // AFTER the first `/`. A `#` before the first `/` is not the delimiter — a
  // provider half is not allowed to contain one — so a model name carrying one
  // keeps it. With no `/` at all there is no provider half, so the first `#`
  // is the delimiter.
  const slash = ref.indexOf("/")
  const hash = ref.indexOf("#", slash === -1 ? 0 : slash + 1)
  return hash === -1 ? ref : ref.slice(0, hash)
}
