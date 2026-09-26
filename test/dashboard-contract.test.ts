import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'
import { DashboardModule } from '../src/dashboard'

/**
 * Server/client contract.
 *
 * The dashboard's SPA is a ~2000-line hand-written page that talks to this
 * server over two channels: HTTP for `/api/*` and a WebSocket for state. There
 * is no browser in this suite, so nothing else checks that the two halves
 * still agree. The failure this exists to catch is concrete and already
 * happened: the server resolved the page from `process.cwd()` and, in an
 * installed package, returned `ENOENT ... dashboard/index.html` as a 200
 * `text/plain` body — a blank dashboard with an HTTP success code.
 *
 * Two controls, no new dependency:
 *   1. Asset integrity — every element id the page looks up via
 *      `getElementById` must exist in the HTML the server actually serves.
 *      A renamed id fails here instead of in a browser.
 *   2. Route contract — every `/api/*` route answers 200 with JSON, an unknown
 *      one answers 404 with JSON, and `/api/costs` is an object rather than a
 *      double-encoded JSON string.
 */

const PORT = 14771
const BASE = `http://127.0.0.1:${PORT}`
const HTML_SOURCE_PATH = new URL('../dashboard/index.html', import.meta.url)

const KNOWN_ROUTES = [
  '/api/state',
  '/api/config',
  '/api/agents',
  '/api/costs',
  '/api/health',
] as const

const UNKNOWN_ROUTES = ['/api/nope', '/api/sessions', '/api'] as const

/** Element ids the page resolves by id, read straight out of the page source. */
async function referencedElementIds(): Promise<string[]> {
  const html = await Bun.file(HTML_SOURCE_PATH).text()
  const ids = new Set<string>()
  for (const match of html.matchAll(/getElementById\('([^']+)'\)/g)) {
    ids.add(match[1] as string)
  }
  return [...ids]
}

describe('dashboard server/client contract', () => {
  let orchestrator: NexusOrchestrator
  let dashboard: DashboardModule

  beforeAll(async () => {
    orchestrator = new NexusOrchestrator({
      budget: {
        maxTotalCost: 10.0,
        maxCostPerTask: 1.0,
        maxCostPerAgent: 2.0,
        alertThreshold: 0.2,
        hardLimit: false,
      },
    })
    await orchestrator.initialize({
      location: { directory: process.cwd() },
    } as any)
    dashboard = new DashboardModule(orchestrator)
    dashboard.start(PORT, '127.0.0.1')
  })

  afterAll(async () => {
    dashboard.stop()
    await orchestrator.shutdown()
  })

  describe('asset integrity', () => {
    it('finds element ids in the page source (guards the control itself)', async () => {
      const ids = await referencedElementIds()
      expect(ids.length).toBeGreaterThan(20)
    })

    it('serves HTML containing every id the page looks up', async () => {
      const ids = await referencedElementIds()
      const res = await fetch(`${BASE}/`)
      expect(res.status).toBe(200)
      const served = await res.text()
      expect(served).toContain('<!DOCTYPE html>')

      const missing = ids.filter((id) => !served.includes(`id="${id}"`))
      expect({ missing }).toEqual({ missing: [] })
    })

    it('serves the page shell on an arbitrary non-API path (SPA fallback)', async () => {
      const res = await fetch(`${BASE}/deep/link`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('text/html')
      const served = await res.text()
      expect(served).toContain('<!DOCTYPE html>')
      expect(served).toContain('id="stat-agents"')
    })
  })

  describe('route contract', () => {
    it('answers 200 with a JSON body for every known route', async () => {
      for (const route of KNOWN_ROUTES) {
        const res = await fetch(`${BASE}${route}`)
        expect({ route, status: res.status }).toEqual({ route, status: 200 })
        const body = await res.text()
        expect({ route, parses: (() => { try { JSON.parse(body); return true } catch { return false } })() })
          .toEqual({ route, parses: true })
      }
    })

    it('answers 404 with a JSON body for an unknown API route', async () => {
      for (const route of UNKNOWN_ROUTES) {
        const res = await fetch(`${BASE}${route}`)
        expect({ route, status: res.status }).toEqual({ route, status: 404 })
        const body = (await res.json()) as { error?: string }
        expect({ route, error: typeof body.error }).toEqual({
          route,
          error: 'string',
        })
      }
    })

    it('serves costs as an object, not a double-encoded JSON string', async () => {
      const res = await fetch(`${BASE}/api/costs`)
      const body = await res.json()
      expect(typeof body).toBe('object')
      expect(body).not.toBeNull()
      expect(Array.isArray(body)).toBe(false)
      const report = body as Record<string, unknown>
      expect(typeof report.totalSpent).toBe('number')
      expect(typeof report.budgetRemaining).toBe('number')
    })

    it('keeps CORS headers on API responses', async () => {
      const res = await fetch(`${BASE}/api/health`)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })

  describe('websocket contract', () => {
    /** Resolve with the first message matching `predicate`, or reject on timeout. */
    function waitFor(
      ws: WebSocket,
      predicate: (msg: { type?: string }) => boolean,
      timeoutMs = 2000,
    ): Promise<{ type?: string; data?: unknown }> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.removeEventListener('message', onMessage)
          reject(new Error('timed out waiting for websocket message'))
        }, timeoutMs)
        function onMessage(event: MessageEvent) {
          const msg = JSON.parse(String(event.data)) as { type?: string }
          if (!predicate(msg)) return
          clearTimeout(timer)
          ws.removeEventListener('message', onMessage)
          resolve(msg)
        }
        ws.addEventListener('message', onMessage)
      })
    }

    it('sends a state snapshot on connect and answers getState', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`)
      const opened = new Promise<void>((resolve) => {
        ws.addEventListener('open', () => resolve(), { once: true })
      })
      await opened

      // On connect — exactly one snapshot, whether the broadcaster is wired or not.
      const onConnect = await waitFor(ws, (m) => m.type === 'orchestrator:state')
      expect(onConnect.data).toHaveProperty('running')

      // The page's auto-refresh poll. This message used to be discarded, so the
      // dashboard never re-rendered on its interval.
      const reply = waitFor(ws, (m) => m.type === 'orchestrator:state')
      ws.send(JSON.stringify({ type: 'getState' }))
      expect((await reply).data).toHaveProperty('running')

      const pong = waitFor(ws, (m) => m.type === 'pong')
      ws.send(JSON.stringify({ type: 'ping' }))
      expect(await pong).toHaveProperty('timestamp')

      ws.close()
    })
  })
})
