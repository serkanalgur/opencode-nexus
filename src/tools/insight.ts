/** Performance, security, history and forecast tools. Registered from `setup()` in `src/index.ts`. */
import type { ToolEditor, ToolDeps } from "./deps"
import { renderCost, renderCostBasis } from "../cost-report"

export function registerInsightTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

  editor.add({
    name: "performance.scores",
    description: "Show agent performance scores by model and role",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const scores = orchestrator.performanceTracker.getScores()
      if (scores.length === 0) return { content: "No performance data yet. Scores build up as tasks are executed." }
      const lines = scores.map(s => `${s.role}/${s.model}: score=${s.overallScore.toFixed(1)} success=${(s.successRate*100).toFixed(0)}% ${renderCostBasis(s)} (${s.totalTasks} tasks)`)
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
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { role } = input as { role: string }
      const best = orchestrator.performanceTracker.getBestModel(role)
      if (!best) return { content: `No performance data for role '${role}' yet.` }
      return { content: `Best for ${role}: ${best.model} (score: ${best.overallScore.toFixed(1)}, success: ${(best.successRate*100).toFixed(0)}%, ${renderCostBasis(best)})` }
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
    options: { codemode: true },
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
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { count } = input as { count?: number }
      const records = count ? orchestrator.executionHistory.getRecent(count) : orchestrator.executionHistory.getAll()
      if (records.length === 0) return { content: "No execution history yet." }
      const lines = records.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.taskName} (${r.role}) — ${renderCost(r.cost, r.costProvenance)} — ${r.duration}ms`)
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
    options: { codemode: true },
    execute: async () => {
      const stats = orchestrator.executionHistory.getStats()
      // `totalCost` sums measured and estimated charges, so it is reported
      // with the split rather than on its own.
      return { content: `Total: ${stats.total} | Success: ${(stats.successRate * 100).toFixed(1)}% | Cost: $${stats.totalCost.toFixed(4)} (measured $${stats.costSplit.measuredCost.toFixed(4)} over ${stats.costSplit.measuredEntries} tasks, estimated $${stats.costSplit.estimatedCost.toFixed(4)} over ${stats.costSplit.estimatedEntries} tasks) | Avg: ${stats.avgDuration.toFixed(0)}ms\nBy role: ${JSON.stringify(stats.byRole)}` }
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
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { tasks } = input as { tasks: string }
      const taskList = JSON.parse(tasks)
      const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent

      // Support both formats: full Task objects or simple {role, model, complexity}
      const normalizedTasks = taskList.map((t: any) => ({
        task: t.task || {
          id: `forecast-${Date.now()}`,
          name: t.name || `${t.role} task`,
          description: t.description || '',
          files: { include: [] },
          dependencies: [],
          requiredRole: t.role,
          complexity: typeof t.complexity === 'number'
            ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
            : { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } },
          priority: 'normal' as const,
          status: 'pending' as const
        },
        role: t.role,
        model: t.model,
        complexity: typeof t.complexity === 'number'
          ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
          : t.complexity || { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
      }))

      const result = orchestrator.forecaster.forecastAll(normalizedTasks, remaining)
      const lines = result.estimates.map(e => `${e.taskName}: ~$${e.estimatedCost.toFixed(4)} (${e.model})`)
      lines.push(`\nTotal: ~$${result.totalEstimatedCost.toFixed(4)}`)
      lines.push(`Budget remaining: $${remaining.toFixed(2)}`)
      lines.push(`Within budget: ${result.withinBudget ? '✅' : '❌'}`)
      return { content: lines.join('\n') }
    }
  })
}
