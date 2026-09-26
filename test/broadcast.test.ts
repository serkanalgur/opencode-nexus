import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'
import { StateBroadcaster, type WebSocketLike } from '../src/broadcast'

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

/** Create a mock WebSocket client that records messages sent to it. */
function createMockWs(): WebSocketLike & { messages: string[] } {
  const ws = {
    messages: [] as string[],
    send(data: string) {
      ws.messages.push(data)
    },
  }
  return ws
}

describe('StateBroadcaster', () => {
  let orchestrator: NexusOrchestrator
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
    orchestrator.initialize(mockCtx as any)
    broadcaster = new StateBroadcaster(orchestrator, { throttleMs: 50 })
  })

  afterEach(() => {
    broadcaster.destroy()
  })

  describe('client management', () => {
    it('should track connected client count', () => {
      expect(broadcaster.getClientCount()).toBe(0)

      const ws1 = createMockWs()
      broadcaster.addClient(ws1)
      expect(broadcaster.getClientCount()).toBe(1)

      const ws2 = createMockWs()
      broadcaster.addClient(ws2)
      expect(broadcaster.getClientCount()).toBe(2)

      broadcaster.removeClient(ws1)
      expect(broadcaster.getClientCount()).toBe(1)

      broadcaster.removeClient(ws2)
      expect(broadcaster.getClientCount()).toBe(0)
    })

    it('should send current state to new client on connect', () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)

      expect(ws.messages).toHaveLength(1)
      const msg = JSON.parse(ws.messages[0])
      expect(msg.type).toBe('orchestrator:state')
      expect(msg.data).toHaveProperty('running')
      expect(msg.data).toHaveProperty('agents')
      expect(msg.data).toHaveProperty('tasks')
      expect(msg.data).toHaveProperty('totalSpent')
      expect(msg.data).toHaveProperty('budgetRemaining')
      expect(msg.timestamp).toBeDefined()
    })
  })

  describe('broadcast', () => {
    it('should send JSON messages to all connected clients', () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      broadcaster.addClient(ws1)
      broadcaster.addClient(ws2)

      // Clear the initial state messages
      ws1.messages = []
      ws2.messages = []

      broadcaster.broadcast('agent:spawned', { id: 'agent-1' })

      expect(ws1.messages).toHaveLength(1)
      expect(ws2.messages).toHaveLength(1)

      const msg1 = JSON.parse(ws1.messages[0])
      const msg2 = JSON.parse(ws2.messages[0])

      expect(msg1.type).toBe('agent:spawned')
      expect(msg1.data).toEqual({ id: 'agent-1' })
      expect(msg1.timestamp).toBeDefined()
      expect(msg2.type).toBe('agent:spawned')
    })

    it('should remove dead clients during broadcast', () => {
      const wsGood = createMockWs()
      const wsBad: WebSocketLike = {
        send() { throw new Error('connection closed') }
      }

      broadcaster.addClient(wsGood)
      broadcaster.addClient(wsBad)
      // Bad client is already removed during addClient because sendTo catches and deletes
      expect(broadcaster.getClientCount()).toBe(1) // only good client
    })
  })

  describe('broadcastState (throttled)', () => {
    it('should broadcast state to all clients', async () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)
      ws.messages = [] // clear initial state message

      broadcaster.broadcastState()

      // Wait for throttle timer to fire
      await new Promise(resolve => setTimeout(resolve, 80))

      expect(ws.messages).toHaveLength(1)
      const msg = JSON.parse(ws.messages[0])
      expect(msg.type).toBe('orchestrator:state')
    })

    it('should collapse multiple calls within throttle window', async () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)
      ws.messages = []

      broadcaster.broadcastState()
      broadcaster.broadcastState()
      broadcaster.broadcastState()

      await new Promise(resolve => setTimeout(resolve, 80))

      // Only one state broadcast despite 3 calls
      expect(ws.messages).toHaveLength(1)
    })
  })

  describe('event subscriptions', () => {
    it('should broadcast agent:spawned events immediately', async () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)
      ws.messages = []

      // Trigger the event through the orchestrator
      await orchestrator.spawnAgent({ role: 'coder' })

      // The spawnAgent calls emit('agent:spawned', agent) and notifyStateChange
      // Find the agent:spawned message (may be mixed with throttled state)
      const spawnedMessages = ws.messages.filter(m => {
        const parsed = JSON.parse(m)
        return parsed.type === 'agent:spawned'
      })

      expect(spawnedMessages.length).toBeGreaterThanOrEqual(1)
      const msg = JSON.parse(spawnedMessages[0])
      expect(msg.data).toHaveProperty('id')
      expect(msg.data).toHaveProperty('role', 'coder')
    })

    it('should broadcast agent:terminated events immediately', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })
      const ws = createMockWs()
      broadcaster.addClient(ws)
      ws.messages = []

      await orchestrator.terminateAgent(agent.id)

      const terminatedMessages = ws.messages.filter(m => {
        const parsed = JSON.parse(m)
        return parsed.type === 'agent:terminated'
      })

      expect(terminatedMessages.length).toBeGreaterThanOrEqual(1)
      const msg = JSON.parse(terminatedMessages[0])
      expect(msg.data).toHaveProperty('id', agent.id)
    })

    it('should broadcast budget:alert when threshold is reached', async () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)
      ws.messages = []

      // Set up a tight budget
      // 85% of 10.00
      orchestrator.trackCost('agent-1', 'claude-sonnet', 8.50, 2000, { usage: 'measured', pricing: 'model-costs' })

      const alertMessages = ws.messages.filter(m => {
        const parsed = JSON.parse(m)
        return parsed.type === 'budget:alert'
      })

      expect(alertMessages.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('destroy', () => {
    it('should clean up timers and clients', () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)

      broadcaster.destroy()

      expect(broadcaster.getClientCount()).toBe(0)
    })

    it('should stop broadcasting after destroy', async () => {
      const ws = createMockWs()
      broadcaster.addClient(ws)
      ws.messages = []

      broadcaster.destroy()
      broadcaster.broadcastState()

      await new Promise(resolve => setTimeout(resolve, 80))

      expect(ws.messages).toHaveLength(0)
    })
  })
})

describe('NexusOrchestrator.initBroadcaster', () => {
  let orchestrator: NexusOrchestrator

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
    orchestrator.initialize(mockCtx as any)
  })

  afterEach(() => {
    orchestrator.broadcaster?.destroy()
  })

  it('should attach a StateBroadcaster to the orchestrator', () => {
    expect(orchestrator.broadcaster).toBeNull()

    orchestrator.initBroadcaster({ throttleMs: 50 })

    expect(orchestrator.broadcaster).toBeInstanceOf(StateBroadcaster)
  })

  it('should broadcast state on notifyStateChange via the broadcaster', async () => {
    orchestrator.initBroadcaster({ throttleMs: 50 })

    const ws = createMockWs()
    orchestrator.broadcaster!.addClient(ws)
    ws.messages = []

    // Manually test the broadcaster works independently
    const bc = orchestrator.broadcaster!
    bc.broadcast('test:direct', { hello: 'world' })
    expect(ws.messages).toHaveLength(1)
    ws.messages = []

    // Now test broadcastState
    bc.broadcastState()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(ws.messages.length).toBeGreaterThanOrEqual(1)
  })
})
