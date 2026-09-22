import type {
  Agent, Task, DAG, DAGNode, ExecutionRequest, ExecutionResult,
  AgentRole, ComplexityScore, ModelSelection, BudgetConstraint,
  CostReport, AgentMessage, MemoryEntry, MemoryScope,
  SpawnConfig, RecoveryAction, HealthStatus, NexusConfig, TaskResult
} from "./types"
import { NexusConfigManager } from "./config"

export interface OrchestratorState {
  running: boolean
  paused: boolean
  agents: Array<{
    id: string
    name: string
    role: string
    status: string
    model: string
    sessionID?: string
    spawnedAt: string
    tasksCompleted: number
    tasksFailed: number
    totalCost: number
  }>
  tasks: Array<{
    id: string
    name: string
    role: string
    status: string
    assignedAgent?: string
    result?: { success: boolean; output?: string; error?: string; duration: number }
  }>
  totalSpent: number
  budgetRemaining: number
  lastUpdated: string
}

export class NexusOrchestrator {
  private agents: Map<string, Agent> = new Map()
  private tasks: Map<string, Task> = new Map()
  private dag: DAG | null = null
  private config: NexusConfig
  private budget: BudgetConstraint
  private running: boolean = false
  private paused: boolean = false
  private budgetExceeded: boolean = false

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

  // Config manager
  private configManager: NexusConfigManager

  // OpenCode context (set during initialization)
  public ctx: any = null

  // State update callback
  private onStateChange: (() => void) | null = null

  constructor(config?: Partial<NexusConfig>) {
    this.config = this.mergeConfig(config)
    this.budget = this.config.budget
    this.configManager = new NexusConfigManager()
  }

  /**
   * Initialize with OpenCode plugin context for session API access
   */
  initialize(ctx: any, onStateChange?: () => void) {
    this.ctx = ctx
    this.onStateChange = onStateChange ?? null

    // Load project/global config files from disk
    this.configManager.loadFromPath(process.cwd())
  }

  /**
   * Export current state for TUI/dashboard consumption
   */
  getState(): OrchestratorState {
    const agents = Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
      model: `${a.model.provider}/${a.model.model}`,
      sessionID: a.sessionID,
      spawnedAt: a.spawnedAt.toISOString(),
      tasksCompleted: a.metrics.tasksCompleted,
      tasksFailed: a.metrics.tasksFailed,
      totalCost: a.metrics.totalCost
    }))

    const tasks = Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      name: t.name,
      role: t.requiredRole,
      status: t.status,
      assignedAgent: t.assignedAgent,
      result: t.result ? {
        success: t.result.success,
        output: t.result.output?.slice(0, 500),
        error: t.result.error,
        duration: t.result.duration
      } : undefined
    }))

    return {
      running: this.running,
      paused: this.paused,
      agents,
      tasks,
      totalSpent: this.totalSpent,
      budgetRemaining: this.budget.maxTotalCost - this.totalSpent,
      lastUpdated: new Date().toISOString()
    }
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
        enabled: true,
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

  private notifyStateChange() {
    this.onStateChange?.()
  }

  // === Core Operations ===

  /**
   * Execute a set of tasks using real OpenCode sessions
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.running) {
      throw new Error("Orchestrator is already running")
    }

    if (!this.ctx) {
      throw new Error("Orchestrator not initialized - call initialize(ctx) first")
    }

    this.running = true
    const startTime = Date.now()
    this.notifyStateChange()

    try {
      // 1. Build DAG
      this.dag = this.buildDAG(request.tasks)

      // 2. Apply budget constraints
      if (request.budget) {
        this.budget = request.budget
      }

      // 3. Execute DAG with real sessions
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
      this.notifyStateChange()
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
      const spawnPromises: Promise<void>[] = []
      for (const node of readyNodes) {
        if (this.agents.size < this.config.maxConcurrency) {
          spawnPromises.push(this.spawnAndExecute(node))
        }
      }

      await Promise.all(spawnPromises)

      // Wait for scheduler interval
      await this.sleep(this.config.schedulerInterval)
    }
  }

  private async spawnAndExecute(node: DAGNode): Promise<void> {
    // Analyze complexity and select model
    const complexity = this.analyzeComplexity(node.task)
    const model = this.selectModel(node.task.requiredRole, complexity)

    // Spawn agent with real session
    const agent = await this.spawnAgent({
      role: node.task.requiredRole,
      task: node.task,
      model: model.model
    })

    node.spawnedAgent = agent
    node.status = 'running'
    node.task.assignedAgent = agent.id
    this.notifyStateChange()

    // Execute task via OpenCode session
    await this.executeTask(agent, node)
  }

  /**
   * Execute a task by sending it to a real OpenCode session
   */
  private async executeTask(agent: Agent, node: DAGNode): Promise<void> {
    if (!this.ctx || !agent.sessionID) {
      node.status = 'failed'
      node.result = {
        success: false,
        error: "No session available for agent",
        duration: 0,
        tokensUsed: 0,
        cost: 0
      }
      this.notifyStateChange()
      return
    }

    const startTime = Date.now()
    const timeout = node.task.timeout || this.config.defaultTimeout

    try {
      // Build the prompt for the agent
      const rolePrompt = this.buildRolePrompt(node.task.requiredRole)
      const taskPrompt = `${rolePrompt}\n\n## Task\n${node.task.name}\n\n${node.task.description}\n\n## Scope\nFiles: ${node.task.files.include.join(', ')}`

      // Send the task to the session
      await this.ctx.session.prompt({
        sessionID: agent.sessionID,
        text: taskPrompt
      })

      // Wait for completion (with timeout)
      const waitPromise = this.ctx.session.wait({ sessionID: agent.sessionID })
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Task timed out")), timeout)
      )

      await Promise.race([waitPromise, timeoutPromise])

      // Get the result context
      const messages = await this.ctx.session.context({ sessionID: agent.sessionID })
      const lastAssistantMsg = messages.filter((m: any) => m.role === 'assistant').pop()
      const output = lastAssistantMsg?.content || "Task completed"

      const duration = Date.now() - startTime
      const result: TaskResult = {
        success: true,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        duration,
        tokensUsed: 0, // Would need to parse from session context
        cost: this.estimateModelCost(agent.model.model)
      }

      this.dag!.markComplete(node.id, result)
      agent.metrics.tasksCompleted++
      agent.metrics.totalCost += result.cost
      this.totalSpent += result.cost
      this.costByAgent.set(agent.id, (this.costByAgent.get(agent.id) || 0) + result.cost)
      this.checkBudget()

    } catch (error: any) {
      const duration = Date.now() - startTime
      const result: TaskResult = {
        success: false,
        error: error.message || "Task failed",
        duration,
        tokensUsed: 0,
        cost: 0
      }

      this.dag!.markFailed(node.id, new Error(result.error!))
      agent.metrics.tasksFailed++

      // Self-healing: retry or respawn
      if (this.config.selfHealing.enabled) {
        await this.handleFailure(agent, node, new Error(result.error!))
      }
    } finally {
      agent.status = 'idle'
      node.task.status = node.status === 'completed' ? 'completed' : 'failed'
      this.notifyStateChange()
    }
  }

  /**
   * Build a system prompt for the agent's role
   */
  private buildRolePrompt(role: AgentRole): string {
    const rolePrompts: Record<string, string> = {
      architect: "You are a software architect. Focus on system design, architecture patterns, and high-level technical decisions. Analyze requirements and propose structured solutions.",
      coder: "You are a senior software engineer. Write clean, efficient, well-documented code. Follow best practices and coding standards.",
      reviewer: "You are a code reviewer. Review code for correctness, security, performance, and maintainability. Provide constructive feedback.",
      tester: "You are a QA engineer. Write comprehensive tests, identify edge cases, and ensure code quality.",
      explorer: "You are a code explorer. Navigate and analyze codebases, understand architecture, and provide detailed reports.",
      documenter: "You are a technical writer. Create clear, comprehensive documentation for code and APIs."
    }
    return rolePrompts[role] || `You are a ${role}. Complete the assigned task professionally.`
  }

  private async handleFailure(agent: Agent, node: DAGNode, error: Error): Promise<void> {
    const failureCount = agent.metrics.tasksFailed + 1

    if (failureCount < this.config.selfHealing.maxRetries) {
      // Retry with delay
      const delay = this.config.selfHealing.retryDelay *
        Math.pow(this.config.selfHealing.backoffMultiplier, failureCount - 1)

      await this.sleep(delay)

      // Retry by re-executing the task
      if (agent.sessionID) {
        node.status = 'running'
        this.notifyStateChange()
        await this.executeTask(agent, node)
      }
    } else {
      node.status = 'failed'
      node.result = {
        success: false,
        error: `Max retries (${this.config.selfHealing.maxRetries}) exceeded: ${error.message}`,
        duration: 0,
        tokensUsed: 0,
        cost: 0
      }
      this.notifyStateChange()
    }
  }

  // === Agent Management ===

  /**
   * Spawn a real OpenCode session for an agent
   */
  async spawnAgent(config: SpawnConfig): Promise<Agent> {
    if (!this.ctx) {
      throw new Error("Orchestrator not initialized")
    }

    // Check budget before spawning
    if (this.budgetExceeded) {
      throw new Error("Budget exceeded — cannot spawn new agents")
    }

    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Resolve model: override > config > default
    const modelConfig = config.model || this.configManager.getModelForRole(config.role)
    const slashIndex = modelConfig.indexOf('/')
    const provider = slashIndex > -1 ? modelConfig.slice(0, slashIndex) : modelConfig
    const modelName = slashIndex > -1 ? modelConfig.slice(slashIndex + 1) : modelConfig

    // Build descriptive session title for TUI display
    const roleEmoji = this.configManager.getRoleEmoji(config.role)
    const title = `${roleEmoji} ${this.configManager.getRoleDisplayName(config.role)} — ${modelConfig}`

    // Create session with agent and model params directly (most reliable method)
    const session = await this.ctx.session.create({
      title,
      agent: 'build',
      model: modelName ? { providerID: provider, id: modelName } : undefined,
    })

    const agent: Agent = {
      id: agentId,
      name: title,
      role: config.role,
      status: 'idle',
      model: {
        provider,
        model: modelName || 'default',
        estimatedCost: 0,
        estimatedQuality: 0.5,
        reasoning: `Configured for ${config.role}`
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
      },
      sessionID: session.id
    }

    this.agents.set(agentId, agent)
    this.emit('agent:spawned', agent)
    this.notifyStateChange()

    return agent
  }

  async terminateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.status = 'terminated'
      this.agents.delete(agentId)
      this.emit('agent:terminated', agent)
      this.notifyStateChange()
    }
  }

  // === Complexity Analysis ===

  analyzeComplexity(task: Task): ComplexityScore {
    const fileCount = task.files.include.length
    const codeLines = task.files.include.length * 50
    const dependencyDepth = task.dependencies.length
    let domainKnowledge = 0
    const keywords = ['security', 'auth', 'payment', 'crypto', 'database']
    for (const keyword of keywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        domainKnowledge += 20
      }
    }
    domainKnowledge = Math.min(100, domainKnowledge)

    let riskLevel: string = 'low'
    const highRiskKeywords = ['migration', 'production', 'security', 'payment']
    for (const keyword of highRiskKeywords) {
      if (task.description.toLowerCase().includes(keyword)) {
        riskLevel = 'high'
        break
      }
    }

    const overall = Math.min(100,
      (fileCount * 10) +
      (codeLines / 10) +
      (dependencyDepth * 15) +
      (domainKnowledge * 20) +
      (riskLevel === 'high' ? 30 : riskLevel === 'medium' ? 15 : 0)
    )

    return {
      overall,
      factors: { fileCount, codeLines, dependencyDepth, domainKnowledge, riskLevel: riskLevel as 'low' | 'medium' | 'high' }
    }
  }

  // === Model Selection ===

  selectModel(role: AgentRole, complexity: ComplexityScore): ModelSelection {
    const configModel = this.configManager.getModelForRole(role)
    const [provider, ...modelParts] = configModel.split('/')
    const model = modelParts.join('/')

    const budgetRemaining = this.budget.maxTotalCost - this.totalSpent

    if (budgetRemaining < 1 && configModel !== 'opencode/minimax-m2.5-free') {
      return {
        provider: 'opencode',
        model: 'minimax-m2.5-free',
        estimatedCost: 0,
        estimatedQuality: 0.5,
        reasoning: 'Budget constrained, using free tier'
      }
    }

    return {
      provider,
      model,
      estimatedCost: this.estimateModelCost(model),
      estimatedQuality: this.estimateModelQuality(model),
      reasoning: `Configured model for ${role}`
    }
  }

  private estimateModelCost(model: string): number {
    const costs: Record<string, number> = {
      'claude-sonnet-4-6': 0.15,
      'claude-opus-4-7': 15.00,
      'claude-haiku-4-5': 0.80,
      'gpt-5-mini': 0.05,
      'gpt-5': 2.50,
      'gemini-2.5-flash': 0.075,
      'minimax-m2.5-free': 0
    }
    return costs[model] || 0.10
  }

  private estimateModelQuality(model: string): number {
    const quality: Record<string, number> = {
      'claude-opus-4-7': 0.95,
      'claude-sonnet-4-6': 0.85,
      'gpt-5': 0.88,
      'claude-haiku-4-5': 0.75,
      'gemini-2.5-flash': 0.78,
      'gpt-5-mini': 0.70,
      'minimax-m2.5-free': 0.50
    }
    return quality[model] || 0.60
  }

  // === Cost Tracking ===

  trackCost(agentId: string, model: string, cost: number, tokens: number): void {
    this.totalSpent += cost
    const agentCost = this.costByAgent.get(agentId) || 0
    this.costByAgent.set(agentId, agentCost + cost)
    const modelCost = this.costByModel.get(model) || 0
    this.costByModel.set(model, modelCost + cost)
    this.checkBudget()
    this.notifyStateChange()
  }

  private checkBudget(): void {
    const remaining = this.budget.maxTotalCost - this.totalSpent
    const remainingPercent = remaining / this.budget.maxTotalCost

    if (remainingPercent <= this.config.budget.alertThreshold) {
      this.emit('budget:alert', { remaining, remainingPercent })
    }

    if (this.budget.hardLimit && remaining <= 0 && !this.budgetExceeded) {
      this.budgetExceeded = true
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
      if (idx > -1) handlers.splice(idx, 1)
    }
  }

  // === Memory ===

  setMemory(scope: MemoryScope, key: string, value: unknown, author: string): void {
    const entry: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      key, value, scope, author,
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

  // === Query ===

  getStatus(detailed?: boolean): string {
    const state = this.getState()
    if (detailed) return JSON.stringify({ ...state, budgetExceeded: this.budgetExceeded }, null, 2)
    return JSON.stringify({
      running: state.running,
      paused: state.paused,
      budgetExceeded: this.budgetExceeded,
      agents: state.agents.length,
      tasks: state.tasks.length,
      totalCost: state.totalSpent,
      budgetRemaining: state.budgetRemaining
    }, null, 2)
  }

  listAgents(filter?: string): string {
    const state = this.getState()
    const filtered = filter
      ? state.agents.filter(a => a.status === filter)
      : state.agents
    return JSON.stringify(filtered, null, 2)
  }

  getCostReport(): string {
    const state = this.getState()
    return JSON.stringify({
      totalSpent: state.totalSpent,
      budgetRemaining: state.budgetRemaining,
      byAgent: Object.fromEntries(this.costByAgent),
      byModel: Object.fromEntries(this.costByModel)
    }, null, 2)
  }

  // === Control ===

  pause(): void {
    this.paused = true
    this.emit('orchestrator:paused', {})
    this.notifyStateChange()
  }

  resume(): void {
    this.paused = false
    this.emit('orchestrator:resumed', {})
    this.notifyStateChange()
  }

  isBudgetExceeded(): boolean {
    return this.budgetExceeded
  }

  resetBudgetExceeded(): void {
    this.budgetExceeded = false
  }

  shutdown(): void {
    this.agents.forEach((agent) => {
      agent.status = 'terminated'
    })
    this.agents.clear()
    this.running = false
    this.emit('orchestrator:shutdown', {})
    this.notifyStateChange()
  }

  // === Helpers ===

  private collectResults(): TaskResult[] {
    const results: TaskResult[] = []
    if (this.dag) {
      this.dag.nodes.forEach((node) => {
        if (node.result) results.push(node.result)
      })
    }
    return results
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
      if (idx > -1) handlers.splice(idx, 1)
    }
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event) || []
    handlers.forEach(handler => handler(data))
  }

  // === Command Handling ===

  handleCommand(text: string): string {
    const parts = text.split(' ')
    const command = parts[1]

    switch (command) {
      case 'status':
        return this.getStatus(true)
      case 'agents':
        return this.listAgents(parts[2])
      case 'costs':
        return this.getCostReport()
      case 'pause':
        this.pause()
        return "Orchestrator paused"
      case 'resume':
        this.resume()
        return "Orchestrator resumed"
      case 'dashboard':
        return JSON.stringify(this.getState(), null, 2)
      default:
        return 'Unknown command. Available: status, agents, costs, pause, resume, dashboard'
    }
  }
}
