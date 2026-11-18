/**
 * The `nexus.model.costs` report and the cost/basis renderers the status tools
 * share. Moved out of `src/index.ts` unchanged.
 */
import type { NexusModelCost } from "./orchestrator"
import { formatModelPrice, providerIDFromRef, providerLabels, type ModelCostRow, type ProviderLabelSource } from "./model-groups"
import type { CostProvenance } from "./types"
import type { PerformanceScore } from "./performance"

/**
 * Render one cost with the label that says whether it was measured or
 * predicted. Every figure a tool hands to a user or an agent goes through
 * here: a `$0.0123` and a `$0.0123` that is the forecaster's guess are the
 * same string, and the guess is the one that gets acted on.
 */
export function renderCost(cost: number, provenance: CostProvenance): string {
  return provenance.usage === 'measured'
    ? `$${cost.toFixed(4)} measured`
    : `$${cost.toFixed(4)} estimated`
}

/**
 * Render a performance score's cost coverage. `costBasis: 'none'` is stated in
 * words rather than as a zero, because the cost third of that score is an
 * absence of evidence and reads as a measurement if it is printed as a number.
 */
export function renderCostBasis(score: PerformanceScore): string {
  if (score.costBasis === 'none') {
    return 'cost unscored: 0 measured tasks, 0% of score from cost'
  }
  return `avg=$${score.avgCost.toFixed(4)} (${score.measuredTasks}/${score.totalTasks} measured)`
}

/**
 * The heading for a `modelCosts` key that names no provider.
 *
 * `setModelCosts` accepts a bare `"id"` and stores it under that key verbatim
 * (`src/orchestrator.ts`), so this bucket is a real, reachable state and not a
 * defensive branch: it holds every hand-priced model that was set without a
 * provider prefix.
 *
 * The wording states the REASON rather than inventing a category. Rejected
 * alternatives: "Ungrouped" leaks the implementation into user-facing text;
 * "Other" implies these models belong to some provider and sorts them among
 * real ones; "Unknown" asserts the provider is unknown, when the truth is that
 * there IS no provider. So the heading says both halves — no provider, and the
 * bare-id key that causes it.
 */
const UNGROUPED_HEADING = 'No provider (bare model id)'

/**
 * How many providers the all-models listing renders in full.
 *
 * The cap is on PROVIDERS, not models, and deliberately so: a group cut in half
 * is indistinguishable from a provider that publishes one model, whereas
 * dropping a whole provider is visible and is what the announcement counts.
 * Twelve covers a wide multi-provider install (the built-in providers plus a
 * gateway or two) while keeping the report readable when a user has a large
 * catalogue. The ungrouped bucket is exempt — see `renderModelCostReport`.
 */
const MODEL_COST_GROUP_CAP = 12

/**
 * The per-1K rates in `modelCosts` as the per-million rows `formatModelPrice`
 * reads.
 *
 * `modelCosts` is normalised on WRITE to USD per 1K (`normaliseTiers`), while
 * `ModelCostRow` — and therefore `formatModelPrice` — divides by 1000 to get
 * there, so the rows are scaled back UP. Handing per-1K numbers to
 * `formatModelPrice` untreated would print every price 1000x too small, e.g.
 * `$0.000003/1K tokens` for a $3/M model; that is the failure this conversion
 * exists to prevent, and the test pins the unit by asserting a $3/M model
 * renders as `$0.003/1K tokens`.
 *
 * `x * 1000 / 1000` is exact for every published price figure, so this cannot
 * introduce the 1-ULP discrepancy a lossy round trip would: a double survives
 * the round trip only when its mantissa allows it, and real rates (0.003, 0.015,
 * 0.3, 3, 15 …) all do. A pathological rate could still differ in the last
 * significant digit from the picker's own arithmetic, which is the one residual
 * risk of sharing the formatter rather than reimplementing it — and sharing it is
 * what makes the two surfaces agree in the first place.
 *
 * Cache rates are dropped rather than reconstructed: `formatModelPrice` omits
 * them (see its docstring — a four-rate line is unreadable in a list column),
 * and they remain available per-model through the `model` argument's branch.
 */
function priceRowsFor(cost: NexusModelCost): ModelCostRow[] {
  return cost.tiers.map(tier => ({
    ...(tier.threshold === undefined ? {} : { tier: { type: 'context', size: tier.threshold } }),
    input: tier.rates.input * 1000,
    output: tier.rates.output * 1000,
  }))
}

/**
 * The `modelCosts` catalogue, grouped under one heading per provider.
 *
 * This is the text-output twin of the TUI picker's grouping (`src/tui.tsx`), and
 * it is deliberately built from the SAME two helpers in `src/model-groups.ts`
 * rather than a second implementation:
 *
 *  - `providerLabels` supplies the heading. Its three-way return is what makes
 *    the bare-id case decidable: a known provider yields its display name, an
 *    unrecognised id yields the raw id (an ugly heading, but a true one), and
 *    `undefined` means there is no provider to name. Only that last case goes to
 *    the ungrouped bucket, so a bare id is never filed under a fabricated
 *    provider and never dropped.
 *  - `formatModelPrice` supplies the price text, so the picker column and this
 *    report cannot print different numbers for the same model.
 *
 * ORDERING matches the picker: providers by display name, then models by id
 * within their provider. It is load-bearing there because the host groups by
 * first appearance, and it is load-bearing here for the same underlying reason
 * — one provider must be one contiguous block, or the grouping achieves nothing.
 * The ungrouped bucket sorts FIRST, which is what the picker's own sort does
 * with uncategorised rows (`a.category ?? ""`), so the two surfaces put these
 * models in the same place; it also means the hand-priced entries are the first
 * thing read rather than the last thing scrolled past.
 *
 * `providers` is optional and every failure mode degrades to raw ids: an empty
 * list means headings read `opencode-go` rather than `OpenCode Go`, which is a
 * degraded label on correct rows. No model is ever missing and no price is ever
 * wrong, which is why the catalogue is best-effort. Its single caller passes
 * `orchestrator.getProviderList()` — the same array `getCostReport()` hands the
 * dashboard — so the tool and the page cannot disagree about a heading, and the
 * empty-list case is a host that named nothing rather than a fetch that failed
 * here. A provider the host reported with an unusable name reaches this function
 * as `{ id }` with no `name` at all, which `providerLabels` resolves through its
 * raw-id fallback: an ugly heading, never a blank one.
 */
export function renderModelCostReport(
  costs: ReadonlyMap<string, NexusModelCost> | undefined,
  providers: readonly ProviderLabelSource[] | undefined,
): string {
  if (!costs || costs.size === 0) {
    // The sibling memory tools distinguish an empty store from a filtered one,
    // and so does this: a populated report opens with a heading and rows, so
    // "no pricing data loaded" cannot be read as "here is your pricing".
    return 'No real pricing data loaded. Using labelled fallback estimates.'
  }

  const label = providerLabels(providers)
  const groups = new Map<string, { models: { id: string; text: string }[] }>()
  const ungrouped: { id: string; text: string }[] = []

  for (const [ref, cost] of costs) {
    const heading = label(providerIDFromRef(ref))
    // `formatModelPrice` returns undefined only for a model that published NO
    // price at all. `loadModelCosts` skips those and `setModelCosts` always
    // writes one tier, so this needs the public mutable map to reach — but the
    // row is still printed, labelled. A blank line would read as "no price"
    // indistinguishably from a rendering failure, and `$0` would assert the
    // model is free, which is the false zero this tool already refuses to print.
    const price = formatModelPrice(priceRowsFor(cost)) ?? 'no published price'

    if (heading === undefined) {
      ungrouped.push({ id: ref, text: price })
      continue
    }
    const group = groups.get(heading) ?? { models: [] }
    group.models.push({ id: ref, text: price })
    groups.set(heading, group)
  }

  // Two providers sharing a display name merge into one heading, which is what
  // `providerLabels` documents. The model lists concatenate, so no model is
  // lost by the merge; the sort below is stable enough for a price list, where
  // a tie between same-named providers' models carries no meaning.
  type ModelRow = { id: string; text: string }
  type Group = [heading: string, models: ModelRow[]]
  const byModelId = (a: ModelRow, b: ModelRow) => a.id.localeCompare(b.id)
  const ordered: Group[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, group]): Group => [name, group.models.sort(byModelId)])
  ungrouped.sort(byModelId)

  const shown = ordered.slice(0, MODEL_COST_GROUP_CAP)
  const hidden = ordered.slice(MODEL_COST_GROUP_CAP)
  const countModels = (entries: readonly Group[]) =>
    entries.reduce((sum, [, models]) => sum + models.length, 0)

  const lines = ['📊 Model Pricing (from OpenCode, per 1K tokens):', '']

  // The ungrouped bucket is rendered in full and exempt from the cap: these are
  // hand-priced entries the user most likely just set, and a half-rendered
  // bucket is the one truncation that would hide a price someone is looking for.
  if (ungrouped.length > 0) {
    lines.push(UNGROUPED_HEADING)
    for (const { id, text } of ungrouped) lines.push(`  ${id}: ${text}`)
    lines.push('')
  }

  for (const [name, models] of shown) {
    lines.push(name)
    for (const { id, text } of models) lines.push(`  ${id}: ${text}`)
    lines.push('')
  }

  if (hidden.length > 0) {
    // Announced, never silent: a cap that hides rows without saying so
    // satisfies the cap while defeating the point of it. Both units are given,
    // because the truncation unit is providers while the reader counts models,
    // and the bare-id bucket is counted as its own group so the totals add up.
    // `src/memory-recall.ts` uses the same `showing N of M` form.
    const ungroupedGroup = ungrouped.length > 0 ? 1 : 0
    const totalGroups = ordered.length + ungroupedGroup
    const shownGroups = shown.length + ungroupedGroup
    const totalModels = countModels(ordered) + ungrouped.length
    const shownModels = countModels(shown) + ungrouped.length
    lines.push(
      `(showing ${shownGroups} of ${totalGroups} groups, ${shownModels} of ${totalModels} models` +
      ` — ${totalGroups - shownGroups} group(s) and ${totalModels - shownModels} model(s) not listed)`
    )
  }

  return lines.join('\n').trimEnd()
}
