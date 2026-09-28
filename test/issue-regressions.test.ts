import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { blankNonCode, matchBrace } from './helpers/dashboard-page'

/**
 * Regressions for three fixes, locked in one file.
 *
 *   #87  duplicate `editor.add` registrations silently overwrote one another.
 *   #86  docs/API.md said `saveProjectConfig` writes "all four" blocks when
 *        `getSaveableConfig()` has written eight for some time.
 *   #89  `RetryPolicy` was a type nothing implemented, and `analyzeComplexity`
 *        carried a 15-point `'medium'` risk arm no producer could reach.
 *
 * WHY THESE ARE SOURCE-PARSING TESTS RATHER THAN BEHAVIOURAL ONES
 *
 * All three fixes removed something that is invisible at the boundary. A
 * duplicate tool registration does not throw: the second `editor.add` wins, and
 * the first tool's `execute` is simply never called. A stale word in a
 * markdown file is prose. An unreachable branch in a score is arithmetic that
 * never runs. So there is no call to make and no return value to assert — the
 * only honest place to observe them is the artefact itself.
 *
 * The parsing is done over `blankNonCode(source, true)`, which blanks comments
 * AND string literals while preserving every index, so a body is located by its
 * real braces and a `name` is read back out of the ORIGINAL text at the offset
 * the blanked copy found. That is what stops a commented-out registration from
 * being counted as a live one — which is exactly the state #87 was fixed from,
 * and exactly the state an accidental revert would put it back into.
 */

const REPO = join(import.meta.dir, '..')
const SRC = join(REPO, 'src')

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir = SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (entry.endsWith('.ts')) found.push(full)
  }
  return found
}

/** Repo-relative path, so a failure message names a file a reader can open. */
function rel(file: string): string {
  return file.slice(REPO.length + 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// #87 — no tool is registered twice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every tool `src/index.ts` registers, as the names OpenCode will see.
 *
 * The namespace comes from the `editor.namespace({ … })` call rather than being
 * assumed, so a second namespace added later is picked up instead of being
 * silently merged into `nexus` and compared against the wrong README rows.
 */
function registeredTools(): string[] {
  const raw = readFileSync(join(SRC, 'index.ts'), 'utf-8')
  const code = blankNonCode(raw, true)
  const full: string[] = []

  // The namespace in effect at each offset. Only one is declared today; the
  // walk is here so that a second one is accounted for rather than assumed away.
  // The opening quote is NOT part of the pattern: on the blanked copy it has
  // been replaced by a space, so a pattern that expects it would find no
  // namespace at all and every tool would come out with an empty one.
  const namespaces: { at: number; name: string }[] = []
  for (const m of code.matchAll(/editor\.namespace\(\{\s*name:/g)) {
    const name = /^editor\.namespace\(\{\s*name:\s*"([^"]+)"/.exec(raw.slice(m.index))?.[1]
    if (name) namespaces.push({ at: m.index, name })
    else throw new Error(`editor.namespace at offset ${m.index} in src/index.ts has no name`)
  }
  expect(namespaces.length).toBeGreaterThan(0)
  const namespaceAt = (offset: number): string => {
    let current = namespaces[0]?.name
    for (const ns of namespaces) if (ns.at <= offset) current = ns.name
    return current ?? ''
  }

  for (const m of code.matchAll(/editor\.add\(\{/g)) {
    const name = /name:\s*"([^"]+)"/.exec(raw.slice(m.index))?.[1]
    if (!name) throw new Error(`editor.add at offset ${m.index} in src/index.ts has no name`)
    full.push(`${namespaceAt(m.index)}.${name}`)
  }
  return full
}

/**
 * The rows of README.md's Tools table, as the fully-qualified names they claim.
 *
 * Scoped to the `## Tools` section so a `| \`nexus.something\` |` line in prose
 * or in another table cannot be mistaken for a registered tool, and to the
 * table's first column only so a description mentioning a tool name is not
 * counted twice.
 */
function readmeToolNames(): string[] {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf-8')
  const section = readme.slice(readme.indexOf('\n## Tools'))
  expect(section.length).toBeGreaterThan(0)
  const end = section.indexOf('\n## ', 1)
  const table = end === -1 ? section : section.slice(0, end)
  return [...table.matchAll(/^\| `(nexus\.[A-Za-z0-9._]+)` \|/gm)].map(m => m[1]!)
}

describe('#87 — every tool is registered exactly once', () => {
  it('registers no name twice', () => {
    const names = registeredTools()
    // Sanity: the parse found the registrations it is supposed to find. Without
    // this, a regex that silently matched nothing would make every assertion
    // below pass by proving nothing.
    expect(names.length).toBeGreaterThan(20)

    // Counted rather than de-duplicated by a Set, because the assertion is
    // about the REPEATS: `new Set(names)` would answer a different question
    // (which names exist) and would stay quiet on a duplicate.
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    const duplicates = [...counts].filter(([, n]) => n > 1).map(([name]) => name)
    expect(duplicates).toEqual([])
    // Stated separately so the intent survives: the count and the set are the
    // same statement, and a duplicate is the only way they disagree.
    expect(counts.size).toBe(names.length)
  })

  it('registers the goal tools once each, which is the pair #87 was about', () => {
    const goals = registeredTools().filter(n => n.startsWith('nexus.goal.'))
    expect(goals.sort()).toEqual([
      'nexus.goal.complete',
      'nexus.goal.list',
      'nexus.goal.set',
      'nexus.goal.status',
    ])
  })

  it('agrees with the README tool table 1:1, in both directions', () => {
    const code = registeredTools()
    const readme = readmeToolNames()

    // Both directions, and as explicit name lists rather than a count. A count
    // comparison passes when a tool is renamed on one side only — the number
    // still matches, and the tool is gone from one of the two places a user
    // reads.
    expect(code.filter(n => !readme.includes(n)).sort()).toEqual([])
    expect(readme.filter(n => !code.includes(n)).sort()).toEqual([])
    expect(readme.length).toBe(code.length)
  })
})

/**
 * The tool rows of TECHNICAL_DESIGN.md §8.2, as bare names.
 *
 * §8.2 documents the tools by their literal `editor.add()` `name` values, which
 * are unprefixed — the plugin is in the `nexus` namespace, so the registered
 * name is `status`, not `nexus_status`. Stripping the namespace off
 * `registeredTools()` is therefore the comparison that matches what the table
 * claims to be listing, rather than the fully-qualified form README uses.
 *
 * Scoped to the §8.2 heading so a tool named in §8 prose, or in a parameters
 * table elsewhere in the document, is not counted as a row.
 */
function designDocToolNames(): string[] {
  const doc = readFileSync(join(REPO, 'TECHNICAL_DESIGN.md'), 'utf-8')
  const start = doc.indexOf('### 8.2 Tool Registration')
  expect(start).toBeGreaterThan(-1)
  const end = doc.indexOf('### 8.3', start)
  const section = end === -1 ? doc.slice(start) : doc.slice(start, end)
  return [...section.matchAll(/^\| `([A-Za-z0-9._]+)` \|/gm)].map(m => m[1]!)
}

describe('TECHNICAL_DESIGN.md §8.2 — the tool table tracks the registry', () => {
  // The document was written before the tools existed and listed ten of them
  // under `nexus_*` names, three of which were never implemented. README is
  // already pinned to the registry by the test above; this closes the same
  // drift on the second table, which is the one a reader following §8 lands on.
  it('agrees with the registered tools 1:1, in both directions', () => {
    const registered = registeredTools().map(n => n.replace(/^nexus\./, ''))
    const documented = designDocToolNames()

    expect(registered.length).toBeGreaterThan(20)
    expect(registered.filter(n => !documented.includes(n)).sort()).toEqual([])
    expect(documented.filter(n => !registered.includes(n)).sort()).toEqual([])
    expect(documented.length).toBe(registered.length)
  })

  // The specific failure this document had: names under a `nexus_` prefix that
  // the registry never used. A test on counts alone would pass on this.
  it('documents unprefixed names, not the old `nexus_` spelling', () => {
    const documented = designDocToolNames()
    expect(documented.filter(n => n.startsWith('nexus_'))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #86 — the config block count, and the docs that state it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The blocks `getSaveableConfig()` writes, read out of the method body.
 *
 * Located by the method's own signature and closed by brace matching, so
 * `result.X = …` lines anywhere else in `src/config.ts` — and there are many,
 * in the preset and storage-merge paths — cannot be counted into this list.
 */
function saveableConfigBlocks(): string[] {
  const raw = readFileSync(join(SRC, 'config.ts'), 'utf-8')
  const code = blankNonCode(raw, true)
  // The DEFINITION, not the first mention. `src/config.ts` mentions
  // `getSaveableConfig()` in doc comments and at its two call sites long before
  // the declaration, and brace-matching from a mention lands in an unrelated
  // body — which is a silently wrong answer, not a loud one. The signature is
  // what distinguishes the declaration from the calls.
  const decl = /private\s+getSaveableConfig\s*\(/.exec(code)
  expect(decl).not.toBeNull()
  const open = code.indexOf('{', decl!.index)
  // Shared with the dashboard-page tests rather than open-coded a second time:
  // it throws on an unbalanced body, which is the same failure this file had to
  // hand-roll a sentinel `-1` and a second throw for.
  const close = matchBrace(code, open)
  return [...code.slice(open, close).matchAll(/\bresult\.(\w+)\s*=/g)].map(m => m[1]!)
}

/** The English number words this file can state, indexed by count. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'] as const

/**
 * The English number word for a small count, so the expectation is not magic.
 *
 * Throws rather than returning `undefined` for a count past the table: the
 * caller compares this word against words scraped out of prose, so an
 * out-of-range count would make the comparison vacuously true instead of wrong.
 */
function numberWord(n: number): string {
  const word: string | undefined = NUMBER_WORDS[n]
  if (word === undefined) throw new Error(`no number word for ${n} — extend NUMBER_WORDS and blockCountMentions' regex`)
  return word
}

/** docs/API.md's config-schema code fence, parsed to its top-level keys. */
function apiSchemaKeys(): string[] {
  const api = readFileSync(join(REPO, 'docs', 'API.md'), 'utf-8')
  const at = api.indexOf('#### The config file schema')
  expect(at).toBeGreaterThan(-1)
  const fence = /```jsonc?\n([\s\S]*?)```/.exec(api.slice(at))
  if (!fence) throw new Error('the config schema section in docs/API.md has no code fence')
  // The example carries a `/* … */` elision and the TRAILING COMMA that elision
  // leaves behind — `"coder": "provider/model", /* ... */ },` — which JSONC
  // allows and `JSON.parse` does not. Removing the trailing commas is the
  // obvious fix and is a trap: it is a regex, and it also eats a comma inside a
  // string value. So the top-level keys are read by a character walk that
  // tracks string state and depth itself, on a comments-blanked copy (`false`
  // — blanking the string literals too would erase the keys it is looking for,
  // quotes and all).
  const text = blankNonCode(fence[1]!, false)
  const keys: string[] = []
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      // A quoted name at depth 1 followed by a colon is a key. The `:` may sit
      // after whitespace, which is why the lookahead rather than the next
      // character is what is tested.
      const close = text.indexOf('"', i + 1)
      if (depth === 1 && close !== -1 && /^\s*:/.test(text.slice(close + 1))) {
        keys.push(text.slice(i + 1, close))
      }
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return keys
}

/**
 * The `NexusConfig` fields whose value is an inline object — the ones a reader
 * would call "blocks" — as opposed to the plain scalars beside them.
 *
 * Read from the source at the top level of the interface body only, so a nested
 * `{ … }` belonging to some inner field is not mistaken for a block of its own.
 */
function nexusConfigBlocks(): string[] {
  const code = blankNonCode(readFileSync(join(SRC, 'types.ts'), 'utf-8'), false)
  const decl = /export\s+interface\s+NexusConfig\s*\{/.exec(code)
  expect(decl).not.toBeNull()
  const open = code.indexOf('{', decl!.index)
  const close = matchBrace(code, open)
  return [...code.slice(open, close).matchAll(/^ {2}(\w+)\??:\s*\{/gm)].map(m => m[1]!)
}

/** The backticked names in the "not in this schema" sentence of docs/API.md. */
function apiConstructorOnlyBlocks(): string[] {
  const api = readFileSync(join(REPO, 'docs', 'API.md'), 'utf-8')
  const at = api.indexOf('that are **not** in this schema')
  expect(at).toBeGreaterThan(-1)
  // The sentence runs to the first `—` AFTER the em dash that opens the list,
  // which is the only delimiter in it that is not a backtick or a word.
  const rest = api.slice(at)
  const open = rest.indexOf('—')
  const close = rest.indexOf('—', open + 1)
  expect(close).toBeGreaterThan(-1)
  return [...rest.slice(open, close).matchAll(/`(\w+)`/g)].map(m => m[1]!)
}

/**
 * Every count word in a docs/API.md paragraph that is talking about config
 * BLOCKS, as `[paragraph, word]`.
 *
 * Scoped to paragraphs that mention "block" on purpose. The document also says
 * "all four precedence levels", and a number word in that sentence is a true
 * statement about something this test knows nothing about.
 *
 * KNOWN LIMITS, stated rather than hidden. The alternation is bounded at
 * "twelve" (and by the lookahead, which only fires before "block"/"blocks" or a
 * comma), so a count phrased some other way — "eight of the blocks", a numeral
 * "8 blocks" — is not matched at all and this sweep misses it silently. The
 * guard in the caller (`NUMBER_WORDS.length > blocks.length`) catches the
 * out-of-range direction; nothing here catches a differently-PHRASED in-range
 * count, and the `mentions.length >= 2` floor is what keeps that honest.
 */
function blockCountMentions(): { paragraph: string; word: string }[] {
  const api = readFileSync(join(REPO, 'docs', 'API.md'), 'utf-8')
  const out: { paragraph: string; word: string }[] = []
  for (const paragraph of api.split(/\n\s*\n/)) {
    if (!/\bblocks?\b/i.test(paragraph)) continue
    for (const m of paragraph.matchAll(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=\s+blocks?\b|,)/gi,
    )) {
      out.push({ paragraph, word: m[1]!.toLowerCase() })
    }
  }
  return out
}

describe('#86 — the config block count is stated once, correctly, and follows the code', () => {
  it('writes every block NexusFullConfig models, and the docs list the same ones', async () => {
    const blocks = saveableConfigBlocks()
    expect([...blocks].sort()).toEqual([
      'budget', 'customRoles', 'dashboard', 'effort', 'gitFlow', 'models', 'notifications', 'selfHealing',
    ])

    // The same answer, from the RUNTIME rather than from the source text, so the
    // parse above cannot drift into describing a method that does something
    // else. `saveProjectConfig` writes this return value as the whole file.
    const { NexusConfigManager } = await import('../src/config')
    const dir = mkdtempSync(join(tmpdir(), 'nexus-issue86-'))
    new NexusConfigManager({ enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined)
      .saveProjectConfig(dir)
    const written = JSON.parse(
      readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8').replace(/^\/\/[^\n]*\n/gm, ''),
    ) as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual([...blocks].sort())

    // And the documented schema is that same set — not a subset, which is the
    // shape #86 had (four of eight documented, four undocumented).
    expect(apiSchemaKeys().sort()).toEqual([...blocks].sort())
  })

  it('says the same number in words wherever docs/API.md counts the blocks', () => {
    const blocks = saveableConfigBlocks()
    const word = numberWord(blocks.length)
    // `numberWord` throws past twelve, but `blockCountMentions`'s alternation
    // would simply stop MATCHING — a thirteenth block would then make the
    // `mentions.length >= 2` guard below fail, which is the intended signal but
    // a confusing one. Assert the range explicitly, against the same table, so
    // the failure says which of the two has to be extended.
    expect(NUMBER_WORDS.length).toBeGreaterThan(blocks.length)
    const mentions = blockCountMentions()

    // At least two places count them (the schema paragraph and saveGlobalConfig).
    // A vacuous version of this test — "every number word it finds is right" —
    // would pass on a document that had stopped counting altogether.
    expect(mentions.length).toBeGreaterThanOrEqual(2)
    expect(mentions.map(m => m.word)).toEqual(mentions.map(() => word))

    // The prose enumerates the blocks too, and it is the sentence carrying the
    // number word, so it is checked here rather than only in the code fence.
    const counting = mentions.map(m => m.paragraph)
    const namesOut = counting.find(p => p.includes(`all ${word}`))
    expect(namesOut).toBeDefined()
    for (const block of blocks) {
      expect(namesOut).toContain(`\`${block}\``)
    }
  })

  it('names the constructor-only blocks the TYPE has, not ones it lost', () => {
    // The complement sentence — the blocks `NexusConfig` has and the schema
    // does not — was wrong in both directions at once: it listed `memory`,
    // `security` and `communication`, which no longer exist on the type at all,
    // and omitted `agents`, `learning` and `cost`, which do. Both halves are
    // asserted off the source rather than restated, so the doc cannot agree
    // with itself while disagreeing with `src/types.ts`.
    const expected = nexusConfigBlocks().filter(b => !saveableConfigBlocks().includes(b)).sort()
    expect(apiConstructorOnlyBlocks().sort()).toEqual(expected)

    // And the named ones really are gone from the type, so the doc is not
    // listing a block the source happens to still carry.
    const blocks = nexusConfigBlocks()
    for (const gone of ['memory', 'security', 'communication']) {
      expect({ gone, onType: blocks.includes(gone) }).toEqual({ gone, onType: false })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #89 — no dead RetryPolicy, no unreachable medium risk arm
// ─────────────────────────────────────────────────────────────────────────────

describe('#89 — RetryPolicy is gone rather than merely unused', () => {
  it('names RetryPolicy nowhere in the shipped code', () => {
    const hits: string[] = []
    for (const file of sourceFiles()) {
      const code = blankNonCode(readFileSync(file, 'utf-8'), false)
      for (const m of code.matchAll(/\bRetryPolicy\b|\bretryPolicy\b/g)) {
        hits.push(`${rel(file)}: ${m[0]}`)
      }
    }
    // Comments are blanked but strings are not, so a doc comment explaining why
    // it was removed cannot fail this — only a live identifier can.
    expect(hits).toEqual([])
  })

  it('confirms the sweep is real, so an emptied src/ cannot pass it vacuously', () => {
    // The negative assertion above is only worth anything if the search space
    // is the real one. Pinned here: the code still declares `Task` in
    // `src/types.ts` and still has plenty of files to sweep.
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(10)
    const types = blankNonCode(readFileSync(join(SRC, 'types.ts'), 'utf-8'), false)
    expect(types).toContain('export interface Task {')
    // `Task` keeps its optional `timeout`; the sibling that followed it is the
    // one that went.
    expect(types).toMatch(/^\s*timeout\?: number$/m)
  })

  it('names retryPolicy in no doc either, so src/ and the docs agree', () => {
    // The docs are read as WRITTEN, comments and all: a design sketch that
    // still shows `retryPolicy?: RetryPolicy` is a reader being told the field
    // exists, and that is the same defect as the type having carried it. So
    // this is a plain textual sweep of the shipped markdown — the one place
    // where "documented on purpose" is not an acceptable escape hatch.
    //
    // The search space is enumerated rather than globbed so that a doc added
    // under a new top-level directory is a visible omission here, not a silent
    // hole in the sweep. `docs/` is read flat, which is a limit and not a
    // claim of depth: a nested `docs/x/y.md` would be missed.
    const files = [
      join(REPO, 'README.md'),
      join(REPO, 'TECHNICAL_DESIGN.md'),
      ...readdirSync(join(REPO, 'docs')).map(n => join(REPO, 'docs', n)),
    ]
    const docs: string[] = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      if (/\bretryPolicy\b/.test(readFileSync(file, 'utf-8'))) docs.push(rel(file))
    }
    expect(docs.sort()).toEqual([])
  })
})

const { NexusOrchestrator } = await import('../src/orchestrator')

/**
 * `analyzeComplexity` is a pure function of its `task` — it reads nothing off
 * `this` — so it is called off the prototype with a null receiver rather than
 * by standing up an orchestrator. Standing one up would make these assertions
 * depend on constructor wiring that has nothing to do with the score, and a
 * dependency that can fail for unrelated reasons is a test that goes red for
 * the wrong reason.
 */
function complexityOf(task: {
  description: string
  files: { include: string[] }
  dependencies: string[]
}): { overall: number; factors: { riskLevel: string } } {
  // The cast is on the ARGUMENT, not the return. `analyzeComplexity` declares a
  // full `Task` but reads three of its fields and nothing else, so building a
  // whole task per case — an id, a name, a `complexity` the method is about to
  // overwrite — would assert nothing and clutter every call. The returned
  // `riskLevel` is typed as `string` on purpose: the point of the assertions is
  // that a value outside `'low' | 'high'` fails at RUNTIME, and a narrowed type
  // would make that unreachable.
  return NexusOrchestrator.prototype.analyzeComplexity.call(
    null,
    task as unknown as Parameters<typeof NexusOrchestrator.prototype.analyzeComplexity>[0],
  ) as unknown as { overall: number; factors: { riskLevel: string } }
}

describe('#89 — analyzeComplexity produces only the two risk levels that have a producer', () => {
  it('never returns a risk level outside low/high, over every keyword in both lists', () => {
    // Every keyword each of the two loops tests for, plus the empty
    // description, plus one that hits all of them at once. If any producer of
    // 'medium' survived in either loop, one of these would surface it.
    const words = [
      'migration', 'production', 'security', 'payment', 'auth', 'crypto', 'database',
      'nothing here matches', 'SECURITY PRODUCTION payment migration auth crypto database',
    ]
    for (const word of words) {
      const score = complexityOf({
        description: word, files: { include: ['a.ts'] }, dependencies: [],
      })
      expect(['low', 'high']).toContain(score.factors.riskLevel)
    }
  })

  it('weights a high-risk task 30 points above the same task at low risk', () => {
    // The two descriptions differ only in the risk keyword, so the whole of the
    // difference is the risk term. 30 is the value with the `'medium'` arm
    // deleted: with the arm back, this delta is still 30 for these two inputs
    // (nothing produces 'medium'), which is WHY the source assertions below
    // exist as well — a delta cannot see a branch that no input reaches.
    const shape = { files: { include: ['a.ts', 'b.ts'] }, dependencies: ['x'] }
    const high = complexityOf({ ...shape, description: 'production migration' })
    const low = complexityOf({ ...shape, description: 'rename a variable' })
    expect(high.factors.riskLevel).toBe('high')
    expect(low.factors.riskLevel).toBe('low')
    expect(high.overall - low.overall).toBe(30)
  })

  it('has no medium arm and no widening cast left in the method body', () => {
    const raw = readFileSync(join(SRC, 'orchestrator.ts'), 'utf-8')
    const code = blankNonCode(raw, true)
    const at = code.indexOf('analyzeComplexity(task: Task)')
    expect(at).toBeGreaterThan(-1)
    const open = code.indexOf('{', at)
    let depth = 0
    let close = -1
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}' && --depth === 0) {
        close = i
        break
      }
    }
    const body = raw.slice(open, close!)
    // Strings KEPT here (`false`), because the assertions are about string
    // literals: `'medium'`, the declared union and the `? 30 : 0` term are
    // all quoted. Only comments are blanked, so the prose explaining the
    // removal cannot satisfy or break any of them.
    const codeOnly = blankNonCode(body, false)

    // No third risk level in the method at all. The 15-point arm and the
    // `riskLevel as 'low' | 'medium' | 'high'` cast both went in #89, and both
    // are gone from this string.
    expect(codeOnly).not.toContain("'medium'")
    expect(codeOnly).not.toMatch(/riskLevel\s+as\s/)
    // The local is declared as the two-ended union, so a third assignment is a
    // type error rather than something a reviewer has to notice.
    expect(codeOnly).toMatch(/let riskLevel: 'low' \| 'high' = 'low'/)
    expect(codeOnly).toMatch(/riskLevel === 'high' \? 30 : 0/)
  })

  it('reads riskLevel from no difficulty ladder, so the deleted arm had no other host', () => {
    // `selectQualifiedModel` is the consumer the #89 comment blames for
    // discarding a template's declared risk level. It recomputes the score
    // rather than reading `task.complexity`, and the ladder itself never looks
    // at `riskLevel` — so there is nowhere else for a 15-point arm to have been
    // living. `blankNonCode` again keeps the prose that explains this out of the
    // assertion.
    const code = blankNonCode(readFileSync(join(SRC, 'model-ref.ts'), 'utf-8'), false)
    expect(code).not.toContain('riskLevel')
  })
})
