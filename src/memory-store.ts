import type { MemoryEntry, MemoryScope } from "./types"
import { Database } from "bun:sqlite"
import { join, dirname } from "node:path"
import { mkdirSync } from "node:fs"

export interface MemoryStoreConfig {
  dbPath: string
  defaultTTL: number    // ms, 0 = no expiry
  maxEntries: number
}

const DEFAULT_CONFIG: MemoryStoreConfig = {
  dbPath: join(process.env.HOME || '~', '.local', 'share', 'opencode-nexus', 'memory.db'),
  defaultTTL: 0,
  maxEntries: 10000,
}

export class PersistentMemoryStore {
  private db: Database
  private config: MemoryStoreConfig

  constructor(config?: Partial<MemoryStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Ensure directory exists
    try { mkdirSync(dirname(this.config.dbPath), { recursive: true }) } catch {}

    this.db = new Database(this.config.dbPath)
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        scope TEXT NOT NULL,
        author TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        confidence REAL DEFAULT 1.0,
        tags TEXT DEFAULT '[]',
        ttl INTEGER DEFAULT 0,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
      CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key);
      CREATE INDEX IF NOT EXISTS idx_memory_author ON memory(author);
    `)
  }

  set(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry {
    const id = `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const timestamp = Date.now()
    const expiresAt = entry.ttl ? timestamp + entry.ttl : null

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory (id, key, value, scope, author, timestamp, confidence, tags, ttl, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(id, entry.key, JSON.stringify(entry.value), entry.scope, entry.author,
             timestamp, entry.confidence, JSON.stringify(entry.tags || []), entry.ttl || 0, expiresAt)

    return { ...entry, id, timestamp: new Date(timestamp) }
  }

  get(key: string, scope?: MemoryScope): MemoryEntry | null {
    const entries = this.getByKey(key, scope)
    return entries[entries.length - 1] || null
  }

  getByKey(key: string, scope?: MemoryScope): MemoryEntry[] {
    let query = 'SELECT * FROM memory WHERE key = ?'
    const params: any[] = [key]

    if (scope) {
      query += ' AND scope = ?'
      params.push(scope)
    }

    query += ' AND (expires_at IS NULL OR expires_at > ?)'
    params.push(Date.now())

    const rows = this.db.prepare(query).all(...params) as any[]
    return rows.map(this.rowToEntry)
  }

  getByScope(scope: MemoryScope): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC'
    ).all(scope, Date.now()) as any[]
    return rows.map(this.rowToEntry)
  }

  search(query: string): MemoryEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM memory WHERE (key LIKE ? OR value LIKE ?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC`
    ).all(`%${query}%`, `%${query}%`, Date.now()) as any[]
    return rows.map(this.rowToEntry)
  }

  getRecent(count: number): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC LIMIT ?'
    ).all(Date.now(), count) as any[]
    return rows.map(this.rowToEntry)
  }

  getByAuthor(author: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory WHERE author = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC'
    ).all(author, Date.now()) as any[]
    return rows.map(this.rowToEntry)
  }

  delete(key: string, scope?: MemoryScope): boolean {
    let query = 'DELETE FROM memory WHERE key = ?'
    const params: any[] = [key]
    if (scope) { query += ' AND scope = ?'; params.push(scope) }
    const result = this.db.prepare(query).run(...params)
    return result.changes > 0
  }

  clear(scope?: MemoryScope): number {
    let query = 'DELETE FROM memory'
    const params: any[] = []
    if (scope) { query += ' WHERE scope = ?'; params.push(scope) }
    const result = this.db.prepare(query).run(...params)
    return result.changes
  }

  getStats(): { total: number; byScope: Record<string, number>; expired: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM memory').get() as any).count
    const byScope: Record<string, number> = {}
    const scopes = this.db.prepare('SELECT DISTINCT scope FROM memory').all() as any[]
    for (const { scope } of scopes) {
      byScope[scope] = (this.db.prepare('SELECT COUNT(*) as count FROM memory WHERE scope = ?').get(scope) as any).count
    }
    const expired = (this.db.prepare('SELECT COUNT(*) as count FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?').get(Date.now()) as any).count
    return { total, byScope, expired }
  }

  private rowToEntry(row: any): MemoryEntry {
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      // Corrupted value — store raw string instead of crashing
      value = row.value
    }

    let tags: string[] = []
    try {
      tags = JSON.parse(row.tags || '[]')
    } catch {
      // Corrupted tags — default to empty array
      tags = []
    }

    return {
      id: row.id,
      key: row.key,
      value,
      scope: row.scope as MemoryScope,
      author: row.author,
      timestamp: new Date(row.timestamp),
      confidence: row.confidence,
      tags,
      ttl: row.ttl || undefined
    }
  }

  close(): void {
    this.db.close()
  }
}
