import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_RECALL_ENTRIES,
  RECALL_HEADING,
  candidateKeys,
  fileKey,
  isAutoInjectableKey,
  relativeAge,
  renderRecall,
  recallForTask,
  type MemoryReader,
  type RecalledNote,
} from '../src/memory-recall'
import { PersistentMemoryStore } from '../src/memory-store'
import type { MemoryEntry, MemoryScope } from '../src/types'

/**
 * Automatic memory retrieval: what fires, what does not, and what the injected
 * text is allowed to look like.
 *
 * THE STORE IS REAL, NOT A MOCK, throughout. Retrieval's whole contract is
 * about which ROWS come back and in what order, and a hand-written
 * `MemoryReader` double would let a broken `ORDER BY` pass by returning what
 * the test expected. A real `PersistentMemoryStore` in a real temp directory is
 * the only thing that tests the thing that can actually be wrong.
 *
 * The temp directory is `mkdtemp` under the OS temp dir, never a path relative
 * to the repo or to `$HOME`. CI runs on `ubuntu-latest` while this was written
 * on macOS, and a home-relative path in a test is exactly how a suite passes
 * locally and fails there — or worse, writes to a developer's real store.
 */

let TEST_DIR: string
let DB_PATH: string
let store: PersistentMemoryStore

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'nexus-memory-recall-'))
  DB_PATH = join(TEST_DIR, 'memory.db')
  store = new PersistentMemoryStore({ dbPath: DB_PATH, maxEntries: 1000 })
})

afterEach(() => {
  try { store.close() } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

function write(input: {
  key: string
  value?: unknown
  scope?: MemoryScope
  author?: string
  confidence?: number | null
}): MemoryEntry {
  return store.set({
    key: input.key,
    value: input.value ?? `about ${input.key}`,
    scope: input.scope ?? 'project',
    author: input.author ?? 'alice',
    confidence: input.confidence === undefined ? null : input.confidence,
    tags: [],
  })
}

/** The reader retrieval actually goes through — the real store, narrowed. */
function reader(): MemoryReader {
  return store
}

describe('the retrieval key', () => {
  it('is the file path, under one fixed prefix', () => {
    expect(fileKey('src/memory-store.ts')).toBe('file:src/memory-store.ts')
  })

  it('normalises the two spellings that are the same file', () => {
    // A task listing `./src/a.ts` and a note naming `src/a.ts` is a formatting
    // accident, not a different subject, and a miss here is a silent miss.
    expect(fileKey('./src/a.ts')).toBe(fileKey('src/a.ts'))
    expect(fileKey('src\\a.ts')).toBe(fileKey('src/a.ts'))
  })

  it('does NOT normalise case or `..`, because those change which file is meant', () => {
    // Silently folding these would make a note fire against a file its writer
    // did not name, which is the one failure the key convention exists to
    // prevent.
    expect(fileKey('src/A.ts')).not.toBe(fileKey('src/a.ts'))
    expect(fileKey('../src/a.ts')).not.toBe(fileKey('src/a.ts'))
  })

  it('accepts only `file:<path>` as automatically injectable', () => {
    expect(isAutoInjectableKey('file:src/a.ts')).toBe(true)
    expect(isAutoInjectableKey('role:coder')).toBe(false)
    expect(isAutoInjectableKey('notes')).toBe(false)
    // A bare prefix is not a key: `file:` with nothing after it would match
    // every task, which is the "becomes instruction by accumulation" outcome.
    expect(isAutoInjectableKey('file:')).toBe(false)
  })

  it('reads file paths out of freeform task text, for the path that has no Task', () => {
    // `nexus.spawn` passes a STRING. There is no `files.include` to read on
    // that path, so the paths in the prose are the only file signal there is.
    //
    // FIVE CASES PLUS A NEGATIVE, not one case, and that is load-bearing. The
    // pattern's leading branch is `(?:^|[chars]|\[)` rather than one merged
    // character class, because an unescaped `[` inside a class makes the whole
    // regex match NOTHING: no throw, no warning, an empty result on every task,
    // and the tool path silently stops retrieving while every other test still
    // passes. A one-case version of this test can be satisfied by a pattern that
    // only ever handles a leading space.
    const cases: ReadonlyArray<readonly [string, string[]]> = [
      ['fix the bug in src/auth/jwt.ts please', ['file:src/auth/jwt.ts']],
      // `./` is stripped by `normalizePath`, so a task writing `./src/a/b.ts`
      // and a note naming `src/a/b.ts` are the same subject.
      ['(see ./src/a/b.ts)', ['file:src/a/b.ts']],
      ['x src/c.ts, done', ['file:src/c.ts']],
      ['array src/foo.test.ts] end', ['file:src/foo.test.ts']],
      ['[src/d.ts]', ['file:src/d.ts']],
    ]
    for (const [text, expected] of cases) {
      expect(candidateKeys({ files: [], text })).toEqual(expected)
    }
    // The negative, so a pattern that matches everything is caught too.
    expect(candidateKeys({ files: [], text: 'no path here' })).toEqual([])
  })
})

describe('a retrieval that genuinely matches, and one that genuinely does not', () => {
  // THESE TWO ARE PAIRED IN ONE FILE ON PURPOSE. A match test on its own is
  // passed by `return "always inject something"`, and a non-match test on its
  // own is passed by a stub that always returns null. Together they pin the
  // behaviour, and the negative half asserts on the ABSENCE OF THE HEADING in
  // the final text rather than on an empty array — an implementation that
  // returns an empty-but-present block passes the array assertion and fails the
  // heading one, which is the defect it is here to catch.

  it('injects the note whose key names a file the task is scoped to', () => {
    write({ key: 'file:src/memory-store.ts', value: 'set() appends, it does not upsert', author: 'alice' })
    const outcome = recallForTask(reader(), { files: ['src/memory-store.ts'], text: 'tidy the store' })
    expect(outcome.block).toContain('set() appends, it does not upsert')
    expect(outcome.block).toContain('alice')
    expect(outcome.shown).toBe(1)
  })

  it('injects nothing, and says nothing, for a task touching no named file', () => {
    write({ key: 'file:src/memory-store.ts', value: 'set() appends, it does not upsert' })
    write({ key: 'file:src/git-flow.ts', value: 'detection is memoised' })
    const outcome = recallForTask(reader(), {
      files: ['src/unrelated.ts'],
      // No distinctive word shared with either key either, so this is a genuine
      // miss rather than a lucky one.
      text: 'zqx unrelated work',
    })
    expect(outcome.block).toBeNull()
    expect(outcome.matched).toBe(0)
    expect(outcome.shown).toBe(0)
    expect(outcome.characters).toBe(0)
  })

  it('keeps the heading out of the prompt entirely on a miss', () => {
    write({ key: 'file:src/a.ts', value: 'a note' })
    const outcome = recallForTask(reader(), { files: ['src/b.ts'], text: 'qzx nothing shared' })
    // Asserted on the assembled text a caller would concatenate, not on the
    // return value's shape: a caller that appended an empty string plus a
    // heading would pass a null-check and fail this.
    const composed = `role prompt${outcome.block ? `\n\n${outcome.block}` : ''}`
    expect(composed).not.toContain(RECALL_HEADING)
  })

  it('is inert on an empty store, which is the shipped default', () => {
    // The honest cold start. With nothing written, EVERY task gets null, and
    // that is the feature working rather than broken.
    const outcome = recallForTask(reader(), { files: ['src/anything.ts'], text: 'anything' })
    expect(outcome).toEqual({ block: null, matched: 0, shown: 0, characters: 0 })
  })
})

describe('a session entry cannot leak into an injected block', () => {
  // TWO INDEPENDENT HALVES, because the exclusion has two independent
  // barriers, and each half proves one of them works ALONE.
  //
  //   HALF 1: the scope allowlist. The entry's KEY is one that would match
  //   exactly, so if the key convention were the only thing keeping it out this
  //   test would fail — which is what proves the allowlist is load-bearing and
  //   not decorative.
  //
  //   HALF 2: never reading a value. A session entry is `collectContext(agent)`,
  //   which copies the failing agent's own memory entries into the blob it
  //   stores. So one agent's blob carries another agent's content, and a value
  //   match can reach it. This half puts a project note's text INSIDE a session
  //   entry and asserts the text does not surface.

  it('HALF 1 — a session entry whose key WOULD match is still excluded', () => {
    write({ key: 'file:src/memory-store.ts', scope: 'session', value: 'agent A2 failed twice' })
    const outcome = recallForTask(reader(), { files: ['src/memory-store.ts'], text: 'anything' })
    expect(outcome.block).toBeNull()
  })

  it('HALF 2 — a project note carried inside a session blob does not surface', () => {
    write({ key: 'file:src/cfg.ts', scope: 'session', value: {
      previousAgentId: 'agent-2',
      // The exact text of a real project note, as `collectContext` would carry
      // it in its `memoryEntries` field.
      memoryEntries: [{ key: 'file:src/cfg.ts', value: 'THE-UNIQUE-PROJECT-NOTE-MARKER' }],
    }, author: 'agent-2' })
    const outcome = recallForTask(reader(), { files: ['src/cfg.ts'], text: 'anything' })
    // A retrieval that matched VALUES would find the marker here.
    expect(outcome.block ?? '').not.toContain('THE-UNIQUE-PROJECT-NOTE-MARKER')
    expect(outcome.block).toBeNull()
  })

  it('excludes learning and temp too, and never auto-writes either', () => {
    // `learning` is an unused string in this table that shares a name with a
    // different, unpersisted, AUTOMATICALLY-written mechanism. If it were ever
    // injectable, a task failure would write into it and the next task would
    // read it back — automatic writing through the back door.
    write({ key: 'file:src/l.ts', scope: 'learning', value: 'auto-written by a failure' })
    write({ key: 'file:src/t.ts', scope: 'temp', value: 'scratch' })
    expect(recallForTask(reader(), { files: ['src/l.ts'], text: 'x' }).block).toBeNull()
    expect(recallForTask(reader(), { files: ['src/t.ts'], text: 'x' }).block).toBeNull()
  })

  it('injects nothing on a task whose WORDS match a note, but whose files do not', () => {
    // THE DESIGN'S TIER 3 WAS REMOVED BECAUSE OF THIS SHAPE, and this is the
    // observation that removed it: a substring tier fired on the single word
    // "store" from a task named "tidy the store", handing a task scoped to
    // `src/totally-other.ts` a note about `src/memory-store.ts`. A miss
    // produced a guess, which falsifies the one property that justifies having
    // automatic retrieval instead of a tool.
    //
    // It also would have taught the agent to skim past a section titled
    // "Recollections", which spends the marking's power on the task where it
    // was right.
    write({ key: 'file:src/memory-store.ts', value: 'THE-NOTE-MARKER' })
    const outcome = recallForTask(reader(), {
      files: ['src/totally-other.ts'],
      text: 'tidy the store',
    })
    expect(outcome.block).toBeNull()
  })

  it('never reaches a value, so a note mentioned only in a value cannot surface', () => {
    // Automatic retrieval does exact `getByKey` lookups and reads no other
    // column. A value that matches the task's words — or a `session` blob that
    // nests it — cannot bring its entry back, because nothing ever reads the
    // value column on this path.
    write({ key: 'file:src/other.ts', value: 'zebra-appears-only-in-the-value' })
    const outcome = recallForTask(reader(), { files: [], text: 'investigate the zebra situation' })
    expect(outcome.block ?? '').not.toContain('zebra-appears-only-in-the-value')
    expect(outcome.block).toBeNull()
  })

  it('finds a note when the tool path NAMES A FILE in its prose, and there is no Task', () => {
    // What replaced tier 3, and it is a far stronger signal: a path is a file,
    // a word is not. This is the only file signal `nexus.spawn` has, because it
    // takes a string and never receives a `files.include`.
    write({ key: 'file:src/auth/jwt.ts', value: 'PATH-FROM-PROSE-MARKER' })
    const outcome = recallForTask(reader(), { files: [], text: 'fix the token check in src/auth/jwt.ts' })
    expect(outcome.block).toContain('PATH-FROM-PROSE-MARKER')
  })
})

describe('the size cap', () => {
  // (c) IS THE TEST. A block that silently shows three of nine reads as "those
  // were all of them", which is the exact failure the marking exists to
  // prevent: a reader TOLD a partial set is a reader who knows to look for the
  // rest. A silent truncation satisfies the count and character caps and fails
  // the announced count, which is why the announced count is asserted.

  it('caps the count at MAX_RECALL_ENTRIES, and ANNOUNCES the cap', () => {
    // FIFTY DISTINCT KEYS, all of them files the task is scoped to. Writing 50
    // entries under ONE key would be collapsed to a single note by the supersede
    // rule, so the cap would never be exercised.
    const files = Array.from({ length: 50 }, (_, i) => `src/big-${i}.ts`)
    for (const file of files) write({ key: fileKey(file), value: 'a short note' })
    const outcome = recallForTask(reader(), { files, text: 'anything' })
    expect(outcome.block).not.toBeNull()
    expect(outcome.matched).toBe(50)
    // Short enough that the CHARACTER budget is not the binding constraint, so
    // the count cap is what stops this — which is the cap being tested.
    expect(outcome.shown).toBe(MAX_RECALL_ENTRIES)
    // THE ANNOUNCED COUNT. Without this the test passes on a silent truncation,
    // which is the defect the count-string exists to prevent — and it is
    // asserted against the REAL `shown`, so an implementation that reported a
    // number other than the one it rendered fails here.
    expect(outcome.block).toContain(`showing ${outcome.shown} of 50 notes`)
  })

  it('lets the character cap bind before the count cap, and says so', () => {
    // Both caps apply and the tighter one wins. Pinned so the interaction is not
    // a surprise: five LONG notes do not fit in 800 characters, so four render,
    // and the block reports four of fifty rather than implying five.
    const files = Array.from({ length: 50 }, (_, i) => `src/big-${i}.ts`)
    for (const file of files) write({ key: fileKey(file), value: 'x'.repeat(300) })
    const outcome = recallForTask(reader(), { files, text: 'anything' })
    expect(outcome.shown).toBeLessThan(MAX_RECALL_ENTRIES)
    expect(outcome.shown).toBeGreaterThan(0)
    expect(outcome.block).toContain(`showing ${outcome.shown} of 50 notes`)
  })

  it('keeps the whole block inside the character budget', () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/big-${i}.ts`)
    for (const file of files) write({ key: fileKey(file), value: 'x'.repeat(500) })
    const outcome = recallForTask(reader(), { files, text: 'anything' })
    expect(outcome.characters).toBe(outcome.block?.length ?? 0)
    expect(outcome.characters).toBeLessThanOrEqual(800)
  })

  it('reports the block length, so prompt-weight regression is visible', () => {
    write({ key: 'file:src/a.ts', value: 'a note' })
    const outcome = recallForTask(reader(), { files: ['src/a.ts'], text: 'x' })
    // The injected block is prepended to the prompt and `readSessionTokens`
    // counts it in `input`, so the BILL is accurate. This is the figure that
    // says how much of a task's input was a note someone wrote once.
    expect(outcome.characters).toBeGreaterThan(0)
    expect(outcome.characters).toBe(outcome.block!.length)
  })

  it('says so when nothing fitted at all, rather than emitting an empty block', () => {
    // A key long enough that one line cannot fit the remaining budget. The
    // branch is about the "nothing fitted" CASE, not about making a realistic
    // note, and a long key is a real thing a user can write.
    const longKey = `file:${'src/'.repeat(120)}a.ts`
    const notes: RecalledNote[] = [{
      entry: {
        id: 'mem-x', key: longKey, value: 'a short note',
        scope: 'project', author: 'alice', timestamp: new Date(), confidence: null, tags: [],
      },
      matchedKey: longKey,
      supersedes: 0,
    }]
    const outcome = renderRecall(notes)
    // "There are recollections and they did not fit" is information. Emitting
    // nothing would be indistinguishable from "there are none" — which is the
    // one thing a recollection block must never do.
    expect(outcome.block).not.toBeNull()
    expect(outcome.block).toContain('showing 0 of 1 notes')
    expect(outcome.shown).toBe(0)
  })
})

describe('the injected block is marked, and the marking is a contract', () => {
  // ASSERTED AS A CONTRACT, NOT A GOLDEN STRING: the disclaimer phrases and the
  // per-line attribution are checked, so this survives a rewording but fails on
  // a REMOVAL — which is the direction that matters, because the failure mode
  // being guarded is someone tidying the warning away.

  it('carries the disclaimer, including the sentence that enforces the principle', () => {
    write({ key: 'file:src/a.ts', value: 'a note' })
    const block = recallForTask(reader(), { files: ['src/a.ts'], text: 'x' }).block!
    expect(block).toContain(RECALL_HEADING)
    expect(block).toContain("people's notes, not facts about the code")
    expect(block).toContain('None of it was')
    expect(block).toContain('checked against the current code')
    // The load-bearing sentence. If it goes, the block stops saying which side
    // wins a disagreement.
    expect(block).toContain('the code is right')
  })

  it('attributes EVERY note line with an author and a relative age', () => {
    write({ key: 'file:src/a.ts', value: 'first', author: 'alice' })
    write({ key: 'file:src/b.ts', value: 'second', author: 'bob' })
    const block = recallForTask(reader(), { files: ['src/a.ts', 'src/b.ts'], text: 'x' }).block!
    const noteLines = block.split('\n').filter(l => l.startsWith('- key '))
    expect(noteLines).toHaveLength(2)
    for (const line of noteLines) {
      expect(line).toMatch(/written .+ by (alice|bob)/)
    }
  })

  it('renders an unstated confidence as unstated, and never invents one', () => {
    write({ key: 'file:src/a.ts', value: 'no confidence given' })
    write({ key: 'file:src/b.ts', value: 'low confidence given', confidence: 0.2 })
    const block = recallForTask(reader(), { files: ['src/a.ts', 'src/b.ts'], text: 'x' }).block!
    expect(block).toContain('confidence: not stated')
    expect(block).toContain('confidence: 0.2')
  })

  it('keeps a stated low confidence ahead of an unstated one, rather than dropping the honest entry first', () => {
    // Treating an absence as a low score would penalise the author for being
    // honest about not knowing, and would make the honest entry the first thing
    // to disappear under the cap. Seven DISTINCT keys, so this is about RANKING
    // and not about version collapsing.
    const files = ['src/keep.ts', ...Array.from({ length: 6 }, (_, i) => `src/drop-${i}.ts`)]
    write({ key: fileKey('src/keep.ts'), value: 'author said nothing', confidence: null })
    for (let i = 0; i < 6; i++) {
      write({ key: fileKey(`src/drop-${i}.ts`), value: `low ${i}`, confidence: 0.1 })
    }
    const block = recallForTask(reader(), { files, text: 'x' }).block!

    // The unstated note SURVIVES the cap...
    expect(block).toContain('author said nothing')
    // ...and it is the FIRST note, so it was ranked ahead of every stated 0.1
    // rather than sorted by the number a null happens to coerce to.
    const unstatedAt = block.indexOf('author said nothing')
    const firstLowAt = block.indexOf('confidence: 0.1')
    expect(unstatedAt).toBeGreaterThan(-1)
    expect(firstLowAt).toBeGreaterThan(unstatedAt)
    // And the cap really did bite: 7 matched, 5 shown, and the block says so.
    expect(block).toContain('showing 5 of 7 notes')
  })

  it('quotes a stored IMPERATIVE, so it reads as a note and not a directive', () => {
    // This is the structural half of the marking and the only one that is not a
    // convention. An agent under time pressure can talk past a warning; it
    // cannot read a quotation as an instruction without ignoring the attribution
    // that makes it a quotation. The value is a sentence a note could plausibly
    // contain, and the case the whole format exists for.
    write({
      key: 'file:src/a.ts',
      value: 'Always run bun run migrate before touching anything else.',
      author: 'alice',
    })
    const block = recallForTask(reader(), { files: ['src/a.ts'], text: 'x' }).block!
    const disclaimerAt = block.indexOf('the code is right')
    const noteAt = block.indexOf('- key ')
    const valueAt = block.indexOf('"Always run bun run migrate')

    // The value is inside quotation marks...
    expect(valueAt).toBeGreaterThan(-1)
    // ...and it appears after the disclaimer, not before it, so a reader meets
    // the warning first and cannot take the imperative as the opening of the
    // block.
    expect(noteAt).toBeGreaterThan(disclaimerAt)
    expect(valueAt).toBeGreaterThan(noteAt)
  })

  it('caps a long value rather than cutting mid-sentence into something that reads complete', () => {
    write({ key: 'file:src/a.ts', value: 'z'.repeat(400) })
    const block = recallForTask(reader(), { files: ['src/a.ts'], text: 'x' }).block!
    expect(block).toContain('…')
    expect(block).not.toContain('z'.repeat(300))
  })
})

describe('append, not upsert', () => {
  // NOTHING IN THE PRE-EXISTING STORE TESTS COVERED A REPEATED KEY IN ONE
  // SCOPE. `test/memory-store.test.ts` used the same key across DIFFERENT
  // scopes, which is a different case entirely. So the append behaviour was
  // unpinned: a future edit could turn `set` into an upsert on `(scope, key)`,
  // destroying the supersede history, and no test would notice.

  it('leaves both versions on disk under one key', () => {
    write({ key: 'file:src/a.ts', value: 'first version' })
    write({ key: 'file:src/a.ts', value: 'second version' })
    expect(store.getByKey('file:src/a.ts', 'project')).toHaveLength(2)
  })

  it('resolves the newest version by ordering, not by rowid accident', () => {
    write({ key: 'file:src/a.ts', value: 'first version' })
    write({ key: 'file:src/a.ts', value: 'second version' })
    expect(store.get('file:src/a.ts', 'project')?.value).toBe('second version')
    // And the ordering is a stated contract of the query, not an emergent
    // property: oldest first, so the LAST element is the newest.
    const all = store.getByKey('file:src/a.ts', 'project')
    expect(all.map(e => e.value)).toEqual(['first version', 'second version'])
  })

  it('injects only the newest version, and says how many it supersedes', () => {
    write({ key: 'file:src/a.ts', value: 'old and wrong' })
    write({ key: 'file:src/a.ts', value: 'new and right' })
    const block = recallForTask(reader(), { files: ['src/a.ts'], text: 'x' }).block!
    expect(block).toContain('new and right')
    expect(block).not.toContain('old and wrong')
    // A correction the writer cannot see is a correction they will not trust.
    expect(block).toContain('supersedes 1 earlier version')
  })

  it('shows a superseded note TWICE in search, because both are on disk', () => {
    // A tool that reported one would be hiding a row that `memory.set` told the
    // writer it kept. Both surfaces have to agree.
    write({ key: 'file:src/a.ts', value: 'first version' })
    write({ key: 'file:src/a.ts', value: 'second version' })
    expect(store.search('version')).toHaveLength(2)
  })
})

describe('relative age', () => {
  // Hand-rolled arithmetic rather than `Intl` or `toLocaleDateString`, because
  // locale- and timezone-dependent date rendering is exactly what passes on a
  // development machine and differs on CI. These words are the output contract,
  // so they are asserted rather than regenerated.

  const now = Date.UTC(2026, 0, 15, 12, 0, 0)
  const ago = (ms: number): string => relativeAge(new Date(now - ms), now)

  it('says "just now" below a minute, then steps through the units', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(59_000)).toBe('just now')
    expect(ago(60_000)).toBe('1 minute ago')
    expect(ago(120_000)).toBe('2 minutes ago')
    expect(ago(3_600_000)).toBe('1 hour ago')
    expect(ago(86_400_000)).toBe('1 day ago')
    expect(ago(6 * 86_400_000)).toBe('6 days ago')
  })

  it('reaches weeks and months and years without ever naming a calendar date', () => {
    // A date is a fact that goes stale silently; an age degrades as it ages.
    expect(ago(21 * 86_400_000)).toBe('3 weeks ago')
    expect(ago(75 * 86_400_000)).toBe('2 months ago')
    expect(ago(400 * 86_400_000)).toBe('over 1 year ago')
    expect(ago(3 * 365 * 86_400_000)).toBe('over 3 years ago')
  })

  it('does not go negative for a timestamp in the future', () => {
    expect(ago(-5000)).toBe('just now')
  })
})
