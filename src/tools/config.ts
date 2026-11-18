/** Config file and preset tools. Registered from `setup()` in `src/index.ts`. */
import { PRESETS } from "../config"
import type { ToolEditor, ToolDeps } from "./deps"
import { clearPresetOverride } from "./preset-actions"

export function registerConfigTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

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
    options: { codemode: true },
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
    options: { codemode: true },
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
    description: "Apply a session preset (model/budget selection), or clear it with mode 'clear' to hand control back to nexus.jsonc. A preset shadows the config file's models, so call mode 'clear' if the user edited nexus.jsonc but no model changed.",
    input: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["apply", "clear"],
          description: "'apply' (default) applies the named preset for this session. 'clear' drops the session preset override so nexus.jsonc is in control again — use it whenever edits to nexus.jsonc appear to have no effect."
        },
        name: {
          type: "string",
          description: "Preset name (minimal, balanced, enterprise, cost-optimized). Required for mode 'apply'; ignored by 'clear'."
        }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { mode, name } = input as { mode?: 'apply' | 'clear'; name?: string }

      if (mode === 'clear') return clearPresetOverride(orchestrator)

      if (!name) {
        // Do not silently do nothing: a missing name is a mistake, and the
        // fix is either a valid preset name or mode 'clear'.
        return { content: `Error: mode 'apply' needs a \`name\` (${orchestrator.configManager.listPresets().join(', ')}). To hand control back to nexus.jsonc instead, call preset with mode: 'clear'.` }
      }
      try {
        orchestrator.configManager.applyPreset(name)
        // A preset replaces the whole models level, so it now shadows
        // nexus.jsonc. Say that here, at the moment the user is told the
        // preset was applied — otherwise a later edit that does nothing is
        // the same silent surprise as a missing reload.
        return {
          content: `Applied preset: ${PRESETS[name]?.name || name}\n`
            + `⚠️ This preset now overrides the \`models\` section of nexus.jsonc. `
            + `Edits to models in the config file will NOT take effect until the preset is cleared. `
            + `Clear it with this tool (mode: 'clear'), or from the TUI (config manager), to hand control back to disk. `
            + `Budget and self-healing values from the file still apply.`,
        }
      } catch (error: any) {
        return { content: `Error: ${error.message}` }
      }
    }
  })
}
