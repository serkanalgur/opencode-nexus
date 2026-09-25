import { describe, it, expect, beforeEach } from 'bun:test'
import { MessageRouter } from '../src/fanout'
import type { AgentMessage } from '../src/types'

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from: 'agent-1',
    type: 'status-update',
    payload: { status: 'working' },
    timestamp: new Date(),
    metadata: { priority: 'normal', requiresResponse: false },
    topic: 'general',
    ...overrides,
  }
}

describe('MessageRouter', () => {
  let router: MessageRouter

  beforeEach(() => {
    router = new MessageRouter()
  })

  describe('subscribe / unsubscribe', () => {
    it('should subscribe to a specific topic', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', 'tasks', (msg) => received.push(msg))

      const stats = router.getStats()
      expect(stats.totalSubscribers).toBe(1)
      expect(router.getSubscribers('tasks')).toContain('sub-1')
    })

    it('should subscribe to wildcard topic', () => {
      router.subscribe('sub-1', '*', () => {})

      const stats = router.getStats()
      expect(stats.wildcardSubscribers).toBe(1)
      expect(router.getWildcardSubscribers()).toContain('sub-1')
    })

    it('should unsubscribe and clean up all routes', () => {
      router.subscribe('sub-1', 'tasks', () => {})
      router.subscribe('sub-1', '*', () => {})

      router.unsubscribe('sub-1')

      const stats = router.getStats()
      expect(stats.totalSubscribers).toBe(0)
      expect(stats.wildcardSubscribers).toBe(0)
      expect(router.getSubscribers('tasks')).not.toContain('sub-1')
      expect(router.getWildcardSubscribers()).not.toContain('sub-1')
    })

    it('should clean up from multiple topic routes on unsubscribe', () => {
      router.subscribe('sub-1', 'topic-a', () => {})
      router.subscribe('sub-1', 'topic-b', () => {})

      router.unsubscribe('sub-1')

      expect(router.getSubscribers('topic-a')).not.toContain('sub-1')
      expect(router.getSubscribers('topic-b')).not.toContain('sub-1')
    })
  })

  describe('route', () => {
    it('should deliver to exact topic subscribers', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', 'tasks', (msg) => received.push(msg))

      const msg = makeMessage({ topic: 'tasks' })
      const delivered = router.route(msg)

      expect(delivered).toContain('sub-1')
      expect(received).toHaveLength(1)
      expect(received[0].topic).toBe('tasks')
    })

    it('should not deliver to non-matching topic subscribers', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', 'reviews', (msg) => received.push(msg))

      const msg = makeMessage({ topic: 'tasks' })
      const delivered = router.route(msg)

      expect(delivered).not.toContain('sub-1')
      expect(received).toHaveLength(0)
    })

    it('should deliver to wildcard subscribers for any topic', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', '*', (msg) => received.push(msg))

      const msg = makeMessage({ topic: 'tasks' })
      const delivered = router.route(msg)

      expect(delivered).toContain('sub-1')
      expect(received).toHaveLength(1)
    })

    it('should not double-deliver to a subscriber on both exact and wildcard', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', 'tasks', (msg) => received.push(msg))
      router.subscribe('sub-1', '*', (msg) => received.push(msg))

      const msg = makeMessage({ topic: 'tasks' })
      const delivered = router.route(msg)

      // Should be delivered exactly once
      expect(delivered.filter(id => id === 'sub-1')).toHaveLength(1)
      expect(received).toHaveLength(1)
    })

    it('should return list of delivered subscriber IDs', () => {
      router.subscribe('sub-1', 'tasks', () => {})
      router.subscribe('sub-2', 'tasks', () => {})
      router.subscribe('sub-3', 'other', () => {})

      const msg = makeMessage({ topic: 'tasks' })
      const delivered = router.route(msg)

      expect(delivered).toContain('sub-1')
      expect(delivered).toContain('sub-2')
      expect(delivered).not.toContain('sub-3')
      expect(delivered).toHaveLength(2)
    })

    it('should deliver to both exact and wildcard subscribers (no overlap)', () => {
      const receivedExact: AgentMessage[] = []
      const receivedWildcard: AgentMessage[] = []

      router.subscribe('sub-exact', 'tasks', (msg) => receivedExact.push(msg))
      router.subscribe('sub-wild', '*', (msg) => receivedWildcard.push(msg))

      const msg = makeMessage({ topic: 'tasks' })
      const delivered = router.route(msg)

      expect(delivered).toContain('sub-exact')
      expect(delivered).toContain('sub-wild')
      expect(receivedExact).toHaveLength(1)
      expect(receivedWildcard).toHaveLength(1)
    })

    it('should handle messages with no topic', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', '*', (msg) => received.push(msg))

      const msg = makeMessage({ topic: undefined })
      const delivered = router.route(msg)

      expect(delivered).toContain('sub-1')
      expect(received).toHaveLength(1)
    })
  })

  describe('broadcast', () => {
    it('should send to all subscribers regardless of topic', () => {
      const received1: AgentMessage[] = []
      const received2: AgentMessage[] = []

      router.subscribe('sub-1', 'tasks', (msg) => received1.push(msg))
      router.subscribe('sub-2', 'reviews', (msg) => received2.push(msg))

      const msg = makeMessage({ topic: 'tasks' })
      router.broadcast(msg)

      expect(received1).toHaveLength(1)
      expect(received2).toHaveLength(1)
    })

    it('should broadcast to wildcard subscribers too', () => {
      const received: AgentMessage[] = []
      router.subscribe('sub-1', '*', (msg) => received.push(msg))

      const msg = makeMessage()
      router.broadcast(msg)

      expect(received).toHaveLength(1)
    })
  })

  describe('getStats', () => {
    it('should return correct stats', () => {
      router.subscribe('sub-1', 'tasks', () => {})
      router.subscribe('sub-2', 'tasks', () => {})
      router.subscribe('sub-3', '*', () => {})

      const stats = router.getStats()
      expect(stats.topics).toBe(1)       // 'tasks' topic
      expect(stats.totalSubscribers).toBe(3)
      expect(stats.wildcardSubscribers).toBe(1)
    })

    it('should return zero stats for empty router', () => {
      const stats = router.getStats()
      expect(stats.topics).toBe(0)
      expect(stats.totalSubscribers).toBe(0)
      expect(stats.wildcardSubscribers).toBe(0)
    })
  })

  describe('getSubscribers', () => {
    it('should return subscribers for a topic', () => {
      router.subscribe('sub-1', 'tasks', () => {})
      router.subscribe('sub-2', 'tasks', () => {})

      const subs = router.getSubscribers('tasks')
      expect(subs).toContain('sub-1')
      expect(subs).toContain('sub-2')
    })

    it('should return empty array for unknown topic', () => {
      const subs = router.getSubscribers('nonexistent')
      expect(subs).toEqual([])
    })
  })

  describe('getWildcardSubscribers', () => {
    it('should return wildcard subscribers', () => {
      router.subscribe('sub-1', '*', () => {})
      router.subscribe('sub-2', 'tasks', () => {})

      const wildcards = router.getWildcardSubscribers()
      expect(wildcards).toContain('sub-1')
      expect(wildcards).not.toContain('sub-2')
    })
  })
})

describe('MessageRouter integration with NexusOrchestrator', () => {
  let { NexusOrchestrator } = require('../src/orchestrator')
  let orchestrator: InstanceType<typeof NexusOrchestrator>

  const mockCtx = {
    // `location` is required by the real plugin context (see initialize)
    location: { directory: process.cwd() },
    session: {
      create: async () => ({ id: 'session-mock' }),
      prompt: async () => {},
      wait: async () => {},
      context: async () => [],
    },
    storage: {
      set: async () => {},
      get: async () => null,
    }
  }

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
    orchestrator.initialize(mockCtx)
  })

  it('should expose messageRouter property', () => {
    expect(orchestrator.messageRouter).toBeDefined()
    expect(orchestrator.messageRouter).toBeInstanceOf(MessageRouter)
  })

  it('should route published messages through messageRouter', () => {
    const received: AgentMessage[] = []
    orchestrator.messageRouter.subscribe('sub-1', 'tasks', (msg) => received.push(msg))

    orchestrator.publish('tasks', {
      from: 'agent-1',
      type: 'status-update',
      payload: { status: 'working' },
      metadata: { priority: 'normal', requiresResponse: false }
    })

    expect(received).toHaveLength(1)
  })

  it('should still deliver to legacy subscribers', () => {
    let legacyReceived = false
    orchestrator.subscribe('tasks', () => { legacyReceived = true })

    orchestrator.publish('tasks', {
      from: 'agent-1',
      type: 'status-update',
      payload: { status: 'working' },
      metadata: { priority: 'normal', requiresResponse: false }
    })

    expect(legacyReceived).toBe(true)
  })

  it('should deliver to both legacy and fanout subscribers', () => {
    let legacyReceived = false
    const fanoutReceived: AgentMessage[] = []

    orchestrator.subscribe('tasks', () => { legacyReceived = true })
    orchestrator.messageRouter.subscribe('sub-1', 'tasks', (msg) => fanoutReceived.push(msg))

    orchestrator.publish('tasks', {
      from: 'agent-1',
      type: 'status-update',
      payload: { status: 'working' },
      metadata: { priority: 'normal', requiresResponse: false }
    })

    expect(legacyReceived).toBe(true)
    expect(fanoutReceived).toHaveLength(1)
  })
})
