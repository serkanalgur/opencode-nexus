/** Persistent memory tools. Registered from `setup()` in `src/index.ts`. */
import { describeListResult, describeSearchResult, describeSetResult } from "../memory-recall"
import type { MemoryScope } from "../types"
import type { ToolEditor, ToolDeps } from "./deps"

export function registerMemoryTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

  // ── Memory ───────────────────────────────────────────────────────────
  //
  // Three tools, and the split between them is the point: `set` and
  // `search`/`list` are REACTIVE (an agent has to remember to call them,
  // and agents forget), while the recollection block injected at spawn is
  // PROACTIVE and is what makes a written note actually get used. These
  // tools are also the day-one value: the store ships EMPTY, so the
  // injection half recalls nothing for anyone until something is written
  // here.
  //
  // `scope` on `set` is a THREE-value enum, not the full `MemoryScope`,
  // and the two excluded values are excluded on purpose:
  //   - `session` is the orchestrator's own escalation-transfer channel.
  //     Letting an agent write there would let it fabricate a context blob
  //     that reads as one the orchestrator produced.
  //   - `learning` is an unused string in the table that shares a name with
  //     a different mechanism (`src/learning.ts`) which is written
  //     AUTOMATICALLY on every failure. Never writable, never injected.

  editor.add({
    name: "memory.set",
    description: "Write a durable note. Nothing is ever written automatically — this is the only way in, and nothing is injected into a task's prompt unless the key is `file:<path>` naming a file that task is scoped to. Appends, so correcting a note writes a new version rather than replacing the old. Scope is project (durable) or temp (scratch); session and learning are not writable.",
    input: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The note's key. Use `file:<path>` (e.g. `file:src/memory-store.ts`) to have it injected automatically into tasks touching that file. Any other key is reachable only by search."
        },
        value: { description: "The note. A string, or any JSON value." },
        scope: {
          type: "string",
          enum: ["project", "temp"],
          description: "project = durable and never evicted by count. temp = scratch, FIFO-evicted. Default: project."
        },
        author: {
          type: "string",
          description: "Who is writing this. Required, and SELF-REPORTED: nothing verifies it, and it is shown to readers as a claim rather than a record."
        },
        confidence: {
          type: "number",
          description: "How sure you are, 0–1. Optional. OMIT IT if you are not sure — an entry that records no confidence is not a low-confidence entry, and inventing a number makes your uncertainty invisible to whoever reads it later."
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
        ttl: { type: "number", description: "Optional expiry in ms. Off by default, and for `project` notes that is deliberate: nothing revalidates or rewrites a note, so an expiry would delete it permanently." }
      },
      required: ["key", "value", "author"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { key, value, scope, author, confidence, tags, ttl } = input as {
        key: string; value: unknown; scope?: 'project' | 'temp'; author: string
        confidence?: number; tags?: string[]; ttl?: number
      }
      const targetScope: MemoryScope = scope ?? 'project'
      try {
        const entry = orchestrator.memoryStore.set({
          key,
          value,
          scope: targetScope,
          author,
          confidence: confidence ?? null,
          tags: tags ?? [],
          ...(ttl ? { ttl } : {})
        })
        orchestrator.notifyMemoryWritten(entry)
        // Read AFTER the write, so the count is the number that exists now
        // and includes the entry just written.
        const versionsUnderKey = orchestrator.memoryStore.getByKey(key, targetScope).length
        const eviction = orchestrator.memoryStore.takeEviction()
        return {
          content: describeSetResult({
            entry,
            versionsUnderKey,
            evicted: eviction ? { scope: eviction.scope, count: eviction.count } : null,
          })
        }
      } catch (err) {
        // Reported as text, for the same reason `git.check` reports rather
        // than throws: a tool result the agent can read and relay beats an
        // exception it has to interpret. And it says what did NOT happen, so
        // a failed write is never read as a successful one.
        return { content: `memory.set did not write anything: ${err instanceof Error ? err.message : String(err)}. The store is unchanged.` }
      }
    }
  })

  editor.add({
    name: "memory.search",
    description: "Search notes by substring, over keys AND values. Unranked, so a result count is hits not relevance, and nothing is verified against the code. Project scope only unless you ask for internal session context.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to look for. A path or an identifier matches better than a description." },
        includeSession: {
          type: "boolean",
          description: "Also return internal escalation context — snapshots a failed agent wrote when it exhausted its retries. Those are labelled, never presented as notes, and are never injected into a task. For debugging escalations only."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { query, includeSession } = input as { query: string; includeSession?: boolean }
      // D1, enforced here rather than inside `searchMemory` so the allowlist
      // is visible at the surface that could get it wrong: project by
      // default, project + session only on an explicit opt-in, and never
      // `learning` — which is not a note store at all but the name of a
      // different, automatically-written mechanism.
      const scopes: MemoryScope[] = includeSession ? ['project', 'session'] : ['project']
      const results = orchestrator.searchMemory(query, scopes)
      const stats = orchestrator.memoryStore.getStats()
      return {
        content: describeSearchResult({
          query,
          results,
          storeTotal: stats.total,
          dbPath: orchestrator.memoryStore.path,
          includeSession: includeSession === true,
        })
      }
    }
  })

  editor.add({
    name: "memory.list",
    description: "List notes in a scope, newest version of each key first, with the entry counts by scope and anything evicted for exceeding a per-scope cap. Nothing here is verified against the code.",
    input: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["project", "session", "temp"],
          description: "Which scope to list. Default: project."
        },
        limit: { type: "number", description: "Maximum notes to show. Default 50." }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { scope, limit } = input as { scope?: MemoryScope; limit?: number }
      const targetScope: MemoryScope = scope ?? 'project'
      const cappedAt = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : 50
      const { entries, versionsSuperseded } = orchestrator.listMemory(targetScope, cappedAt)
      const stats = orchestrator.memoryStore.getStats()
      return {
        content: describeListResult({
          scope: targetScope,
          entries,
          versionsSuperseded,
          byScope: stats.byScope,
          evicted: stats.evicted,
          truncatedAt: cappedAt,
          dbPath: orchestrator.memoryStore.path,
        })
      }
    }
  })
}
