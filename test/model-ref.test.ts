import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Model } from "@opencode/plugin"
import {
  InvalidModelRefError,
  bareModelId,
  formatModelRef,
  parseModelRef,
  priceKeyForRef,
  providerIDFromRefLoose,
  tryParseModelRef,
} from "../src/model-ref"

// ── The old implementations, kept as the ORACLE ─────────────────────
// These are the five ad-hoc parsers this change replaced, copied verbatim from
// the code as it stood at ddbceff. They are here to be COMPARED AGAINST, not
// reimplemented anywhere in src/: `test/model-ref.test.ts` is the only place
// they exist, and the guard test at the bottom greps src/ to keep it that way.
//
// A differential test like this is the honest way to show a consolidation was
// behaviour-preserving. Asserting expected strings instead would only restate
// what the new code does, and would pass just as happily on a rewrite that
// changed every answer.

/** `src/forecast.ts:162` — the "single copy" that was not. */
function oracleBareModelId(ref: string): string {
  return ref.slice(ref.indexOf("/") + 1)
}

/** `src/model-groups.ts:91` — the three-valued provider helper. */
function oracleProviderIDFromRef(ref: string): string | undefined {
  const slash = ref.indexOf("/")
  return slash > 0 ? ref.slice(0, slash) : undefined
}

/** `src/orchestrator.ts:3744` — `scoreModel`. */
function oracleScoreModel(modelId: string): { provider: string; model: string } {
  const [provider, ...parts] = modelId.split("/")
  return { provider, model: parts.join("/") }
}

/** `src/orchestrator.ts:3364` — `spawnAgent`. */
function oracleSpawnAgent(modelConfig: string): { provider: string; modelName: string } {
  const slashIndex = modelConfig.indexOf("/")
  return {
    provider: modelConfig.slice(0, slashIndex),
    modelName: modelConfig.slice(slashIndex + 1),
  }
}

/** `src/orchestrator.ts:3352` — the spawn autocomplete. */
function oracleAutocomplete(configRef: string, bareInput: string): boolean {
  return configRef.split("/")[1] === bareInput
}

// ── A corpus of references, chosen to break a parser rather than please one ──
const REFS = [
  // Ordinary refs.
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5-mini",
  "google/gemini-2.5-flash",
  "opencode/minimax-m2.5-free",
  // Two slashes. Real: OpenCode's `cloudflare-ai-gateway` Unified-API loader
  // produces these, and the `anthropic/` is part of the MODEL id.
  "openrouter/anthropic/claude-sonnet-4-5",
  "a/b/c/d",
  // Bare ids — not references at all, but held by callers throughout.
  "mystery-model",
  "claude-sonnet-4-6",
  // Malformed.
  "/leading-slash",
  "trailing/",
  "p/m#",
  "p/m#a#b",
  // Variants.
  "anthropic/claude-sonnet-4-6#high",
  "openrouter/anthropic/claude-sonnet-4-5#xhigh",
  "mystery-model#low",
  // An at-sign is NOT a variant delimiter anywhere in this repository or the
  // host, so this is a model id that does not exist. Pinned so that if someone
  // later "helpfully" adds `@` support, this fails and says why.
  "anthropic/claude-sonnet-4-6@high",
] as const

/** The variant-free refs only — the corpus the preservation claim is about. */
const VARIANT_FREE_REFS = REFS.filter((ref) => !ref.includes("#"))

/**
 * The inputs the old parsers got RIGHT: refs the host accepts, and bare ids
 * (which are not refs at all, but which this repository holds throughout).
 *
 * The behaviour-preservation claim is scoped to these. Inputs the host REJECTS
 * are excluded deliberately and their differences are asserted one by one
 * further down, so that a deliberate change and an accidental one are never
 * mistaken for each other.
 */
const WELL_FORMED = REFS.filter((ref) => tryParseModelRef(ref) !== undefined || !ref.includes("/"))

/** One comparable shape for a parser's whole answer on an input. */
type Verdict = { accepted: boolean; providerID?: string; id?: string; variant?: string }

// ── The oracle, and our own answer, in one comparable shape ──────────
// Both sides are reduced to `{ accepted, providerID, id, variant }` so a
// single `toEqual` compares the whole verdict: acceptance and every field
// together. Reducing the host's result rather than asserting against it
// directly is what lets one comparison catch a field that disagrees on a ref
// the host REJECTS, which a fields-only comparison cannot see.
const hostVerdict = (input: string): Verdict => {
  try {
    const host = Model.Ref.parse(input)
    return { accepted: true, providerID: host.providerID, id: host.id, variant: host.variant }
  } catch {
    return { accepted: false }
  }
}

const localVerdict = (input: string): Verdict => {
  const mine = tryParseModelRef(input)
  return mine
    ? { accepted: true, providerID: mine.providerID, id: mine.id, variant: mine.variant }
    : { accepted: false }
}

describe("parseModelRef", () => {
  it("splits a ref with no variant into provider and id", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-6",
      variant: undefined,
      key: "anthropic/claude-sonnet-4-6",
      ref: "anthropic/claude-sonnet-4-6",
    })
  })

  it("splits a variant off a ref, and rebuilds both spellings", () => {
    // `key` is the PRICE key and is variant-free; `ref` is the round-trippable
    // spelling. Asserting both is what pins the one place a variant is dropped.
    expect(parseModelRef("anthropic/claude-sonnet-4-6#high")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-6",
      variant: "high",
      key: "anthropic/claude-sonnet-4-6",
      ref: "anthropic/claude-sonnet-4-6#high",
    })
  })

  it("keeps a two-slash ref's tail in the MODEL id, not the provider", () => {
    // The single most consequential case: `split("/")` would report the model
    // as `claude-sonnet-4-5` and lose the `anthropic/` namespace the real
    // catalogue keys it under.
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-4-5#low")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-sonnet-4-5",
      variant: "low",
      key: "openrouter/anthropic/claude-sonnet-4-5",
      ref: "openrouter/anthropic/claude-sonnet-4-5#low",
    })
  })

  it("round-trips: parsing `ref` again yields the same thing", () => {
    for (const input of REFS) {
      const parsed = tryParseModelRef(input)
      if (!parsed) continue
      expect(parseModelRef(parsed.ref)).toEqual(parsed)
    }
  })

  describe("rejects what the host rejects, loudly", () => {
    // Each case is a real failure mode, and each must THROW rather than
    // degrade: every one of them, if accepted, becomes a request for a model
    // that does not exist, which the host answers by silently running the
    // default model.
    const REJECTED: ReadonlyArray<readonly [string, string]> = [
      ["a bare id with no provider", "claude-sonnet-4-6"],
      ["a bare id that carries a variant", "mystery-model#low"],
      ["a leading slash", "/leading-slash"],
      ["a trailing slash", "trailing/"],
      ["an empty variant", "p/m#"],
      ["a variant containing a #", "p/m#a#b"],
    ]

    for (const [what, input] of REJECTED) {
      it(what, () => {
        expect(() => parseModelRef(input)).toThrow(InvalidModelRefError)
        // tryParseModelRef is the non-throwing form and must agree that this
        // is not a reference — if these two ever disagreed, one of the callers
        // would be working from a parse the other rejects.
        expect(tryParseModelRef(input)).toBeUndefined()
      })
    }

    it("says what was wrong, and echoes the input, without the host's own wording", () => {
      // The message must not merely restate `Invalid model reference: p/m#`,
      // which is what the host throws and which names neither the input's
      // problem nor this repository's accepted forms.
      let caught: unknown
      try {
        parseModelRef("p/m#")
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(InvalidModelRefError)
      const error = caught as InvalidModelRefError
      expect(error.input).toBe("p/m#")
      expect(error.message).toContain("p/m#")
      expect(error.message).toContain("variant")
    })

    it("names a missing provider rather than reporting an empty id", () => {
      let caught: unknown
      try {
        parseModelRef("claude-sonnet-4-6")
      } catch (error) {
        caught = error
      }
      expect((caught as InvalidModelRefError).message).toContain("bare id is not a reference")
    })
  })

  describe("is pinned to the host's parser, which is the ORACLE", () => {
    // ── Why this block is load-bearing ──────────────────────────────
    // `src/model-ref.ts` does NOT import the host at runtime. It carries a
    // transcription of `Model.Ref.parse` (see `splitModelRef`) because the
    // host's entrypoint re-exports the entire schema barrel plus the Effect
    // runtime, and that import was being inlined into `dist/tui.js` through
    // `src/tui.tsx` → `src/model-groups.ts` → this module: 51 KB → 0.32 MB.
    //
    // That trade is only sound if the transcription is CHECKED, and this block
    // is the check. It runs the same inputs through the REAL
    // `Model.Ref.parse` — reached here, in a test, where nothing is bundled —
    // and asserts the two agree. If a host upgrade changes the delimiter or the
    // rejection set, this fails here, loudly, rather than silently in the TUI.
    //
    // The `@opencode/plugin` import below is therefore DELIBERATELY test-only.
    // A guard further down asserts the runtime never does this.

    it("agrees with Model.Ref.parse on acceptance AND all three fields, on every corpus ref", () => {
      // One comparison per input covering acceptance and every field together.
      // The earlier shape compared acceptance for the corpus and fields only
      // for refs BOTH sides accepted, which meant a field bug on a ref the
      // host rejected could not show up at all. Comparing the whole verdict
      // closes that hole: an input the host rejects must be rejected here too,
      // and one it accepts must produce the identical three fields.
      for (const input of REFS) {
        expect({ input, verdict: localVerdict(input) }).toEqual({ input, verdict: hostVerdict(input) })
      }
    })

    it("throws the SAME error type the host throws, for every ref the host rejects", () => {
      // Agreement on acceptance is not enough: the throwing path is where a
      // caller that catches `InvalidModelRefError` specifically would be
      // broken. If the host rejects and we do not throw, or throw something
      // else, a degraded-mode caller would mishandle it.
      for (const input of REFS.filter((ref) => hostVerdict(ref).accepted === false)) {
        expect(tryParseModelRef(input)).toBeUndefined()
        expect(() => parseModelRef(input)).toThrow(InvalidModelRefError)
      }
    })

    it("covers BOTH outcomes in the corpus, so agreement cannot be vacuous", () => {
      // A corpus where everything agreed on "invalid" would pass the test above
      // for the wrong reason. The corpus currently holds 16 refs: 9 the host
      // accepts, 7 it rejects. The floors sit one below the real counts so the
      // guard survives legitimate additions while still failing if a trim guts
      // one side of the comparison.
      const verdicts = REFS.map(hostVerdict)
      expect(verdicts.filter((v) => v.accepted).length).toBeGreaterThanOrEqual(8)
      expect(verdicts.filter((v) => !v.accepted).length).toBeGreaterThanOrEqual(6)
      // And at least one accepted ref must actually carry a variant, since the
      // variant is the half of the grammar most likely to be transcribed wrong.
      // Two do: `#high` and the two-slash `#xhigh`.
      expect(verdicts.filter((v) => v.variant !== undefined).length).toBeGreaterThanOrEqual(2)
    })

    it("covers every case the brief names, so the corpus cannot be quietly narrowed", () => {
      // Each of these is a behaviour that was previously provided by the host
      // and is now provided by the transcription. If a future edit trims the
      // corpus, this fails and says which guarantee went with it.
      const REQUIRED: ReadonlyArray<readonly [string, string]> = [
        ["no variant", "anthropic/claude-sonnet-4-6"],
        ["a variant", "anthropic/claude-sonnet-4-6#high"],
        ["a two-slash ref WITH a variant", "openrouter/anthropic/claude-sonnet-4-5#xhigh"],
        ["a bare id", "claude-sonnet-4-6"],
        ["/leading-slash", "/leading-slash"],
        ["trailing/", "trailing/"],
        ["an empty variant", "p/m#"],
        ["a variant containing a #", "p/m#a#b"],
        ["an at-sign ref", "anthropic/claude-sonnet-4-6@high"],
      ]
      for (const [what, ref] of REQUIRED) {
        expect({ what, present: (REFS as readonly string[]).includes(ref) }).toEqual({ what, present: true })
      }
    })

    it("agrees on a generated corpus, not only on the hand-picked one", () => {
      // The hand-written corpus is only as good as the author's imagination.
      // This builds inputs combinatorially from the pieces the grammar cares
      // about — empty and non-empty provider, 0/1/2 slashes, `#` before and
      // after the first slash, empty and repeated variants, `@` — and compares
      // the two parsers on all of them. Deterministic, so a failure is
      // reproducible and a weakening of the grammar shows up as a diff on a
      // specific input rather than as a philosophical worry.
      const parts = ["", "p", "m", "#", "a", "@", "/"]
      const inputs: string[] = []
      for (const head of parts) {
        for (const tail of parts) {
          inputs.push(head + tail)
          inputs.push(`${head}/${tail}`)
          inputs.push(`${head}/m#${tail}`)
          inputs.push(`p/${head}#${tail}`)
        }
      }
      // Deduplicate, and confirm the generated corpus is worth the comparison.
      const unique = [...new Set(inputs)]
      expect(unique.length).toBeGreaterThanOrEqual(100)
      const disagreements: string[] = []
      for (const input of unique) {
        const ours = localVerdict(input)
        const host = hostVerdict(input)
        if (JSON.stringify(ours) !== JSON.stringify(host)) disagreements.push(`${JSON.stringify(input)}: ${JSON.stringify(ours)} vs ${JSON.stringify(host)}`)
      }
      expect(disagreements).toEqual([])
      // Both outcomes must actually occur here too, or the sweep proves nothing.
      expect(unique.filter((i) => hostVerdict(i).accepted).length).toBeGreaterThanOrEqual(10)
      expect(unique.filter((i) => !hostVerdict(i).accepted).length).toBeGreaterThanOrEqual(10)
    })

    it("names the reason for every rejection, and the reasons are distinguishable", () => {
      // The reason is OUR text, not the host's (`Invalid model reference: <in>`,
      // which only echoes the input), so nothing checks it against the oracle —
      // but it is the part a user reads when a model ref is wrong, and the
      // ladder has four distinct branches. If a branch's wording drifts into
      // another branch's, the message starts describing a different input than
      // the one that was rejected, which is the failure mode this module's
      // single ladder exists to prevent. So: each input must produce its own
      // reason, naming the actual problem.
      const REASONS: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
        // providerEnd <= 0: no slash, or the slash is at position 0.
        ["claude-sonnet-4-6", [/bare id is not a reference/]],
        ["/leading-slash", [/bare id is not a reference/]],
        // Empty model id: the slash is immediately followed by `#` or by the
        // end of the string.
        ["trailing/", [/model id is empty/]],
        ["p/#high", [/model id is empty/]],
        // A `#` in the provider half — a distinct branch from an empty id, and
        // the one mutation testing shows a corpus entry alone does not pin.
        ["p#x/m", [/provider must not contain/]],
        // Variant problems. These two share their wording in the host's ladder
        // and must be told apart by the variant VALUE that is echoed back, so
        // that is what each case asserts.
        ["p/m#", [/must be non-empty/, /variant ""/]],
        ["p/m#a#b", [/must not contain/, /variant "a#b"/]],
      ]
      for (const [input, expected] of REASONS) {
        // Each must be a rejection in the first place, or the reason is fiction.
        expect(hostVerdict(input).accepted).toBe(false)
        let caught: unknown
        try {
          parseModelRef(input)
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(InvalidModelRefError)
        const message = (caught as InvalidModelRefError).message
        for (const pattern of expected) {
          expect({ input, pattern: String(pattern), matches: pattern.test(message) }).toEqual({ input, pattern: String(pattern), matches: true })
        }
        // And it must name the input, so the message is actionable on its own.
        expect(message).toContain(input)
      }
      // Distinct problems must not share wording, or the reason is decoration.
      const messages = REASONS.map(([input]) => {
        try {
          parseModelRef(input)
          return "DID NOT THROW"
        } catch (error) {
          return (error as InvalidModelRefError).message
        }
      })
      expect(new Set(messages).size).toBe(REASONS.length)
    })

    it("uses a HASH, and an at-sign is not one", () => {
      // `p/m@v1` is not rejected — it is accepted as the model id `m@v1`,
      // because nothing anywhere looks for `@`. Saying so out loud is the
      // documentation; if a future change adds `@` support this test says so.
      expect(parseModelRef("p/m@v1").id).toBe("m@v1")
      expect(parseModelRef("p/m@v1").variant).toBeUndefined()
      // ...and the id it produces names a model that does not exist, which is
      // precisely why the delimiter has to be a hash.
      expect(parseModelRef("p/m@v1").key).toBe("p/m@v1")
      expect(tryParseModelRef("p/m@v1")).not.toBeUndefined()
    })
  })
})

describe("formatModelRef", () => {
  it("adds the # only when there is a variant", () => {
    expect(formatModelRef({ providerID: "p", id: "m" })).toBe("p/m")
    expect(formatModelRef({ providerID: "p", id: "m", variant: undefined })).toBe("p/m")
    expect(formatModelRef({ providerID: "p", id: "m", variant: "" })).toBe("p/m")
    expect(formatModelRef({ providerID: "p", id: "m", variant: "high" })).toBe("p/m#high")
  })

  it("keeps a two-slash id intact", () => {
    expect(formatModelRef({ providerID: "openrouter", id: "anthropic/x", variant: "low" })).toBe("openrouter/anthropic/x#low")
  })
})

describe("tryParseModelRef — three-way, and the three ways are distinguished", () => {
  it("answers a valid ref with the ref", () => {
    expect(tryParseModelRef("p/m#high")?.variant).toBe("high")
  })

  it("answers a bare id with undefined, because a bare id is not a reference", () => {
    expect(tryParseModelRef("claude-sonnet-4-6")).toBeUndefined()
  })

  it("answers a malformed ref with undefined", () => {
    expect(tryParseModelRef("p/m#")).toBeUndefined()
  })
})

describe("bareModelId", () => {
  it("is the historical slice for every well-formed variant-free ref, differentially", () => {
    for (const ref of WELL_FORMED.filter((r) => !r.includes("#"))) {
      expect({ ref, id: bareModelId(ref) }).toEqual({ ref, id: oracleBareModelId(ref) })
    }
    // Stated as a count so an empty filter cannot make the loop above vacuous.
    expect(WELL_FORMED.filter((r) => !r.includes("#")).length).toBeGreaterThanOrEqual(8)
  })

  it("strips a variant, which the old slice could not", () => {
    // The oracle is shown here too, to make the difference visible rather than
    // asserted: the old answer names a model that does not exist.
    expect({ ref: "p/m#high", old: oracleBareModelId("p/m#high"), now: bareModelId("p/m#high") })
      .toEqual({ ref: "p/m#high", old: "m#high", now: "m" })
  })

  it("differs from the old slice on exactly the refs the host rejects", () => {
    // Every one of these is a case where the old slice produced a model id that
    // no catalogue holds, or a silently truncated one. The new answer is the
    // whole input, which matches no model and so degrades to the labelled
    // `unknown-model` guess rather than to a WRONG model. Pinned one at a time
    // so a deliberate change and an accidental one cannot be confused.
    const DELIBERATE: ReadonlyArray<readonly [string, string, string]> = [
      ["/leading-slash", "leading-slash", "/leading-slash"],
      ["trailing/", "", "trailing/"],
      ["p/m#", "m#", "p/m"],
    ]
    for (const [ref, oldId, newId] of DELIBERATE) {
      expect({ ref, old: oracleBareModelId(ref), now: bareModelId(ref) }).toEqual({ ref, old: oldId, now: newId })
    }
    // And nothing outside that list changed: the two sets are the same set.
    const rejected = REFS.filter((ref) => tryParseModelRef(ref) === undefined && ref.includes("/"))
    expect(rejected).toEqual(["/leading-slash", "trailing/", "p/m#", "p/m#a#b"])
  })

  it("never throws, whatever it is given", () => {
    for (const ref of REFS) {
      expect(() => bareModelId(ref)).not.toThrow()
    }
  })

  it("returns a bare id unchanged", () => {
    expect(bareModelId("mystery-model")).toBe("mystery-model")
  })
})

describe("providerIDFromRefLoose — the three-valued answer is preserved exactly", () => {
  it("matches the old model-groups implementation on every corpus ref", () => {
    for (const ref of REFS) {
      expect({ ref, provider: providerIDFromRefLoose(ref) }).toEqual({ ref, provider: oracleProviderIDFromRef(ref) })
    }
  })

  it("answers a bare id with undefined, NOT a fabricated provider", () => {
    // Load-bearing: the TUI picker, the `model.costs` tool and the dashboard all
    // keep "no provider" as an explicit ungrouped bucket.
    expect(providerIDFromRefLoose("claude-sonnet-4-6")).toBeUndefined()
    // And specifically not the `slice(0, -1)` answer the comment warns about.
    expect(providerIDFromRefLoose("claude-sonnet-4-6")).not.toBe("claude-sonnet-4-")
  })

  it("takes the FIRST slash of a two-slash ref, never the second", () => {
    expect(providerIDFromRefLoose("openrouter/anthropic/claude-sonnet-4-5")).toBe("openrouter")
  })

  it("reports the provider of a variant-bearing ref", () => {
    expect(providerIDFromRefLoose("p/m#high")).toBe("p")
  })
})

describe("priceKeyForRef", () => {
  it("is the identity on a variant-free ref, so getModelCost changes nothing", () => {
    // The old `getModelCost` step 1 was `modelCosts.get(model)` — the input
    // verbatim, whatever it was. `priceKeyForRef` must therefore be the
    // identity on EVERY variant-free input, including the malformed ones, or
    // that first lookup changes what it finds. No corpus filter here: the
    // property is unconditional.
    for (const ref of VARIANT_FREE_REFS) {
      expect({ ref, key: priceKeyForRef(ref) }).toEqual({ ref, key: ref })
    }
    expect(VARIANT_FREE_REFS.length).toBeGreaterThanOrEqual(9)
  })

  it("leaves the bare-id sweep key alone for every well-formed ref", () => {
    // Step 3 of the old lookup swept `modelCosts` on `bareModelId(model)`; the
    // new sweep uses the new `bareModelId`, already pinned identical above.
    for (const ref of WELL_FORMED.filter((r) => !r.includes("#"))) {
      expect({ ref, bare: bareModelId(ref) }).toEqual({ ref, bare: oracleBareModelId(ref) })
    }
  })

  it("drops the variant so a variant-bearing ref joins the price table", () => {
    expect(priceKeyForRef("p/m#high")).toBe("p/m")
    expect(priceKeyForRef("openrouter/anthropic/x#low")).toBe("openrouter/anthropic/x")
  })

  it("keeps a # that is not acting as the variant delimiter", () => {
    // A `#` before the first `/` cannot be the delimiter — a provider half is
    // not allowed to contain one — so it belongs to the model name.
    expect(priceKeyForRef("org#team/model#high")).toBe("org#team/model")
  })
})

describe("the consolidation — every old parser is gone from src/", () => {
  // A sixth ad-hoc parser appearing is the actual risk this change leaves
  // behind, so the guard is a grep. Each pattern below is one of the five
  // implementations replaced, quoted from the code at ddbceff.
  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp, string]> = [
    ["bareModelId", /ref\.slice\(ref\.indexOf\(['"]\/['"]\)\s*\+\s*1\)/, "forecast.ts:162"],
    ["providerIDFromRef", /slash\s*>\s*0\s*\?\s*\w+\.slice\(0,\s*slash\)/, "model-groups.ts:91"],
    ["scoreModel", /const\s*\[\s*provider\s*,\s*\.\.\.\s*\w+\s*\]\s*=/, "orchestrator.ts:3744"],
    ["spawnAgent", /slashIndex\s*=\s*\w+\.indexOf\(['"]\/['"]\)/, "orchestrator.ts:3364"],
    ["spawn autocomplete", /\?\.\s*split\(['"]\/['"]\)\[1\]/, "orchestrator.ts:3352"],
  ]

  const SRC_DIR = resolve(import.meta.dir, "../src")
  const srcFiles = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  const sourceText = (file: string): string => readFileSync(resolve(SRC_DIR, file), "utf8")
  /**
   * `src/model-ref.ts` is the sanctioned home of the ref grammar, so it is
   * exempt from the "the old pattern is gone" greps — and checked separately,
   * one pattern at a time, immediately below. Exempting it silently would make
   * the greps decorative; exempting it with a pinned count keeps the exemption
   * itself falsifiable.
   */
  const CALLERS = srcFiles.filter((f) => f !== "model-ref.ts")

  it("found the source files to scan, so the guard is not vacuous", () => {
    // A grep guard over zero files passes for the wrong reason. This is the
    // assertion that makes the guards below mean something.
    expect(srcFiles.length).toBeGreaterThan(5)
    expect(CALLERS.length).toBe(srcFiles.length - 1)
    expect(CALLERS).toContain("orchestrator.ts")
    expect(CALLERS).toContain("forecast.ts")
  })

  for (const [name, pattern, wasAt] of FORBIDDEN) {
    it(`no caller parses a ref the way ${name} did (was ${wasAt})`, () => {
      const offenders = CALLERS.filter((file) => pattern.test(sourceText(file)))
      expect({ pattern: String(pattern), offenders }).toEqual({ pattern: String(pattern), offenders: [] })
    })
  }

  it("holds exactly one copy of the oracle-preserving provider slice, and says why", () => {
    // `providerIDFromRefLoose` deliberately keeps the old slice for the inputs
    // the host rejects, because `test/dashboard-model-groups.test.ts` pins its
    // answers against a page that carries its own copy. One occurrence, in the
    // one file allowed to have it.
    const occurrences = sourceText("model-ref.ts").match(/slash > 0 \?/g) ?? []
    expect(occurrences.length).toBe(1)
  })

  it("and every ref-shaped key in src/ is built by a shared helper", () => {
    // The other half of the risk: a template literal that REBUILDS a ref from
    // provider and model is how the variant got dropped in one place and kept
    // in another. All of them now go through `modelSpendKey`/`modelLabelKey`.
    const offenders = CALLERS.filter((file) => /\$\{\w+\.model\.provider\}\/\$\{\w+\.model\.model\}/.test(sourceText(file)))
    expect(offenders).toEqual([])
  })
})

/**
 * The bundle guard: the reason the host's parser is not called at runtime.
 *
 * A grep over `src/` is not enough here, because the thing that regressed was
 * not a direct import in one file — it was a transitive one. `src/tui.tsx`
 * imports `src/model-groups.ts`, which re-exports from `src/model-ref.ts`, so a
 * single `import { Model } from "@opencode/plugin"` reached the TUI bundle, and
 * the TUI build externalises only the OpenTUI and Solid packages. So this
 * builds the real bundle with the real flags and measures the result, which is
 * the property that actually regressed.
 */
describe("the TUI bundle does not carry the host's schema barrel", () => {
  /** The exact flags `package.json`'s `build:tui` script uses. */
  const TUI_EXTERNALS = ["@opentui/solid", "solid-js", "@opentui/core"]

  const buildTui = async (): Promise<{ bytes: number; text: string }> => {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/tui.tsx")],
      target: "bun",
      external: TUI_EXTERNALS,
    })
    expect(result.success).toBe(true)
    expect(result.outputs).toHaveLength(1)
    const output = result.outputs[0]
    if (!output) throw new Error("bun build produced no output for src/tui.tsx")
    return { bytes: output.size, text: await output.text() }
  }

  it("builds at all, and emits a real bundle rather than a stub", async () => {
    // A build that silently emitted nothing — or emitted something truncated —
    // would make every size check below pass for the wrong reason. `> 1000`
    // bounds almost nothing: the actual bundle is ~77 KB, and the regression
    // this file exists to catch is 316 KB. A floor of 60 KB is still far below
    // the real figure and far above "the bundler gave up halfway", so a
    // truncated or stubbed build fails LOUDLY here instead of quietly
    // satisfying the ceiling two lines down.
    const { bytes, text } = await buildTui()
    expect(bytes).toBeGreaterThan(60 * 1024)
    expect(text.length).toBeGreaterThan(60 * 1024)
    // Both the same fact read two ways: a bundler that reports a size but emits
    // different bytes is a broken build, and only one of the two would notice.
    expect(text.length).toBe(bytes)
  })

  it("stays small — the barrel cost 265 KB and would blow straight past this", async () => {
    // Measured: 51,180 B without the host's parser; 316,113 B with it, because
    // `@opencode/plugin`'s entrypoint re-exports the whole schema barrel plus
    // the Effect runtime. 96 KB leaves generous room for real TUI work while
    // staying an order of magnitude below the regression.
    const { bytes } = await buildTui()
    expect(bytes).toBeLessThan(96 * 1024)
  })

  it("contains none of the host's own parser, by name", async () => {
    // The size bound alone would be satisfied by a future host upgrade that
    // happened to trim the barrel while still shipping a DIFFERENT grammar.
    // These markers are strings that exist only in `@opencode/schema`'s
    // `model.js`, so their absence proves the host's code is not in the bundle
    // at all — which is what lets the local parser be the single runtime one.
    const { text } = await buildTui()
    for (const marker of ["Invalid model reference", "Model.Ref", "Provider.ID.make", "@opencode/schema"]) {
      expect({ marker, present: text.includes(marker) }).toEqual({ marker, present: false })
    }
  })

  it("keeps the host's parser reachable from the test oracle that checks it", async () => {
    // The flip side. If this module ever stopped importing the host, the
    // differential test above would be comparing the local parser against
    // itself and would pass forever while proving nothing. Pinning the test's
    // own import means the guarantee cannot be lost silently.
    const testText = readFileSync(resolve(import.meta.dir, "model-ref.test.ts"), "utf8")
    expect(testText).toMatch(/import \{ Model \} from "@opencode\/plugin"/)
    expect(hostVerdict("p/m").accepted).toBe(true)
    expect(hostVerdict("p/m#").accepted).toBe(false)
  })
})
