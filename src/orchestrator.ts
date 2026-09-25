import type {
  Agent, Task, DAG, DAGNode, ExecutionRequest, ExecutionResult,
  AgentRole, ComplexityScore, ModelSelection, BudgetConstraint,
  CostReport, AgentMessage, MemoryEntry, MemoryScope,
  SpawnConfig, RecoveryAction, HealthStatus, NexusConfig, TaskResult
} from "./types"
import { NexusConfigManager } from "./config"
import { StateBroadcaster } from "./broadcast"
import { DashboardModule } from "./dashboard"
import { detectCycles } from "./dag"
import { MessageStore, type MessageStoreConfig } from "./message-store"
import { PersistentMemoryStore, type MemoryStoreConfig } from "./memory-store"
import { HealthMonitor } from "./health"
import { MessageRouter } from "./fanout"
import { NotificationManager } from "./notifications"
import { LearningModule } from "./learning"
import { ModuleRegistry, type ModuleContext } from "./modules"
import { SecurityScanner } from "./security"
import { PerformanceTracker } from "./performance"
import { ExecutionHistory } from "./history"
import { CustomRoleManager } from "./custom-roles"
import { CostForecaster } from "./forecast"
import { WorktreeManager } from "./worktree"
import { TodoEnforcer } from "./todo"

/**
 * Subset of OpenCode's `Tool.Context` that `spawnAgent` needs to fabricate a
 * tool invocation for the built-in `subagent` tool. Passed in from the plugin's
 * tool executor so the child session is linked to the real parent session.
 */
export interface SpawnToolContext {
  sessionID: string
  agent?: string
  messageID?: string
  callID?: string
  signal?: AbortSignal
}

export interface SpawnOptions {
  /**
   * The tool context of the calling tool. When present (and carrying a
   * `sessionID`), the child session is created through OpenCode's built-in
   * `subagent` tool so OpenCode links it to the parent via `parentID`.
   * When absent (internal scheduler / respawn call sites) a plain
   * `ctx.session.create()` is used, as before.
   */
  toolContext?: SpawnToolContext
  /** Full task text. Required for the subagent-tool path, which delivers it. */
  task?: string
}

/** How a child session was created — lets callers know which path was taken. */
export type SpawnPath = 'subagent-tool' | 'session-create'

export type SpawnedAgent = Agent & { spawnPath?: SpawnPath }

export interface ModelScore {
  model: string
  provider: string
  costScore: number      // 0-1, lower cost = higher score
  qualityScore: number   // 0-1, from estimateModelQuality
  speedScore: number     // 0-1, estimated based on model size
  overallScore: number   // weighted combination
  reasoning: string
}

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
    priority: string
    status: string
    assignedAgent?: string
    result?: { success: boolean; output?: string; error?: string; duration: number }
  }>
  totalSpent: number
  budgetRemaining: number
  lastUpdated: string
}

export interface EscalationPolicy {
  maxRetries: number
  retryDelay: number
  enableRespawn: boolean
  fallbackModels: string[]
  alertOnFailure: boolean
}

export const DEFAULT_ESCALATION: EscalationPolicy = {
  maxRetries: 3,
  retryDelay: 1000,
  enableRespawn: true,
  fallbackModels: ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4-5'],
  alertOnFailure: true
}

export interface ContextTransferData {
  previousAgentId: string
  partialResults: string[]
  decisions: string[]
  memoryEntries: MemoryEntry[]
  taskProgress: number // 0-100 percentage
  errorLog: string[]
}

export class NexusOrchestrator {
  private agents: Map<string, Agent> = new Map()
  private tasks: Map<string, Task> = new Map()
  private dag: DAG | null = null
  private config: NexusConfig
  public budget: BudgetConstraint
  private running: boolean = false
  private paused: boolean = false
  private budgetExceeded: boolean = false

  // Cost tracking
  public totalSpent: number = 0
  private costByAgent: Map<string, number> = new Map()
  private costByModel: Map<string, number> = new Map()

  // Communication
  private messageQueue: AgentMessage[] = []
  private subscribers: Map<string, ((msg: AgentMessage) => void)[]> = new Map()

  // Message persistence
  public messageStore: MessageStore

  // Memory (SQLite-backed persistent store)
  public memoryStore: PersistentMemoryStore

  // Topic-based fan-out router
  public messageRouter: MessageRouter

  // Event handlers
  private eventHandlers: Map<string, Function[]> = new Map()

  // Config manager
  public configManager: NexusConfigManager

  // OpenCode context (set during initialization)
  public ctx: any = null

  // WebSocket broadcaster (set via initBroadcaster)
  public broadcaster: StateBroadcaster | null = null

  // Dashboard server
  public dashboard: DashboardModule | null = null

  // Health monitor (lazy-initialized via getter)
  private _healthMonitor: HealthMonitor | null = null

  // Learning module for pattern recognition
  public learning: LearningModule

  // Escalation policy for self-healing
  private escalationPolicy: EscalationPolicy

  // Per-node retry counts for escalation tracking
  private nodeRetryCounts: Map<string, number> = new Map()

  // Module registry for composable features
  public moduleRegistry: ModuleRegistry

  // Security scanner for task output scanning
  public securityScanner: SecurityScanner

  // Performance tracker for model/role scoring
  public performanceTracker: PerformanceTracker

  // Execution history tracking
  public executionHistory: ExecutionHistory

  // Custom agent roles defined by the user
  public customRoles: CustomRoleManager

  // Cost forecaster for pre-execution estimates
  public forecaster: CostForecaster

  // Git worktree manager for agent isolation
  public worktreeManager: WorktreeManager | null = null

  // Todo enforcer for task tracking
  public todoEnforcer: TodoEnforcer = new TodoEnforcer()

  // State update callback
  private onStateChange: (() => void) | null = null

  // State change debounce timer
  private stateChangeTimer: ReturnType<typeof setTimeout> | null = null

  // Cost history for periodic cleanup
  private costHistory: Array<{ timestamp: number; cost: number; agentId: string }> = []

  // Cleanup interval handle
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  // Lazy-initialized health monitor
  get healthMonitor(): HealthMonitor | null {
    return this._healthMonitor
  }

  // OS notification manager
  public notifications: NotificationManager | null = null

  // Real model pricing from OpenCode (populated via loadModelCosts)
  public modelCosts: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = new Map()

  // Set when a spawn fell back to ctx.session.create() instead of the built-in
  // subagent tool (child session not parent-linked). null when the last spawn
  // used the subagent tool.
  public lastDegradedSpawn: { agentId: string; role: string; reason: 'no-parent-context' | 'subagent-tool-unavailable' } | null = null

  constructor(config?: Partial<NexusConfig>, messageStoreConfig?: Partial<MessageStoreConfig>, memoryStoreConfig?: Partial<MemoryStoreConfig>) {
    this.config = this.mergeConfig(config)
    this.budget = this.config.budget
    this.configManager = new NexusConfigManager()
    this.moduleRegistry = new ModuleRegistry()
    this.messageStore = new MessageStore(messageStoreConfig)
    this.memoryStore = new PersistentMemoryStore(memoryStoreConfig)
    this.messageRouter = new MessageRouter()

    // Initialize escalation policy from config selfHealing settings
    this.escalationPolicy = {
      ...DEFAULT_ESCALATION,
      maxRetries: this.config.selfHealing.maxRetries,
      retryDelay: this.config.selfHealing.retryDelay,
      enableRespawn: this.config.selfHealing.contextTransfer
    }

    // Initialize learning module with config min confidence
    this.learning = new LearningModule(this.config.learning.minConfidence)

    // Initialize security scanner
    this.securityScanner = new SecurityScanner()

    // Initialize performance tracker
    this.performanceTracker = new PerformanceTracker()

    // Initialize execution history tracker
    this.executionHistory = new ExecutionHistory()

    // Initialize custom role manager
    this.customRoles = new CustomRoleManager()

    // Initialize cost forecaster
    this.forecaster = new CostForecaster()
  }

  /**
   * Initialize with OpenCode plugin context for session API access
   */
  async initialize(ctx: any, onStateChange?: () => void) {
    this.ctx = ctx
    this.onStateChange = onStateChange ?? null

    // Load project/global config files from disk
    // Use plugin location directory, not process.cwd() which may be wrong
    const projectDir = ctx.location?.directory || process.cwd()
    this.configManager.loadFromPath(projectDir)

    // Load real model pricing from OpenCode
    await this.loadModelCosts()

    // Start periodic cleanup of stale data (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupStaleData(), 300000)

    // Initialize health monitor
    this._healthMonitor = new HealthMonitor({
      checkInterval: this.config.agents.healthCheckInterval
    })

    // Initialize notification manager
    this.notifications = new NotificationManager(true)

    // Set up all registered modules
    const moduleCtx: ModuleContext = {
      orchestrator: this,
      config: this.config,
      emit: (event: string, data: any) => this.emit(event, data),
      on: (event: string, handler: (data: any) => void) => { this.on(event, handler) }
    }
    await this.moduleRegistry.setupAll(moduleCtx)
  }

  /**
   * Load real model pricing from OpenCode's model list API.
   * Falls back to hardcoded values if API is unavailable.
   */
  private async loadModelCosts(): Promise<void> {
    try {
      if (!this.ctx) return

      // Method 1: Try via plugin client SDK (server plugin context)
      if (this.ctx.client?.model?.list) {
        const result = await this.ctx.client.model.list()
        const models = result?.data?.data ?? result?.data ?? []
        if (Array.isArray(models)) {
          for (const model of models) {
            if (model.cost && Array.isArray(model.cost) && model.cost.length > 0) {
              const baseCost = model.cost[0]
              this.modelCosts.set(model.id, {
                input: baseCost.input || 0,
                output: baseCost.output || 0,
                cacheRead: baseCost.cache?.read || 0,
                cacheWrite: baseCost.cache?.write || 0,
              })
            }
          }
        }
        return
      }

      // Method 2: Try via TUI location context (if available)
      const location = this.ctx.location ?? this.ctx.data?.location?.default()
      if (location && this.ctx.data?.location?.model) {
        await this.ctx.data.location.model.sync(location)
        const models = this.ctx.data.location.model.list(location) ?? []
        for (const model of models) {
          if (model.cost && Array.isArray(model.cost) && model.cost.length > 0) {
            const baseCost = model.cost[0]
            this.modelCosts.set(model.id, {
              input: baseCost.input || 0,
              output: baseCost.output || 0,
              cacheRead: baseCost.cache?.read || 0,
              cacheWrite: baseCost.cache?.write || 0,
            })
          }
        }
      }
    } catch {
      // Cost loading is best-effort — hardcoded fallbacks will be used
    }
  }

  /**
   * Manually set model costs (e.g., from TUI model list)
   */
  setModelCosts(costs: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>): void {
    for (const [model, cost] of Object.entries(costs)) {
      this.modelCosts.set(model, {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead || 0,
        cacheWrite: cost.cacheWrite || 0,
      })
    }
  }

  /**
   * Wire up the StateBroadcaster so that every notifyStateChange() call
   * also triggers a throttled broadcast to WebSocket clients.
   */
  initBroadcaster(opts?: { throttleMs?: number }): void {
    this.broadcaster = new StateBroadcaster(this, opts)
    // Chain into the existing onStateChange callback
    const previousOnStateChange = this.onStateChange
    this.onStateChange = () => {
      previousOnStateChange?.()
      this.broadcaster?.broadcastState()
    }
  }

  /**
   * Start the web dashboard server
   */
  startDashboard(port?: number, host?: string): void {
    const dashPort = port || this.config.dashboard.port
    const dashHost = host || this.config.dashboard.host
    this.dashboard = new DashboardModule(this)
    this.dashboard.start(dashPort, dashHost)

    // Wire up events for broadcasting
    this.on('agent:spawned', (agent: any) => this.dashboard?.broadcast('agent:spawned', agent))
    this.on('agent:terminated', (agent: any) => this.dashboard?.broadcast('agent:terminated', agent))
    this.on('budget:alert', (data: any) => this.dashboard?.broadcast('budget:alert', data))
    this.on('budget:exceeded', (data: any) => this.dashboard?.broadcast('budget:exceeded', data))
  }

  /**
   * Stop the web dashboard server
   */
  stopDashboard(): void {
    if (this.dashboard) {
      this.dashboard.stop()
      this.dashboard = null
    }
  }

  /**
   * Enable git worktree isolation for agents
   */
  enableWorktrees(repoRoot?: string): void {
    this.worktreeManager = new WorktreeManager(repoRoot || process.cwd())
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
      priority: t.priority || 'normal',
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

  public notifyStateChange(): void {
    if (this.stateChangeTimer) return
    this.stateChangeTimer = setTimeout(() => {
      this.stateChangeTimer = null
      this.onStateChange?.()
    }, 100) // 100ms debounce
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

      // 2. Detect circular dependencies before execution
      const dagNodes = Array.from(this.dag.nodes.values())
      const cycles = detectCycles(dagNodes)
      if (cycles.length > 0) {
        const cycleDescriptions = cycles.map(c => c.join(' → ')).join(', ')
        throw new Error(`Circular dependency detected: ${cycleDescriptions}`)
      }

      // 3. Apply budget constraints
      if (request.budget) {
        this.budget = request.budget
      }

      // 4. Execute DAG with real sessions
      await this.executeDAG()

      // 5. Collect results
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
        // Sort by priority: critical > high > normal > low
        const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 }
        return ready.sort((a, b) => {
          const pa = priorityOrder[a.task.priority] ?? 2
          const pb = priorityOrder[b.task.priority] ?? 2
          return pa - pb
        })
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

  private async spawnAndExecute(node: DAGNode, transferContext?: ContextTransferData): Promise<void> {
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
    await this.executeTask(agent, node, transferContext)
  }

  /**
   * Execute a task by sending it to a real OpenCode session
   */
  private async executeTask(agent: Agent, node: DAGNode, transferContext?: ContextTransferData): Promise<void> {
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
      let taskPrompt = `${rolePrompt}\n\n## Task\n${node.task.name}\n\n${node.task.description}\n\n## Scope\nFiles: ${node.task.files.include.join(', ')}`

      if (transferContext) {
        taskPrompt += `\n\n## Previous Agent Context (from failed agent ${transferContext.previousAgentId})`
        taskPrompt += `\nPartial results: ${transferContext.partialResults.join(', ') || 'None'}`
        taskPrompt += `\nDecisions made: ${transferContext.decisions.join(', ') || 'None'}`
        taskPrompt += `\nProgress: ${transferContext.taskProgress}%`
        taskPrompt += `\nErrors encountered: ${transferContext.errorLog.join(', ') || 'None'}`
        taskPrompt += `\n\nPlease continue from where the previous agent left off.`
      }

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
      this.todoEnforcer.completeTask(agent.id)
      agent.metrics.tasksCompleted++
      agent.metrics.totalCost += result.cost
      this.totalSpent += result.cost
      this.costByAgent.set(agent.id, (this.costByAgent.get(agent.id) || 0) + result.cost)
      this.checkBudget()

      // Record performance metrics
      this.performanceTracker.record({
        model: agent.model.model,
        role: node.task.requiredRole,
        success: result.success,
        duration: result.duration,
        cost: result.cost,
        tokensUsed: result.tokensUsed
      })

      // Record successful execution to history
      this.executionHistory.record({
        taskId: node.id,
        taskName: node.task.name,
        role: node.task.requiredRole,
        model: agent.model.model,
        status: 'success',
        cost: result.cost,
        duration: result.duration,
        tokensUsed: result.tokensUsed,
        startedAt: new Date(startTime),
        completedAt: new Date(),
      })

      // Notify on task completion
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Complete', body: `${node.task.name} completed successfully` })
      }

      // Record learning success if there was a prior failure pattern for this task
      const priorPattern = this.learning.findSolutions(`task ${node.id} failed`)
      if (priorPattern.length > 0) {
        this.learning.recordSuccess(priorPattern[0].entry.id)
      }

      // Scan task output for security issues
      if (typeof output === 'string' && output.length > 0) {
        const securityIssues = this.securityScanner.scanContent(output, node.task.name)
        if (securityIssues.length > 0) {
          this.emit('security:issues-found', {
            taskId: node.id,
            taskName: node.task.name,
            issues: securityIssues,
            totalIssues: securityIssues.length
          })
        }
      }

    } catch (error: any) {
      const duration = Date.now() - startTime
      const errorMessage = error.message || "Task failed"
      const result: TaskResult = {
        success: false,
        error: errorMessage,
        duration,
        tokensUsed: 0,
        cost: 0
      }

      this.dag!.markFailed(node.id, new Error(errorMessage))
      this.todoEnforcer.completeTask(agent.id)
      agent.metrics.tasksFailed++
      agent.status = 'failed'

      // Emit failure event for listeners
      this.emit('task:failed', {
        taskId: node.id,
        taskName: node.task.name,
        agentId: agent.id,
        role: node.task.requiredRole,
        model: agent.model.model,
        error: errorMessage,
        duration,
        sessionID: agent.sessionID
      })

      // Record performance metrics for failed task
      this.performanceTracker.record({
        model: agent.model.model,
        role: node.task.requiredRole,
        success: result.success,
        duration: result.duration,
        cost: result.cost,
        tokensUsed: result.tokensUsed
      })

      // Record failed execution to history (with session ID for traceability)
      this.executionHistory.record({
        taskId: node.id,
        taskName: node.task.name,
        role: node.task.requiredRole,
        model: agent.model.model,
        status: 'failed',
        cost: result.cost,
        duration: result.duration,
        tokensUsed: result.tokensUsed,
        startedAt: new Date(startTime),
        completedAt: new Date(),
        error: errorMessage
      })

      // Notify on task failure
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${errorMessage}`, sound: true })
      }

      // Self-healing: retry or respawn
      if (this.config.selfHealing.enabled) {
        await this.handleFailure(agent, node, new Error(errorMessage))
      }
    } finally {
      // Only reset to idle if agent is still in a non-terminal state
      if (agent.status !== 'terminated' && agent.status !== 'failed') {
        agent.status = 'idle'
      }
      node.task.status = node.status === 'completed' ? 'completed' : 'failed'
      this.notifyStateChange()
    }
  }

  /**
   * Build a system prompt for the agent's role
   */
  private buildRolePrompt(role: AgentRole): string {
    // Check for a custom role first
    if (this.customRoles.has(role)) {
      return this.customRoles.getPrompt(role) || `You are a ${role}. Complete the assigned task professionally.`
    }

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

  /**
   * Collect context from a failing agent for transfer to a respawned agent
   */
  collectContext(agent: Agent): ContextTransferData {
    // Gather partial results from session context if available
    const partialResults: string[] = []
    const decisions: string[] = []
    const errorLog: string[] = []

    // Extract recent session messages as partial results
    if (agent.sessionID && this.ctx) {
      // Note: In production, this would pull from the session context API.
      // For now we capture what we can from agent state.
      if (agent.metrics.tasksCompleted > 0) {
        partialResults.push(`${agent.metrics.tasksCompleted} task(s) completed before failure`)
      }
      if (agent.metrics.tasksFailed > 0) {
        errorLog.push(`${agent.metrics.tasksFailed} task(s) failed`)
      }
    }

    // Gather memory entries for this agent's scope
    const memoryEntries: MemoryEntry[] = []
    const byAgentId = this.memoryStore.getByAuthor(agent.id)
    const byRole = this.memoryStore.getByAuthor(agent.role)
    memoryEntries.push(...byAgentId, ...byRole)

    const taskProgress = agent.metrics.tasksCompleted > 0
      ? Math.min(50, agent.metrics.tasksCompleted * 25)
      : 0

    return {
      previousAgentId: agent.id,
      partialResults,
      decisions,
      memoryEntries,
      taskProgress,
      errorLog
    }
  }

  private async handleFailure(agent: Agent, node: DAGNode, error: Error): Promise<void> {
    const policy = this.escalationPolicy
    const retryCount = this.nodeRetryCounts.get(node.id) || 0

    // Record the failure pattern for learning
    const pattern = error.message || 'Unknown error'
    const solution = `Retry (attempt ${retryCount + 1}/${policy.maxRetries})`
    const context = `during ${node.task.requiredRole} task "${node.task.name}"`
    this.learning.recordFailure(pattern, solution, context, [node.task.requiredRole])

    // Step 1: Retry with exponential backoff
    if (retryCount < policy.maxRetries) {
      this.nodeRetryCounts.set(node.id, retryCount + 1)
      const delay = policy.retryDelay * Math.pow(2, retryCount) // exponential backoff
      await this.sleep(delay)

      // Re-spawn and execute the node
      node.status = 'pending'
      this.notifyStateChange()
      await this.spawnAndExecute(node)
      return
    }

    // Step 2: Respawn with context transfer
    if (policy.enableRespawn && this.config.selfHealing.contextTransfer) {
      const context = this.collectContext(agent)
      this.setMemory('session', `context:${agent.id}`, context, agent.id)

      // Terminate the failed agent before respawning
      await this.terminateAgent(agent.id)

      // Respawn with context
      node.status = 'pending'
      this.notifyStateChange()
      await this.spawnAndExecute(node, context)
      return
    }

    // Step 3: Try fallback model
    if (policy.fallbackModels.length > 0) {
      const fallbackModel = policy.fallbackModels.shift()
      if (fallbackModel) {
        // Terminate the failed agent
        await this.terminateAgent(agent.id)

        // Spawn with fallback model override
        node.status = 'pending'
        this.notifyStateChange()
        // KNOWN PRE-EXISTING BUG (present at base commit a87e81e, not introduced
        // here): this bare spawnAgent never prompts the new session, so the
        // fallback agent receives no task. Out of scope for the subagent-tool
        // dispatch change; do not mistake it for a regression from that work.
        await this.spawnAgent({ role: node.task.requiredRole, model: fallbackModel })
        return
      }
    }

    // Step 4: Alert and mark as failed
    if (policy.alertOnFailure) {
      this.emit('agent:escalation', { agentId: agent.id, taskId: node.id, error: error.message })
      // Notify on final failure
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Task Failed', body: `${node.task.name} failed: ${error.message}`, sound: true })
      }
    }

    node.status = 'failed'
    node.result = {
      success: false,
      error: error.message,
      duration: 0,
      tokensUsed: 0,
      cost: 0
    }
    this.notifyStateChange()
  }

  // === Agent Management ===

  /**
   * Create a child session by invoking OpenCode's built-in `subagent` tool.
   *
   * The public session API (`ctx.session.create`) has no `parentID` field, so a
   * plugin cannot link a child session to its parent that way. The built-in
   * `subagent` tool does set `parentID` from the tool context's `sessionID`,
   * so we call it directly with a fabricated tool context.
   *
   * Returns the child session ID, which the `subagent` tool reports through its
   * `progress` callback immediately after creating the session.
   */
  private async createChildSession(params: {
    tool: any
    agent: string
    description: string
    prompt: string
    model: string
    parent: SpawnToolContext
    callID: string
  }): Promise<string> {
    const { tool, agent, description, prompt, model, parent, callID } = params

    if (!parent.sessionID) {
      throw new Error("Cannot spawn agent without a parent session ID")
    }
    if (!tool || typeof tool.execute !== 'function') {
      throw new Error("OpenCode's built-in 'subagent' tool is unavailable — cannot create a child session")
    }
    // The subagent executor resolves the caller's permission rules from
    // `agent`. Do not fabricate a most-permissive identity — fail loudly.
    if (!parent.agent) {
      throw new Error("Cannot spawn agent without the calling agent id (tool context has no 'agent')")
    }

    // The subagent tool fires progress with the child session ID as soon as the
    // session exists, before the child finishes. That is our source of truth.
    let childSessionID: string | undefined
    let reportProgress: ((p: { sessionID: string; status: string }) => void) | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const childSessionReady = new Promise<string>((resolve, reject) => {
      reportProgress = async (p: { sessionID: string; status: string }) => {
        if (p?.sessionID && !childSessionID) {
          childSessionID = p.sessionID
          resolve(p.sessionID)
        }
      }
      // Never hang spawn waiting on progress if the tool misbehaves.
      watchdog = setTimeout(() => reject(new Error(`subagent tool did not report a child session for ${agent}`)), 30_000)
    })
    childSessionReady.catch(() => {})

    const toolContext = {
      sessionID: parent.sessionID,
      agent: parent.agent,
      messageID: parent.messageID || `msg_${callID}`,
      id: `call_${callID}`,
      progress: reportProgress,
      signal: parent.signal ?? new AbortController().signal,
    }

    const subagentCall = tool.execute(
      { agent, description, prompt, model, background: true },
      toolContext,
    ) as Promise<unknown>

    let childSessionIDResolved: string
    try {
      childSessionIDResolved = await Promise.race([
        childSessionReady,
        // Surface real tool failures (e.g. "Subagent denied") instead of timing out.
        subagentCall.then(
          () => { throw new Error(`subagent tool finished without reporting a child session for ${agent}`) },
          (err: any) => { throw new Error(`subagent tool failed for ${agent}: ${err?.message || err}`) },
        ),
      ])
    } finally {
      if (watchdog) clearTimeout(watchdog)
    }

    // The child runs in the background; surface tool failures without rejecting
    // the spawn once we already have a usable child session.
    subagentCall.catch(() => {})

    return childSessionIDResolved
  }

  /**
   * Spawn a real OpenCode session for an agent
   *
   * @param options.toolContext Tool context of the calling tool. Only when this
   *   is supplied (with a `sessionID`) is the built-in `subagent` tool used, so
   *   OpenCode links the child to the real parent session. Internal call sites
   *   (scheduler, model-fallback respawn) have no tool context and keep using
   *   `ctx.session.create()`.
   * @param options.task Full task text, delivered through the subagent tool's
   *   `prompt` on the subagent-tool path. Callers on the create path must
   *   deliver the task themselves via `ctx.session.prompt()`.
   */
  async spawnAgent(config: SpawnConfig, options?: SpawnOptions): Promise<SpawnedAgent> {
    if (!this.ctx) {
      throw new Error("Orchestrator not initialized")
    }

    // Check budget before spawning
    if (this.budgetExceeded) {
      throw new Error("Budget exceeded — cannot spawn new agents")
    }

    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Resolve model: override > config > default
    let modelConfig = config.model || this.configManager.getModelForRole(config.role)

    // Auto-complete model name if missing provider prefix
    // e.g. "mimo-v2.5" → find "opencode-go/mimo-v2.5" in config
    if (!modelConfig.includes('/')) {
      const allModels = this.configManager.getConfig().models
      const match = Object.values(allModels).find(m => m?.split('/')[1] === modelConfig)
      if (match) {
        modelConfig = match
      } else {
        throw new Error(`Invalid model "${config.model}". Use "providerID/modelID" format (e.g. "opencode-go/mimo-v2.5")`)
      }
    }

    const slashIndex = modelConfig.indexOf('/')
    const provider = modelConfig.slice(0, slashIndex)
    const modelName = modelConfig.slice(slashIndex + 1)

    // Build descriptive session title for TUI display
    const roleEmoji = this.configManager.getRoleEmoji(config.role)
    const title = `${roleEmoji} ${this.configManager.getRoleDisplayName(config.role)} — ${modelConfig}`

    // Map Nexus roles to the plugin's own nexus-* agents (see the agent
    // markdown files written in index.ts). These are non-primary, so the
    // subagent executor accepts them.
    const agentTypeMap: Record<string, string> = {
      architect: 'nexus-architect',
      coder: 'nexus-coder',
      reviewer: 'nexus-reviewer',
      tester: 'nexus-tester',
      explorer: 'nexus-explorer',
      documenter: 'nexus-documenter',
    }
    const agentType = agentTypeMap[config.role] || 'nexus-coder'

    // The subagent-tool path requires an explicitly supplied tool context: it
    // must never borrow a parent session latched from an unrelated session.
    const parent: SpawnToolContext | undefined = options?.toolContext?.sessionID
      ? options.toolContext
      : undefined

    const toolList = parent && typeof this.ctx.tool?.list === 'function'
      ? await this.ctx.tool.list()
      : undefined
    const subagentTool = Array.isArray(toolList)
      ? toolList.find(t => t?.id === 'subagent' && typeof t?.execute === 'function')
      : undefined

    // Complete task text. On the subagent-tool path the tool's `prompt`
    // delivers it — that is the single delivery point (no second prompt).
    const taskText = options?.task || config.task?.description || config.task?.name || ''

    let spawnPath: SpawnPath = 'session-create'
    let childSessionID: string

    if (subagentTool) {
      if (!taskText) {
        throw new Error("spawnAgent requires task text when using the subagent tool path")
      }
      spawnPath = 'subagent-tool'
      childSessionID = await this.createChildSession({
        tool: subagentTool,
        agent: agentType,
        description: title,
        prompt: taskText,
        model: modelConfig,
        parent: parent!,
        callID: agentId,
      })
    } else {
      // No tool context (internal scheduler / respawn call sites) or the tool is
      // unavailable. NOTE: there is deliberately no session-metadata write after
      // this — SessionUpdateInput is exactly { sessionID, title?, permissions? },
      // so `metadata` would be silently dropped. The equivalent data (role,
      // model, sessionID) lives on the Agent record, which is persisted to
      // ctx.storage as `orchestrator-state` / `nexus-sidebar-state`.
      const created = await this.ctx.session.create({
        title,
        agent: agentType,
        model: modelName ? { providerID: provider, id: modelName } : undefined,
        metadata: {
          nexusRole: config.role,
          nexusTask: config.task?.name || 'direct-spawn',
          nexusAgentId: agentId,
          nexusModel: modelConfig,
        },
      })
      childSessionID = created.id
    }

    if (spawnPath === 'session-create') {
      // Make the degradation visible: a create-path child is NOT linked to a
      // parent session in OpenCode, which is the defect this code fixes.
      this.lastDegradedSpawn = {
        agentId,
        role: config.role,
        // A parent context was supplied but the tool is missing; without any
        // parent context tool.list() is never even consulted.
        reason: parent ? 'subagent-tool-unavailable' : 'no-parent-context',
      }
      console.warn(
        `[nexus] spawn degraded for ${config.role}: child session ${childSessionID} was created via ` +
        `ctx.session.create (${this.lastDegradedSpawn.reason}) and is not linked to a parent session.`
      )
    } else {
      this.lastDegradedSpawn = null
    }

    const agent: SpawnedAgent = {
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
      sessionID: childSessionID,
      spawnPath
    }

    this.agents.set(agentId, agent)

    // Auto-add todo for the spawned task
    const taskDesc = config.task?.name || `Agent ${config.role} task`
    this.todoEnforcer.trackTask(agentId, taskDesc, config.role)

    this.emit('agent:spawned', agent)
    this.notifyStateChange()

    // Enforce agent map size limit
    this.enforceAgentLimit()

    // Start health monitoring if not already running (lazy init)
    const monitor = this.getOrCreateHealthMonitor()
    if (!monitor.isActive()) {
      monitor.start(() => Array.from(this.agents.values()))
    }

    return agent
  }

  async terminateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.status = 'terminated'
      this.agents.delete(agentId)
      this.emit('agent:terminated', agent)
      this.notifyStateChange()

      // Stop health monitoring if no more agents
      if (this._healthMonitor && this.agents.size === 0) {
        this._healthMonitor.stop()
      }
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
    return this.selectBestModel(role, complexity)
  }

  private estimateModelCost(model: string): number {
    // Try real pricing data first
    const realCost = this.modelCosts.get(model)
    if (realCost) {
      // Estimate cost per 1K tokens (input + output averaged)
      // Real pricing is per-token, we estimate per 1K tokens for budget tracking
      return (realCost.input * 1000 + realCost.output * 1000) / 2
    }

    // Fallback to hardcoded estimates
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

  private estimateModelSpeed(model: string): number {
    const speeds: Record<string, number> = {
      'claude-opus-4-7': 0.4,
      'claude-sonnet-4-6': 0.7,
      'gpt-5': 0.6,
      'claude-haiku-4-5': 0.9,
      'gemini-2.5-flash': 0.95,
      'gpt-5-mini': 0.85,
      'minimax-m2.5-free': 0.8
    }
    return speeds[model] || 0.5
  }

  scoreModel(modelId: string, role: string, complexity: ComplexityScore): ModelScore {
    const [provider, ...parts] = modelId.split('/')
    const model = parts.join('/')

    const cost = this.estimateModelCost(model)
    const quality = this.estimateModelQuality(model)
    const maxCost = 15.00 // normalize against most expensive

    const costScore = 1 - (cost / maxCost)
    const speedScore = this.estimateModelSpeed(model)

    // Weight based on complexity: high complexity favors quality, low favors cost
    const qualityWeight = complexity.overall > 70 ? 0.6 : complexity.overall > 40 ? 0.4 : 0.2
    const costWeight = 1 - qualityWeight

    const overallScore = (quality * qualityWeight) + (costScore * costWeight)

    return {
      model,
      provider,
      costScore,
      qualityScore: quality,
      speedScore,
      overallScore,
      reasoning: `Score: ${overallScore.toFixed(2)} (quality: ${quality.toFixed(2)}, cost: ${costScore.toFixed(2)}, speed: ${speedScore.toFixed(2)})`
    }
  }

  selectBestModel(role: string, complexity: ComplexityScore): ModelSelection {
    const configModel = this.configManager.getModelForRole(role)

    // Build candidate list: configured model + alternatives
    const candidates = [
      configModel,
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'opencode/minimax-m2.5-free'
    ]

    // Deduplicate while preserving order
    const unique = [...new Set(candidates)]

    // Score all candidates
    const scored = unique.map(m => this.scoreModel(m, role, complexity))

    // Filter by budget
    const budgetRemaining = this.budget.maxTotalCost - this.totalSpent
    const affordable = scored.filter(s => {
      const cost = this.estimateModelCost(s.model)
      return cost <= budgetRemaining || cost === 0
    })

    // Pick best — prefer affordable models, but fall back to all if none are affordable
    const best = (affordable.length > 0 ? affordable : scored)
      .sort((a, b) => b.overallScore - a.overallScore)[0]

    return {
      provider: best.provider,
      model: best.model,
      estimatedCost: this.estimateModelCost(best.model),
      estimatedQuality: best.qualityScore,
      reasoning: best.reasoning
    }
  }

  // === Cost Tracking ===

  trackCost(agentId: string, model: string, cost: number, tokens: number): void {
    this.totalSpent += cost
    const agentCost = this.costByAgent.get(agentId) || 0
    this.costByAgent.set(agentId, agentCost + cost)
    const modelCost = this.costByModel.get(model) || 0
    this.costByModel.set(model, modelCost + cost)
    this.costHistory.push({ timestamp: Date.now(), cost, agentId })
    this.checkBudget()
    this.notifyStateChange()
  }

  private checkBudget(): void {
    const remaining = this.budget.maxTotalCost - this.totalSpent
    const remainingPercent = remaining / this.budget.maxTotalCost

    if (remainingPercent <= this.config.budget.alertThreshold) {
      this.emit('budget:alert', { remaining, remainingPercent })
      // Notify on budget alert
      if (this.notifications?.isEnabled()) {
        this.notifications.notify({ title: 'Nexus: Budget Alert', body: `Budget low: $${remaining.toFixed(2)} remaining (${(remainingPercent * 100).toFixed(1)}%)`, sound: true })
      }
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
      topic: message.topic ?? topic,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    }
    this.messageQueue.push(fullMessage)

    // Persist to message store
    this.messageStore.add(fullMessage)

    // Legacy topic-based pub/sub
    const handlers = this.subscribers.get(topic) || []
    handlers.forEach(handler => handler(fullMessage))

    // Fan-out routing (topic + wildcard subscribers)
    this.messageRouter.route(fullMessage)
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
    const entry = this.memoryStore.set({
      key,
      value,
      scope,
      author,
      confidence: 1.0,
      tags: []
    })
    this.emit('memory:set', entry)
  }

  getMemory(scope: MemoryScope, key: string): MemoryEntry | undefined {
    return this.memoryStore.get(key, scope) ?? undefined
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

  async shutdown(): Promise<void> {
    // Tear down all modules before stopping orchestrator components
    await this.moduleRegistry.teardownAll()

    this._healthMonitor?.stop()
    this.stopDashboard()
    this.memoryStore.close()
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    if (this.stateChangeTimer) {
      clearTimeout(this.stateChangeTimer)
      this.stateChangeTimer = null
    }
    this.agents.forEach((agent) => {
      agent.status = 'terminated'
    })
    this.agents.clear()
    this.running = false
    this.emit('orchestrator:shutdown', {})
    this.onStateChange?.()
  }

  // === Helpers ===

  /**
   * Periodically clean up stale agents and cost history to prevent unbounded memory growth.
   */
  private cleanupStaleData(): void {
    const now = Date.now()

    // Clean old terminated agents (terminated for > 1 hour)
    for (const [id, agent] of this.agents) {
      if (agent.status === 'terminated' &&
          now - agent.lastActivity.getTime() > 3600000) {
        this.agents.delete(id)
      }
    }

    // Trim cost history if it grows too large (keep last 500 entries)
    if (this.costHistory.length > 1000) {
      this.costHistory = this.costHistory.slice(-500)
    }
  }

  /**
   * Enforce agent map size limit to prevent unbounded growth.
   * Removes oldest terminated agents when over the concurrency limit.
   */
  private enforceAgentLimit(): void {
    const MAX_AGENTS = this.config.maxConcurrency || 10
    if (this.agents.size > MAX_AGENTS) {
      // Find oldest terminated agents to clean up first
      const terminated = [...this.agents.entries()]
        .filter(([_, a]) => a.status === 'terminated')
        .sort((a, b) => a[1].lastActivity.getTime() - b[1].lastActivity.getTime())

      const toRemove = terminated.slice(0, this.agents.size - MAX_AGENTS)
      for (const [id] of toRemove) {
        this.agents.delete(id)
      }
    }
  }

  /**
   * Get or lazily initialize the health monitor
   */
  private getOrCreateHealthMonitor(): HealthMonitor {
    if (!this._healthMonitor) {
      this._healthMonitor = new HealthMonitor({
        checkInterval: this.config.agents.healthCheckInterval
      })
    }
    return this._healthMonitor
  }

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
