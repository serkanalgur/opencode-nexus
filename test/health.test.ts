import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { HealthMonitor } from "../src/health"
import type { Agent } from "../src/types"

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent-1",
    name: "Test Agent",
    role: "coder",
    status: "idle",
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedCost: 0.15,
      estimatedQuality: 0.85,
      reasoning: "Test model"
    },
    spawnedAt: new Date(),
    lastActivity: new Date(),
    metrics: {
      tasksCompleted: 10,
      tasksFailed: 1,
      totalTokens: 1000,
      totalCost: 0.5,
      averageResponseTime: 5000,
      errorRate: 0.1
    },
    ...overrides
  }
}

describe("HealthMonitor", () => {
  let monitor: HealthMonitor

  beforeEach(() => {
    monitor = new HealthMonitor()
  })

  afterEach(() => {
    monitor.stop()
  })

  describe("constructor", () => {
    it("should create with default config", () => {
      const config = monitor.getConfig()
      expect(config.checkInterval).toBe(30000)
      expect(config.unhealthyThreshold).toBe(0.5)
      expect(config.degradedThreshold).toBe(10000)
    })

    it("should create with custom config", () => {
      const customMonitor = new HealthMonitor({
        checkInterval: 5000,
        unhealthyThreshold: 0.3
      })
      const config = customMonitor.getConfig()
      expect(config.checkInterval).toBe(5000)
      expect(config.unhealthyThreshold).toBe(0.3)
      expect(config.degradedThreshold).toBe(10000) // default preserved
    })
  })

  describe("checkAgent", () => {
    it("should mark healthy agent with low error rate and response time", () => {
      const agent = createAgent({
        metrics: {
          tasksCompleted: 10,
          tasksFailed: 1,
          totalTokens: 1000,
          totalCost: 0.5,
          averageResponseTime: 5000,
          errorRate: 0.1
        }
      })

      const check = monitor.checkAgent(agent)
      expect(check.status).toBe("healthy")
      expect(check.agentId).toBe("test-agent-1")
      expect(check.errorRate).toBeCloseTo(0.0909, 3) // 1/11
      expect(check.responseTime).toBe(5000)
    })

    it("should mark degraded agent with high response time", () => {
      const agent = createAgent({
        metrics: {
          tasksCompleted: 10,
          tasksFailed: 1,
          totalTokens: 1000,
          totalCost: 0.5,
          averageResponseTime: 15000, // > 10000 threshold
          errorRate: 0.1
        }
      })

      const check = monitor.checkAgent(agent)
      expect(check.status).toBe("degraded")
    })

    it("should mark unhealthy agent with high error rate", () => {
      const agent = createAgent({
        metrics: {
          tasksCompleted: 5,
          tasksFailed: 6, // 6/11 = 0.545 > 0.5 threshold
          totalTokens: 1000,
          totalCost: 0.5,
          averageResponseTime: 5000,
          errorRate: 0.545
        }
      })

      const check = monitor.checkAgent(agent)
      expect(check.status).toBe("unhealthy")
    })

    it("should prioritize unhealthy over degraded", () => {
      const agent = createAgent({
        metrics: {
          tasksCompleted: 5,
          tasksFailed: 6, // High error rate
          totalTokens: 1000,
          totalCost: 0.5,
          averageResponseTime: 15000, // Also high response time
          errorRate: 0.545
        }
      })

      const check = monitor.checkAgent(agent)
      expect(check.status).toBe("unhealthy") // Not degraded
    })

    it("should handle agent with zero completed tasks", () => {
      const agent = createAgent({
        metrics: {
          tasksCompleted: 0,
          tasksFailed: 3,
          totalTokens: 0,
          totalCost: 0,
          averageResponseTime: 5000,
          errorRate: 1.0
        }
      })

      const check = monitor.checkAgent(agent)
      expect(check.status).toBe("unhealthy")
      expect(check.errorRate).toBe(1.0)
    })

    it("should store check history", () => {
      const agent = createAgent()
      monitor.checkAgent(agent)
      monitor.checkAgent(agent)

      const history = monitor.getHistory("test-agent-1")
      expect(history).toHaveLength(2)
    })

    it("should limit history to 100 entries", () => {
      const agent = createAgent()
      
      // Add 105 checks
      for (let i = 0; i < 105; i++) {
        monitor.checkAgent(agent)
      }

      const history = monitor.getHistory("test-agent-1")
      expect(history).toHaveLength(100)
    })
  })

  describe("getHealth", () => {
    it("should return latest check for agent", () => {
      const agent = createAgent()
      monitor.checkAgent(agent)
      
      const health = monitor.getHealth("test-agent-1")
      expect(health).not.toBeNull()
      expect(health!.agentId).toBe("test-agent-1")
    })

    it("should return null for unknown agent", () => {
      const health = monitor.getHealth("unknown-agent")
      expect(health).toBeNull()
    })
  })

  describe("getUnhealthyAgents", () => {
    it("should return list of unhealthy agents", () => {
      const healthyAgent = createAgent({
        id: "healthy-agent",
        metrics: {
          tasksCompleted: 10,
          tasksFailed: 0,
          totalTokens: 1000,
          totalCost: 0.5,
          averageResponseTime: 5000,
          errorRate: 0
        }
      })

      const unhealthyAgent = createAgent({
        id: "unhealthy-agent",
        metrics: {
          tasksCompleted: 5,
          tasksFailed: 6,
          totalTokens: 1000,
          totalCost: 0.5,
          averageResponseTime: 5000,
          errorRate: 0.545
        }
      })

      monitor.checkAgent(healthyAgent)
      monitor.checkAgent(unhealthyAgent)

      const unhealthy = monitor.getUnhealthyAgents()
      expect(unhealthy).toContain("unhealthy-agent")
      expect(unhealthy).not.toContain("healthy-agent")
    })

    it("should return empty array when no unhealthy agents", () => {
      const agent = createAgent()
      monitor.checkAgent(agent)

      const unhealthy = monitor.getUnhealthyAgents()
      expect(unhealthy).toHaveLength(0)
    })
  })

  describe("start/stop lifecycle", () => {
    it("should start and stop monitoring", () => {
      expect(monitor.isActive()).toBe(false)
      
      const agents: Agent[] = []
      monitor.start(() => agents)
      
      expect(monitor.isActive()).toBe(true)
      
      monitor.stop()
      expect(monitor.isActive()).toBe(false)
    })

    it("should only check active agents (working or idle)", async () => {
      const mockFn = mock(() => [
        createAgent({ id: "idle-agent", status: "idle" }),
        createAgent({ id: "spawning-agent", status: "spawning" }),
        createAgent({ id: "working-agent", status: "working" })
      ])

      // Use very short interval for testing
      const testMonitor = new HealthMonitor({ checkInterval: 10 })
      testMonitor.start(mockFn)

      // Wait for at least one check
      await new Promise(resolve => setTimeout(resolve, 50))
      
      testMonitor.stop()

      // idle and working agents should be checked
      expect(testMonitor.getHealth("idle-agent")).not.toBeNull()
      expect(testMonitor.getHealth("working-agent")).not.toBeNull()
      // spawning agent should not be checked
      expect(testMonitor.getHealth("spawning-agent")).toBeNull()
    })
  })

  describe("isActive", () => {
    it("should return false when not started", () => {
      expect(monitor.isActive()).toBe(false)
    })

    it("should return true when started", () => {
      monitor.start(() => [])
      expect(monitor.isActive()).toBe(true)
    })
  })
})
