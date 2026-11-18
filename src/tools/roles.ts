/** Custom role tools. Registered from `setup()` in `src/index.ts`. */
import type { ToolEditor, ToolDeps } from "./deps"

export function registerRolesTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

  editor.add({
    name: "roles.list",
    description: "List all custom agent roles",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const roles = orchestrator.customRoles.list()
      if (roles.length === 0) return { content: "No custom roles defined. Add them in .opencode/nexus.jsonc under 'customRoles', or register one for this session with roles.add." }
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
        model: { type: "string", description: "First-choice model for the role (optional). It is the first candidate the ranker considers, not the model the spawn necessarily uses: a models[role] entry takes precedence over it, and the ranker is free to select another candidate." }
      },
      required: ["name", "displayName", "prompt"]
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { name, displayName, emoji, prompt, model } = input as any
      orchestrator.customRoles.register({ name, displayName, emoji: emoji || '🤖', prompt, model })
      // Session-only, and said so here because it no longer is: a config
      // reload replaces the registry from the file, so a role added this
      // way and not written to `nexus.jsonc` stops resolving on the next
      // reload. The tool used to imply it had registered something durable.
      return { content: `Custom role '${displayName}' registered for this session. To keep it across config reloads and restarts, add it to .opencode/nexus.jsonc under 'customRoles'.` }
    }
  })
}
