import { describe, it, expect, beforeEach } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'

describe('NexusOrchestrator', () => {
  let orchestrator: NexusOrchestrator

  beforeEach(() => {
    orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
    })
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
    it('should spawn an agent', async () => {
      const agent = await orchestrator.spawnAgent({ role: 'coder' })
      expect(agent).toBeDefined()
      expect(agent.role).toBe('coder')
      expect(agent.status).toBe('idle')
      expect(agent.id).toMatch(/^agent-/)
    })

    it('should spawn agent with custom model', async () => {
      const agent = await orchestrator.spawnAgent({ 
        role: 'reviewer', 
        model: 'anthropic/claude-sonnet-4-6' 
      })
      expect(agent.model.model).toBe('anthropic/claude-sonnet-4-6')
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

    it('should return detailed status', () => {
      const status = orchestrator.getStatus(true)
      expect(status).toContain('running')
      expect(status).toContain('agentsByStatus')
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

    it('should search memory', () => {
      orchestrator.setMemory('project', 'auth', { approach: 'jwt' }, 'architect')
      orchestrator.setMemory('project', 'db', { type: 'postgres' }, 'architect')
      
      const results = orchestrator.searchMemory('jwt')
      expect(results.length).toBeGreaterThan(0)
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

    it('should send direct message', () => {
      const agent = { id: 'test-agent', receiveMessage: () => {} }
      orchestrator['agents'].set('test-agent', agent as any)
      
      // Should not throw
      orchestrator.send('test-agent', {
        from: 'sender',
        type: 'status-update',
        payload: { status: 'working' },
        metadata: { priority: 'normal', requiresResponse: false }
      })
    })
  })

  describe('cost tracking', () => {
    it('should track costs', () => {
      orchestrator.trackCost('agent-1', 'claude-sonnet', 0.50, 1000)
      orchestrator.trackCost('agent-1', 'claude-sonnet', 0.25, 500)
      
      const report = orchestrator.getCostReport()
      expect(report).toContain('totalSpent')
      expect(report).toContain('budgetRemaining')
    })

    it('should check budget limits', () => {
      const orch = new NexusOrchestrator({
        budget: { maxTotalCost: 1.00, maxCostPerTask: 0.50, maxCostPerAgent: 0.50, alertThreshold: 0.8, hardLimit: true }
      })
      
      // Track costs
      orch.trackCost('agent-1', 'claude-sonnet', 0.90, 2000)
      
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
      // Should not throw
      orchestrator.handleCommand('/nexus status')
    })

    it('should handle agents command', () => {
      // Should not throw
      orchestrator.handleCommand('/nexus agents')
    })

    it('should handle costs command', () => {
      // Should not throw
      orchestrator.handleCommand('/nexus costs')
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
  })
})
