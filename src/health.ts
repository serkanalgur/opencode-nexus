import type { Agent } from "./types"

export interface HealthCheck {
  agentId: string
  timestamp: Date
  responseTime: number
  errorRate: number
  tokensPerSecond: number
  memoryUsage: number
  status: 'healthy' | 'degraded' | 'unhealthy'
}

export interface HealthConfig {
  checkInterval: number    // ms between checks
  unhealthyThreshold: number // error rate threshold
  degradedThreshold: number  // response time threshold (ms)
}

const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  checkInterval: 30000,  // 30 seconds
  unhealthyThreshold: 0.5,  // 50% error rate
  degradedThreshold: 10000, // 10 seconds response time
}

export class HealthMonitor {
  private checks: Map<string, HealthCheck[]> = new Map()
  private interval: ReturnType<typeof setInterval> | null = null
  private config: HealthConfig

  constructor(config?: Partial<HealthConfig>) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config }
  }

  start(getAgents: () => Agent[]): void {
    this.stop() // Clear any existing interval
    this.interval = setInterval(() => {
      const agents = getAgents()
      for (const agent of agents) {
        if (agent.status === 'working' || agent.status === 'idle') {
          this.checkAgent(agent)
        }
      }
    }, this.config.checkInterval)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  checkAgent(agent: Agent): HealthCheck {
    const errorRate = agent.metrics.tasksFailed / Math.max(1, agent.metrics.tasksCompleted + agent.metrics.tasksFailed)
    const avgResponseTime = agent.metrics.averageResponseTime || 0
    
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    if (errorRate > this.config.unhealthyThreshold) status = 'unhealthy'
    else if (avgResponseTime > this.config.degradedThreshold) status = 'degraded'

    const check: HealthCheck = {
      agentId: agent.id,
      timestamp: new Date(),
      responseTime: avgResponseTime,
      errorRate,
      tokensPerSecond: 0,
      memoryUsage: 0,
      status
    }

    const history = this.checks.get(agent.id) || []
    history.push(check)
    if (history.length > 100) history.shift() // Keep last 100 checks
    this.checks.set(agent.id, history)

    return check
  }

  getHealth(agentId: string): HealthCheck | null {
    const history = this.checks.get(agentId)
    return history?.[history.length - 1] || null
  }

  getHistory(agentId: string): HealthCheck[] {
    return this.checks.get(agentId) || []
  }

  getUnhealthyAgents(): string[] {
    const unhealthy: string[] = []
    for (const [agentId, history] of this.checks) {
      const latest = history[history.length - 1]
      if (latest?.status === 'unhealthy') unhealthy.push(agentId)
    }
    return unhealthy
  }

  /**
   * Get the current configuration
   */
  getConfig(): HealthConfig {
    return { ...this.config }
  }

  /**
   * Check if monitoring is active
   */
  isActive(): boolean {
    return this.interval !== null
  }
}
