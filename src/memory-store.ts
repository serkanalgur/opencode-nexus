import type { MemoryEntry, MemoryScope } from "./types"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { join, dirname } from "node:path"
import { mkdirSync } from "node:fs"

export interface MemoryStoreConfig {
  dbPath: string
  /**
   * Per-scope cap on stored entries, oldest evicted first.
   *
   * This was declared, defaulted to 10000, and READ BY NOTHING — the same
   * shape as `PerformanceTracker.maxEntries` (which does enforce it) with the
   * enforcement left out. The table therefore grew without bound, and the `LIKE`
   * scan backing `search` scanned all of it.
   *
   * `project` is EXEMPT, and the exemption is the point rather than an
   * oversight. `ExecutionHistory` (500 records) and `PerformanceTracker` (1000
   * entries) are process-lifetime caches, so FIFO there loses a cache. Memory
   * is the durable store: evicting a `project` note because a thousand
   * disposable `temp` entries arrived would destroy the only thing a user
   * actually wrote down, in exchange for bounding rows nobody reads. So the
   * cap applies per scope, and the scope that holds a human's durable notes is
   * exempt from it. See `evictOverflow`.
   */
  maxEntries: number
}

/**
 * Injection point for the store's millisecond clock. Deliberately NOT part of
 * `MemoryStoreConfig`, which is a user-facing knob type that the orchestrator
 * forwards and `index.ts` re-exports: a test seam has no business widening
 * that surface, so it is a separate optional parameter instead.
 *
 * It exists for one reason: "the newest version of this key wins" is decided by
 * `ORDER BY timestamp, id`, and the `id` half of that only matters when two
 * writes share a millisecond. A test cannot make two writes share a millisecond
 * by trying — it can only observe whether it happened, and assert on the
 * observation. A test that observes its own preconditions is a test that fails
 * on a slow machine and passes on a fast one, which is the same defect wearing
 * a different hat. Pinning the clock makes the tie a fact the test builds
 * rather than a fact it hopes for.
 *
 * Real production callers pass nothing and get `Date.now`.
 */
export interface MemoryStoreOptions {
  /** Millisecond epoch source. Defaults to `Date.now`. */
  now?: () => number
}

const DEFAULT_CONFIG: MemoryStoreConfig = {
  // MUST mirror `NexusFullConfig`'s `DEFAULT_CONFIG.memory.storage`
  // (`src/config.ts`) exactly, expression and all. The same default is written
  // down in two places because a user can now see and change it in
  // `nexus.jsonc`; if the two drift, the config reports a path the store is not
  // using, with nothing logging the disagreement. If you change one, change
  // both.
  //
  // The two literals are the same value by CONSTRUCTION rather than by
  // coincidence: the store never falls back to this one behind the config's
  // back, because the orchestrator feeds it a resolver over
  // `configManager.getConfig().memory` (see the constructor), and this default
  // only applies when a caller supplies no config at all. So the mirror is not a
  // "change both" convention resting on review — a change to one and not the
  // other is a bug `test/config-knobs.test.ts` fails on. The resolution is LIVE:
  // an edit to either key takes effect on the next store call, with no restart.
  dbPath: join(process.env.HOME || '~', '.local', 'share', 'opencode-nexus', 'memory.db'),
  // Mirrored by `DEFAULT_CONFIG.memory.maxEntries` in `src/config.ts`, and
  // applied live: read on every `set` rather than frozen here. See
  // `evictOverflow`.
  maxEntries: 1000,
}

/**
 * A live view of the store's settings.
 *
 * `() => Partial<MemoryStoreConfig>` rather than the full config, because every
 * real caller has the merged result already and a required `dbPath` would make
 * each of them restate a default. Both fields merge over `DEFAULT_CONFIG`.
 */
export type MemoryStoreConfigResolver = () => Partial<MemoryStoreConfig>

/**
 * Merge config layers over the defaults, IGNORING `undefined`-valued keys.
 *
 * Not a spread, and the difference is the same one that cost `memory.storage` a
 * whole key once already (`src/config.ts`, the filtered `memorySeed`): object
 * spread copies own enumerable keys INCLUDING ones whose value is
 * `undefined`, so `{ storage: undefined }` would DELETE the key rather than fall
 * through to the default. Callers legitimately pass literals of
 * possibly-absent fields — the orchestrator's constructor parameter is one — so
 * this is the expected shape here, not a hypothetical.
 */
function mergeStoreConfig(...layers: Array<Partial<MemoryStoreConfig> | undefined>): MemoryStoreConfig {
  const merged: MemoryStoreConfig = { ...DEFAULT_CONFIG }
  for (const layer of layers) {
    if (layer?.dbPath !== undefined) merged.dbPath = layer.dbPath
    if (layer?.maxEntries !== undefined) merged.maxEntries = layer.maxEntries
  }
  return merged
}

/**
 * Scopes exempt from `maxEntries`, because what they hold is a human's
 * deliberate record rather than a cache line.
 *
 * See `MemoryStoreConfig.maxEntries` for why the durable scope is exempt and
 * the disposable ones are not.
 */
const COUNT_EXEMPT_SCOPES: ReadonlySet<string> = new Set<MemoryScope>(['project'])

/**
 * One round of count-based eviction, as reported to the caller.
 *
 * Eviction is REPORTED and never silent, following the rule the dashboard
 * already applies to a truncated list (a line showing three of nine must say
 * three of nine, or it reads as three). A note that vanished with no output is
 * a note the user cannot discover was ever there, and a memory store that
 * silently drops a user's writing is a store they stop writing into.
 */
export interface MemoryEviction {
  scope: MemoryScope
  /** How many entries this round removed. */
  count: number
  /**
   * `timestamp` of the OLDEST entry removed, so a reader can say when the
   * thing that disappeared was written. `null` when `count` is 0, because
   * "the oldest thing I deleted" is not a question with an answer when I
   * deleted nothing.
   */
  oldestEvictedAt: Date | null
}

export class PersistentMemoryStore {
  /**
   * The open handle, or `null` when nothing is open.
   *
   * Nullable because it is no longer opened once in the constructor and held for
   * the life of the process: it is opened for the path that is CURRENTLY
   * resolved, and re-opened when that changes. See `database`.
   */
  private db: Database | null = null
  /**
   * The path `db` was opened for, and the thing `database` compares a freshly
   * resolved path against. Stored beside the handle rather than recomputed from
   * it, because the resolved path is a config value and the handle does not
   * report the file it came from.
   */
  private openPath: string | null = null
  /**
   * Set by `close`. Distinguished from "nothing is open yet" so a closed store
   * stays closed: lazily reopening on the next call would turn an explicit
   * `shutdown()` into a no-op that silently resurrects the file.
   */
  private closed = false
  /**
   * Where the settings come from, re-read on every use.
   *
   * A FUNCTION, not a snapshot, and that is the whole point of the field: a
   * `storage` or `maxEntries` edit made in `nexus.jsonc` has to be observable by
   * the running process. Holding a copy — which is what this field used to be —
   * made the config panel report a saved value the store ignored until restart.
   */
  private resolveConfig: MemoryStoreConfigResolver
  /**
   * Cumulative per-scope count of entries removed by `maxEntries`, so a
   * surface can report "12 notes have been evicted" rather than leaving a user
   * to infer it from a missing one. Survives neither restart nor `close` —
   * it is a report about this process's behaviour, and recomputing it from
   * evicted rows is not possible because the rows are gone. That is stated
   * rather than hidden: a counter that resets on restart under-reports, and a
   * durable total would need a second table.
   */
  private evictedTotals: Map<MemoryScope, number> = new Map()

  /**
   * Monotonic per-process write counter, used to break timestamp ties in the
   * id.
   *
   * NOT cosmetic. "The newest version of this key wins" is load-bearing — it is
   * how a correction supersedes the thing it corrects, and how `supersedes: 2`
   * becomes a true statement. `getByKey` orders by `timestamp, id`, and two
   * writes in the SAME MILLISECOND have the same timestamp. The id used to end
   * in nine random characters, so between two same-millisecond writes the order
   * was RANDOM: which version of a note was current, and therefore which one
   * every agent was shown, was decided by `Math.random()`. A user correcting a
   * note twice in quick succession could have the old text win.
   *
   * Fixed-width base-36 so the lexicographic tie-break on `id` follows
   * insertion order — unpadded, `...-9-` sorts after `...-10-`. It resets per
   * process, which is harmless: two writes collide on timestamp only within one
   * millisecond, and a counter that resets cannot be the tie-break for two
   * writes separated by a process lifetime.
   */
  private writeCounter = 0
  /**
   * The most recent eviction, or `null` if this process has evicted nothing.
   *
   * Consumed by the orchestrator, which turns it into a `memory:evicted` event
   * so eviction reaches a surface a user can see. Held as a single slot rather
   * than a queue: `set` evicts at most one round per call, and the orchestrator
   * drains it after the write that caused it. A queue would grow on a write
   * path that must not allocate.
   */
  private lastEviction: MemoryEviction | null = null

  /**
   * The store's clock. A field rather than a bare `Date.now()` at each call site
   * so that WRITE time and READ time come from one source: a test that pins
   * writes without pinning reads would store entries that are already expired
   * the moment they are written, and the resulting test would be asserting
   * about a store nobody runs.
   */
  private now: () => number

  /**
   * @param config Either a fixed `Partial<MemoryStoreConfig>`, or a RESOLVER
   *   re-read on every use so `storage` / `maxEntries` take effect live. The
   *   union rather than a second parameter because a fixed config is just the
   *   degenerate resolver, and every existing caller passes the former — which
   *   is why this is backward compatible and not a breaking change.
   * @param options Clock seam, unchanged.
   */
  constructor(
    config?: Partial<MemoryStoreConfig> | MemoryStoreConfigResolver,
    options?: MemoryStoreOptions,
  ) {
    this.resolveConfig = typeof config === 'function' ? config : () => config ?? {}
    this.now = options?.now ?? (() => Date.now())

    // Opened eagerly rather than truly on first use, and the difference is
    // worth naming: this is still the first USE, it just happens to be the
    // constructor. Opening here means a bad path or an unwritable directory
    // throws at construction — where the stack names the caller — instead of
    // surfacing as a mysterious failure inside some agent's recall. A path
    // change LATER is the part that is deferred, and that is the part that has
    // to be, because the value cannot exist before the config is re-read.
    this.database()
  }

  /**
   * The settings as of right now.
   *
   * A fresh object per call, so a caller cannot capture one and hold a stale
   * copy — `evictOverflow` deliberately re-reads this per write rather than
   * trusting a value resolved at the top of `set`.
   */
  private currentConfig(): MemoryStoreConfig {
    return mergeStoreConfig(this.resolveConfig())
  }

  /**
   * The open database for the CURRENTLY resolved path, opening or swapping it
   * as needed.
   *
   * ── WHY A SWAP IS SAFE HERE, AND WHY IT IS SYNCHRONOUS ──
   *
   * `bun:sqlite` is synchronous, so this whole method runs to completion with no
   * await point in it. JavaScript is single-threaded, so no other `recallForTask`
   * — however many agents are mid-flight — can observe a state between "decided
   * to swap" and "finished swapping": the next caller to arrive runs after this
   * one returns. The race a rebuild-in-`reloadConfigFromDisk` design has (every
   * in-flight reader holding a handle to a store that is being closed underneath
   * it) does not exist when the swap is confined to one synchronous block.
   *
   * The ORDER is what makes a failure recoverable rather than destructive: the
   * new handle is opened AND initialised first, and only then is the old one
   * closed. A path that cannot be opened throws with the previous database
   * still open and still current, so the store keeps serving reads from the last
   * good path instead of ending up with no handle at all. A `close` that throws
   * is swallowed for the mirror-image reason: the new handle is already open, and
   * losing it over a cleanup failure would be strictly worse than leaking the old
   * one.
   */
  private database(): Database {
    if (this.closed) throw new Error('memory store is closed')
    const { dbPath } = this.currentConfig()
    if (this.db !== null && this.openPath === dbPath) return this.db

    try { mkdirSync(dirname(dbPath), { recursive: true }) } catch {}
    const opened = new Database(dbPath)
    try {
      this.init(opened)
    } catch (error) {
      // Never leave a half-open handle behind: the old database is still the
      // live one, and an extra connection to a file the caller is about to be
      // told is unusable is a lock they did not ask for.
      try { opened.close() } catch {}
      throw error
    }
    if (this.db !== null) {
      try { this.db.close() } catch {}
    }
    this.db = opened
    this.openPath = dbPath
    return opened
  }

  private init(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        scope TEXT NOT NULL,
        author TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        confidence REAL,
        tags TEXT DEFAULT '[]',
        ttl INTEGER DEFAULT 0,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
      CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key);
      CREATE INDEX IF NOT EXISTS idx_memory_author ON memory(author);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_timestamp ON memory(scope, timestamp);
    `)
  }

  /**
   * Append one entry.
   *
   * THIS APPENDS. IT DOES NOT UPSERT, AND THAT IS THE DESIGN.
   *
   * The statement below reads `INSERT OR REPLACE`, and that clause is dead
   * code: `id` is the primary key and the id is minted fresh on every call, so
   * a conflict can never arise and `OR REPLACE` never fires. Writing the same
   * `(scope, key)` twice therefore produces two rows, and the second is what
   * `get` resolves to.
   *
   * It is left appending deliberately, even though the statement suggests an
   * upsert and even though the clause is removed below to stop it reading as
   * one. An upsert on `(scope, key)` would overwrite the previous version, and
   * then the store could no longer answer "when did we believe this?" — which
   * is the question a stale-memory bug always turns out to be, and the only
   * question that makes a correction visible. Appending is what lets
   * `supersedes: 2` be a true statement instead of a guess. `getByKey` is
   * ordered, so "the newest version of this key" is a contract rather than an
   * accident of rowid order.
   *
   * The consequence a caller must not be surprised by: correcting a note does
   * not replace it, and the old version stays readable. There is no in-product
   * way to REMOVE an entry — `delete` is API-only, not a tool, because an
   * agent that finds a note inconvenient will delete it to unblock itself and
   * there is no confirmation step an agent honours.
   *
   * `confidence` is written as given, including `null`. It is not defaulted
   * here: see `MemoryEntry.confidence`.
   */
  set(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry {
    this.writeCounter = (this.writeCounter + 1) % 36 ** SEQUENCE_WIDTH
    const sequence = this.writeCounter.toString(36).padStart(SEQUENCE_WIDTH, '0')
    // ONE clock read, used for BOTH the id's timestamp segment and the row's
    // `timestamp`. These were two separate `Date.now()` calls, which could
    // disagree by a millisecond: an id stamped T while the row claims T+1.
    //
    // That could not produce a wrong ORDER, and the reason is worth recording so
    // nobody "discovers" it as a bug later. Ordering is by `timestamp` first, so
    // the only case the id segment decides is two rows with EQUAL timestamps.
    // Read a for both uses, `a1 <= a2`; read b afterwards, so `a2 <= b1`; if
    // `a2 == b2` then `a1 <= a2 == b2 <= b1`, i.e. the id segments are correctly
    // ordered too. The divergence was real but harmless. It is now gone anyway,
    // because an id that embeds a time its own row does not claim is a thing a
    // reader has to re-derive rather than check.
    const timestamp = this.now()
    // `mem-` prefix, then the timestamp, then the monotonic sequence, then a
    // random tail. The random part keeps ids unique ACROSS processes writing in
    // the same millisecond; the sequence is what makes the ORDER WITHIN one
    // process follow insertion order. See `writeCounter`.
    const id = `mem-${timestamp}-${sequence}-${Math.random().toString(36).substr(2, 9)}`
    const expiresAt = entry.ttl ? timestamp + entry.ttl : null

    const stmt = this.database().prepare(`
      INSERT INTO memory (id, key, value, scope, author, timestamp, confidence, tags, ttl, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(id, entry.key, JSON.stringify(entry.value), entry.scope, entry.author,
             timestamp, entry.confidence, JSON.stringify(entry.tags || []), entry.ttl || 0, expiresAt)

    this.evictOverflow(entry.scope)

    return { ...entry, id, timestamp: new Date(timestamp) }
  }

  /**
   * Remove the oldest rows in `scope` until it is within `maxEntries`.
   *
   * Exempt scopes are left alone, and expired rows in an exempt scope are not
   * touched either — a `project` note whose TTL has passed is still a row
   * someone wrote, and deleting it here would be eviction by a rule that does
   * not apply to it. Expired rows in capped scopes are fair game: they are
   * already invisible to every read in this class, so they occupy the cap
   * without earning it.
   *
   * No-op (and therefore silent) for an exempt scope or when nothing is over
   * the cap. A caller that wants the totals does not have to poll for them.
   */
  private evictOverflow(scope: MemoryScope): void {
    if (COUNT_EXEMPT_SCOPES.has(scope)) return
    // THE CAP IS A PURE READ, resolved on EVERY write. It is not snapshotted at
    // construction, and it needs no database swap: lowering `maxEntries` in
    // `nexus.jsonc` makes the very next `set` evict down to the new number, with
    // no restart and no reopening. Reading it once per `set` rather than once
    // per process is what makes the setting live.
    const maxEntries = this.currentConfig().maxEntries
    if (maxEntries <= 0) return
    const db = this.database()

    // Expired first: they are unreadable already, so spending cap headroom on
    // them evicts a LIVE row in their place for no gain.
    // `id ASC` tie-breaks same-millisecond writes, which share a `timestamp`;
    // see `getRecent`. Without it, "the oldest N" is an arbitrary set whenever
    // two writes land in the same millisecond, and the entry evicted would be
    // whichever the query plan reached first.
    const expired = db.prepare(
      'SELECT id, timestamp FROM memory WHERE scope = ? AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY timestamp ASC, id ASC'
    ).all(scope, this.now()) as Array<{ id: string; timestamp: number }>

    const live = (db.prepare(
      'SELECT COUNT(*) as count FROM memory WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).get(scope, this.now()) as { count: number }).count

    let over = expired.length + (live - maxEntries)

    let oldestEvictedAt: number | null = null
    let count = 0
    const deleteStmt = db.prepare('DELETE FROM memory WHERE id = ?')

    if (over > 0) {
      for (const row of expired) {
        if (over <= 0) break
        deleteStmt.run(row.id)
        over--
        count++
        if (oldestEvictedAt === null || row.timestamp < oldestEvictedAt) oldestEvictedAt = row.timestamp
      }
    }

    if (over > 0) {
      const liveRows = db.prepare(
        'SELECT id, timestamp FROM memory WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp ASC, id ASC LIMIT ?'
      ).all(scope, this.now(), over) as Array<{ id: string; timestamp: number }>
      for (const row of liveRows) {
        deleteStmt.run(row.id)
        count++
        if (oldestEvictedAt === null || row.timestamp < oldestEvictedAt) oldestEvictedAt = row.timestamp
      }
    }

    if (count > 0) {
      this.evictedTotals.set(scope, (this.evictedTotals.get(scope) ?? 0) + count)
      this.lastEviction = {
        scope,
        count,
        oldestEvictedAt: oldestEvictedAt === null ? null : new Date(oldestEvictedAt),
      }
    }
  }

  /**
   * Take the pending eviction report, leaving the slot empty.
   *
   * Draining rather than reading, so a caller that reports an eviction and
   * then reads the counter sees both the event and the running total exactly
   * once, and a caller that reports nothing does not re-report an old one.
   */
  takeEviction(): MemoryEviction | null {
    const eviction = this.lastEviction
    this.lastEviction = null
    return eviction
  }

  /**
   * Cumulative per-scope evictions this process has performed.
   *
   * Process-scoped, not durable: see the note on `evictedTotals`. It resets on
   * restart and therefore UNDER-reports across restarts, which is why the
   * surfaces that show it also say what it counts.
   */
  getEvictionTotals(): Record<string, number> {
    return Object.fromEntries(this.evictedTotals)
  }

  /**
   * Where this store lives on disk.
   *
   * Exposed because the two EMPTY results have to be told apart, and telling
   * them apart means naming the file: "nothing was ever written" and "your
   * query matched nothing" look identical until the reader is told which one
   * they are looking at and where to go and look. See
   * `describeEmptyResult` in `src/memory-recall.ts`.
   */
  get path(): string {
    return this.currentConfig().dbPath
  }

  get(key: string, scope?: MemoryScope): MemoryEntry | null {
    const entries = this.getByKey(key, scope)
    return entries[entries.length - 1] || null
  }

  /**
   * Every non-expired entry for a key, OLDEST FIRST.
   *
   * The `ORDER BY` is the reason `get` can claim to return the newest version
   * of a key. Without it this query was unordered and `get` took
   * `[length - 1]`, which returned the right answer only because SQLite scans
   * a rowid table in insertion order — correct by accident, and the accident
   * would have broken the first time a `WITHOUT ROWID` rewrite or an index
   * hint changed the scan. `id` breaks the tie because two entries written in
   * the same millisecond have equal timestamps, and "newest" must not be
   * decided by the order the storage engine happened to return them in.
   */
  getByKey(key: string, scope?: MemoryScope): MemoryEntry[] {
    const db = this.database()
    let query = 'SELECT * FROM memory WHERE key = ?'
    const params: SQLQueryBindings[] = [key]

    if (scope) {
      query += ' AND scope = ?'
      params.push(scope)
    }

    query += ' AND (expires_at IS NULL OR expires_at > ?)'
    params.push(this.now())

    query += ' ORDER BY timestamp ASC, id ASC'

    const rows = db.prepare(query).all(...params) as RowData[]
    return rows.map(row => this.rowToEntry(row))
  }

  getByScope(scope: MemoryScope): MemoryEntry[] {
    const rows = this.database().prepare(
      'SELECT * FROM memory WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC, id DESC'
    ).all(scope, this.now()) as RowData[]
    return rows.map(row => this.rowToEntry(row))
  }

  /**
   * Substring match over BOTH the key and the JSON-serialised value.
   *
   * This is what the `memory.search` TOOL uses, and automatic retrieval does NOT
   * use it — automatic retrieval only does exact `getByKey` lookups on `file:`
   * keys, so it can neither be fooled by a common word nor reach into a value.
   *
   * The value half makes matching weak in a way the caller has to be told
   * about: a stored value is arbitrary JSON, so `%q%` matches any field
   * nested anywhere inside it. Searching `8080` returns entries whose *key*
   * says nothing about ports and whose value mentions 8080 in some unrelated
   * field. There is no ranking either — this returns every match, ordered by
   * time — so a result count is a hit count, never a relevance count. An agent
   * can judge a weak hit and discard it, which is why this is acceptable behind
   * a tool that says so; the same result injected unjudgeable into a prompt
   * would not be.
   *
   * `scope` narrows the match. It is optional so this stays a superset of its
   * old behaviour, but every tool-facing caller passes one: without it a user
   * asking what nexus remembers about retries gets back an agent's escalation
   * blob, nested `memoryEntries` and all, rendered as though it were a note.
   */
  search(query: string, scope?: MemoryScope): MemoryEntry[] {
    const db = this.database()
    let sql = `SELECT * FROM memory WHERE (key LIKE ? OR value LIKE ?) AND (expires_at IS NULL OR expires_at > ?)`
    const params: SQLQueryBindings[] = [`%${query}%`, `%${query}%`, this.now()]
    if (scope) {
      sql += ' AND scope = ?'
      params.push(scope)
    }
    // `id DESC` tie-breaks same-millisecond writes, which share a `timestamp`.
    // See `getRecent` for why that is not optional.
    sql += ' ORDER BY timestamp DESC, id DESC'
    const rows = db.prepare(sql).all(...params) as RowData[]
    return rows.map(row => this.rowToEntry(row))
  }

  /**
   * The newest entries, newest first.
   *
   * `id DESC` is the tie-break, and it is not decoration: two writes in the
   * same millisecond share a `timestamp`, and without a second sort key SQLite
   * is free to return those two rows in either order. `getRecent(2)` on a store
   * holding two same-millisecond entries would then be right or wrong
   * depending on the query plan — which is how `listMemory` came to show a
   * user the note they had just corrected, on a run that passed and a run that
   * did not. Ids are monotonic within a process (see `writeCounter`), so
   * `id DESC` is "newest first" with no gaps.
   */
  getRecent(count: number): MemoryEntry[] {
    const rows = this.database().prepare(
      'SELECT * FROM memory WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC, id DESC LIMIT ?'
    ).all(this.now(), count) as RowData[]
    return rows.map(row => this.rowToEntry(row))
  }

  getByAuthor(author: string): MemoryEntry[] {
    const rows = this.database().prepare(
      'SELECT * FROM memory WHERE author = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY timestamp DESC, id DESC'
    ).all(author, this.now()) as RowData[]
    return rows.map(row => this.rowToEntry(row))
  }

  /**
   * Delete every entry under a key, and report whether anything went.
   *
   * API-ONLY ON PURPOSE, and there is no `memory.delete` TOOL. The reasoning is
   * about who is asking: an agent that finds a note inconvenient can delete it
   * to unblock itself, and there is no confirmation step an agent honours — the
   * confirmation would be text written by the deleting party. A human running a
   * script is the only caller whose interest in removing a wrong note can be
   * assumed to outlive the removal.
   *
   * THE CONSEQUENCE, WHICH IS A REAL GAP AND NOT A DETAIL: there is no in-product
   * path for a non-programmer to remove a wrong note. `set` appends, so the
   * natural move is to write a correction and let the newest version win by
   * timestamp — which works, and leaves every earlier version readable under
   * the same key. "Remove" itself is reachable only from code. If this feature
   * gets used enough for that to bite, a dashboard affordance is the fix, and
   * it is the first thing to build.
   *
   * With `scope` omitted this removes the key in EVERY scope, which is broader
   * than any caller above means to express. Pass the scope.
   */
  delete(key: string, scope?: MemoryScope): boolean {
    const db = this.database()
    let query = 'DELETE FROM memory WHERE key = ?'
    const params: SQLQueryBindings[] = [key]
    if (scope) { query += ' AND scope = ?'; params.push(scope) }
    const result = db.prepare(query).run(...params)
    return result.changes > 0
  }

  clear(scope?: MemoryScope): number {
    const db = this.database()
    let query = 'DELETE FROM memory'
    const params: SQLQueryBindings[] = []
    if (scope) { query += ' WHERE scope = ?'; params.push(scope) }
    const result = db.prepare(query).run(...params)
    return result.changes
  }

  /**
   * Row counts, and how much `maxEntries` has thrown away this process.
   * `evicted` is reported here rather than left to a log line because the
   * alternative is a store that shrinks for reasons the user cannot find. A
   * note that vanished silently is a note they will assume was never written,
   * and then never write again.
   *
   * `evicted` counts THIS PROCESS only (see `evictedTotals`), so it is reported
   * as what it is — a per-run total, not a lifetime figure.
   */
  getStats(): { total: number; byScope: Record<string, number>; expired: number; evicted: Record<string, number> } {
    const db = this.database()
    const total = (db.prepare('SELECT COUNT(*) as count FROM memory').get() as CountRow).count
    const byScope: Record<string, number> = {}
    const scopes = db.prepare('SELECT DISTINCT scope FROM memory').all() as Array<{ scope: string }>
    for (const { scope } of scopes) {
      byScope[scope] = (db.prepare('SELECT COUNT(*) as count FROM memory WHERE scope = ?').get(scope) as CountRow).count
    }
    const expired = (db.prepare('SELECT COUNT(*) as count FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?').get(this.now()) as CountRow).count
    return { total, byScope, expired, evicted: this.getEvictionTotals() }
  }

  private rowToEntry(row: RowData): MemoryEntry {
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      // Corrupted value — store raw string instead of crashing
      value = row.value
    }

    let tags: string[]
    try {
      const parsed: unknown = JSON.parse(row.tags || '[]')
      // A non-array `tags` column parses cleanly and is then not `string[]`, so
      // the shape is checked rather than assumed. Before this, `any` on the row
      // is what let a bad value in.
      tags = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
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

  /**
   * Close the open handle. Idempotent, and terminal: a later store call throws
   * rather than reopening, so `shutdown()` cannot be undone by a recall that
   * races teardown.
   */
  close(): void {
    this.closed = true
    this.openPath = null
    const db = this.db
    this.db = null
    db?.close()
  }
}

/** One `SELECT *` row. Every field is typed as the column actually is. */
interface RowData {
  id: string
  key: string
  value: string
  scope: string
  author: string
  timestamp: number
  confidence: number | null
  tags: string | null
  ttl: number | null
}

/** One `SELECT COUNT(*) as count` row. */
interface CountRow {
  count: number
}

/**
 * Digits of the write-sequence segment of an id, in base 36.
 *
 * Fixed width, because the id is compared as TEXT to break timestamp ties and
 * an unpadded number sorts wrong: `mem-1-9-x` is greater than `mem-1-10-x`.
 */
const SEQUENCE_WIDTH = 6

/**
 * Which of two entries was written LATER.
 *
 * COMPARES THE ID, NOT THE TIMESTAMP, and that is the whole point. Two writes in
 * the same millisecond share a `timestamp`, so a timestamp comparison is a tie,
 * and whatever a caller picks to break that tie is arbitrary. That is not
 * hypothetical: `listMemory` collapsed a key to whichever version arrived last,
 * `getByScope` returns newest-first, and so a user who corrected a note was
 * shown the text they had just replaced — on roughly half the runs.
 *
 * String comparison of the id is a valid global write order, because the id is
 * built most-significant-first: `mem-<13-digit ms>-<fixed-width base-36
 * sequence>-<random tail>`. The timestamp segment dominates, the sequence
 * segment orders writes inside one millisecond within one process (see
 * `writeCounter`), and the random tail only decides the order of two writes from
 * DIFFERENT processes in the same millisecond — where either order is
 * acceptable, because no single process holds a "current version" claim about
 * the other's write.
 */
export function isNewerThan(candidate: MemoryEntry, other: MemoryEntry): boolean {
  return candidate.id > other.id
}
