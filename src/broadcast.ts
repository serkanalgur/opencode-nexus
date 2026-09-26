import type { NexusOrchestrator } from "./orchestrator"

/**
 * A minimal WebSocket-like interface so we don't depend on any specific WS library.
 * Any object with a send(data: string) method works (e.g. ws from 'ws' or Bun.serve).
 */
export interface WebSocketLike {
  send(data: string): void
}

/**
 * Every orchestrator event the broadcaster forwards to WebSocket clients.
 *
 * This list used to be four events long — `agent:spawned`,
 * `agent:terminated`, `budget:alert`, `budget:exceeded` — which was the wiring
 * the original dashboard had, and which is why rewiring the socket alone gained
 * nothing: nine of the thirteen events the orchestrator actually emits
 * (`task:failed`, `cost:delta`, `agent:escalation`, `security:issues-found`,
 * `memory:set`, `config:reloaded`, and the three `orchestrator:*` lifecycle
 * events) reached no client at all.
 *
 * It is EXPORTED, and a test ties it to the `this.emit(...)` sites in
 * `orchestrator.ts`, because a hand-maintained second copy of a list that lives
 * in the code is precisely the thing that drifts: an event added to the
 * orchestrator and not here is silent, and nothing at runtime complains. The
 * test is `test/broadcast-event-coverage.test.ts`.
 *
 * `orchestrator:state` is deliberately NOT in this list: it is produced by
 * `broadcastState()` rather than subscribed to, because it is throttled while
 * these are not.
 */
export const BROADCAST_EVENTS = [
  "agent:spawned",
  "agent:terminated",
  "agent:escalation",
  "task:failed",
  "cost:delta",
  "security:issues-found",
  "memory:set",
  "budget:alert",
  "budget:exceeded",
  "config:reloaded",
  "orchestrator:paused",
  "orchestrator:resumed",
  "orchestrator:shutdown",
] as const

/** One of the events in `BROADCAST_EVENTS`. */
export type BroadcastEvent = (typeof BROADCAST_EVENTS)[number]

/**
 * StateBroadcaster bridges the orchestrator event system to WebSocket clients.
 *
 * - Every event in `BROADCAST_EVENTS` is broadcast immediately.
 * - Full state snapshots (orchestrator:state) are throttled to at most once per second
 *   to avoid overwhelming clients during rapid state changes.
 * - Dead clients are cleaned up automatically when send() throws.
 */
export class StateBroadcaster {
  private clients: Set<WebSocketLike> = new Set()
  private orchestrator: NexusOrchestrator
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  private throttleMs: number
  private unsubscribers: Array<() => void> = []

  constructor(orchestrator: NexusOrchestrator, opts?: { throttleMs?: number }) {
    this.orchestrator = orchestrator
    this.throttleMs = opts?.throttleMs ?? 1000
    this.setupEventListeners()
  }

  // ── Client management ──────────────────────────────────────────────

  /**
   * Register a new WebSocket client and send it the current orchestrator state.
   *
   * `getState()` is guarded because this is called from Bun's server upgrade
   * handler, i.e. from the CONNECT path: a throw here would reject a client
   * that has already been accepted, and the client is in `this.clients` from
   * the line above, so it would be left in the broadcast set with no first
   * state push and no explanation. Catching keeps a wedged `getState()` from
   * taking the whole dashboard endpoint down; the log is what makes it
   * diagnosable rather than merely survivable.
   */
  addClient(ws: WebSocketLike): void {
    this.clients.add(ws)
    this.snapshot("orchestrator:state", ws)
  }

  /**
   * Remove a client from the broadcast set.
   */
  removeClient(ws: WebSocketLike): void {
    this.clients.delete(ws)
  }

  // ── Event wiring ───────────────────────────────────────────────────

  private setupEventListeners(): void {
    const orch = this.orchestrator as NexusOrchestrator & {
      on?: (event: string, handler: Function) => () => void
    }

    // Subscribe to every orchestrator event, and broadcast immediately. The list
    // is `BROADCAST_EVENTS`, not a subset chosen here — see its doc comment for
    // why it is exported and test-enforced.
    for (const eventName of BROADCAST_EVENTS) {
      const unsub = orch.on?.(eventName, (data: unknown) => {
        this.broadcast(eventName, data)
      })
      if (unsub) this.unsubscribers.push(unsub)
    }
  }

  // ── State broadcast (throttled) ────────────────────────────────────

  /**
   * Read `getState()` and ship it, with the read GUARDED.
   *
   * Both of this class's state reads are unowned by it: `getState()` walks the
   * agent map, the DAG and the session views, and a throw in any of them
   * would otherwise surface as a dropped broadcast — which is the right failure
   * mode but a WHOLLY SILENT one. The caller is either a `setTimeout` callback
   * (where an unhandled throw is a process-level event) or Bun's upgrade
   * handler (where it rejects a live connection), and in neither case does the
   * dashboard get to learn that its own state push failed.
   *
   * So a failed read is logged and the push is skipped, and — this is the part
   * that matters — the client is still in the broadcast set, so the NEXT
   * successful state change delivers a full state to it. A subscriber that
   * merely got `undefined` would render an empty dashboard forever.
   *
   * `to` narrows the send to one client; omitted, it fans out to all of them.
   */
  private snapshot(type: string, to?: WebSocketLike): void {
    let data: ReturnType<NexusOrchestrator['getState']>
    try {
      data = this.orchestrator.getState()
    } catch (error) {
      console.error(`[nexus] getState() failed; skipping the "${type}" push:`, error)
      return
    }
    const frame = { type, data, timestamp: new Date().toISOString() }
    if (to) this.sendTo(to, frame)
    else this.broadcast(type, data)
  }

  /**
   * Schedule a throttled full-state broadcast. Multiple calls within the
   * throttle window collapse into a single broadcast.
   */
  broadcastState(): void {
    if (this.broadcastTimer) return

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.snapshot("orchestrator:state")
    }, this.throttleMs)
    // `.unref()`'d for the same reason the timeout-delta timers in
    // `orchestrator.ts` are: a background watcher must never be the thing that
    // holds the process open. This is NOT a regression — the timer only arms on
    // an actual state change, and `destroy()` clears it — so the window is
    // bounded and rare. It is fixed anyway because it is the same class as the
    // delta timers, and a dashboard that has to be killed with SIGKILL because
    // a throttled state push is pending is not a distinction anyone should have
    // to remember to re-derive.
    this.broadcastTimer.unref?.()
  }

  // ── Low-level broadcast ────────────────────────────────────────────

  /**
   * Send an event to all connected clients immediately.
   */
  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({
      type: event,
      data,
      timestamp: new Date().toISOString(),
    })

    for (const client of this.clients) {
      try {
        client.send(message)
      } catch {
        // Dead client — remove it.
        this.clients.delete(client)
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private sendTo(ws: WebSocketLike, data: unknown): void {
    try {
      ws.send(JSON.stringify(data))
    } catch {
      this.clients.delete(ws)
    }
  }

  /**
   * Number of currently connected clients.
   */
  getClientCount(): number {
    return this.clients.size
  }

  /**
   * Tear down timers, event subscriptions, and client tracking.
   */
  destroy(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
    this.clients.clear()
  }
}
