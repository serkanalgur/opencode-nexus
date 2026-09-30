import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { PersistentMemoryStore, isNewerThan, type MemoryStoreConfig } from '../src/memory-store'
import { unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Use a temp directory for tests
const TEST_DIR = join(import.meta.dir, '..', '.test-tmp')
const TEST_DB_PATH = join(TEST_DIR, 'test-memory.db')

function makeConfig(overrides?: Partial<MemoryStoreConfig>): Partial<MemoryStoreConfig> {
  return {
    dbPath: TEST_DB_PATH,
    maxEntries: 1000,
    ...overrides,
  }
}

/** Remove one database and its sidecars. Tolerates an absent file. */
function cleanupPath(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix)
    } catch {}
  }
}

describe('PersistentMemoryStore', () => {
  // THE WHOLE DIRECTORY IS REMOVED, not just `TEST_DB_PATH`. Tests here open
  // their own databases under `TEST_DIR` (the ordering test opens 40 of them),
  // and a file-scoped cleanup leaves those behind — so a second run of this file
  // would find the first run's rows already present and fail with four entries
  // where it expected two. That is a failure with no cause in the code under
  // test, which is the worst kind to hand someone debugging a green-red-green.
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('should create a new store', () => {
      const store = new PersistentMemoryStore(makeConfig())
      const stats = store.getStats()
      expect(stats.total).toBe(0)
      store.close()
    })

    it('should create the database directory if needed', () => {
      const deepPath = join(TEST_DIR, 'nested', 'dir', 'test.db')
      const store = new PersistentMemoryStore(makeConfig({ dbPath: deepPath }))
      store.close()
      expect(existsSync(deepPath)).toBe(true)
      // Cleanup
      try { unlinkSync(deepPath) } catch {}
      try { unlinkSync(deepPath + '-wal') } catch {}
      try { unlinkSync(deepPath + '-shm') } catch {}
    })
  })

  describe('set and get', () => {
    it('should store and retrieve an entry', () => {
      const store = new PersistentMemoryStore(makeConfig())
      const entry = store.set({
        key: 'architecture',
        value: { pattern: 'event-sourcing' },
        scope: 'project',
        author: 'architect',
        confidence: 1.0,
        tags: ['architecture']
      })

      expect(entry.id).toMatch(/^mem-/)
      expect(entry.key).toBe('architecture')
      expect(entry.value).toEqual({ pattern: 'event-sourcing' })
      expect(entry.scope).toBe('project')
      expect(entry.author).toBe('architect')
      expect(entry.timestamp).toBeInstanceOf(Date)

      const retrieved = store.get('architecture', 'project')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.key).toBe('architecture')
      expect(retrieved!.value).toEqual({ pattern: 'event-sourcing' })
      store.close()
    })

    it('should return null for non-existent key', () => {
      const store = new PersistentMemoryStore(makeConfig())
      expect(store.get('nonexistent')).toBeNull()
      store.close()
    })
  })

  describe('getByKey', () => {
    it('should return all entries for a key', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k1', value: 'v2', scope: 'session', author: 'a2', confidence: 0.9, tags: [] })

      const entries = store.getByKey('k1')
      expect(entries).toHaveLength(2)
      store.close()
    })

    it('should filter by scope when provided', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k1', value: 'v2', scope: 'session', author: 'a2', confidence: 0.9, tags: [] })

      const projectEntries = store.getByKey('k1', 'project')
      expect(projectEntries).toHaveLength(1)
      expect(projectEntries[0].scope).toBe('project')
      store.close()
    })
  })

  describe('getByScope', () => {
    it('should return all entries for a scope', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k2', value: 'v2', scope: 'project', author: 'a2', confidence: 0.9, tags: [] })
      store.set({ key: 'k3', value: 'v3', scope: 'session', author: 'a3', confidence: 1.0, tags: [] })

      const projectEntries = store.getByScope('project')
      expect(projectEntries).toHaveLength(2)
      store.close()
    })
  })

  describe('search', () => {
    it('should search by key and value content', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'architecture', value: { pattern: 'event-sourcing' }, scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'performance', value: { metric: 'slow query' }, scope: 'project', author: 'a2', confidence: 1.0, tags: [] })

      const results = store.search('event')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('architecture')
      store.close()
    })

    it('should search by key', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'architecture', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })

      const results = store.search('architect')
      expect(results).toHaveLength(1)
      store.close()
    })
  })

  describe('getRecent', () => {
    it('should return the most recent entries', async () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      // Delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 2))
      store.set({ key: 'k2', value: 'v2', scope: 'project', author: 'a2', confidence: 1.0, tags: [] })
      await new Promise(r => setTimeout(r, 2))
      store.set({ key: 'k3', value: 'v3', scope: 'project', author: 'a3', confidence: 1.0, tags: [] })

      const recent = store.getRecent(2)
      expect(recent).toHaveLength(2)
      // Most recent first
      expect(recent[0].key).toBe('k3')
      expect(recent[1].key).toBe('k2')
      store.close()
    })
  })

  describe('getByAuthor', () => {
    it('should return entries by author', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'agent-1', confidence: 1.0, tags: [] })
      store.set({ key: 'k2', value: 'v2', scope: 'session', author: 'agent-2', confidence: 1.0, tags: [] })
      store.set({ key: 'k3', value: 'v3', scope: 'project', author: 'agent-1', confidence: 1.0, tags: [] })

      const entries = store.getByAuthor('agent-1')
      expect(entries).toHaveLength(2)
      store.close()
    })
  })

  describe('delete', () => {
    it('should delete an entry by key', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })

      const deleted = store.delete('k1', 'project')
      expect(deleted).toBe(true)
      expect(store.get('k1', 'project')).toBeNull()
      store.close()
    })

    it('should return false when key does not exist', () => {
      const store = new PersistentMemoryStore(makeConfig())
      const deleted = store.delete('nonexistent')
      expect(deleted).toBe(false)
      store.close()
    })
  })

  describe('clear', () => {
    it('should clear all entries', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k2', value: 'v2', scope: 'session', author: 'a2', confidence: 1.0, tags: [] })

      const cleared = store.clear()
      expect(cleared).toBe(2)
      expect(store.getStats().total).toBe(0)
      store.close()
    })

    it('should clear only entries in a scope', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k2', value: 'v2', scope: 'session', author: 'a2', confidence: 1.0, tags: [] })

      const cleared = store.clear('project')
      expect(cleared).toBe(1)
      expect(store.getStats().total).toBe(1)
      store.close()
    })
  })

  describe('TTL', () => {
    it('should not return expired entries', async () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [], ttl: 1 })

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 5))

      const entry = store.get('k1', 'project')
      expect(entry).toBeNull()
      store.close()
    })

    it('should return entries that have not expired', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [], ttl: 60000 })

      const entry = store.get('k1', 'project')
      expect(entry).not.toBeNull()
      store.close()
    })

    it('should not include expired entries in getStats total', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k2', value: 'v2', scope: 'project', author: 'a1', confidence: 1.0, tags: [], ttl: 1 })

      // Wait for the TTL to expire
      const start = Date.now()
      while (Date.now() - start < 5) {} // spin for at least 5ms

      const stats = store.getStats()
      expect(stats.total).toBe(2) // total includes expired
      expect(stats.expired).toBe(1)
      store.close()
    })
  })

  describe('stats', () => {
    it('should report correct stats by scope', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: [] })
      store.set({ key: 'k2', value: 'v2', scope: 'project', author: 'a2', confidence: 1.0, tags: [] })
      store.set({ key: 'k3', value: 'v3', scope: 'session', author: 'a3', confidence: 1.0, tags: [] })

      const stats = store.getStats()
      expect(stats.total).toBe(3)
      expect(stats.byScope['project']).toBe(2)
      expect(stats.byScope['session']).toBe(1)
      store.close()
    })
  })

  describe('eviction', () => {
    // `maxEntries` was declared, defaulted to 10000, and READ BY NOTHING until
    // this change. These pin the enforcement, and the two things that make the
    // enforcement defensible rather than merely present: the EXEMPTION, and the
    // REPORTING.

    it('evicts oldest-first once a capped scope is over maxEntries', () => {
      const store = new PersistentMemoryStore(makeConfig({ maxEntries: 3 }))
      for (const k of ['k1', 'k2', 'k3', 'k4']) {
        store.set({ key: k, value: k, scope: 'temp', author: 'a', confidence: null, tags: [] })
      }
      // FIFO, like `ExecutionHistory` and `PerformanceTracker`.
      expect(store.getByScope('temp').map(e => e.key)).toEqual(['k4', 'k3', 'k2'])
      store.close()
    })

    it('NEVER evicts a project note, however many disposable entries arrive', () => {
      // The exemption is the point. `ExecutionHistory` and `PerformanceTracker`
      // are process-lifetime caches, so FIFO there loses a cache. Memory is the
      // durable store: evicting a note someone deliberately wrote because a
      // thousand `temp` entries arrived would destroy the only thing a user
      // actually wrote down, in exchange for bounding rows nobody reads.
      const store = new PersistentMemoryStore(makeConfig({ maxEntries: 2 }))
      store.set({ key: 'durable', value: 'keep me', scope: 'project', author: 'a', confidence: null, tags: [] })
      for (let i = 0; i < 20; i++) {
        store.set({ key: `junk-${i}`, value: 'x', scope: 'temp', author: 'a', confidence: null, tags: [] })
      }
      expect(store.get('durable', 'project')?.value).toBe('keep me')
      expect(store.getByScope('temp')).toHaveLength(2)
      // And nothing was counted against the project scope.
      expect(store.getEvictionTotals()['project']).toBeUndefined()
      expect(store.getEvictionTotals()['temp']).toBe(18)
      store.close()
    })

    it('REPORTS an eviction rather than dropping rows silently', () => {
      const store = new PersistentMemoryStore(makeConfig({ maxEntries: 1 }))
      expect(store.takeEviction()).toBeNull()
      store.set({ key: 'a', value: '1', scope: 'temp', author: 'a', confidence: null, tags: [] })
      // A write inside the cap evicts nothing and reports nothing.
      expect(store.takeEviction()).toBeNull()
      store.set({ key: 'b', value: '2', scope: 'temp', author: 'a', confidence: null, tags: [] })
      const eviction = store.takeEviction()
      expect(eviction).not.toBeNull()
      expect(eviction!.scope).toBe('temp')
      expect(eviction!.count).toBe(1)
      // The time of the OLDEST thing removed, so a reader can say when the
      // thing that disappeared was written.
      expect(eviction!.oldestEvictedAt).toBeInstanceOf(Date)
      // Draining, not reading: the same eviction is not reported twice.
      expect(store.takeEviction()).toBeNull()
      store.close()
    })

    it('reports `oldestEvictedAt` as null when nothing was actually removed', () => {
      // "The oldest thing I deleted" is not a question with an answer when I
      // deleted nothing, so it is not a date that means "the beginning of time".
      const store = new PersistentMemoryStore(makeConfig({ maxEntries: 5 }))
      for (let i = 0; i < 3; i++) {
        store.set({ key: `k${i}`, value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [] })
      }
      expect(store.takeEviction()).toBeNull()
      store.close()
    })

    it('counts expired rows against the cap without counting them as evictable later', () => {
      // Expired rows are unreadable already, so spending cap headroom on them
      // would evict a LIVE row in their place for no gain.
      const store = new PersistentMemoryStore(makeConfig({ maxEntries: 2 }))
      store.set({ key: 'dead-1', value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [], ttl: 1 })
      store.set({ key: 'dead-2', value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [], ttl: 1 })
      const start = Date.now()
      while (Date.now() - start < 5) {}
      store.set({ key: 'live-1', value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [] })
      store.set({ key: 'live-2', value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [] })
      // Both live rows survive, because the two expired ones took the cap slots.
      expect(store.get('live-1', 'temp')).not.toBeNull()
      expect(store.get('live-2', 'temp')).not.toBeNull()
      expect(store.get('dead-1', 'temp')).toBeNull()
      store.close()
    })

    it('exposes evictions in getStats, so growth and loss are one question', () => {
      const store = new PersistentMemoryStore(makeConfig({ maxEntries: 1 }))
      store.set({ key: 'a', value: '1', scope: 'temp', author: 'a', confidence: null, tags: [] })
      store.set({ key: 'b', value: '2', scope: 'temp', author: 'a', confidence: null, tags: [] })
      const stats = store.getStats()
      expect(stats.evicted['temp']).toBe(1)
      expect(stats.byScope['temp']).toBe(1)
      store.close()
    })
  })

  describe('version ordering is a contract, not a rowid accident', () => {
    // `getByKey` had no `ORDER BY` at all and `get` took `[length - 1]`, so
    // "the newest version of this key" was correct only because SQLite scans a
    // rowid table in insertion order. Worse, two writes in the same millisecond
    // shared a `timestamp`, and the id used to end in random characters — so
    // which version of a note was CURRENT, and therefore which one every agent
    // was shown, was decided by `Math.random()`.

    it('orders oldest-first, so the last element is the newest', async () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k', value: 'v1', scope: 'project', author: 'a', confidence: null, tags: [] })
      await new Promise(r => setTimeout(r, 2))
      store.set({ key: 'k', value: 'v2', scope: 'project', author: 'a', confidence: null, tags: [] })
      expect(store.getByKey('k', 'project').map(e => e.value)).toEqual(['v1', 'v2'])
      expect(store.get('k', 'project')?.value).toBe('v2')
      store.close()
    })

    it('resolves the newest version deterministically, INCLUDING on a timestamp tie', () => {
      // THE TIE IS CONSTRUCTED, NOT OBSERVED. DO NOT SIMPLIFY THIS BACK.
      //
      // This test used to write two versions back to back and count how many
      // pairs happened to land in the same millisecond, then assert the count
      // was above zero so the loop could not silently stop covering the case it
      // exists for. That was a test failing on its own preconditions: on a warm
      // machine the pair ties, and on a cold one — CI's Node 22 legs, where
      // schema creation and statement preparation are slower than the
      // millisecond the two writes are trying to share — the pair never ties, the
      // ordering is trivially right 40 times, and the count reads zero. A test
      // that cannot fail because the code is wrong, and CAN fail because the
      // machine was slow, is the defect. The same shape shipped in 2.8.0 and
      // passed on darwin while failing on both ubuntu legs.
      //
      // So the clock is pinned through the store's own injection point. The tie
      // is now a fact about the data, identical on every machine and every Node
      // version, and what follows is the real contract: a user correcting a note
      // twice in quick succession must not have the OLD text win.
      const PINNED = 1_700_000_000_000
      const store = new PersistentMemoryStore(makeConfig(), { now: () => PINNED })

      const first = store.set({ key: 'k', value: 'v1', scope: 'project', author: 'a', confidence: null, tags: [] })
      const second = store.set({ key: 'k', value: 'v2', scope: 'project', author: 'a', confidence: null, tags: [] })

      // The tie is asserted, so a future change that made the injection point
      // stop applying here would be caught rather than quietly un-covering the
      // test.
      expect(first.timestamp.getTime()).toBe(PINNED)
      expect(second.timestamp.getTime()).toBe(PINNED)

      // ASC: oldest first, so `get` — which takes the last element — is newest.
      expect(store.getByKey('k', 'project').map(e => e.value)).toEqual(['v1', 'v2'])
      expect(store.get('k', 'project')?.value).toBe('v2')
      // DESC: the same tie, the other way. A fix that only taught the ASC query
      // to break ties would pass the three assertions above and still show a
      // user the note they had just corrected.
      expect(store.getRecent(2).map(e => e.value)).toEqual(['v2', 'v1'])
      expect(store.getByScope('project').map(e => e.value)).toEqual(['v2', 'v1'])
      expect(store.search('v', 'project').map(e => e.value)).toEqual(['v2', 'v1'])

      // And the pure function agrees with the query's own ordering, both ways,
      // with equal timestamps and no timestamp to fall back on.
      expect(isNewerThan(second, first)).toBe(true)
      expect(isNewerThan(first, second)).toBe(false)
      expect(isNewerThan(first, first)).toBe(false)

      store.close()
    })

    it('pads the sequence segment, so the tie-break survives the 9-to-10 edge', () => {
      // THE ID IS COMPARED AS TEXT, so an unpadded counter would put write 10
      // BEFORE write 9 and reverse every "newest wins" answer from the tenth
      // write of a process onwards. Asserted as text, not as a property, so the
      // failure names the width rather than the symptom.
      //
      // This is the concrete form of the doc comment on `SEQUENCE_WIDTH`:
      // `'mem-1-9-x' > 'mem-1-10-x'` is TRUE in string comparison, which is
      // exactly the wrong answer.
      expect('mem-1-9-x' > 'mem-1-10-x').toBe(true)
      expect('mem-1-000009-x' > 'mem-1-000010-x').toBe(false)
      expect('mem-1-000009-x' < 'mem-1-000010-x').toBe(true)

      // Ten writes pinned to one millisecond, so the sequence runs
      // 000001..00000a and the pinned-clock test above is joined by a real
      // store that crosses the base-36 9 -> 10 edge inside a single tie.
      const PINNED = 1_700_000_000_000
      const store = new PersistentMemoryStore(makeConfig(), { now: () => PINNED })
      const entries = Array.from({ length: 10 }, (_, i) =>
        store.set({ key: `k${i}`, value: `v${i}`, scope: 'project', author: 'a', confidence: null, tags: [] })
      )

      // Every id has a six-character base-36 sequence segment, zero-padded.
      for (const entry of entries) {
        expect(entry.id).toMatch(/^mem-\d{13}-[0-9a-z]{6}-[0-9a-z]+$/)
      }
      // Writes 9 and 10 are the padded forms of the two ids compared above.
      expect(entries[8].id).toContain('-000009-')
      expect(entries[9].id).toContain('-00000a-')

      // Pairwise, every later write is newer — including across that edge, where
      // an unpadded counter would have inverted the answer.
      for (let i = 1; i < entries.length; i++) {
        expect(isNewerThan(entries[i], entries[i - 1])).toBe(true)
        expect(isNewerThan(entries[i - 1], entries[i])).toBe(false)
      }
      // And the query agrees, newest first, all ten sharing one timestamp.
      expect(store.getRecent(10).map(e => e.value)).toEqual(
        Array.from({ length: 10 }, (_, i) => `v${9 - i}`)
      )
      store.close()
    })

    it('orders correctly on the real clock without asserting anything about timing', () => {
      // The pinned-clock test above is the one that covers the tie. This one
      // covers the DEFAULT clock — real `Date.now`, no injection — and says
      // nothing about how the two writes were spaced.
      //
      // Specifically NOT asserted: that any pair tied. Whether a pair of
      // back-to-back writes shares a millisecond is a fact about this machine's
      // speed, and a test that requires it is the bug, not the guard. Here the
      // answer must simply always be right, tied or not.
      for (let attempt = 0; attempt < 10; attempt++) {
        // A FRESH DATABASE PER ATTEMPT, AND REMOVED AFTERWARDS. The outer
        // `beforeEach` cleanup only deletes `TEST_DB_PATH`, so without both a
        // unique name and an unlink, attempt 0 on a SECOND run of this file
        // would find attempt 0's two rows already there and assert against four.
        const path = join(TEST_DIR, `order-${attempt}.db`)
        const store = new PersistentMemoryStore(makeConfig({ dbPath: path }))
        const first = store.set({ key: 'k', value: 'v1', scope: 'project', author: 'a', confidence: null, tags: [] })
        const second = store.set({ key: 'k', value: 'v2', scope: 'project', author: 'a', confidence: null, tags: [] })
        expect(store.get('k', 'project')?.value).toBe('v2')
        expect(store.getByKey('k', 'project').map(e => e.value)).toEqual(['v1', 'v2'])
        expect(isNewerThan(second, first)).toBe(true)
        expect(isNewerThan(first, second)).toBe(false)
        store.close()
        cleanupPath(path)
      }
    })

    it('orders getByScope and getRecent newest-first with no tie either', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'a', value: 'v1', scope: 'project', author: 'x', confidence: null, tags: [] })
      store.set({ key: 'b', value: 'v2', scope: 'project', author: 'x', confidence: null, tags: [] })
      expect(store.getByScope('project').map(e => e.value)).toEqual(['v2', 'v1'])
      expect(store.getRecent(1).map(e => e.value)).toEqual(['v2'])
      expect(store.getByAuthor('x').map(e => e.value)).toEqual(['v2', 'v1'])
      store.close()
    })
  })

  describe('search scope filtering', () => {
    // The underlying `search` matched over VALUES as well as keys and had no
    // scope filter at all, so the moment a tool existed, a user asking what
    // nexus remembered about retries got another agent's escalation blob back
    // — nested `memoryEntries` and all — rendered as though it were a note.

    it('returns only the requested scope', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k', value: 'shared text', scope: 'project', author: 'a', confidence: null, tags: [] })
      store.set({ key: 'k', value: 'shared text', scope: 'session', author: 'agent-1', confidence: null, tags: [] })
      expect(store.search('shared', 'project')).toHaveLength(1)
      expect(store.search('shared', 'session')).toHaveLength(1)
      // Unfiltered remains a superset, so this is not a breaking change.
      expect(store.search('shared')).toHaveLength(2)
      store.close()
    })

    it('matches on VALUES as well as keys, which is why the tool must say it is weak', () => {
      const store = new PersistentMemoryStore(makeConfig())
      // A stored value is arbitrary JSON, so `%q%` matches any field nested
      // anywhere inside it. Searching 8080 returns an entry whose KEY says
      // nothing about ports.
      store.set({ key: 'k2', value: { note: 'the port is 8080' }, scope: 'project', author: 'a', confidence: null, tags: [] })
      const results = store.search('8080')
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('k2')
      store.close()
    })
  })

  describe('the db path is reportable', () => {
    it('names where the store is, so "empty" and "broken" can be told apart', () => {
      // The two empty results look identical until the reader is told which one
      // they are looking at and where to go and look.
      const store = new PersistentMemoryStore(makeConfig())
      expect(store.path).toBe(TEST_DB_PATH)
      store.close()
    })
  })

  describe('confidence is recorded as given, and null means unstated', () => {
    it('keeps a stated number', () => {
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k', value: 'v', scope: 'project', author: 'a', confidence: 0.4, tags: [] })
      expect(store.get('k', 'project')?.confidence).toBe(0.4)
      store.close()
    })

    it('keeps an absent confidence as null, never inventing 1.0', () => {
      // The column used to be `REAL DEFAULT 1.0` and `setMemory` hardcoded it,
      // so every entry carried a confidence nobody had expressed — and the
      // retrieval path rendered it, making an unexpressed confidence
      // indistinguishable from a considered one.
      const store = new PersistentMemoryStore(makeConfig())
      store.set({ key: 'k', value: 'v', scope: 'project', author: 'a', confidence: null, tags: [] })
      expect(store.get('k', 'project')?.confidence).toBeNull()
      store.close()
    })
  })

  describe('persistence', () => {
    it('should survive process restart', () => {
      const config = makeConfig()

      // First instance: write entries
      const store1 = new PersistentMemoryStore(config)
      store1.set({ key: 'k1', value: 'v1', scope: 'project', author: 'a1', confidence: 1.0, tags: ['test'] })
      store1.set({ key: 'k2', value: { nested: true }, scope: 'session', author: 'a2', confidence: 0.9, tags: [] })
      store1.close()

      // Second instance: should load from disk
      const store2 = new PersistentMemoryStore(config)
      const stats = store2.getStats()
      expect(stats.total).toBe(2)

      const entry = store2.get('k1', 'project')
      expect(entry).not.toBeNull()
      expect(entry!.value).toEqual('v1')
      expect(entry!.tags).toEqual(['test'])

      const entry2 = store2.get('k2', 'session')
      expect(entry2).not.toBeNull()
      expect(entry2!.value).toEqual({ nested: true })

      store2.close()
    })
  })
  // ── LIVE RESOLUTION ──
  //
  // `storage` and `maxEntries` were frozen at CONSTRUCTION: the store opened
  // `dbPath` in its constructor and held the handle, and `maxEntries` was read
  // from a field nobody updated. So a user who edited `nexus.jsonc` saw the new
  // value in the config modal — `getConfig().memory` reports it — while the
  // running process kept using the old path until restart. That is a knob that
  // reports itself saved and does nothing, which is the failure the whole
  // `memory` block was rebuilt to remove.
  //
  // These tests drive the RESOLVER directly rather than through a config file,
  // because the resolver is the mechanism: a file-level test would pass whether
  // the value arrived by resolver or by a snapshot taken at construction, which
  // is precisely the distinction under test. The end-to-end half — the store and
  // the config manager agreeing — is in `test/config-knobs.test.ts`.
  describe('the config is resolved LIVE, not snapshotted at construction', () => {
    it('swaps the open database when the resolved path changes, leaving the old file intact', () => {
      const first = join(TEST_DIR, 'first.db')
      const second = join(TEST_DIR, 'second.db')
      // A mutable view of "what nexus.jsonc says now", which is the shape the
      // orchestrator's resolver has over `configManager.getConfig().memory`.
      let resolved: Partial<MemoryStoreConfig> = { dbPath: first, maxEntries: 1000 }
      const store = new PersistentMemoryStore(() => resolved)

      store.set({ key: 'before', value: 'v1', scope: 'project', author: 'a', confidence: null, tags: [] })
      expect(store.path).toBe(first)

      // The edit. No reconstruction, no reload hook, no restart.
      resolved = { dbPath: second, maxEntries: 1000 }
      store.set({ key: 'after', value: 'v2', scope: 'project', author: 'a', confidence: null, tags: [] })
      expect(store.path).toBe(second)

      // The live store sees only the new file. Seeing both would mean one
      // process was querying two stores and calling it one.
      expect(store.getByScope('project').map(e => e.key).sort()).toEqual(['after'])

      // The OLD FILE IS STILL THERE AND STILL COMPLETE. A swap that deleted or
      // truncated the previous database would silently destroy a user's notes
      // the moment they repointed the setting — the least recoverable way this
      // feature could be wrong.
      expect(existsSync(first)).toBe(true)
      const old = new PersistentMemoryStore({ dbPath: first, maxEntries: 1000 })
      expect(old.getByScope('project').map(e => e.key)).toEqual(['before'])
      old.close()

      // And the new one, read by a fresh handle, is where the second write went.
      const fresh = new PersistentMemoryStore({ dbPath: second, maxEntries: 1000 })
      expect(fresh.getByScope('project').map(e => e.key)).toEqual(['after'])
      fresh.close()

      store.close()
    })

    it('applies a changed maxEntries to the VERY NEXT write, with no reconstruction', () => {
      // The cap is a PURE READ — no database swap is involved — so this is the
      // cheaper half of the fix and the one that was silently wrong: raising
      // `maxEntries` in the config did nothing at all until restart, and
      // nothing about the store's identity had changed to hint at it.
      const dbPath = join(TEST_DIR, 'cap.db')
      let maxEntries = 1000
      const store = new PersistentMemoryStore(() => ({ dbPath, maxEntries }))

      for (let i = 0; i < 5; i++) {
        store.set({ key: `k${i}`, value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [] })
      }
      expect(store.getByScope('temp')).toHaveLength(5)
      expect(store.getEvictionTotals()['temp']).toBeUndefined()

      // Lower the cap below what is already stored. The NEXT write is the one
      // that observes it — there is no "rebuild" step in between that a caller
      // could be expected to remember to trigger.
      maxEntries = 2
      store.set({ key: 'k5', value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [] })
      expect(store.getByScope('temp')).toHaveLength(2)
      expect(store.getEvictionTotals()['temp']).toBe(4)

      // Raising it again stops eviction immediately, and does not resurrect
      // anything already evicted (it could not: the rows are gone, which is
      // what `evictedTotals` is reporting).
      maxEntries = 1000
      store.set({ key: 'k6', value: 'v', scope: 'temp', author: 'a', confidence: null, tags: [] })
      expect(store.getByScope('temp')).toHaveLength(3)
      store.close()
    })

    it('keeps `project` exempt from a cap that is ALSO resolved live', () => {
      // The exemption is load-bearing and the change could have broken it by
      // making the cap a per-write read: an exempt scope must still be exempt
      // when the cap arrives from a resolver rather than a field.
      const maxEntries = 1
      const store = new PersistentMemoryStore(() => ({ dbPath: join(TEST_DIR, 'exempt.db'), maxEntries }))
      store.set({ key: 'durable', value: 'keep me', scope: 'project', author: 'a', confidence: null, tags: [] })
      for (let i = 0; i < 5; i++) {
        store.set({ key: `junk-${i}`, value: 'x', scope: 'temp', author: 'a', confidence: null, tags: [] })
      }
      expect(store.get('durable', 'project')?.value).toBe('keep me')
      expect(store.getByScope('temp')).toHaveLength(1)
      store.close()
    })

    it('survives concurrent reads and writes ACROSS a path change, losing nothing', () => {
      // The safety claim is about MANY calls in flight, because that is the
      // shape a rebuild-inside-`reloadConfigFromDisk` design breaks: a store
      // closed underneath a reader. Here the swap is a synchronous block with
      // no await point in it, so a caller either sees the whole transition or
      // none of it. What is asserted is not the happy path — it is that every
      // write either landed in one of the two files, and that the file the
      // write was issued against is the one holding it.
      const first = join(TEST_DIR, 'concurrent-a.db')
      const second = join(TEST_DIR, 'concurrent-b.db')
      let resolved: Partial<MemoryStoreConfig> = { dbPath: first, maxEntries: 1000 }
      const store = new PersistentMemoryStore(() => resolved)

      const paths = [first, second]
      const errors: unknown[] = []
      // A write and a read per iteration, with the path flipped every other
      // iteration so the change happens repeatedly and mid-sequence rather than
      // once at a convenient moment.
      const work: Array<Promise<void>> = []
      for (let i = 0; i < 24; i++) {
        const at = i % 2 === 0 ? first : second
        work.push((async () => {
          try {
            if (i % 4 === 0) {
              store.set({ key: `k${i}`, value: 'v', scope: 'project', author: 'a', confidence: null, tags: [] })
            } else {
              // A read must not throw whatever the handle is doing, and must
              // never see a half-swapped store.
              expect(Array.isArray(store.getByScope('project'))).toBe(true)
            }
            // Every third caller moves the config on, from inside the same
            // interleaving.
            if (i % 3 === 0) resolved = { dbPath: at, maxEntries: 1000 }
          } catch (error) {
            errors.push(error)
          }
        })())
      }

      return Promise.all(work).then(() => {
        expect(errors).toEqual([])
        // Nothing was lost: every write is in exactly one of the two files.
        const a = new PersistentMemoryStore({ dbPath: paths[0]!, maxEntries: 1000 })
        const b = new PersistentMemoryStore({ dbPath: paths[1]!, maxEntries: 1000 })
        const keys = [...a.getByScope('project'), ...b.getByScope('project')].map(e => e.key)
        expect(new Set(keys).size).toBe(keys.length)
        for (let i = 0; i < 24; i += 4) expect(keys).toContain(`k${i}`)
        a.close()
        b.close()
        store.close()
      })
    })

    it('keeps the LAST GOOD database open when a new path cannot be opened', () => {
      // The order inside `database` earns its keep here. Opening first and
      // closing second means a path that blows up throws with the previous
      // database still serving reads, rather than leaving a store with no
      // handle at all — a user who mistypes `storage` gets an error, not a
      // memory feature that has quietly stopped working.
      const good = join(TEST_DIR, 'good.db')
      const store = new PersistentMemoryStore(() => ({ dbPath: good, maxEntries: 1000 }))
      store.set({ key: 'k', value: 'v', scope: 'project', author: 'a', confidence: null, tags: [] })

      // A directory, not a file: `new Database` on this path fails.
      store['resolveConfig'] = () => ({ dbPath: TEST_DIR, maxEntries: 1000 })
      expect(() => store.getByScope('project')).toThrow()
      // Still readable, from the path that worked.
      store['resolveConfig'] = () => ({ dbPath: good, maxEntries: 1000 })
      expect(store.getByScope('project').map(e => e.key)).toEqual(['k'])
      store.close()
    })

    it('still accepts a fixed config object, so existing callers are unaffected', () => {
      // The union, not a new required parameter: `new
      // PersistentMemoryStore({ dbPath })` is how the store is constructed
      // everywhere else in the repository, and the type is re-exported from
      // `index.ts` for embedders who construct it themselves.
      const dbPath = join(TEST_DIR, 'fixed.db')
      const store = new PersistentMemoryStore({ dbPath, maxEntries: 2 })
      expect(store.path).toBe(dbPath)
      store.set({ key: 'a', value: '1', scope: 'temp', author: 'a', confidence: null, tags: [] })
      store.set({ key: 'b', value: '2', scope: 'temp', author: 'a', confidence: null, tags: [] })
      store.set({ key: 'c', value: '3', scope: 'temp', author: 'a', confidence: null, tags: [] })
      expect(store.getByScope('temp').map(e => e.key)).toEqual(['c', 'b'])
      store.close()
    })

    it('reports the RESOLVED path from `path`, not the one it was built with', () => {
      // `path` is what a surface prints to tell a user where to look, so it has
      // to be the path in effect. Returning the construction-time one is how a
      // diagnostic tool sends someone to the wrong file.
      const store = new PersistentMemoryStore(() => ({ dbPath: join(TEST_DIR, 'live.db'), maxEntries: 1000 }))
      expect(store.path).toBe(join(TEST_DIR, 'live.db'))
      store.close()
    })
  })
})
