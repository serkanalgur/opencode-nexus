import { bareModelId } from "./forecast"

/**
 * Provider grouping and price display for a model picker.
 *
 * Shared by every surface that has to show a list of models: the TUI picker
 * (`src/tui.tsx`, which holds `ModelInfo` objects) and the `model.costs` tool
 * (`src/index.ts`, which holds only `"provider/id"` strings). The two see the
 * same catalogue through different lenses, so the rules that decide *what a
 * provider is called* and *what a price looks like* live here once, and each
 * surface reaches them through the path its data allows:
 *
 *  - from objects: `providerLabels(providers)(model.providerID)`.
 *  - from a ref:   `providerIDFromRef(ref)` then the same resolver, or
 *                  `modelIDFromRef(ref)` for the bare id.
 *
 * Nothing here selects, prices, ranks or bills anything. It is presentation
 * only; `trackCost`'s provenance requirements and every cost figure the
 * orchestrator computes are untouched by this module.
 *
 * ── Why the provider is never split out of a ref ─────────────────────
 * `providerID` and `id` are SEPARATE fields on `ModelInfo`, so the object path
 * reads them and never parses. The ref path exists only for callers that have
 * nothing but a string, and it is a `slice` on the FIRST slash — never
 * `split("/")`, which is the only way to get a two-slash ref wrong. Such refs
 * are real: `openrouter/anthropic/claude-sonnet-4-5` arrives through
 * OpenCode's `cloudflare-ai-gateway` Unified-API loader, and `split("/")` would
 * report the provider as `openrouter` and the model as `claude-sonnet-4-5`,
 * losing the `anthropic/` namespace that the real catalogue keys it under.
 */

// ── Structural slices of the host types ─────────────────────────────
// Declared here rather than imported from `@opencode/client`, which is not a
// dependency of this package (see the same convention at `src/tui.tsx:31-45`).
// Every real `ModelInfo` / `ModelCost` / `ProviderInfo` is assignable to these.

/**
 * The `ModelInfo` fields grouping and pricing read.
 *
 * `name`, `cost` and `status` are optional because the data crosses a wire and
 * models genuinely arrive without them; `providerID` and `id` are not, because
 * there is no model without them and a caller holding neither cannot build a
 * ref at all.
 */
export interface GroupedModel {
  readonly providerID: string
  readonly id: string
  readonly name?: string
  /** USD per MILLION tokens, in the host's own unit. See `ModelCost`. */
  readonly cost?: readonly ModelCostRow[]
}

/**
 * One entry of `ModelInfo.cost`.
 *
 * `tier` is `{ type: "context", size }` where `size` is the prompt size ABOVE
 * which these rates apply — so a tiered list has no row covering small prompts
 * unless it also carries an untiered base row. That is the case the display
 * below exists to get right.
 */
export interface ModelCostRow {
  readonly tier?: { readonly type: string; readonly size: number }
  readonly input?: number
  readonly output?: number
  readonly cache?: { readonly read?: number; readonly write?: number }
}

/**
 * The `ProviderInfo` field grouping reads.
 *
 * `name` is optional even though the host types it as required: it is the human
 * label from models.dev, and a provider whose name is missing must degrade to
 * the raw id rather than become an unlabelled group (see `providerLabels`).
 */
export interface ProviderLabelSource {
  readonly id: string
  readonly name?: string
}

// ── Ref helpers ──────────────────────────────────────────────────────

/**
 * The provider half of a `"provider/id"` ref, or `undefined` for a bare id.
 *
 * `undefined` is a real answer and not a failure: a bare id names a model with
 * no provider at all, so there is nothing to group it under and inventing a
 * provider for it would be a guess. `slice(0, -1)` on a slashless ref would
 * silently chop the last character, hence the explicit guard.
 *
 * Re-exported from `src/model-ref.ts` — the single copy of the ref grammar —
 * with its three-valued behaviour intact. It cannot be
 * `tryParseModelRef(...)?.providerID`, because the host's grammar rejects a
 * bare id outright and this function's whole job is to answer about one.
 */
export { providerIDFromRefLoose as providerIDFromRef } from "./model-ref"

/**
 * The model half of a ref, bare id returned unchanged.
 *
 * Delegates rather than reimplementing: the ref grammar lives in
 * `src/model-ref.ts` (re-exported through `forecast.ts`), and the string
 * surface and the object surface have to agree on what the tail of a ref
 * means. A second copy would be free to drift from the pricing path, which
 * resolves bare ids the same way — which is precisely what happened here.
 */
export function modelIDFromRef(ref: string): string {
  return bareModelId(ref)
}

/** The `"provider/id"` string a model is submitted and priced under. */
export function modelRef(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

// ── Provider naming ──────────────────────────────────────────────────

/**
 * Builds a provider-id → display-name lookup, and returns it as a resolver.
 *
 * The resolver takes `string | undefined` and returns `string | undefined`:
 *
 *  - a known provider  → its human label (`opencode-go` → `OpenCode Go`);
 *  - an unknown id     → the raw id, so a model whose provider is not in
 *                        `ProviderInfo` still gets a header, just an ugly one;
 *  - `undefined`      → `undefined`, i.e. no group. A bare model id has no
 *                        provider, and `undefined` is what lets the caller tell
 *                        that apart from "provider exists, name unknown".
 *
 * A provider whose `name` is missing, empty or not a string is SKIPPED from the
 * map entirely rather than stored as `""`. It would be indistinguishable from
 * absent at the point of use, and an empty name is worse than absent: the host
 * groups on `category ?? ""`, so an empty-string label lands in the same
 * keyless group an uncategorised row gets, and the caller loses the ability to
 * choose a label. Skipping makes the raw-id fallback the single path for
 * "provider we could not name".
 *
 * Two providers sharing one display name merge into one header. That is a
 * visual merge only — every model keeps its own distinct `value`, so a
 * selection is still unambiguous — and the alternative, disambiguating a
 * provider's own name, is a guess about a label this code did not author.
 */
export function providerLabels(
  providers: readonly ProviderLabelSource[] | undefined
): (providerID: string | undefined) => string | undefined {
  const names = new Map<string, string>()
  for (const provider of providers ?? []) {
    if (!provider || typeof provider.id !== "string") continue
    const name = provider.name
    if (typeof name !== "string" || name.length === 0) continue
    // First writer wins, so the order of `ProviderInfo` decides nothing but
    // stability: two entries with the same id and different names are not a
    // case worth guessing at.
    if (!names.has(provider.id)) names.set(provider.id, name)
  }
  return (providerID) => {
    if (typeof providerID !== "string" || providerID.length === 0) return undefined
    return names.get(providerID) ?? providerID
  }
}

// ── Price display ────────────────────────────────────────────────────

/** One USD-per-million rate → the per-1K string both surfaces print. */
function per1k(perMillion: number | undefined): string {
  return `$${((perMillion ?? 0) / 1000).toString()}/1K tokens`
}

/**
 * A context tier's threshold, or `undefined` for a row that is not one.
 *
 * A row qualifies as a base when it is untiered, is not a context tier, or
 * carries a non-numeric `size` — the last because every comparison against a
 * `NaN` size is false, so such a tier is permanently unselectable and treating
 * it as a base is what keeps it from silently becoming the price of a
 * sub-threshold prompt. This mirrors `NexusOrchestrator.normaliseTiers`, which
 * makes the same call for the same reason; see that method for the full
 * argument, and note the two must be changed together.
 */
function thresholdOf(row: ModelCostRow): number | undefined {
  if (row.tier?.type !== "context") return undefined
  return typeof row.tier.size === "number" ? row.tier.size : undefined
}

/**
 * The rates a prompt BELOW every published context tier is billed at, plus the
 * threshold at which those rates stop applying.
 *
 * This is display-only re-derivation of a rule the orchestrator owns
 * (`normaliseTiers` + `forecast.selectTier(tiers, 0)`), done here because the
 * TUI has no orchestrator instance to ask and `normaliseTiers` is private to
 * one. The arithmetic is deliberately trivial — pick a row, format two numbers —
 * so there is nothing here to drift, but the SELECTION rules are load-bearing
 * and are restated:
 *
 *  - Non-context tiers are dropped, matching `normaliseTiers`: OpenCode's own
 *    cost function never consults them, so keeping one here would show a price
 *    the bill never applies.
 *  - The untiered row is the base. When there is none — a model that publishes
 *    ONLY context tiers — the base is SYNTHETIC: the lowest-threshold tier's
 *    own rates. OpenCode's own fallback in that case is zero, i.e. "this model
 *    bills nothing", which is the one answer that cannot be right for a model
 *    that published prices. This mirrors `normaliseTiers`; the residual risk it
 *    records (the synthetic base is the lowest *published* rate, so it
 *    under-reports if the provider's true sub-threshold price is higher) is
 *    inherited here and is why the caller is told, in the returned text, that
 *    no base price was published.
 *  - The threshold reported is the LOWEST one, i.e. the prompt size at which
 *    the displayed rate stops applying and a tier takes over.
 */
function baseRow(
  cost: readonly ModelCostRow[]
): { row: ModelCostRow; lowestThreshold: number | undefined; hasBase: boolean } | undefined {
  const kept = cost.filter(row => row?.tier === undefined || row?.tier?.type === "context")
  if (kept.length === 0) return undefined

  const contextual = kept
    .filter(row => thresholdOf(row) !== undefined)
    .sort((a, b) => (thresholdOf(a) as number) - (thresholdOf(b) as number))
  const lowestThreshold = contextual.length > 0 ? (thresholdOf(contextual[0]) as number) : undefined
  const base = kept.find(row => thresholdOf(row) === undefined)

  return {
    // A synthetic base COPIES the lowest tier's rates rather than aliasing
    // them, so a caller cannot reprice one by mutating the other.
    row: base ?? { ...contextual[0] },
    lowestThreshold,
    hasBase: base !== undefined
  }
}

/**
 * The price column for one model, in the `model.costs` tool's own format.
 *
 * The per-1K unit and the `in=` / `out=` labels are the SAME strings
 * `renderTiers` prints (`src/index.ts`), so the picker and the tool cannot
 * disagree about what a number means. `renderTiers` cannot be reused directly
 * — it is a local binding inside one tool's `execute` closure — so the format
 * is mirrored here rather than imported; if one side changes, both must.
 *
 * Cache rates are omitted even though `renderTiers` prints them. The four-rate
 * form is correct for a terminal report and unreadable in a list column, and
 * dropping two terms changes width, not unit or labels.
 *
 * Returns `undefined` when the model published NO price at all — an absent or
 * empty `cost` array. That is deliberately not `$0`: OpenCode does bill an
 * empty `cost` array at a hard zero, but `$0` here would assert "this model
 * bills nothing" about a model whose provider simply did not publish a price,
 * which is the false-zero the `model.costs` tool already refuses to print. No
 * price is not the same as free, and only one of them may look like `$0`.
 */
export function formatModelPrice(cost: readonly ModelCostRow[] | undefined): string | undefined {
  if (!Array.isArray(cost) || cost.length === 0) return undefined
  const base = baseRow(cost)
  if (!base) return undefined

  const price = `in=${per1k(base.row.input)}, out=${per1k(base.row.output)}`
  if (base.lowestThreshold === undefined) return price

  // Both arms name a number, so a tiered model can never read as free or
  // blank. The second arm additionally says the displayed rate is not a
  // published sub-threshold price but the lowest tier's own — the honest
  // rendering of a model that publishes tiers and nothing else, which is the
  // case a naive implementation renders as free.
  return base.hasBase
    ? `${price} (tiered above ${base.lowestThreshold} prompt tokens)`
    : `${price} (lowest tier, above ${base.lowestThreshold} prompt tokens — no base price)`
}
