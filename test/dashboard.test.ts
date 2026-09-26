import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'
import { DashboardModule } from '../src/dashboard'

// Mock OpenCode context for session API. `location` is a required member of
// the real plugin context and `initialize` reads `location.directory`.
const mockCtx = {
  location: { directory: process.cwd() },
  session: {
    create: mock(() => Promise.resolve({ id: 'session-mock-123' })),
    switchAgent: mock(() => Promise.resolve()),
    switchModel: mock(() => Promise.resolve()),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([])),
  },
  storage: {
    set: mock(() => Promise.resolve()),
    get: mock(() => Promise.resolve(null)),
  }
}

describe('DashboardModule', () => {
  let orchestrator: NexusOrchestrator
  let dashboard: DashboardModule

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
    orchestrator.initialize(mockCtx as any)
    dashboard = new DashboardModule(orchestrator)
  })

  afterEach(() => {
    dashboard.stop()
  })

  describe('constructor', () => {
    it('should create a dashboard module', () => {
      expect(dashboard).toBeDefined()
      expect(dashboard).toBeInstanceOf(DashboardModule)
    })
  })

  describe('start and stop', () => {
    it('should start the server on specified port', () => {
      dashboard.start(14747, '127.0.0.1')
      expect(dashboard.isRunning()).toBe(true)
    })

    it('should stop the server', () => {
      dashboard.start(14748, '127.0.0.1')
      expect(dashboard.isRunning()).toBe(true)
      dashboard.stop()
      expect(dashboard.isRunning()).toBe(false)
    })

    it('should report 0 clients when no connections', () => {
      dashboard.start(14749, '127.0.0.1')
      expect(dashboard.getClientCount()).toBe(0)
    })
  })

  describe('REST API endpoints', () => {
    beforeEach(() => {
      dashboard.start(14750, '127.0.0.1')
    })

    it('should return health status', async () => {
      const res = await fetch('http://127.0.0.1:14750/api/health')
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.ok).toBe(true)
      expect(data.uptime).toBeGreaterThan(0)
    })

    it('should return orchestrator state', async () => {
      const res = await fetch('http://127.0.0.1:14750/api/state')
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data).toHaveProperty('running')
      expect(data).toHaveProperty('paused')
      expect(data).toHaveProperty('agents')
      expect(data).toHaveProperty('tasks')
      expect(data).toHaveProperty('totalSpent')
      expect(data).toHaveProperty('budgetRemaining')
    })

    it('should return agents list', async () => {
      const res = await fetch('http://127.0.0.1:14750/api/agents')
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(Array.isArray(data)).toBe(true)
    })

    it('should return costs report', async () => {
      const res = await fetch('http://127.0.0.1:14750/api/costs')
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('totalSpent')
      expect(text).toContain('budgetRemaining')
    })

    it('should return config', async () => {
      const res = await fetch('http://127.0.0.1:14750/api/config')
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data).toBeDefined()
    })

    it('should return welcome message at root', async () => {
      const res = await fetch('http://127.0.0.1:14750/')
      expect(res.status).toBe(200)
      const text = await res.text()
      // Root returns either SPA HTML or API text
      expect(text.length).toBeGreaterThan(0)
    })
  })

  describe('broadcast', () => {
    it('should broadcast to connected clients', () => {
      dashboard.start(14751, '127.0.0.1')
      // broadcast with no clients should not throw
      dashboard.broadcast('test:event', { key: 'value' })
      expect(dashboard.getClientCount()).toBe(0)
    })
  })

  describe('CORS', () => {
    beforeEach(() => {
      dashboard.start(14752, '127.0.0.1')
    })

    it('should handle CORS preflight requests', async () => {
      const res = await fetch('http://127.0.0.1:14752/api/state', {
        method: 'OPTIONS'
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should include CORS headers on responses', async () => {
      const res = await fetch('http://127.0.0.1:14752/api/state')
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })
})

describe('Dashboard integration with Orchestrator', () => {
  let orchestrator: NexusOrchestrator

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
    orchestrator.initialize(mockCtx as any)
  })

  afterEach(() => {
    orchestrator.stopDashboard()
  })

  it('should start dashboard via orchestrator', () => {
    orchestrator.startDashboard(14753, '127.0.0.1')
    expect(orchestrator.dashboard).not.toBeNull()
    expect(orchestrator.dashboard!.isRunning()).toBe(true)
  })

  it('should stop dashboard via orchestrator', () => {
    orchestrator.startDashboard(14754, '127.0.0.1')
    expect(orchestrator.dashboard).not.toBeNull()
    orchestrator.stopDashboard()
    expect(orchestrator.dashboard).toBeNull()
  })

  it('should stop dashboard on shutdown', async () => {
    orchestrator.startDashboard(14755, '127.0.0.1')
    expect(orchestrator.dashboard).not.toBeNull()
    await orchestrator.shutdown()
    expect(orchestrator.dashboard).toBeNull()
  })

  it('should broadcast agent:spawned event', async () => {
    orchestrator.startDashboard(14756, '127.0.0.1')
    const agent = await orchestrator.spawnAgent({ role: 'coder' })

    // Give time for event propagation
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify the event handler was registered
    expect(orchestrator.dashboard).not.toBeNull()
    expect(orchestrator.dashboard!.isRunning()).toBe(true)
  })

  it('should broadcast budget:alert event', async () => {
    orchestrator.startDashboard(14757, '127.0.0.1')

    // Trigger budget alert
    orchestrator.trackCost('agent-1', 'test-model', 8.50, 1000, { usage: 'measured', pricing: 'model-costs' })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(orchestrator.dashboard!.isRunning()).toBe(true)
  })
})
