import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildModelOptions,
  providerNamesFor,
  USE_DEFAULT_VALUE,
  type ModelSelectOption,
} from "../src/tui"
import {
  formatModelPrice,
  modelIDFromRef,
  modelRef,
  providerIDFromRef,
  providerLabels,
  type GroupedModel,
  type ModelCostRow,
  type ProviderLabelSource,
} from "../src/model-groups"

// ── Fixtures ────────────────────────────────────────────────────────

/** A model as `model.list()` returns it, with only the fields that are read. */
function model(overrides: Partial<GroupedModel> & { providerID: string; id: string }): GroupedModel {
  return { name: overrides.id, ...overrides }
}

/** Providers as `context.data.location.provider` returns them. */
const PROVIDERS: readonly ProviderLabelSource[] = [
  { id: "opencode-go", name: "OpenCode Go" },
  { id: "anthropic", name: "Claude" },
  { id: "openrouter", name: "OpenRouter" },
]

/**
 * Every option except the trailing reset row.
 *
 * Filtered on `USE_DEFAULT_VALUE` rather than a restated `""`, so this cannot
 * quietly stop excluding the row if the sentinel changes — and so a change to the
 * sentinel is a deliberate edit here rather than a silent one.
 */
function modelRows(options: readonly ModelSelectOption[]): readonly ModelSelectOption[] {
  return options.filter(o => o.value !== USE_DEFAULT_VALUE)
}

function descriptionsFor(
  models: readonly GroupedModel[],
  providers: readonly ProviderLabelSource[] = PROVIDERS
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const option of modelRows(buildModelOptions(models, providers))) {
    out[option.value] = option.description
  }
  return out
}

// ── One option per model, and the submitted value is unchanged ──────

describe("model picker: every model is offered exactly once", () => {
  const models: readonly GroupedModel[] = [
    model({ providerID: "opencode-go", id: "space-bunny-free", name: "Space Bunny Free" }),
    model({ providerID: "opencode-go", id: "gpt-6-luna" }),
    model({ providerID: "anthropic", id: "claude-sonnet-4-6" }),
  ]

  it("emits one option per model plus the reset row", () => {
    const options = buildModelOptions(models, PROVIDERS)
    expect(options).toHaveLength(models.length + 1)
    expect(modelRows(options).map(o => o.value)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "opencode-go/gpt-6-luna",
      "opencode-go/space-bunny-free",
    ])
  })

  // The regression this guards is invisible until a spawn throws: `getModelForRole`
  // (`src/config.ts:663`) only warns on a missing prefix, and `spawnAgent`
  // (`src/orchestrator.ts:3237`) throws on the value that came out of here.
  it("keeps the value as `provider/id`, not the title and not the category", () => {
    // The value is rebuilt from the FIXTURE's own two fields, so the two sides of
    // this comparison come from different places. The line this replaced was
    // `expect(option.value).toBe(split(option.value)[0] + "/" + rest)`, which is
    // `expect(x).toBe(x)` — splitting on "/" and rejoining with "/" is the
    // identity function, so it passed for ANY value containing a slash, including
    // one built from the category. Proven by mutation: pointing `value` at
    // `category` left this assertion green. Both sides here come from the model,
    // so only a correct implementation satisfies it.
    const options = buildModelOptions(models, PROVIDERS)
    for (const m of models) {
      expect(options.find(o => o.title === (m.name || m.id))?.value).toBe(`${m.providerID}/${m.id}`)
    }
    // Every value carries at least one "/" and a non-empty provider half. These
    // have power — a value with a leading or trailing slash fails both.
    for (const option of modelRows(buildModelOptions(models, PROVIDERS))) {
      expect(option.value.startsWith("/")).toBe(false)
      expect(option.value.endsWith("/")).toBe(false)
    }
    expect(modelRows(buildModelOptions(models, PROVIDERS)).map(o => o.value))
      .toContain("opencode-go/space-bunny-free")
  })

  it("falls back to the bare id for a title, and to the name when there is one", () => {
    const options = modelRows(buildModelOptions(models, PROVIDERS))
    expect(options.find(o => o.value === "opencode-go/space-bunny-free")?.title).toBe("Space Bunny Free")
    // No `name` on the fixture for gpt-6-luna, so the id is the title.
    expect(options.find(o => o.value === "opencode-go/gpt-6-luna")?.title).toBe("gpt-6-luna")
  })

  it("returns just the reset row for an empty or missing catalogue", () => {
    expect(buildModelOptions([], PROVIDERS)).toHaveLength(1)
    expect(buildModelOptions(undefined, PROVIDERS)).toHaveLength(1)
  })
})

// ── Provider display names become the group headers ─────────────────

describe("model picker: providers become distinct categories", () => {
  const models: readonly GroupedModel[] = [
    model({ providerID: "opencode-go", id: "a" }),
    model({ providerID: "opencode-go", id: "b" }),
    model({ providerID: "anthropic", id: "c" }),
  ]

  it("uses the provider display name, so one provider yields one category", () => {
    const categories = modelRows(buildModelOptions(models, PROVIDERS)).map(o => o.category)
    expect(categories).toEqual(["Claude", "OpenCode Go", "OpenCode Go"])
    expect(new Set(categories).size).toBe(2)
  })

  it("names the header the way the host does, with no bare provider id on any row", () => {
    for (const option of modelRows(buildModelOptions(models, PROVIDERS))) {
      expect(option.category).not.toBe("opencode-go")
      expect(option.category).not.toBe("anthropic")
    }
  })

  it("falls back to the raw id when no ProviderInfo matches", () => {
    const options = modelRows(buildModelOptions(
      [model({ providerID: "some-unlisted-provider", id: "x" })],
      PROVIDERS
    ))
    expect(options[0].category).toBe("some-unlisted-provider")
  })

  // The host groups by FIRST APPEARANCE, so a provider split by another
  // provider's model would render as two "OpenCode Go" headers. This is the
  // test that makes the sort load-bearing rather than a preference.
  it("keeps every provider's models contiguous, so no header is emitted twice", () => {
    // Deliberately interleaved, in reverse alphabetical order.
    const interleaved: readonly GroupedModel[] = [
      model({ providerID: "opencode-go", id: "zebra" }),
      model({ providerID: "anthropic", id: "yak" }),
      model({ providerID: "opencode-go", id: "aardvark" }),
      model({ providerID: "anthropic", id: "bee" }),
    ]
    const categories = modelRows(buildModelOptions(interleaved, PROVIDERS)).map(o => o.category)
    expect(categories).toEqual(["Claude", "Claude", "OpenCode Go", "OpenCode Go"])

    // Each category occupies exactly one RUN, i.e. it is never left and
    // re-entered. Two categories of the same label would be two headers.
    const runs = categories.filter((c, i) => c !== categories[i - 1])
    expect(runs).toEqual(["Claude", "OpenCode Go"])
    expect(runs).toHaveLength(new Set(categories).size)
  })

  it("sorts models alphabetically within a provider", () => {
    const options = modelRows(buildModelOptions(models, PROVIDERS))
    expect(options.filter(o => o.category === "OpenCode Go").map(o => o.title)).toEqual(["a", "b"])
  })

  it("leaves a model with no provider uncategorised rather than inventing a group", () => {
    const options = modelRows(buildModelOptions(
      [{ providerID: "", id: "orphan" } as GroupedModel],
      PROVIDERS
    ))
    expect(options[0].category).toBeUndefined()
    expect(options[0].value).toBe("/orphan")
  })
})

// ── The reset row ───────────────────────────────────────────────────

describe("model picker: the Use default row", () => {
  it("exists, is selectable, and still carries the empty value setModel resets on", () => {
    const options = buildModelOptions([model({ providerID: "anthropic", id: "c" })], PROVIDERS)
    const reset = options[options.length - 1]
    expect(reset.title).toBe("Use default")
    // Pinned against the CONSTANT, not a restated `""`. A test asserting the row
    // carries `""` and a constant that happens to be `""` agree by coincidence,
    // and the agreement would survive renaming the sentinel — leaving the suite
    // green while the product submitted a value the resolver has never seen.
    expect(reset.value).toBe(USE_DEFAULT_VALUE)
    // The constant itself, so the coincidence above cannot be reintroduced by
    // editing the test alone: if the sentinel is ever given a real token, this
    // fails here with the reason visible, rather than at a spawn.
    expect(USE_DEFAULT_VALUE).toBe("")
    // Selectable: not hidden behind a `disabled` flag, and not `undefined`.
    expect("disabled" in reset).toBe(false)
    expect(reset.value).not.toBeUndefined()
  })

  it("sits in its own labelled category, last, so it never joins a provider", () => {
    const options = buildModelOptions([
      model({ providerID: "anthropic", id: "c" }),
      model({ providerID: "opencode-go", id: "d" }),
    ], PROVIDERS)
    expect(options[options.length - 1].category).toBe("Defaults")
    // No model row borrows the reset category.
    expect(options.filter(o => o.category === "Defaults")).toHaveLength(1)
  })

  it("is present even with an empty catalogue, so a role can always be reset", () => {
    expect(buildModelOptions([], PROVIDERS).some(o => o.value === USE_DEFAULT_VALUE)).toBe(true)
    expect(buildModelOptions(undefined, undefined).some(o => o.value === USE_DEFAULT_VALUE)).toBe(true)
  })
})

// ── Price rendering ─────────────────────────────────────────────────

describe("model picker: the price column", () => {
  it("renders a flat price in the model.costs tool's own per-1K format", () => {
    expect(descriptionsFor([
      model({ providerID: "anthropic", id: "flat", cost: [{ input: 3, output: 15 }] }),
    ])["anthropic/flat"]).toBe("in=$0.003/1K tokens, out=$0.015/1K tokens")
  })

  it("renders a free model as $0 on both rates, never blank and never omitted", () => {
    const price = descriptionsFor([
      model({ providerID: "opencode-go", id: "free", cost: [{ input: 0, output: 0 }] }),
    ])["opencode-go/free"]
    expect(price).toBe("in=$0/1K tokens, out=$0/1K tokens")
  })

  // The case an implementation gets wrong by rendering blank or, worse, free.
  it("renders a TIER-ONLY model at the lowest published tier, naming the threshold", () => {
    // Array order is deliberately NOT threshold order, so this also proves the
    // lowest threshold is chosen by value rather than by position.
    const price = descriptionsFor([
      model({
        providerID: "opencode-go",
        id: "gpt-6-luna",
        cost: [
          { tier: { type: "context", size: 272000 }, input: 2.5, output: 10 },
          { tier: { type: "context", size: 200000 }, input: 1.25, output: 5 },
        ],
      }),
    ])["opencode-go/gpt-6-luna"]

    expect(price).not.toBeUndefined()
    // Not blank, and not claiming free: the 200k tier's own rates are shown.
    expect(price).toContain("in=$0.00125/1K tokens")
    expect(price).toContain("out=$0.005/1K tokens")
    // The 272k tier is a higher rate and must not be shown as the base.
    expect(price).not.toContain("$0.0025")
    expect(price).toContain("200000")
    expect(price).toContain("no base price")
  })

  it("renders a base price plus its premium tier as the base, flagged as tiered", () => {
    expect(descriptionsFor([
      model({
        providerID: "anthropic",
        id: "tiered",
        cost: [
          { tier: { type: "context", size: 200000 }, input: 6, output: 30 },
          { input: 3, output: 15 },
        ],
      }),
    ])["anthropic/tiered"]).toBe(
      "in=$0.003/1K tokens, out=$0.015/1K tokens (tiered above 200000 prompt tokens)"
    )
  })

  it("omits the price for a model that published none, rather than claiming $0", () => {
    expect(descriptionsFor([
      model({ providerID: "anthropic", id: "unpriced" }),
      model({ providerID: "anthropic", id: "empty", cost: [] }),
    ])).toEqual({ "anthropic/unpriced": undefined, "anthropic/empty": undefined })
  })

  it("drops a non-context tier, matching what the cost function actually bills", () => {
    expect(formatModelPrice([
      { tier: { type: "something-else", size: 10 }, input: 999, output: 999 },
      { input: 3, output: 15 },
    ])).toBe("in=$0.003/1K tokens, out=$0.015/1K tokens")
  })

  it("agrees with the model.costs tool on the per-1K conversion", () => {
    // The same conversion `renderTiers` prints, on the same published rates.
    const rows: ModelCostRow[] = [{ input: 0.003 * 1000, output: 0.015 * 1000 }]
    expect(formatModelPrice(rows)).toContain("in=$0.003/1K tokens")
    expect(formatModelPrice(rows)).toContain("out=$0.015/1K tokens")
  })
})

// ── Hazards ─────────────────────────────────────────────────────────

describe("model picker: bare ids shared across providers stay distinct", () => {
  it("separates two providers publishing the same bare id", () => {
    // `test/model-costs.test.ts:242` already treats this as a first-class
    // hazard for pricing; the picker has the same collision to avoid.
    const options = modelRows(buildModelOptions([
      model({ providerID: "expensive", id: "shared" }),
      model({ providerID: "cheap", id: "shared" }),
    ], [{ id: "expensive", name: "Expensive" }, { id: "cheap", name: "Cheap" }]))

    expect(options).toHaveLength(2)
    expect(options.map(o => o.value).sort()).toEqual(["cheap/shared", "expensive/shared"])
    expect(options.map(o => o.category).sort()).toEqual(["Cheap", "Expensive"])
  })
})

describe("model picker: a two-slash ref is never split on `/`", () => {
  // Real shape: OpenCode's `cloudflare-ai-gateway` Unified-API loader produces
  // `openrouter/anthropic/claude-sonnet-4-5`.
  const REF = "openrouter/anthropic/claude-sonnet-4-5"

  it("reads the provider off the ModelInfo field rather than parsing the ref", () => {
    const options = modelRows(buildModelOptions([
      model({ providerID: "openrouter", id: "anthropic/claude-sonnet-4-5" }),
    ], PROVIDERS))
    expect(options[0].value).toBe(REF)
    expect(options[0].category).toBe("OpenRouter")
  })

  it("splits a ref on the first slash only, for the string-only callers", () => {
    expect(providerIDFromRef(REF)).toBe("openrouter")
    expect(modelIDFromRef(REF)).toBe("anthropic/claude-sonnet-4-5")
    expect(modelRef("openrouter", "anthropic/claude-sonnet-4-5")).toBe(REF)
  })

  it("reports no provider for a bare id, without eating its last character", () => {
    expect(providerIDFromRef("claude-sonnet-4-6")).toBeUndefined()
    expect(modelIDFromRef("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    // The guard that a bare `slice(0, indexOf("/"))` would fail.
    expect(providerIDFromRef("claude-sonnet-4-6")).not.toBe("claude-sonnet-4-")
  })
})

// ── The shared helper, driven directly ─────────────────────────────

describe("providerLabels: what a provider is called", () => {
  const label = providerLabels(PROVIDERS)

  it("prefers the display name over the id", () => {
    expect(label("opencode-go")).toBe("OpenCode Go")
    expect(label("anthropic")).toBe("Claude")
  })

  it("falls back to the raw id for a provider it has never heard of", () => {
    expect(label("brand-new")).toBe("brand-new")
  })

  it("returns undefined when there is no provider at all", () => {
    expect(label(undefined)).toBeUndefined()
    expect(label("")).toBeUndefined()
  })

  it("skips a provider with no name, so it resolves through the raw-id fallback", () => {
    const named = providerLabels([
      { id: "nameless", name: "" },
      { id: "untyped" },
      { id: "good", name: "Good" },
    ])
    expect(named("nameless")).toBe("nameless")
    expect(named("untyped")).toBe("untyped")
    expect(named("good")).toBe("Good")
  })

  it("tolerates a missing or empty provider list", () => {
    expect(providerLabels(undefined)("opencode-go")).toBe("opencode-go")
    expect(providerLabels([])("opencode-go")).toBe("opencode-go")
  })
})

// ── The wiring that feeds buildModelOptions ─────────────────────────

/**
 * `providerNamesFor` is the seam between the host's provider collection and the
 * pure function above. It had no test at all, which meant the sync round trip,
 * the per-directory memo and — most seriously — the absence of any error guard
 * were all unverified: the guard was added because `handleModelSelect` awaits
 * this BEFORE building a single option, so a throw here means the picker does
 * not open at all.
 *
 * ISOLATION IS THE MEMO'S OWN KEY. `providerNames` is module state keyed by
 * directory, so each case takes a fresh temp directory and nothing needs a reset
 * hook. Real temp dirs, not a home-relative path, because CI is `ubuntu-latest`
 * and the developer's own machine is macOS.
 */
describe("providerNamesFor: the names feeding the picker", () => {
  /** A fresh directory, so no case can read another case's memo. */
  function projectDir(): string {
    return mkdtempSync(join(tmpdir(), "nexus-picker-providers-"))
  }

  /** A `LocationCollection<ProviderInfo>` that counts its own round trips. */
  function collection(
    names: readonly ProviderLabelSource[],
    behaviour: { failSync?: boolean; syncThrows?: boolean } = {},
  ) {
    const calls = { sync: 0, list: 0 }
    return {
      calls,
      domain: {
        sync: async () => {
          calls.sync++
          if (behaviour.failSync || behaviour.syncThrows) throw new Error("sync refused")
        },
        list: () => {
          calls.list++
          return names
        },
      },
    }
  }

  it("syncs once per directory and serves later calls from the memo", async () => {
    const dir = projectDir()
    try {
      const first = collection(PROVIDERS)
      const second = collection(PROVIDERS)

      expect(await providerNamesFor({ directory: dir }, first.domain)).toEqual(PROVIDERS)
      expect(first.calls.sync).toBe(1)

      // A DIFFERENT object, same directory: served from the memo, so this
      // collection is never touched. That is the assertion with power — if the
      // memo were keyed on anything but the directory, or dropped, the sync count
      // would be 1 and not 0.
      expect(await providerNamesFor({ directory: dir }, second.domain)).toEqual(PROVIDERS)
      expect(second.calls.sync).toBe(0)
      expect(second.calls.list).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("re-syncs when the directory changes, so a moved TUI is not stale", async () => {
    const one = projectDir()
    const two = projectDir()
    try {
      const first = collection(PROVIDERS)
      const second = collection([{ id: "other", name: "Other" }])

      await providerNamesFor({ directory: one }, first.domain)
      const moved = await providerNamesFor({ directory: two }, second.domain)

      expect(second.calls.sync).toBe(1)
      // The FIRST directory's names, not the second's. Sharing one snapshot
      // across two worktrees would be a wrong label, not a missing one.
      expect(moved).toEqual([{ id: "other", name: "Other" }])
      expect(await providerNamesFor({ directory: one }, first.domain)).toEqual(PROVIDERS)
    } finally {
      rmSync(one, { recursive: true, force: true })
      rmSync(two, { recursive: true, force: true })
    }
  })

  // The finding-6 regression: no optional chaining and no try/catch at the call
  // site, so an older host without `data.location.provider`, or a `sync` that
  // rejects, threw out of `handleModelSelect` and the picker never opened. Each
  // of these must return a value instead.
  it("degrades to undefined instead of throwing, so the dialog still opens", async () => {
    const absent = projectDir()
    const throwing = projectDir()
    const absentDomain = projectDir()
    try {
      expect(await providerNamesFor({ directory: absent }, undefined)).toBeUndefined()

      const rejects = collection(PROVIDERS, { failSync: true })
      expect(await providerNamesFor({ directory: throwing }, rejects.domain)).toBeUndefined()

      // And the consequence that matters, asserted on the real consumer: raw-id
      // headings, not a blank group and not a missing model.
      const options = buildModelOptions(
        [model({ providerID: "opencode-go", id: "space-bunny-free" })],
        await providerNamesFor({ directory: absentDomain }, undefined),
      )
      expect(options[0].category).toBe("opencode-go")
      expect(options[0].value).toBe("opencode-go/space-bunny-free")
    } finally {
      for (const dir of [absent, throwing, absentDomain]) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("does not memoise a failure, so a transient rejection is not permanent", async () => {
    const dir = projectDir()
    try {
      const failing = collection(PROVIDERS, { syncThrows: true })
      expect(await providerNamesFor({ directory: dir }, failing.domain)).toBeUndefined()

      // Caching the failure would pin this directory to raw-id headings for the
      // life of the process; the next open must be free to try again.
      const recovered = collection(PROVIDERS)
      expect(await providerNamesFor({ directory: dir }, recovered.domain)).toEqual(PROVIDERS)
      expect(recovered.calls.sync).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns an empty list when the host synced nothing, and a bare id still groups", async () => {
    const dir = projectDir()
    try {
      const empty = collection([])
      expect(await providerNamesFor({ directory: dir }, empty.domain)).toEqual([])
      // An empty catalogue is a real answer, not a failure: `providerLabels`
      // turns it into raw-id headings.
      const options = buildModelOptions(
        [model({ providerID: "opencode-go", id: "space-bunny-free" })],
        await providerNamesFor({ directory: dir }, empty.domain),
      )
      expect(options[0].category).toBe("opencode-go")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
