import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NexusOrchestrator } from '../src/orchestrator'
import { StateBroadcaster, BROADCAST_EVENTS, type WebSocketLike } from '../src/broadcast'

const mockCtx = {
  location: { directory: process.cwd() },
  session: {
    create: mock(() => Promise.resolve({ id: 'session-mock-123' })),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([])),
  },
  storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
  tool: { list: mock(() => Promise.resolve([])) },
}

/**
 * The broadcaster's subscription list vs. the orchestrator's emit sites.
 *
 * This is a control against DRIFT, and the drift it exists to stop is the real
 * disease: `broadcast.ts` subscribed to four events while the orchestrator
 * emitted thirteen, so nine events — including every `cost:delta` and the whole
 * `orchestrator:*` lifecycle — reached no WebSocket client, and nothing
 * complained. The list is a hand-maintained copy of something that lives
 * somewhere else, and a hand-maintained copy with no test is a copy that rots.
 *
 * TWO HALVES, because a source grep alone is a weak control:
 *
 *   1. STATIC. Every `this.emit('<name>'` in `orchestrator.ts` is in
 *      `BROADCAST_EVENTS`. This is what catches a NEW event being emitted
 *      without being forwarded.
 *   2. RUNTIME. Every name in `BROADCAST_EVENTS` really does reach a connected
 *      client. This is what catches the list naming an event nobody emits, and
 *      it needs no source parsing at all — so half the test still has teeth if
 *      the parser in half 1 rots.
 *
 * On the "can this pass vacuously" question, which is the only question that
 * matters for a source-level test: the grep CAN match zero sites, and a naive
 * version of this test would then pass with an empty list and a broken
 * broadcaster. Three things stop that. `expect(literalSites.length).toBeGreaterThan(0)`
 * fails if the regex stops matching. `expect(dynamicSites).toEqual([])` fails if
 * anyone starts emitting through a variable — a dynamic name is the exact
 * escape hatch that would let an event slip past a static check, so it is a
 * hard failure rather than a silent skip. And half 2 is a runtime assertion
 * over a literal list, so it cannot pass vacuously at all: if `BROADCAST_EVENTS`
 * were emptied, it would assert nothing about the socket and the first
 * `it` would already have failed.
 *
 * The one `this.emit(` that IS dynamic is the `ModuleContext.emit` re-export —
 * the plugin module API, which forwards whatever event a module hands it. It is
 * allowed, and only it, by requiring the text before `this.emit(` to be an
 * arrow.
 */

const ORCHESTRATOR_SOURCE = join(import.meta.dir, '..', 'src', 'orchestrator.ts')

/** Every `this.emit(` call site in the source, classified. */
function readEmitSites(): { literal: string[]; dynamic: Array<{ name: string; text: string }> } {
  const source = readFileSync(ORCHESTRATOR_SOURCE, 'utf8')
  const literal: string[] = []
  const dynamic: Array<{ name: string; text: string }> = []

  // Global, so `lastIndex` advances across the file rather than restarting per
  // call (and so a `/g` regex reused across `describe` blocks cannot loop).
  const CALL = /this\.emit\(/g
  let match: RegExpExecArray | null
  while ((match = CALL.exec(source)) !== null) {
    const start = match.index
    const rest = source.slice(start + match[0].length)
    const nameMatch = /^\s*(['"])([^'"]+)\1/.exec(rest)
    if (nameMatch) {
      literal.push(nameMatch[2] as string)
      continue
    }
    const lineNumber = source.slice(0, start).split('\n').length
    dynamic.push({
      name: `line ${lineNumber}: this.emit(${rest.split('\n')[0]}`,
      text: source.slice(Math.max(0, start - 3), start),
    })
  }
  return { literal, dynamic }
}

describe('the broadcaster subscribes to every event the orchestrator emits', () => {
  const { literal, dynamic } = readEmitSites()

  it('finds the emit sites at all, so the checks below cannot pass on an empty scan', () => {
    // The vacuity guard. If a refactor rewrites `this.emit(x)` into something
    // this file cannot see, this is the assertion that says so out loud instead
    // of leaving the coverage check quietly green over nothing.
    expect(literal.length).toBeGreaterThan(0)
  })

  it('emits every event the broadcaster forwards', () => {
    const unsubscribed = [...new Set(literal)].filter(name => !BROADCAST_EVENTS.includes(name as never))
    expect(unsubscribed).toEqual([])
  })

  it('has no dynamic emit sites, so no event can bypass the coverage check', () => {
    // The one legal dynamic site is `ModuleContext.emit`, an arrow that
    // re-exports whatever a plugin module hands it. Anything else emitting
    // through a variable is an event name this file cannot verify.
    const illegal = dynamic.filter(site => !site.text.trimEnd().endsWith('=>'))
    expect(illegal.map(site => site.name)).toEqual([])
  })

  it('allows exactly one dynamic site, the ModuleContext re-export', () => {
    // So the allowance above is a named exemption rather than a loophole. A
    // second dynamic emit fails here even if it too happens to sit behind an
    // arrow, and a refactor that removes this one entirely fails too — which is
    // the point: the list is being checked, not quietly skipped.
    expect(dynamic).toHaveLength(1)
    expect(dynamic[0]?.text.trimEnd().endsWith('=>')).toBe(true)
    // Pinned to the `ModuleContext.emit` signature, so the exemption cannot be
    // inherited by a differently-shaped dynamic emit that happens to be an
    // arrow too.
    expect(dynamic[0]?.name).toEndWith('this.emit(event, data),')
  })

  it('lists no event twice', () => {
    expect(new Set(BROADCAST_EVENTS).size).toBe(BROADCAST_EVENTS.length)
  })

  it('lists no event nobody emits', () => {
    // The other direction. A name here that is never emitted is dead weight:
    // it advertises a capability the orchestrator does not have.
    const emitted = new Set(literal)
    expect(BROADCAST_EVENTS.filter(name => !emitted.has(name))).toEqual([])
  })
})

describe('every subscribed event actually reaches a connected client', () => {
  let orchestrator: NexusOrchestrator
  let broadcaster: StateBroadcaster
  let ws: WebSocketLike & { messages: string[] }

  beforeEach(() => {
    orchestrator = new NexusOrchestrator()
    broadcaster = new StateBroadcaster(orchestrator, { throttleMs: 10_000 })
    ws = {
      messages: [],
      send(data: string) {
        ws.messages.push(data)
      },
    }
    broadcaster.addClient(ws)
    ws.messages = []
  })

  afterEach(() => {
    broadcaster.destroy()
  })

  it('delivers all of them, and delivers nothing else', () => {
    // Driven off the exported list rather than a copy of it, so a name added to
    // the list is covered the moment it is added. `emit` is private, hence the
    // bracket access — the same escape hatch the other suites use to read the
    // orchestrator's internal collections.
    const sent: Array<{ type: string; data: unknown }> = []
    for (const name of BROADCAST_EVENTS) {
      ws.messages = []
      orchestrator['emit'](name, { probe: name })
      const parsed = ws.messages.map(m => JSON.parse(m) as { type: string; data: unknown })
      expect(parsed).toHaveLength(1)
      sent.push(parsed[0] as { type: string; data: unknown })
    }

    expect(sent.map(m => m.type)).toEqual([...BROADCAST_EVENTS])
    // The payload is forwarded verbatim, so a subscriber sees the real event
    // body and not an empty envelope.
    expect(sent[0]?.data).toEqual({ probe: BROADCAST_EVENTS[0] })
  })

  it('drops a dead client instead of throwing on every later broadcast', () => {
    let sends = 0
    const dead: WebSocketLike = {
      send() {
        sends++
        // The connect-time snapshot (the first send) succeeds, so the client is
        // registered exactly as a live one is; the socket dies on the next
        // broadcast, which is the path under test.
        if (sends > 1) throw new Error('socket closed')
      },
    }
    broadcaster.addClient(dead)
    expect(broadcaster.getClientCount()).toBe(2)

    broadcaster.broadcast('cost:delta', { probe: true })

    // The throw was swallowed, the client was evicted, and the live one still
    // got its message — a failing client must not cost the others their push.
    expect(broadcaster.getClientCount()).toBe(1)
    expect(ws.messages).toHaveLength(1)
  })

  it('unsubscribes on destroy, so a destroyed broadcaster forwards nothing', () => {
    // `destroy()` must reach the orchestrator's own handler list. If it did
    // not, every event would keep fanning out to a broadcaster with no clients
    // for the life of the process — invisible, and unbounded in event count.
    broadcaster.destroy()
    ws.messages = []

    orchestrator['emit']('agent:spawned', { probe: true })

    expect(ws.messages).toEqual([])
  })
})

describe('no second registration duplicates delivery while the dashboard runs', () => {
  // `startDashboard()` used to register its own handlers for `agent:spawned`,
  // `agent:terminated`, `budget:alert` and `budget:exceeded`, each calling
  // `DashboardModule.broadcast()`, which was a pass-through to
  // `broadcaster.broadcast()`. Since the broadcaster subscribes to those same
  // four events itself, every one of them reached every client TWICE — and the
  // page's activity log renders one row per delivery, so a user saw every spawn
  // and every termination twice. Those four lines are gone, and so is
  // `DashboardModule.broadcast()`; delivery has one owner, the broadcaster.
  //
  // Pinned rather than left as a comment, because a duplicate is not a
  // performance footnote — it is a wrong thing drawn on a screen that a user is
  // meant to trust, and nothing at runtime complains about it. The dashboard is
  // genuinely started here, because "nobody registered a second handler" is only
  // provable against the real wiring rather than against the module in
  // isolation. All THIRTEEN are asserted, not just the four that used to
  // duplicate: the point of the assertion is "exactly one delivery per event",
  // and a list of the four known-bad names would leave a fifth path unguarded.
  let orchestrator: NexusOrchestrator
  let ws: WebSocketLike & { messages: string[] }

  beforeEach(async () => {
    orchestrator = new NexusOrchestrator()
    // Awaited: `initialize()` attaches the broadcaster at its end, and an
    // un-awaited call would leave `broadcaster` null at the next line.
    await orchestrator.initialize(mockCtx as never)
    ws = { messages: [], send(data: string) { ws.messages.push(data) } }
    // Stand in for a connected client. Registered on the broadcaster, which is
    // where `DashboardModule`'s `websocket.open` registers every real socket.
    orchestrator.broadcaster?.addClient(ws)
    ws.messages = []
  })

  afterEach(async () => {
    orchestrator.stopDashboard()
    await orchestrator.shutdown()
  })

  it('delivers every one of the thirteen exactly once', () => {
    // A port nothing else in the suite binds. The server is not itself what is
    // under test — the duplicate registration was — but it has to be running,
    // because that is where the second path used to live.
    orchestrator.startDashboard(14999, '127.0.0.1')

    // Driven off the exported list, so an event added to the broadcaster is
    // covered the moment it is added rather than needing this file edited too.
    for (const name of BROADCAST_EVENTS) {
      ws.messages = []
      orchestrator['emit'](name, { probe: name })
      const parsed = ws.messages.map(m => JSON.parse(m) as { type: string; data: unknown })
      // `toEqual([name])` rather than `toHaveLength(1)`: it names the second
      // delivery in the failure output, which is the whole symptom.
      expect(parsed.map(m => m.type)).toEqual([name])
      expect(parsed[0]?.data).toEqual({ probe: name })
    }
  })

  it('stops duplicating once the dashboard is stopped, because the duplicate outlived the server', () => {
    // The same assertion taken from the other side, and the reason the
    // duplicate was worse than a cosmetic wrinkle: those four handlers were
    // registered on the ORCHESTRATOR, so `stopDashboard()` — which tears down
    // the server — did not unregister them. They kept pushing to a client whose
    // page was about to be dismissed, for the life of the process. With the
    // lines gone the count is one before and one after, from the broadcaster
    // alone.
    orchestrator.startDashboard(14999, '127.0.0.1')
    orchestrator['emit']('agent:spawned', { probe: true })
    expect(ws.messages).toHaveLength(1)

    orchestrator.stopDashboard()
    ws.messages = []
    orchestrator['emit']('agent:spawned', { probe: true })
    expect(ws.messages).toHaveLength(1)
  })
})
