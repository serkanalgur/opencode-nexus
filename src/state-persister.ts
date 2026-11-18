/**
 * One writer for the persisted orchestrator snapshot.
 *
 * WHY THIS EXISTS. The snapshot used to be written from eleven places: the
 * debounced state-change listener, and nine tool handlers that each wrote the
 * whole state again right after doing something that had already triggered
 * that listener. Each listener call also wrote a second key,
 * `nexus-sidebar-state`, which nothing read: the TUI keeps its own sidebar
 * store, in a different scope from the server's `ctx.storage` (see the note in
 * `src/tui.tsx`). So one change could produce several full serialisations and
 * storage writes of the same state.
 *
 * Every caller now asks this writer instead. It coalesces: at most one write is
 * in flight, and requests that arrive meanwhile share ONE follow-up write,
 * which reads the state when it starts and so carries everything they changed.
 * The promise a caller gets settles once a write that started after its
 * request has finished, so `await persist()` still means "my change is stored".
 *
 * A failed write is reported, not thrown. The work the caller did has already
 * happened; a storage failure must not turn it into a failed tool call, but it
 * must not vanish either, which is what the old `.catch(() => {})` did.
 */
export function createCoalescingWriter(
  write: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  let queued: Promise<void> | null = null

  const start = (): Promise<void> => {
    const current = write()
      .catch((error: unknown) => { onError(error) })
      .finally(() => {
        if (inFlight === current) inFlight = null
      })
    inFlight = current
    return current
  }

  return () => {
    if (!inFlight) return start()
    if (!queued) {
      queued = inFlight.then(() => {
        queued = null
        return start()
      })
    }
    return queued
  }
}

/**
 * The orchestrator state as storage accepts it: plain JSON. `Date`s become ISO
 * strings and `undefined` fields are dropped, exactly as the
 * `JSON.parse(JSON.stringify(...))` at each old call site did.
 */
export function toStorageJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value))
}
