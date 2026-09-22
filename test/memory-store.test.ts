import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { PersistentMemoryStore, type MemoryStoreConfig } from '../src/memory-store'
import { unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Use a temp directory for tests
const TEST_DIR = join(import.meta.dir, '..', '.test-tmp')
const TEST_DB_PATH = join(TEST_DIR, 'test-memory.db')

function makeConfig(overrides?: Partial<MemoryStoreConfig>): Partial<MemoryStoreConfig> {
  return {
    dbPath: TEST_DB_PATH,
    defaultTTL: 0,
    maxEntries: 10000,
    ...overrides,
  }
}

function cleanup() {
  try {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH)
    if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal')
    if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm')
  } catch {}
}

describe('PersistentMemoryStore', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    cleanup()
  })

  afterEach(() => {
    cleanup()
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
})
