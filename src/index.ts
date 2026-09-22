import { Plugin } from "@opencode/plugin"
import { NexusOrchestrator } from "./orchestrator"
import { PRESETS } from "./config"
import { TEMPLATES, instantiateTemplate, listTemplates } from "./templates"

export default Plugin.define({
  id: "nexus",
  async setup(ctx) {
    const orchestrator = new NexusOrchestrator()

    // Initialize orchestrator with OpenCode context for real session API access
    await orchestrator.initialize(ctx, () => {
      // State change callback - persist to storage for TUI consumption
      const state = orchestrator.getState()
      ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state))).catch(() => {}
      )
    })

    // Persist initial state
    await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

    // Register tools
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "nexus",
        description: "Adaptive multi-agent orchestration tools"
      })

      editor.add({
        name: "status",
        description: "Get orchestrator status and metrics",
        input: {
          type: "object",
          properties: {
            detailed: { type: "boolean", description: "Include detailed metrics" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { detailed } = input as { detailed?: boolean }
          const status = orchestrator.getStatus(detailed)
          // Persist after reading
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
          return { content: status }
        }
      })

      editor.add({
        name: "agents",
        description: "List all active agents",
        input: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by status" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { filter } = input as { filter?: string }
          return { content: orchestrator.listAgents(filter) }
        }
      })

      editor.add({
        name: "costs",
        description: "Get cost report and budget status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          return { content: orchestrator.getCostReport() }
        }
      })

      editor.add({
        name: "dashboard",
        description: "Get full orchestrator state for dashboard display",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const state = orchestrator.getState()
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state)))
          return { content: JSON.stringify(state, null, 2) }
        }
      })

      editor.add({
        name: "queue",
        description: "Show current task queue with priorities",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const state = orchestrator.getState()
          const tasks = state.tasks || []
          return { content: JSON.stringify(tasks, null, 2) }
        }
      })

      editor.add({
        name: "config.save",
        description: "Save Nexus config to disk (project or global)",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global"], description: "Config level to save" },
            basePath: { type: "string", description: "Project root (for project-level, defaults to cwd)" }
          },
          required: ["level"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global'; basePath?: string }
          orchestrator.configManager.saveConfig(level, basePath || process.cwd())
          const location = level === 'project'
            ? `${basePath || process.cwd()}/.opencode/nexus.jsonc`
            : '~/.config/opencode/nexus.jsonc'
          return { content: `Config saved to ${level} level at ${location}` }
        }
      })

      editor.add({
        name: "config.init",
        description: "Initialize default config files for project and/or global",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global", "both"], description: "Which config to initialize" },
            basePath: { type: "string", description: "Project root" }
          },
          required: ["level"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global' | 'both'; basePath?: string }
          const path = basePath || process.cwd()
          const locations: string[] = []
          if (level === 'project' || level === 'both') {
            orchestrator.configManager.initProjectConfig(path)
            locations.push(`${path}/.opencode/nexus.jsonc`)
          }
          if (level === 'global' || level === 'both') {
            orchestrator.configManager.initGlobalConfig()
            locations.push('~/.config/opencode/nexus.jsonc')
          }
          return { content: `Config initialized at ${level} level(s): ${locations.join(', ')}` }
        }
      })

      editor.add({
        name: "preset",
        description: "Apply a preset configuration",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Preset name (minimal, balanced, enterprise, cost-optimized)" }
          },
          required: ["name"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { name } = input as { name: string }
          try {
            orchestrator.configManager.applyPreset(name)
            return { content: `Applied preset: ${PRESETS[name]?.name || name}` }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "dashboard.start",
        description: "Start the web dashboard server",
        input: {
          type: "object",
          properties: {
            port: { type: "number", description: "Port (default: 4747)" },
            host: { type: "string", description: "Host (default: 127.0.0.1)" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { port, host } = input as { port?: number; host?: string }
          orchestrator.startDashboard(port, host)
          return { content: `Dashboard started at http://${host || '127.0.0.1'}:${port || 4747}` }
        }
      })

      editor.add({
        name: "dashboard.stop",
        description: "Stop the web dashboard server",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          orchestrator.stopDashboard()
          return { content: "Dashboard stopped" }
        }
      })

      editor.add({
        name: "model.costs",
        description: "Show real model pricing from OpenCode or set custom costs",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "Model ID to show cost for (optional, shows all if omitted)" },
            setInput: { type: "number", description: "Set input cost per token for a model" },
            setOutput: { type: "number", description: "Set output cost per token for a model" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { model, setInput, setOutput } = input as { model?: string; setInput?: number; setOutput?: number }

          if (model && setInput !== undefined && setOutput !== undefined) {
            // Set custom cost
            orchestrator.setModelCosts({ [model]: { input: setInput, output: setOutput } })
            return { content: `Set ${model}: input=$${setInput}/token, output=$${setOutput}/token` }
          }

          if (model) {
            // Show specific model cost
            const cost = orchestrator.modelCosts.get(model)
            if (cost) {
              return { content: `${model}: input=$${cost.input}/token, output=$${cost.output}/token, cache_read=$${cost.cacheRead}/token, cache_write=$${cost.cacheWrite}/token` }
            }
            // Fallback to hardcoded estimate
            const estimate = orchestrator['estimateModelCost'](model)
            return { content: `${model}: no real pricing data (estimated $${estimate}/1K tokens)` }
          }

          // Show all loaded costs
          if (orchestrator.modelCosts.size > 0) {
            const lines = ['📊 Model Pricing (from OpenCode):']
            for (const [id, cost] of orchestrator.modelCosts) {
              lines.push(`  ${id}: $${cost.input}/token in, $${cost.output}/token out`)
            }
            return { content: lines.join('\n') }
          }
          return { content: 'No real pricing data loaded. Using hardcoded estimates.' }
        }
      })

      editor.add({
        name: "spawn",
        description: "Spawn a sub-agent for a task",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter)" },
            task: { type: "string", description: "Task description" },
            model: { type: "string", description: "Model override (optional)" }
          },
          required: ["role", "task"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { role, task, model } = input as { role: string; task: string; model?: string }
          try {
            const agent = await orchestrator.spawnAgent({ role, model })
            await orchestrator.ctx.session.prompt({
              sessionID: agent.sessionID!,
              text: task
            })

            // Analyze task complexity for informational output
            const complexity = orchestrator.analyzeComplexity({
              id: `spawn-${Date.now()}`,
              name: task,
              description: task,
              files: { include: [] },
              dependencies: [],
              requiredRole: role,
              complexity: { overall: 0, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } },
              priority: 'normal',
              status: 'running'
            })

            // Store complexity on agent
            agent.complexity = complexity

            // Get model selection reasoning
            const modelSelection = orchestrator.selectModel(role, complexity)

            await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
            const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
            const output = [
              `${agent.name}`,
              `📋 Task: ${taskPreview}`,
              `📊 Complexity: ${complexity.overall}/100 (${complexity.factors.riskLevel} risk)`,
              `🤖 Model reasoning: ${modelSelection.reasoning}`,
              `📎 Session: ${agent.sessionID}`
            ].join('\n')
            return { content: output }
          } catch (error: any) {
            return { content: `Failed to spawn agent: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "template",
        description: "List or instantiate task templates",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Template name to instantiate (or 'list' to show all)" },
            baseDir: { type: "string", description: "Base directory for file paths" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { name, baseDir } = input as { name?: string; baseDir?: string }
          if (!name || name === 'list') {
            const templates = listTemplates()
            return { content: templates.map(t => `${t}: ${TEMPLATES[t].description}`).join('\n') }
          }
          try {
            const tasks = instantiateTemplate(name, baseDir || process.cwd())
            return { content: JSON.stringify(tasks, null, 2) }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "performance.scores",
        description: "Show agent performance scores by model and role",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const scores = orchestrator.performanceTracker.getScores()
          if (scores.length === 0) return { content: "No performance data yet. Scores build up as tasks are executed." }
          const lines = scores.map(s => `${s.role}/${s.model}: score=${s.overallScore.toFixed(1)} success=${(s.successRate*100).toFixed(0)}% avg=$${s.avgCost.toFixed(4)} (${s.totalTasks} tasks)`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "performance.best",
        description: "Get best model for a specific role",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role to find best model for" }
          },
          required: ["role"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { role } = input as { role: string }
          const best = orchestrator.performanceTracker.getBestModel(role)
          if (!best) return { content: `No performance data for role '${role}' yet.` }
          return { content: `Best for ${role}: ${best.model} (score: ${best.overallScore.toFixed(1)}, success: ${(best.successRate*100).toFixed(0)}%, avg cost: $${best.avgCost.toFixed(4)})` }
        }
      })

      editor.add({
        name: "security.scan",
        description: "Scan content for security issues",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "Code content to scan" },
            filename: { type: "string", description: "Filename for context" }
          },
          required: ["content"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { content, filename } = input as { content: string; filename?: string }
          const issues = orchestrator.securityScanner.scanContent(content, filename || 'unknown')
          const result = orchestrator.securityScanner.getResult()
          return { content: JSON.stringify({ issues: issues.length, score: result.score, details: issues }, null, 2) }
        }
      })

      editor.add({
        name: "history.list",
        description: "List execution history",
        input: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of recent entries" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { count } = input as { count?: number }
          const records = count ? orchestrator.executionHistory.getRecent(count) : orchestrator.executionHistory.getAll()
          if (records.length === 0) return { content: "No execution history yet." }
          const lines = records.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.taskName} (${r.role}) — $${r.cost.toFixed(4)} — ${r.duration}ms`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "history.stats",
        description: "Show execution statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const stats = orchestrator.executionHistory.getStats()
          return { content: `Total: ${stats.total} | Success: ${(stats.successRate * 100).toFixed(1)}% | Cost: $${stats.totalCost.toFixed(4)} | Avg: ${stats.avgDuration.toFixed(0)}ms\nBy role: ${JSON.stringify(stats.byRole)}` }
        }
      })

      editor.add({
        name: "roles.list",
        description: "List all custom agent roles",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const roles = orchestrator.customRoles.list()
          if (roles.length === 0) return { content: "No custom roles defined. Add them in .opencode/nexus.jsonc under 'customRoles'." }
          const lines = roles.map(r => `${r.emoji} ${r.displayName} (${r.name}): ${r.prompt.substring(0, 60)}...`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "roles.add",
        description: "Add a custom agent role",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Role identifier (lowercase, no spaces)" },
            displayName: { type: "string", description: "Display name" },
            emoji: { type: "string", description: "Emoji for the role" },
            prompt: { type: "string", description: "System prompt for this role" },
            model: { type: "string", description: "Default model (optional)" }
          },
          required: ["name", "displayName", "prompt"]
        },
        execute: async (input: unknown) => {
          const { name, displayName, emoji, prompt, model } = input as any
          orchestrator.customRoles.register({ name, displayName, emoji: emoji || '🤖', prompt, model })
          return { content: `Custom role '${displayName}' registered` }
        }
      })

      editor.add({
        name: "forecast",
        description: "Estimate cost before executing tasks",
        input: {
          type: "object",
          properties: {
            tasks: { type: "string", description: "JSON array of tasks with role, model, and complexity" }
          },
          required: ["tasks"]
        },
        execute: async (input: unknown) => {
          const { tasks } = input as { tasks: string }
          const taskList = JSON.parse(tasks)
          const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent
          const result = orchestrator.forecaster.forecastAll(taskList, remaining)
          const lines = result.estimates.map(e => `${e.taskName}: ~$${e.estimatedCost.toFixed(4)} (${e.model})`)
          lines.push(`\nTotal: ~$${result.totalEstimatedCost.toFixed(4)}`)
          lines.push(`Budget remaining: $${remaining.toFixed(2)}`)
          lines.push(`Within budget: ${result.withinBudget ? '✅' : '❌'}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "worktree.enable",
        description: "Enable git worktree isolation for agents",
        input: { type: "object", properties: { repoRoot: { type: "string", description: "Repository root (defaults to cwd)" } } },
        execute: async (input: unknown) => {
          const { repoRoot } = input as { repoRoot?: string }
          orchestrator.enableWorktrees(repoRoot || process.cwd())
          return { content: "Git worktree isolation enabled." }
        }
      })

      editor.add({
        name: "worktree.list",
        description: "List active agent worktrees",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          if (!orchestrator.worktreeManager) return { content: "Worktree isolation not enabled." }
          const wts = orchestrator.worktreeManager.list()
          if (wts.length === 0) return { content: "No active worktrees." }
          return { content: wts.map(w => `${w.agentId}: ${w.path}`).join('\n') }
        }
      })

      editor.add({
        name: "worktree.disable",
        description: "Disable worktree isolation and clean up",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          if (orchestrator.worktreeManager) {
            orchestrator.worktreeManager.cleanupAll()
            orchestrator.worktreeManager = null
          }
          return { content: "Worktree isolation disabled." }
        }
      })
    })

    // Register session hook for /nexus commands
    await ctx.session.hook("prompt", (event) => {
      if (event.prompt.text.startsWith("/nexus")) {
        const result = orchestrator.handleCommand(event.prompt.text)
        // The result goes to the session as tool output context
        event.metadata = { ...event.metadata, nexusResult: result }
      }
    })

    return () => {
      orchestrator.shutdown()
    }
  }
})

export { NexusOrchestrator } from "./orchestrator"
export { StateBroadcaster } from "./broadcast"
export { NexusConfigManager, DEFAULT_CONFIG, PRESETS } from "./config"
export type { NexusModelConfig, NexusFullConfig, NexusPreset } from "./config"
export { detectCycles } from "./dag"
export { MessageStore } from "./message-store"
export type { MessageStoreConfig } from "./message-store"
export { PersistentMemoryStore } from "./memory-store"
export type { MemoryStoreConfig } from "./memory-store"
export { MessageRouter } from "./fanout"
export type { FanOutRouter } from "./fanout"
export { HealthMonitor } from "./health"
export type { HealthCheck, HealthConfig } from "./health"
export { LearningModule } from "./learning"
export type { LearningEntry, PatternMatch } from "./learning"
export type { Agent, Task, DAG, ExecutionRequest, ExecutionResult } from "./types"
export { TEMPLATES, instantiateTemplate, listTemplates, getTemplate } from "./templates"
export type { TaskTemplate, TaskTemplateStep } from "./templates"
export { ModuleRegistry } from "./modules"
export type { NexusModule, ModuleContext, ModuleTool, ModuleHook } from "./modules"
export { SecurityScanner } from "./security"
export type { SecurityIssue, SecurityScanResult, SecurityConfig } from "./security"
export { PerformanceTracker } from "./performance"
export type { PerformanceEntry, PerformanceScore } from "./performance"
export { CustomRoleManager } from "./custom-roles"
export type { CustomRole } from "./custom-roles"
export { CostForecaster } from "./forecast"
export type { CostEstimate, ForecastResult } from "./forecast"
export { WorktreeManager } from "./worktree"
export type { AgentWorktree } from "./worktree"
