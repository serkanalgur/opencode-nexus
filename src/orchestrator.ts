import type { 
  Agent, Task, DAG, DAGNode, ExecutionRequest, ExecutionResult,
  AgentRole, ComplexityScore, ModelSelection, BudgetConstraint,
  CostReport, AgentMessage, MemoryEntry, MemoryScope,
  SpawnConfig, RecoveryAction, HealthStatus, NexusConfig
} from "./types"

export class NexusOrchestrator {
  private agents: Map<string, Agent> = new Map()
  private tasks: Map<string, Task> = new Map()
  private dag: DAG | null = null
  private config: NexusConfig
  private budget: BudgetConstraint
  private running: boolean = false
  private paused: boolean = false
  
  // Cost tracking
  private totalSpent: number = 0
  private costByAgent: Map<string, number> = new Map()
  private costByModel: Map<string, number> = new Map()
  
  // Communication
  private messageQueue: AgentMessage[] = []
  private subscribers: Map<string, ((msg: AgentMessage) => void)[]> = new Map()
  
  // Memory
  private memory: Map<string, MemoryEntry> = new Map()
  
  // Event handlers
  private eventHandlers: Map<string, Function[]> = new Map()

  constructor(config?: Partial<NexusConfig>) {
    this.config = this.mergeConfig(config)
    this.budget = this.config.budget
  }

  private mergeConfig(partial?: Partial<NexusConfig>): NexusConfig {
    const defaults: NexusConfig = {
      maxConcurrency: 5,
      schedulerInterval: 1000,
      defaultTimeout: 300000,
      budget: {
        maxTotalCost: 10.00,
        maxCostPerTask: 1.00,
        maxCostPerAgent: 2.00,
        alertThreshold: 0.2,
        hardLimit: false
      },
      agents: {
        defaultRole: 'coder',
        spawnDelay: 100,
        healthCheckInterval: 30000
      },
      selfHealing: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000,
        backoffMultiplier: 2,
        contextTransfer: true
      },
      communication: {
        mode: 'pubsub',
        maxQueueSize: 100,
        messageTTL: 60000,
        persistence: false
      },
      memory: {
        enabled: true,
        storage: 'memory',
        maxEntriesPerScope: 1000,
        syncInterval: 5000
      },
      dashboard: {
        enabled: false,
        port: 4747,
        host: '127.0.0.1'
      },
      security: {
        sastEnabled: true,
        secretsScanning: true,
        scopeEnforcement: true
      },
      learning: {
        enabled: true,
        patternStorage: 'memory',
        minConfidence: 0.7
      }
    }

    return {
      ...defaults,
      ...partial,
      budget: { ...defaults.budget, ...partial?.budget },
      agents: { ...defaults.agents, ...partial?.agents },
      selfHealing: { ...defaults.selfHealing, ...partial?.selfHealing },
      communication: { ...defaults.communication, ...partial?.communication },
      memory: { ...defaults.memory, ...partial?.memory },
      dashboard: { ...defaults.dashboard, ...partial?.dashboard },
      security: { ...defaults.security, ...partial?.security },
      learning: { ...defaults.learning, ...partial?.learning }
    }
  }

  // === Core Operations ===

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.running) {
      throw new Error("Orchestrator is already running")
    }

    this.running = true
    const startTime = Date.now()

    try {
      // 1. Analyze and build DAG
      this.dag = this.buildDAG(request.tasks)

      // 2. Apply budget constraints
      if (request.budget) {
        this.budget = request.budget
      }

      // 3. Execute DAG
      await this.executeDAG()

      // 4. Collect results
      const results = this.collectResults()
      const totalDuration = Date.now() - startTime

      return {
        success: true,
        tasks: results,
        totalCost: this.totalSpent,
        totalDuration,
        agentsUsed: this.agents.size
      }
    } catch (error) {
      return {
        success: false,
        tasks: [],
        totalCost: this.totalSpent,
        totalDuration: Date.now() - startTime,
        agentsUsed: this.agents.size
      }
    } finally {
      this.running = false
    }
  }

  private buildDAG(tasks: Task[]): DAG {
    const dag: DAG = {
      nodes: new Map(),
      addNode: (node: DAGNode) => {
        dag.nodes.set(node.id, node)
      },
      addDependency: (nodeId: string, dependsOn: string) => {
        const node = dag.nodes.get(nodeId)
        if (node) {
          node.dependencies.push(dependsOn)
        }
      },
      removeNode: (nodeId: string) => {
        dag.nodes.delete(nodeId)
      },
      getReadyNodes: (): DAGNode[] => {
        const ready: DAGNode[] = []
        dag.nodes.forEach((node) => {
          if (node.status === 'pending') {
            const depsComplete = node.dependencies.every(dep => {
              const depNode = dag.nodes.get(dep)
              return depNode?.status === 'completed'
            })
            if (depsComplete) {
              ready.push(node)
            }
          }
        })
        return ready
      },
      markComplete: (nodeId: string, result) => {
        const node = dag.nodes.get(nodeId)
        if (node) {
          node.status = 'completed'
          node.result = result
        }
      },
      markFailed: (nodeId: string, error: Error) => {
        const node = dag.nodes.get(nodeId)
        if (node) {
          node.status = 'failed'
        }
      },
      getParallelGroups: (): DAGNode[][] => {
        const groups: DAGNode[][] = []
        const ready = dag.getReadyNodes()
        if (ready.length > 0) {
          groups.push(ready)
        }
        return groups
      },
      isComplete: (): boolean => {
        let complete = true
        dag.nodes.forEach((node) => {
          if (node.status !== 'completed' && node.status !== 'failed') {
            complete = false
          }
        })
        return complete
      }
    }

    // Add tasks to DAG
    for (const task of tasks) {
      const node: DAGNode = {
        id: task.id,
        task,
        dependencies: task.dependencies,
        status: 'pending'
      }
      dag.addNode(node)
    }

    return dag
  }

  private async executeDAG(): Promise<void> {
    while (!this.dag!.isComplete() && !this.paused) {
      const readyNodes = this.dag!.getReadyNodes()
      
      // Spawn agents for ready nodes (respecting concurrency limit)
      for (const node of readyNodes) {
        if (this.agents.size < this.config.maxConcurrency) {
          await this.spawnAndExecute(node)
        }
      }

      // Wait for scheduler interval
      await this.sleep(this.config.schedulerInterval)
    }
  }

  private async spawnAndExecute(node: DAGNode): Promise<void> {
    // Analyze complexity and select model
    const complexity = this.analyzeComplexity(node.task)
    const model = this.selectModel(node.task.requiredRole, complexity)

    // Spawn agent
    const agent = await this.spawnAgent({
      role: node.task.requiredRole,
      task: node.task,
      model: model.model
    })

    node.spawnedAgent = agent
    node.status = 'running'

    // Monitor completion
    this.monitorAgent(agent, node)
  }

  private async monitorAgent(agent: Agent, node: DAGNode): Promise<void> {
    // In real implementation, this would listen to agent events
    // For now, we simulate with a timeout
    const timeout = node.task.timeout || this.config.defaultTimeout
    
    setTimeout(() => {
      if (node.status === 'running') {
        // Agent timed out
        this.handleAgentTimeout(agent, node)
      }
    }, timeout)
  }

  private handleAgentTimeout(agent: Agent, node: DAGNode): void {
    if (this.config.selfHealing.enabled) {
      this.handleFailure(agent, node, new Error("Agent timed out"))
    } else {
      node.status = 'failed'
      node.result = {
        success: false,
        error: "Agent timed out",
        duration: node.task.timeout || this.config.defaultTimeout,
        tokensUsed: 0,
        cost: 0
      }
    }
  }

  private async handleFailure(agent: Agent, node: DAGNode, error: Error): Promise<void> {
    const failureCount = agent.metrics.tasksFailed + 1
    agent.metrics.tasksFailed++

    if (failureCount < this.config.selfHealing.maxRetries) {
      // Retry with delay
      const delay = this.config.selfHealing.retryDelay * 
        Math.pow(this.config.selfHealing.backoffMultiplier, failureCount - 1)
      
      setTimeout(async () => {
        await this.retryAgent(agent, node)
      }, delay)
    } else if (this.config.selfHealing.contextTransfer) {
      // Respawn with new agent
      await this.respawnAgent(agent, node)
    } else {
      node.status = 'failed'
      node.result = {
        success: false,
        error: error.message,
        duration: 0,
        tokensUsed: 0,
        cost: 0
      }
    }
  }

  private async retryAgent(agent: Agent, node: DAGNode): Promise<void> {
    // Reset agent status
    agent.status = 'working'
    node.status = 'running'
    
    // In real implementation, this would restart the agent's task
    this.emit('agent:retry', { agent, node })
  }

  private async respawnAgent(oldAgent: Agent, node: DAGNode): Promise<void> {
    // Create new agent with same config
    const newAgent = await this.spawnAgent({
      role: oldAgent.role,
      task: node.task,
      model: oldAgent.model.model
    })

    // Transfer context if enabled
    if (this.config.selfHealing.contextTransfer) {
      await this.transferContext(oldAgent, newAgent)
    }

    // Terminate old agent
    await this.terminateAgent(oldAgent.id)

    // Update node
    node.spawnedAgent = newAgent
    node.status = 'running'

    // Monitor new agent
    this.monitorAgent(newAgent, node)
  }

  private async transferContext(oldAgent: Agent, newAgent: Agent): Promise<void> {
    // Transfer partial results and decisions
    this.emit('context:transfer', { from: oldAgent, to: newAgent })
  }

  // === Agent Management ===

  async spawnAgent(config: SpawnConfig): Promise<Agent> {
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    const agent: Agent = {
      id: agentId,
      name: `${config.role}-${agentId.slice(0, 8)}`,
      role: config.role,
      status: 'spawning',
      model: {
        provider: 'opencode',
        model: config.model || 'default',
        estimatedCost: 0,
        estimatedQuality: 0.5,
        reasoning: 'Default selection'
      },
      spawnedAt: new Date(),
      lastActivity: new Date(),
      metrics: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        totalCost: 0,
        averageResponseTime: 0,
        errorRate: 0
      }
    }

    this.agents.set(agentId, agent)
    this.emit('agent:spawned', agent)

    // Simulate spawn delay
    await this.sleep(this.config.agents.spawnDelay)
    
    agent.status = 'idle'
    return agent
  }

  async terminateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.status = 'terminated'
      this.agents.delete(agentId)
      this.emit('agent:terminated', agent)
    }
  }

  // === Complexity Analysis ===

  private analyzeComplexity(task: Task): ComplexityScore {
    // Simple heuristic-based analysis
    const fileCount = task.files.include.length
    const codeLines = this.estimateCodeLines(task)
    const dependencyDepth = task.dependencies.length
    const domainKnowledge = this.estimateDomainKnowledge(task)
    const riskLevel = this.estimateRiskLevel(task)

    const overall = Math.min(100, 
      (fileCount * 10) + 
      (codeLines / 10) + 
      (dependencyDepth * 15) + 
      (domainKnowledge * 20) +
      (riskLevel === 'high' ? 30 : riskLevel === 'medium' ? 15 : 0)
    )

    return {
      overall,
      factors: {
        fileCount,
        codeLines,
        dependencyDepth,
        domainKnowledge,
        riskLevel
      }
    }
  }

  private estimateCodeLines(task: Task): number {
    // Rough estimate based on file count and task type
    return task.files.include.length * 50
  }

  private estimateDomainKnowledge(task: Task): number {
    // Simple keyword-based analysis
    const keywords = ['security', 'auth', 'payment', 'crypto', 'database']
    let score = 0
    for (const keyword of keywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        score += 20
      }
    }
    return Math.min(100, score)
  }

  private estimateRiskLevel(task: Task): 'low' | 'medium' | 'high' {
    const highRiskKeywords = ['migration', 'production', 'security', 'payment']
    const mediumRiskKeywords = ['refactor', 'update', 'modify']
    
    for (const keyword of highRiskKeywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        return 'high'
      }
    }
    
    for (const keyword of mediumRiskKeywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        return 'medium'
      }
    }
    
    return 'low'
  }

  // === Model Selection ===

  private selectModel(role: AgentRole, complexity: ComplexityScore): ModelSelection {
    // Cost-aware model selection
    const budgetRemaining = this.budget.maxTotalCost - this.totalSpent
    
    // Simple model selection logic
    if (complexity.overall > 70 && budgetRemaining > 5) {
      return {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        estimatedCost: 0.50,
        estimatedQuality: 0.9,
        reasoning: 'High complexity task with sufficient budget'
      }
    } else if (complexity.overall > 40 && budgetRemaining > 2) {
      return {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        estimatedCost: 0.10,
        estimatedQuality: 0.7,
        reasoning: 'Medium complexity, cost-optimized'
      }
    } else {
      return {
        provider: 'opencode',
        model: 'minimax-m2.5-free',
        estimatedCost: 0,
        estimatedQuality: 0.5,
        reasoning: 'Simple task, using free tier'
      }
    }
  }

  // === Cost Tracking ===

  trackCost(agentId: string, model: string, cost: number, tokens: number): void {
    this.totalSpent += cost
    
    const agentCost = this.costByAgent.get(agentId) || 0
    this.costByAgent.set(agentId, agentCost + cost)
    
    const modelCost = this.costByModel.get(model) || 0
    this.costByModel.set(model, modelCost + cost)

    // Check budget
    this.checkBudget()
  }

  private checkBudget(): void {
    const remaining = this.budget.maxTotalCost - this.totalSpent
    const remainingPercent = remaining / this.budget.maxTotalCost

    if (remainingPercent <= this.config.budget.alertThreshold) {
      this.emit('budget:alert', { remaining, remainingPercent })
    }

    if (this.budget.hardLimit && remaining <= 0) {
      this.emit('budget:exceeded', { totalSpent: this.totalSpent })
      this.pause()
    }
  }

  // === Communication ===

  publish(topic: string, message: Omit<AgentMessage, 'id' | 'timestamp'>): void {
    const fullMessage: AgentMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    }

    this.messageQueue.push(fullMessage)
    
    const handlers = this.subscribers.get(topic) || []
    handlers.forEach(handler => handler(fullMessage))
  }

  subscribe(topic: string, handler: (msg: AgentMessage) => void): () => void {
    const handlers = this.subscribers.get(topic) || []
    handlers.push(handler)
    this.subscribers.set(topic, handlers)

    return () => {
      const idx = handlers.indexOf(handler)
      if (idx > -1) {
        handlers.splice(idx, 1)
      }
    }
  }

  send(agentId: string, message: Omit<AgentMessage, 'id' | 'timestamp' | 'to'>): void {
    const fullMessage: AgentMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      to: agentId,
      timestamp: new Date()
    }

    this.messageQueue.push(fullMessage)
    this.emit('message:sent', fullMessage)
  }

  // === Memory ===

  setMemory(scope: MemoryScope, key: string, value: unknown, author: string): void {
    const entry: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      key,
      value,
      scope,
      author,
      timestamp: new Date(),
      confidence: 1.0,
      tags: []
    }

    this.memory.set(`${scope}:${key}`, entry)
    this.emit('memory:set', entry)
  }

  getMemory(scope: MemoryScope, key: string): MemoryEntry | undefined {
    return this.memory.get(`${scope}:${key}`)
  }

  searchMemory(query: string, scope?: MemoryScope): MemoryEntry[] {
    const results: MemoryEntry[] = []
    
    this.memory.forEach((entry) => {
      if (scope && entry.scope !== scope) return
      
      // Simple text matching
      if (entry.key.includes(query) || 
          JSON.stringify(entry.value).includes(query)) {
        results.push(entry)
      }
    })

    return results
  }

  // === Query ===

  getStatus(detailed?: boolean): string {
    const status = {
      running: this.running,
      paused: this.paused,
      agents: this.agents.size,
      tasks: this.tasks.size,
      totalCost: this.totalSpent,
      budgetRemaining: this.budget.maxTotalCost - this.totalSpent
    }

    if (detailed) {
      return JSON.stringify({
        ...status,
        agentsByStatus: this.getAgentsByStatus(),
        costByAgent: Object.fromEntries(this.costByAgent),
        costByModel: Object.fromEntries(this.costByModel)
      }, null, 2)
    }

    return JSON.stringify(status, null, 2)
  }

  listAgents(filter?: string): string {
    const agents = Array.from(this.agents.values())
    
    const filtered = filter 
      ? agents.filter(a => a.status === filter)
      : agents

    return JSON.stringify(filtered, null, 2)
  }

  getCostReport(): string {
    const report: CostReport = {
      totalSpent: this.totalSpent,
      budgetRemaining: this.budget.maxTotalCost - this.totalSpent,
      byAgent: new Map(),
      byModel: new Map(),
      timeline: []
    }

    this.agents.forEach((agent) => {
      report.byAgent.set(agent.id, {
        agentId: agent.id,
        agentName: agent.name,
        totalCost: agent.metrics.totalCost,
        tokenCount: agent.metrics.totalTokens,
        taskCount: agent.metrics.tasksCompleted
      })
    })

    return JSON.stringify({
      ...report,
      byAgent: Object.fromEntries(report.byAgent),
      byModel: Object.fromEntries(report.byModel)
    }, null, 2)
  }

  // === Control ===

  pause(): void {
    this.paused = true
    this.emit('orchestrator:paused', {})
  }

  resume(): void {
    this.paused = false
    this.emit('orchestrator:resumed', {})
  }

  shutdown(): void {
    this.agents.forEach((agent) => {
      agent.status = 'terminated'
    })
    this.agents.clear()
    this.running = false
    this.emit('orchestrator:shutdown', {})
  }

  // === Helpers ===

  private collectResults(): TaskResult[] {
    const results: TaskResult[] = []
    
    if (this.dag) {
      this.dag.nodes.forEach((node) => {
        if (node.result) {
          results.push(node.result)
        }
      })
    }

    return results
  }

  private getAgentsByStatus(): Record<string, number> {
    const counts: Record<string, number> = {}
    
    this.agents.forEach((agent) => {
      counts[agent.status] = (counts[agent.status] || 0) + 1
    })

    return counts
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // === Events ===

  on(event: string, handler: Function): () => void {
    const handlers = this.eventHandlers.get(event) || []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)

    return () => {
      const idx = handlers.indexOf(handler)
      if (idx > -1) {
        handlers.splice(idx, 1)
      }
    }
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) || []
    handlers.forEach(handler => handler(data))
  }

  // === Command Handling ===

  handleCommand(text: string): void {
    const parts = text.split(' ')
    const command = parts[1]

    switch (command) {
      case 'status':
        console.log(this.getStatus(true))
        break
      case 'agents':
        console.log(this.listAgents(parts[2]))
        break
      case 'costs':
        console.log(this.getCostReport())
        break
      case 'pause':
        this.pause()
        break
      case 'resume':
        this.resume()
        break
      default:
        console.log('Unknown command. Use /nexus help')
    }
  }
}
