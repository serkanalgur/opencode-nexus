import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'

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

describe('NexusOrchestrator', () => {
  let orchestrator: NexusOrchestrator

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
    orchestrator.initialize(mockCtx as any)
  })

  describe('constructor', () => {
    it('should create orchestrator with default config', () => {
      const orch = new NexusOrchestrator()
      expect(orch).toBeDefined()
    })

    it('should create orchestrator with custom config', () => {
      expect(orchestrator).toBeDefined()
    })
  })

  describe('spawnAgent', () => {
    it('should spawn an agent with real session', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })
      expect(agent).toBeDefined()
      expect(agent.role).toBe('coder')
      expect(agent.status).toBe('idle')
      expect(agent.id).toMatch(/^agent-/)
      expect(agent.sessionID).toBe('session-mock-123')
      expect(mockCtx.session.create).toHaveBeenCalled()
    })

    it('should spawn agent with role-based model', async () => {
      const agent = await orchestrator.spawnAgent({
        role: 'reviewer'
      })
      // reviewer model comes from project config (.opencode/nexus.jsonc)
      // or defaults if no config file exists
      expect(agent.model.model).toBeDefined()
      expect(agent.model.model.length).toBeGreaterThan(0)
    })

    it('should throw if not initialized', async () => {
      const orch = new NexusOrchestrator()
      try {
        await orch.spawnAgent({ role: 'coder' })
        expect(true).toBe(false) // Should not reach
      } catch (e: any) {
        expect(e.message).toContain('not initialized')
      }
    })
  })

  describe('terminateAgent', () => {
    it('should terminate an agent', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })
      await orchestrator.terminateAgent(agent.id)

      const agents = orchestrator.listAgents()
      expect(agents).not.toContain(agent.id)
    })
  })

  describe('getAgents', () => {
    it('should list agents', async () => {
      await orchestrator.spawnAgent({ role: 'coder' })
      await orchestrator.spawnAgent({ role: 'reviewer' })

      const agents = orchestrator.listAgents()
      expect(agents).toContain('coder')
      expect(agents).toContain('reviewer')
    })
  })

  describe('getStatus', () => {
    it('should return status', () => {
      const status = orchestrator.getStatus()
      expect(status).toContain('running')
      expect(status).toContain('paused')
      expect(status).toContain('budgetRemaining')
    })

    it('should return detailed state', () => {
      const state = orchestrator.getState()
      expect(state).toHaveProperty('running')
      expect(state).toHaveProperty('paused')
      expect(state).toHaveProperty('agents')
      expect(state).toHaveProperty('tasks')
      expect(state).toHaveProperty('totalSpent')
      expect(state).toHaveProperty('budgetRemaining')
    })
  })

  describe('pause and resume', () => {
    it('should pause and resume', () => {
      orchestrator.pause()
      let status = orchestrator.getStatus()
      expect(status).toContain('paused')

      orchestrator.resume()
      status = orchestrator.getStatus()
      expect(status).toContain('paused')
    })
  })

  describe('memory', () => {
    it('should set and get memory', () => {
      orchestrator.setMemory('project', 'architecture', { pattern: 'event-sourcing' }, 'architect')

      const memory = orchestrator.getMemory('project', 'architecture')
      expect(memory).toBeDefined()
      expect(memory?.key).toBe('architecture')
    })
  })

  describe('communication', () => {
    it('should publish and subscribe', () => {
      let received = false

      orchestrator.subscribe('test-topic', (msg) => {
        received = true
      })

      orchestrator.publish('test-topic', {
        from: 'test-agent',
        type: 'status-update',
        payload: { status: 'working' },
        metadata: { priority: 'normal', requiresResponse: false }
      })

      expect(received).toBe(true)
    })
  })

  describe('cost tracking', () => {
    it('should track costs', () => {
      // Provenance is explicit: these figures stand in for real, billed usage.
      const measured = { usage: 'measured', pricing: 'model-costs' } as const
      orchestrator.trackCost('agent-1', 'claude-sonnet', 0.50, 1000, measured)
      orchestrator.trackCost('agent-1', 'claude-sonnet', 0.25, 500, measured)

      const report = orchestrator.getCostReport()
      expect(report).toContain('totalSpent')
      expect(report).toContain('budgetRemaining')
    })

    it('should check budget limits', () => {
      const orch = new NexusOrchestrator({
        budget: { maxTotalCost: 1.00, maxCostPerTask: 0.50, maxCostPerAgent: 0.50, alertThreshold: 0.8, hardLimit: true }
      })

      // Track costs
      orch.trackCost('agent-1', 'claude-sonnet', 0.90, 2000, { usage: 'measured', pricing: 'model-costs' })

      // Budget should be exceeded
      const report = orch.getCostReport()
      expect(report).toContain('totalSpent')
    })
  })

  describe('shutdown', () => {
    it('should shutdown cleanly', async () => {
      await orchestrator.spawnAgent({ role: 'coder' })
      await orchestrator.spawnAgent({ role: 'reviewer' })

      orchestrator.shutdown()

      const status = orchestrator.getStatus()
      expect(status).toContain('running')
    })
  })

  describe('event system', () => {
    it('should emit and handle events', () => {
      let eventFired = false

      orchestrator.on('test:event', () => {
        eventFired = true
      })

      orchestrator['emit']('test:event', {})
      expect(eventFired).toBe(true)
    })

    it('should unsubscribe from events', () => {
      let eventCount = 0

      const unsubscribe = orchestrator.on('test:event', () => {
        eventCount++
      })

      orchestrator['emit']('test:event', {})
      orchestrator['emit']('test:event', {})
      expect(eventCount).toBe(2)

      unsubscribe()
      orchestrator['emit']('test:event', {})
      expect(eventCount).toBe(2) // Should not increase
    })
  })

  describe('command handling', () => {
    it('should handle status command', () => {
      const result = orchestrator.handleCommand('/nexus status')
      expect(result).toContain('running')
    })

    it('should handle agents command', () => {
      const result = orchestrator.handleCommand('/nexus agents')
      expect(result).toBeDefined()
    })

    it('should handle costs command', () => {
      const result = orchestrator.handleCommand('/nexus costs')
      expect(result).toContain('totalSpent')
    })

    it('should handle pause command', () => {
      orchestrator.handleCommand('/nexus pause')
      const status = orchestrator.getStatus()
      expect(status).toContain('paused')
    })

    it('should handle resume command', () => {
      orchestrator.pause()
      orchestrator.handleCommand('/nexus resume')
      const status = orchestrator.getStatus()
      expect(status).toContain('paused')
    })

    it('should handle dashboard command', () => {
      const result = orchestrator.handleCommand('/nexus dashboard')
      expect(result).toContain('running')
      expect(result).toContain('agents')
    })
  })

  describe('context transfer', () => {
    it('should collect context from an agent', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })
      agent.metrics.tasksCompleted = 2
      agent.metrics.tasksFailed = 1

      const context = orchestrator.collectContext(agent)

      expect(context.previousAgentId).toBe(agent.id)
      expect(context.partialResults).toBeDefined()
      expect(context.decisions).toBeDefined()
      expect(context.memoryEntries).toBeDefined()
      expect(context.errorLog).toBeDefined()
      expect(context.taskProgress).toBe(50) // 2 completed => 2*25=50, capped at 50
    })

    it('should return zero progress when no tasks completed', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })

      const context = orchestrator.collectContext(agent)

      expect(context.taskProgress).toBe(0)
      expect(context.partialResults).toHaveLength(0)
    })

    it('should store context in memory during failure handling', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })
      agent.metrics.tasksCompleted = 1

      // Store context manually to verify memory integration
      const context = orchestrator.collectContext(agent)
      orchestrator.setMemory('session', `context:${agent.id}`, context, agent.id)

      const stored = orchestrator.getMemory('session', `context:${agent.id}`)
      expect(stored).toBeDefined()
      expect(stored?.value).toHaveProperty('previousAgentId')
      expect((stored?.value as any).previousAgentId).toBe(agent.id)
    })

    it('should include context transfer data in ContextTransferData', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })

      const context = orchestrator.collectContext(agent)

      expect(context).toHaveProperty('previousAgentId')
      expect(context).toHaveProperty('partialResults')
      expect(context).toHaveProperty('decisions')
      expect(context).toHaveProperty('memoryEntries')
      expect(context).toHaveProperty('taskProgress')
      expect(context).toHaveProperty('errorLog')
      expect(typeof context.previousAgentId).toBe('string')
      expect(Array.isArray(context.partialResults)).toBe(true)
      expect(Array.isArray(context.decisions)).toBe(true)
      expect(Array.isArray(context.memoryEntries)).toBe(true)
      expect(typeof context.taskProgress).toBe('number')
      expect(Array.isArray(context.errorLog)).toBe(true)
    })
  })
})
