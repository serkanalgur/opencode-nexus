import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'
import { DashboardModule, isAllowedRequest } from '../src/dashboard'

/**
 * The dashboard serves session state, task text and config to whatever asks.
 * It used to answer every origin with `Access-Control-Allow-Origin: *` and
 * accept a WebSocket upgrade from any page, so any website open in the user's
 * browser could read `/api/state` or subscribe to `/ws/events` on localhost.
 *
 * The SPA is same-origin and the TUI's health probe is not a browser (it sends
 * no `Origin`), so neither needs CORS. These tests pin the replacement policy:
 * no CORS headers, a foreign `Origin` is refused, and on a loopback bind a
 * foreign `Host` is refused too, which is what stops DNS rebinding (there the
 * attacker's Origin and Host agree with each other, so an Origin check alone
 * passes).
 */

const PORT = 14781
const BASE = `http://127.0.0.1:${PORT}`

const mockCtx = {
  location: { directory: process.cwd() },
  session: {
    create: mock(() => Promise.resolve({ id: 'session-mock-123' })),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([])),
  },
  storage: {
    set: mock(() => Promise.resolve()),
    get: mock(() => Promise.resolve(null)),
  },
}

describe('dashboard origin policy (HTTP)', () => {
  let dashboard: DashboardModule

  beforeAll(() => {
    const orchestrator = new NexusOrchestrator()
    orchestrator.initialize(mockCtx as any)
    dashboard = new DashboardModule(orchestrator)
    dashboard.start(PORT, '127.0.0.1')
  })

  afterAll(() => dashboard.stop())

  it('sends no CORS headers', async () => {
    const res = await fetch(`${BASE}/api/state`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('answers a request with no Origin (the TUI health probe, curl)', async () => {
    const res = await fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
  })

  it('answers a same-origin request (the SPA)', async () => {
    const res = await fetch(`${BASE}/api/state`, { headers: { Origin: BASE } })
    expect(res.status).toBe(200)
  })

  it('refuses a cross-origin request', async () => {
    const res = await fetch(`${BASE}/api/state`, { headers: { Origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
  })

  it('refuses a cross-origin preflight', async () => {
    const res = await fetch(`${BASE}/api/state`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('refuses a cross-origin WebSocket upgrade', async () => {
    const res = await fetch(`${BASE}/ws/events`, {
      headers: {
        Origin: 'https://evil.example',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(res.status).toBe(403)
  })

  it('accepts a same-origin WebSocket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`, { headers: { Origin: BASE } } as any)
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onerror = () => resolve(false)
      setTimeout(() => resolve(false), 2000)
    })
    ws.close()
    expect(opened).toBe(true)
  })
})

describe('isAllowedRequest', () => {
  const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:4747/api/state', { headers })

  it('allows no Origin on a loopback Host', () => {
    expect(isAllowedRequest(req({ Host: '127.0.0.1:4747' }), '127.0.0.1')).toBe(true)
    expect(isAllowedRequest(req({ Host: 'localhost:4747' }), '127.0.0.1')).toBe(true)
    expect(isAllowedRequest(req({ Host: '[::1]:4747' }), '127.0.0.1')).toBe(true)
  })

  it('refuses a rebinding Host on a loopback bind even when Origin matches it', () => {
    expect(isAllowedRequest(
      req({ Host: 'attacker.example:4747', Origin: 'http://attacker.example:4747' }),
      '127.0.0.1',
    )).toBe(false)
  })

  it('allows the bound host name itself', () => {
    expect(isAllowedRequest(req({ Host: 'nexus.local:4747' }), 'nexus.local')).toBe(true)
  })

  it('on a wildcard bind, checks only that Origin matches Host', () => {
    expect(isAllowedRequest(req({ Host: '192.168.1.5:4747' }), '0.0.0.0')).toBe(true)
    expect(isAllowedRequest(req({ Host: '192.168.1.5:4747', Origin: 'http://192.168.1.5:4747' }), '0.0.0.0')).toBe(true)
    expect(isAllowedRequest(req({ Host: '192.168.1.5:4747', Origin: 'https://evil.example' }), '0.0.0.0')).toBe(false)
  })

  it('treats Origin "null" (sandboxed iframe, file://) as foreign', () => {
    expect(isAllowedRequest(req({ Host: '127.0.0.1:4747', Origin: 'null' }), '127.0.0.1')).toBe(false)
  })
})
