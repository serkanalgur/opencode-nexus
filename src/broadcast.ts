import type { NexusOrchestrator } from "./orchestrator"

/**
 * A minimal WebSocket-like interface so we don't depend on any specific WS library.
 * Any object with a send(data: string) method works (e.g. ws from 'ws' or Bun.serve).
 */
export interface WebSocketLike {
  send(data: string): void
}

/**
 * StateBroadcaster bridges the orchestrator event system to WebSocket clients.
 *
 * - Fine-grained events (agent:spawned, agent:terminated, budget:alert, budget:exceeded)
 *   are broadcast immediately.
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
   */
  addClient(ws: WebSocketLike): void {
    this.clients.add(ws)
    this.sendTo(ws, {
      type: "orchestrator:state",
      data: this.orchestrator.getState(),
      timestamp: new Date().toISOString(),
    })
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

    // Subscribe to fine-grained orchestrator events and broadcast immediately.
    const eventNames = [
      "agent:spawned",
      "agent:terminated",
      "budget:alert",
      "budget:exceeded",
    ] as const

    for (const eventName of eventNames) {
      const unsub = orch.on?.(eventName, (data: unknown) => {
        this.broadcast(eventName, data)
      })
      if (unsub) this.unsubscribers.push(unsub)
    }
  }

  // ── State broadcast (throttled) ────────────────────────────────────

  /**
   * Schedule a throttled full-state broadcast. Multiple calls within the
   * throttle window collapse into a single broadcast.
   */
  broadcastState(): void {
    if (this.broadcastTimer) return

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.broadcast("orchestrator:state", this.orchestrator.getState())
    }, this.throttleMs)
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
