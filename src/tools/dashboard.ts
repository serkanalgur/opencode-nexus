/** Dashboard tools. Registered from `setup()` in `src/index.ts`. */
import type { ToolEditor, ToolDeps } from "./deps"
import { DASHBOARD_START_DESCRIPTION, DASHBOARD_STOP_DESCRIPTION, runDashboardStart, runDashboardStop } from "./dashboard-actions"

export function registerDashboardTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

  editor.add({
    name: "dashboard",
    description: "Get full orchestrator state for dashboard display",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const state = orchestrator.getState()
      return { content: JSON.stringify(state, null, 2) }
    }
  })

  editor.add({
    name: "dashboard.start",
    description: DASHBOARD_START_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        port: { type: "number", description: "Port to listen on (default: 4747, or `dashboard.port` from nexus.jsonc). Must be free." },
        host: { type: "string", description: "Bind address (default: 127.0.0.1, or `dashboard.host` from nexus.jsonc)" }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { port, host } = input as { port?: number; host?: string }
      return { content: runDashboardStart(orchestrator, port, host) }
    }
  })

  editor.add({
    name: "dashboard.stop",
    description: DASHBOARD_STOP_DESCRIPTION,
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      return { content: runDashboardStop(orchestrator) }
    }
  })
}
