/** Todo and goal tools. Registered from `setup()` in `src/index.ts`. */
import type { ToolEditor, ToolDeps } from "./deps"

export function registerTrackingTools(editor: ToolEditor, deps: ToolDeps): void {
  const { ctx, orchestrator, goalManager } = deps

  // === Todo Enforcer Tools ===

  editor.add({
    name: "todo.add",
    description: "Add a todo item to track work",
    input: {
      type: "object",
      properties: {
        description: { type: "string", description: "Todo description" },
        assignedTo: { type: "string", description: "Agent or role to assign (optional)" }
      },
      required: ["description"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { description, assignedTo } = input as { description: string; assignedTo?: string }
      const item = orchestrator.todoEnforcer.add(description, assignedTo)
      return { content: `📝 Todo added: ${item.id}: ${item.description} (${item.status})` }
    }
  })

  editor.add({
    name: "todo.list",
    description: "List all todo items",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      return { content: orchestrator.todoEnforcer.formatAll() }
    }
  })

  editor.add({
    name: "todo.complete",
    description: "Mark a todo item as completed",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "Todo item ID" }
      },
      required: ["id"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { id } = input as { id: string }
      const item = orchestrator.todoEnforcer.get(id)
      if (!item) return { content: `❌ Todo ${id} not found.` }
      orchestrator.todoEnforcer.complete(id)
      return { content: `✅ Todo completed: ${id}: ${item.description}` }
    }
  })

  editor.add({
    name: "todo.stats",
    description: "Get todo statistics",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const stats = orchestrator.todoEnforcer.getStats()
      return {
        content: `📊 Todo Statistics:\n  Total: ${stats.total}\n  ⏳ Pending: ${stats.pending}\n  🔄 In Progress: ${stats.inProgress}\n  ✅ Completed: ${stats.completed}\n  🚫 Blocked: ${stats.blocked}`
      }
    }
  })

  // === Goal Tracking Tools ===
  editor.add({
    name: "goal.set",
    description: "Set a new persistent objective",
    input: {
      type: "object",
      properties: {
        description: { type: "string", description: "Goal description" },
        autoContinue: { type: "boolean", description: "Auto-continue (default: true)" }
      },
      required: ["description"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { description, autoContinue } = input as { description: string; autoContinue?: boolean }
      const goal = goalManager.set(description, autoContinue ?? true)
      return { content: `🎯 Goal set: ${goal.description}` }
    }
  })

  editor.add({
    name: "goal.status",
    description: "Show current active goal status",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const active = goalManager.getActive()
      if (!active) return { content: "No active goal. Use nexus.goal.set() to set one." }
      return {
        content: [
          `🎯 Active Goal: ${active.description}`,
          `📋 ID: ${active.id}`,
          `🔄 Auto-continue: ${active.autoContinue ? 'enabled' : 'disabled'}`,
          `📊 Status: ${active.status}`,
          `📎 Tasks: ${active.tasks.length > 0 ? active.tasks.join(', ') : 'none yet'}`,
          `📅 Created: ${active.createdAt.toISOString()}`,
          `⏱️ Should continue: ${goalManager.shouldContinue() ? 'yes' : 'no'}`
        ].join('\n')
      }
    }
  })

  editor.add({
    name: "goal.complete",
    description: "Mark current active goal as completed",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const active = goalManager.getActive()
      if (!active) return { content: "No active goal to complete." }
      goalManager.complete(active.id)
      await ctx.storage.set("nexus-goal", JSON.parse(JSON.stringify(goalManager.getAll())))
      return {
        content: [
          `✅ Goal completed: ${active.description}`,
          `📋 ID: ${active.id}`,
          `📎 Tasks tracked: ${active.tasks.length}`
        ].join('\n')
      }
    }
  })

  editor.add({
    name: "goal.list",
    description: "List all goals",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const goals = goalManager.getAll()
      if (goals.length === 0) return { content: "No goals set yet. Use nexus.goal.set() to create one." }
      const lines = goals.map(g => {
        const icon = g.status === 'active' ? '🎯' : g.status === 'completed' ? '✅' : g.status === 'paused' ? '⏸️' : '❌'
        return `${icon} [${g.status}] ${g.description} (tasks: ${g.tasks.length})`
      })
      return { content: `Goals (${goals.length}):\n${lines.join('\n')}` }
    }
  })
}
