import { Plugin } from "@opencode/plugin"
import { NexusOrchestrator } from "./orchestrator"

export default Plugin.define({
  id: "nexus",
  async setup(ctx) {
    const orchestrator = new NexusOrchestrator()
    
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
          return { content: orchestrator.getStatus(detailed) }
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
    })
    
    // Register session hooks for task orchestration
    await ctx.session.hook("prompt", (event) => {
      // Intercept prompts that look like orchestration requests
      if (event.prompt.text.includes("/nexus")) {
        orchestrator.handleCommand(event.prompt.text)
      }
    })
    
    return () => {
      orchestrator.shutdown()
    }
  }
})

export { NexusOrchestrator } from "./orchestrator"
export type { Agent, Task, DAG, ExecutionRequest, ExecutionResult } from "./types"
