import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NexusOrchestrator } from '../src/orchestrator'
import {
  describeEmptyResult,
  describeListResult,
  describeSearchResult,
  describeSetResult,
  SELF_REPORTED_AUTHOR_WARNING,
  UNVERIFIED_NOTES_WARNING,
  isAutoInjectableKey,
} from '../src/memory-recall'
import type { MemoryEntry, MemoryScope } from '../src/types'

/**
 * What the three memory tools SAY, because that is the part a user reads.
 *
 * The formatting functions are exercised directly here as well as through the
 * orchestrator, for one reason: the honesty text is a CONTRACT, and a contract
 * that is only asserted through a tool executor fails for reasons that have
 * nothing to do with the contract — a mock that drifted, a registration that
 * moved — and stops being the thing being tested.
 *
 * Every claim below is one a user would otherwise have to guess:
 *   - whether "0 results" means "nothing remembered" or "search is broken"
 *   - whether a correction replaced the old note or was appended beside it
 *   - whether a result count is a relevance count
 *   - whether an author is a verified identity
 */

let TEST_DIR: string
let orchestrator: NexusOrchestrator

beforeEach(async () => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'nexus-memory-tools-'))
  const ctx = {
    location: { directory: process.cwd() },
    session: {
      create: mock(() => Promise.resolve({ id: 'session-mock' })),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
    },
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
  }
  orchestrator = new NexusOrchestrator(undefined, undefined, {
    dbPath: join(TEST_DIR, 'memory.db'),
    maxEntries: 1000,
  })
  await orchestrator.initialize(ctx as never)
})

afterEach(async () => {
  try { await orchestrator.shutdown() } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem-1-000001-abc',
    key: 'file:src/a.ts',
    value: 'a note',
    scope: 'project',
    author: 'alice',
    timestamp: new Date(),
    confidence: null,
    tags: [],
    ...overrides,
  }
}

describe('memory.set says the three things a user would otherwise get wrong', () => {
  it('states that it appended, that nothing was overwritten, and that agents see the newest', () => {
    const text = describeSetResult({
      entry: entry({ key: 'file:src/a.ts' }),
      versionsUnderKey: 3,
      evicted: null,
    })
    // Each of these is a wrong belief a user would otherwise hold.
    expect(text).toContain('APPENDED')
    expect(text).toContain('Nothing was overwritten')
    expect(text).toContain('MOST RECENT version only')
    expect(text).toContain('2 earlier version(s) of this key remain')
  })

  it('states that removal is API-only, and says why', () => {
    const text = describeSetResult({ entry: entry(), versionsUnderKey: 1, evicted: null })
    // D2, recorded in the product rather than only in a design doc. A user who
    // cannot remove a wrong note needs to know that before they rely on the
    // store, and needs the reason, because "we didn't build it" and "an agent
    // would abuse it" call for different amounts of patience.
    expect(text).toContain('no `memory.delete` TOOL')
    expect(text).toContain('removal is API-only')
    // Substring chosen to sit inside one wrapped line, so this asserts the
    // CLAIM rather than the exact line breaks of the paragraph above it.
    expect(text).toContain('delete it to unblock')
  })

  it('tells a writer under a non-injectable key how to make it injectable', () => {
    const text = describeSetResult({
      entry: entry({ key: 'architecture-notes' }),
      versionsUnderKey: 1,
      evicted: null,
    })
    // The day-one bridge. The store ships empty, so the single most useful thing
    // this tool can do is teach the one convention that makes injection fire.
    expect(text).toContain('WILL NOT BE INJECTED')
    expect(text).toContain('file:<path>')
    expect(text).toContain('key: "file:')
  })

  it('says nothing about injection for a key that is already injectable', () => {
    const text = describeSetResult({ entry: entry({ key: 'file:src/a.ts' }), versionsUnderKey: 1, evicted: null })
    expect(text).not.toContain('WILL NOT BE INJECTED')
  })

  it('reports an eviction caused by this very write', () => {
    const text = describeSetResult({
      entry: entry(),
      versionsUnderKey: 1,
      evicted: { scope: 'temp', count: 4 },
    })
    // Never silently. A note that vanishes is a note the user assumes was
    // never written, and then never writes again.
    expect(text).toContain('evicted 4 older entries')
    expect(text).toContain('"project" scope is never evicted')
  })

  it('accepts only file: keys as injectable, and rejects the degenerate one', () => {
    expect(isAutoInjectableKey('file:src/a.ts')).toBe(true)
    expect(isAutoInjectableKey('file:')).toBe(false)
  })
})

describe('memory.search tells the two empties apart', () => {
  // "0 results" alone is ambiguous between "nothing was ever written" and "the
  // search is broken", and those are diagnosed in completely different ways —
  // one by writing a note, the other by an afternoon. So an empty STORE says so
  // and names the file; a populated store with no match says how much IS stored,
  // which is the thing that proves the query ran.
  //
  // TWO SEPARATE STATES, TWO SEPARATE ASSERTIONS. A single merged "the result
  // mentions 0" test would pass on an implementation that cannot tell them
  // apart.

  it('an EMPTY store says the store is empty and names the file to go and look at', () => {
    const text = describeEmptyResult('retries', 0, '/tmp/memory.db')
    expect(text).toContain('the memory store is EMPTY')
    expect(text).toContain('/tmp/memory.db')
    expect(text).toContain('does not mean the search failed')
    expect(text).not.toContain('holding 0 entries')
  })

  it('a POPULATED store with no match says how much IS stored', () => {
    const text = describeEmptyResult('retries', 12, '/tmp/memory.db')
    expect(text).toContain('0 matches for "retries" in a store holding 12 entries')
    expect(text).toContain('The query ran and matched nothing')
    expect(text).not.toContain('the memory store is EMPTY')
  })

  it('every search result carries the verify instruction, not just the tool description', () => {
    // In the RESULT, because a subagent may call a tool without ever having
    // read its description. An instruction that lives only in the description
    // reaches whoever happened to read it.
    const text = describeSearchResult({
      query: 'a',
      results: [entry()],
      storeTotal: 1,
      dbPath: '/tmp/memory.db',
      includeSession: false,
    })
    expect(text).toContain('unranked')
    expect(text).toContain('NOT how many are relevant')
    expect(text).toContain('Treat a match as a lead')
    expect(text).toContain('the code is right')
    expect(text).toContain(SELF_REPORTED_AUTHOR_WARNING.split('.')[0]!)
  })

  it('warns that a result count is a hit count and not a relevance count', () => {
    // The substring `LIKE` over a JSON value matches any field nested anywhere
    // inside it, so relevance is genuinely weak and the user has to be told.
    const text = describeSearchResult({
      query: '8080',
      results: [entry()],
      storeTotal: 1,
      dbPath: '/tmp/memory.db',
      includeSession: false,
    })
    expect(text).toContain('unranked')
  })
})

describe('D1: search is project-only by default, session only on an explicit opt-in', () => {
  // A `session` entry is `collectContext(agent)` — an escalation blob that
  // NESTS the failing agent's own memory entries inside itself. The moment a
  // search tool exists, a user asking what nexus remembers about retries gets
  // another agent's failure log rendered as though it were a note about their
  // project. So the default is `project`, the opt-in exists for debugging, and a
  // session hit is LABELLED rather than presented as a note.

  it('finds a project note under the default allowlist', () => {
    orchestrator.memoryStore.set({ key: 'file:src/a.ts', value: 'project note', scope: 'project', author: 'alice', confidence: null, tags: [] })
    const found = orchestrator.searchMemory('note', ['project'])
    expect(found.map(e => e.scope)).toEqual(['project'])
  })

  it('does NOT return a session entry under the default allowlist', () => {
    orchestrator.memoryStore.set({ key: 'context:agent-1', value: '3 tasks failed', scope: 'session', author: 'agent-1', confidence: null, tags: [] })
    const found = orchestrator.searchMemory('failed', ['project'])
    expect(found).toEqual([])
  })

  it('returns a session entry on the opt-in, and LABELS it as internal', () => {
    orchestrator.memoryStore.set({ key: 'context:agent-1', value: '3 tasks failed', scope: 'session', author: 'agent-1', confidence: null, tags: [] })
    const found = orchestrator.searchMemory('failed', ['project', 'session'])
    expect(found).toHaveLength(1)
    const text = describeSearchResult({
      query: 'failed', results: found, storeTotal: 1,
      dbPath: '/tmp/memory.db', includeSession: true,
    })
    // The label leads the line. A note that says "internal escalation context"
    // mid-sentence is read as a note; a line whose FIRST token says so is not.
    expect(text).toContain('INTERNAL ESCALATION CONTEXT, NOT A NOTE ABOUT YOUR PROJECT')
    expect(text).toContain('nests that agent')
    // And the reader is told what the opt-in actually widens.
    expect(text).toContain('are never')
  })

  it('says the scope it searched, so "project only" is visible in the result', () => {
    const text = describeSearchResult({
      query: 'x', results: [entry()], storeTotal: 1,
      dbPath: '/tmp/memory.db', includeSession: false,
    })
    expect(text).toContain('project scope only')
    expect(text).toContain('includeSession: true')
  })

  it('de-duplicates across scopes, so one note is not listed twice', () => {
    orchestrator.memoryStore.set({ key: 'note', value: 'shared text', scope: 'project', author: 'alice', confidence: null, tags: [] })
    orchestrator.memoryStore.set({ key: 'note', value: 'shared text', scope: 'session', author: 'agent-1', confidence: null, tags: [] })
    const found = orchestrator.searchMemory('shared', ['project', 'session'])
    // Two distinct rows, so two results — but they are two different entries,
    // not one entry listed twice, and the ids prove it.
    expect(new Set(found.map(e => e.id)).size).toBe(found.length)
  })
})

describe('memory.list reports what is stored, and what is gone', () => {
  it('lists the NEWEST version of each key, and says how many older ones exist', () => {
    orchestrator.memoryStore.set({ key: 'file:src/a.ts', value: 'v1', scope: 'project', author: 'alice', confidence: null, tags: [] })
    orchestrator.memoryStore.set({ key: 'file:src/a.ts', value: 'v2', scope: 'project', author: 'alice', confidence: null, tags: [] })
    const { entries, versionsSuperseded } = orchestrator.listMemory('project', 50)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.value).toBe('v2')
    expect(versionsSuperseded).toBe(1)
  })

  it('prints the by-scope counts and the eviction totals together', () => {
    // They answer the same question — "is everything I wrote still there?" — so
    // they belong on one screen. A number that only answers it once you already
    // suspect the answer is not a number that helps.
    const text = describeListResult({
      scope: 'project',
      entries: [entry()],
      versionsSuperseded: 0,
      byScope: { project: 3, temp: 2 },
      evicted: { temp: 2 },
      truncatedAt: 50,
      dbPath: '/tmp/memory.db',
    })
    expect(text).toContain('By scope: project 3, temp 2')
    expect(text).toContain('Evicted this run')
    expect(text).toContain('2 from temp')
    // Under-reporting across restarts is stated, not hidden.
    expect(text).toContain('UNDER-report across runs')
    expect(text).toContain(UNVERIFIED_NOTES_WARNING.split('.')[0]!)
  })

  it('reports the cap, so a short list is not read as a complete one', () => {
    const text = describeListResult({
      scope: 'project', entries: [entry()], versionsSuperseded: 0,
      byScope: { project: 99 }, evicted: {}, truncatedAt: 50, dbPath: '/tmp/memory.db',
    })
    expect(text).toContain('Capped at 50')
  })

  it('carries the verify warning even when the scope is empty', () => {
    const text = describeListResult({
      scope: 'project', entries: [], versionsSuperseded: 0,
      byScope: {}, evicted: {}, truncatedAt: 50, dbPath: '/tmp/memory.db',
    })
    expect(text).toContain('No entries in scope "project"')
    expect(text).toContain('Nothing has been evicted this run')
  })
})

describe('the scopes an agent may write, and the ones it may not', () => {
  // A third scope barrier, independent of the two the recall path relies on.
  // `session` is the orchestrator's own escalation-transfer channel: letting an
  // agent write there would let it fabricate a context blob that reads as one
  // the orchestrator produced. `learning` is never writable because it is the
  // name of a different mechanism that is written automatically.

  it('the tool enum offers project and temp only', () => {
    // Pinned against the schema as the tool declares it, not a copy of it: read
    // out of `src/index.ts` so a widened enum fails here.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')
    const setBlock = source.slice(source.indexOf('name: "memory.set"'), source.indexOf('name: "memory.search"'))
    expect(setBlock).toContain('enum: ["project", "temp"]')
    expect(setBlock).not.toContain('"session"')
    expect(setBlock).not.toContain('"learning"')
  })

  it('the list enum offers session, because READING internal context is allowed', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')
    const listBlock = source.slice(source.indexOf('name: "memory.list"'), source.indexOf('name: "roles.list"'))
    expect(listBlock).toContain('enum: ["project", "session", "temp"]')
    // `learning` is absent even for reading: it is not a note store at all.
    expect(listBlock).not.toContain('"learning"')
  })
})

describe('the author is a claim, not a record', () => {
  it('the store records whatever the writer put in `author`', () => {
    // Honesty about authorship is currently a MATTER OF RECORDING the claim and
    // labelling it everywhere it is shown, because there is no identity to check
    // it against. Stated as a test so that if an identity source is ever wired
    // in, this test is the thing that has to be revisited deliberately.
    orchestrator.memoryStore.set({ key: 'k', value: 'v', scope: 'project', author: 'definitely-not-me', confidence: null, tags: [] })
    expect(orchestrator.memoryStore.get('k', 'project')?.author).toBe('definitely-not-me')
  })

  it('and both reading tools say so', () => {
    expect(SELF_REPORTED_AUTHOR_WARNING).toContain('Nothing verifies it')
    const search = describeSearchResult({
      query: 'a', results: [entry()], storeTotal: 1, dbPath: '/tmp/m.db', includeSession: false,
    })
    expect(search).toContain('Nothing verifies it')
    const list = describeListResult({
      scope: 'project', entries: [entry()], versionsSuperseded: 0,
      byScope: { project: 1 }, evicted: {}, truncatedAt: 50, dbPath: '/tmp/m.db',
    })
    expect(list).toContain('Nothing verifies it')
  })
})

describe('a note survives being written, and is readable through the orchestrator API', () => {
  it('setMemory still writes, and announces, with no confidence invented', async () => {
    // The one automatic write in the feature, and it is the escalation transfer.
    // Its confidence is `null` because the orchestrator did not know how sure it
    // was about a blob it assembled from a failure.
    const announced: MemoryEntry[] = []
    orchestrator.on('memory:set', (e: MemoryEntry) => { announced.push(e) })
    orchestrator.setMemory('session', 'context:agent-1', { errorLog: ['x'] }, 'agent-1')
    expect(announced).toHaveLength(1)
    expect(announced[0]!.scope).toBe('session')
    expect(announced[0]!.confidence).toBeNull()
  })

  it('getMemory reads it back', () => {
    orchestrator.setMemory('session', 'context:agent-2', { errorLog: ['y'] }, 'agent-2')
    expect(orchestrator.getMemory('session', 'context:agent-2')?.value).toEqual({ errorLog: ['y'] })
  })

  it('reports how many versions of a key exist, so a correction is visible', () => {
    orchestrator.memoryStore.set({ key: 'k', value: 'v1', scope: 'project' as MemoryScope, author: 'a', confidence: null, tags: [] })
    orchestrator.memoryStore.set({ key: 'k', value: 'v2', scope: 'project' as MemoryScope, author: 'a', confidence: null, tags: [] })
    const { count, entries } = orchestrator.versionsOfMemory('project', 'k')
    expect(count).toBe(2)
    expect(entries.map(e => e.value)).toEqual(['v1', 'v2'])
  })
})
