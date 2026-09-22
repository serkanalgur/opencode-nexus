// Configuration management for Nexus
// Supports project-level and global configuration with precedence

import type { NexusConfig } from "./types"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

export interface NexusModelConfig {
  architect?: string
  coder?: string
  reviewer?: string
  tester?: string
  explorer?: string
  documenter?: string
  [key: string]: string | undefined
}

export interface NexusFullConfig {
  models: NexusModelConfig
  budget: {
    maxTotalCost: number
    maxCostPerTask: number
    maxCostPerAgent: number
    alertThreshold: number
  }
  selfHealing: {
    enabled: boolean
    maxRetries: number
    contextTransfer: boolean
  }
}

/**
 * Strip single-line and multi-line comments from a JSONC string.
 * Handles strings properly — comments inside quoted strings are preserved.
 */
function stripJsonComments(jsonc: string): string {
  const result: string[] = []
  let i = 0
  const len = jsonc.length

  while (i < len) {
    const ch = jsonc[i]

    // Inside a double-quoted string — copy verbatim (handle escapes)
    if (ch === '"') {
      result.push(ch)
      i++
      while (i < len && jsonc[i] !== '"') {
        if (jsonc[i] === '\\') {
          result.push(jsonc[i], jsonc[i + 1] ?? '')
          i += 2
        } else {
          result.push(jsonc[i])
          i++
        }
      }
      if (i < len) {
        result.push(jsonc[i]) // closing quote
        i++
      }
      continue
    }

    // Single-line comment
    if (ch === '/' && jsonc[i + 1] === '/') {
      // Skip until end of line
      while (i < len && jsonc[i] !== '\n') i++
      continue
    }

    // Multi-line comment
    if (ch === '/' && jsonc[i + 1] === '*') {
      i += 2
      while (i < len && !(jsonc[i] === '*' && jsonc[i + 1] === '/')) i++
      i += 2 // skip */
      continue
    }

    result.push(ch)
    i++
  }

  return result.join('')
}

/**
 * Try to read and parse a JSONC file from disk. Returns null on any error.
 */
function readJsoncFile(filePath: string): Partial<NexusFullConfig> | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const stripped = stripJsonComments(raw)
    const parsed = JSON.parse(stripped)
    return parsed as Partial<NexusFullConfig>
  } catch (err: any) {
    // ENOENT → file not found (expected); anything else → warn
    if (err.code !== 'ENOENT') {
      console.warn(`[nexus] Failed to load config from ${filePath}: ${err.message}`)
    }
    return null
  }
}

const DEFAULT_CONFIG: NexusFullConfig = {
  models: {
    architect: "anthropic/claude-sonnet-4-6",
    coder: "anthropic/claude-sonnet-4-6",
    reviewer: "openai/gpt-5-mini",
    tester: "anthropic/claude-haiku-4-5",
    explorer: "google/gemini-2.5-flash",
    documenter: "anthropic/claude-haiku-4-5"
  },
  budget: {
    maxTotalCost: 10.00,
    maxCostPerTask: 1.00,
    maxCostPerAgent: 2.00,
    alertThreshold: 0.2
  },
  selfHealing: {
    enabled: true,
    maxRetries: 3,
    contextTransfer: true
  }
}

export class NexusConfigManager {
  private projectConfig: Partial<NexusFullConfig> | null = null
  private globalConfig: Partial<NexusFullConfig> | null = null
  private storageConfig: NexusFullConfig | null = null

  constructor() {
    // Config files are loaded later via loadFromPath(basePath)
    this.projectConfig = null
    this.globalConfig = null
  }

  /**
   * Load config files from disk and store as project/global config.
   * Called by loadFromPath() — not during construction anymore.
   */
  private loadConfigs(basePath: string): void {
    // Project-level: .opencode/nexus.jsonc
    const projectPath = join(basePath, '.opencode', 'nexus.jsonc')
    this.projectConfig = readJsoncFile(projectPath)

    // Global-level: ~/.config/opencode/nexus.jsonc
    const globalPath = join(homedir(), '.config', 'opencode', 'nexus.jsonc')
    this.globalConfig = readJsoncFile(globalPath)
  }

  /**
   * Public entry point for config file loading.
   * Call during orchestrator initialization with the workspace root.
   */
  loadFromPath(basePath: string): void {
    this.loadConfigs(basePath)
  }

  // Get merged config with precedence: project > global > storage > defaults
  getConfig(): NexusFullConfig {
    return {
      models: {
        ...DEFAULT_CONFIG.models,
        ...this.globalConfig?.models,
        ...this.projectConfig?.models,
        ...this.storageConfig?.models
      },
      budget: {
        ...DEFAULT_CONFIG.budget,
        ...this.globalConfig?.budget,
        ...this.projectConfig?.budget,
        ...this.storageConfig?.budget
      },
      selfHealing: {
        ...DEFAULT_CONFIG.selfHealing,
        ...this.globalConfig?.selfHealing,
        ...this.projectConfig?.selfHealing,
        ...this.storageConfig?.selfHealing
      }
    }
  }

  // Get model for a specific role
  getModelForRole(role: string): string {
    const config = this.getConfig()
    return config.models[role] || config.models.coder || DEFAULT_CONFIG.models.coder!
  }

  // Update storage config (from TUI dialog)
  updateStorageConfig(update: Partial<NexusFullConfig>): void {
    this.storageConfig = {
      ...this.storageConfig,
      ...update,
      models: {
        ...this.storageConfig?.models,
        ...update.models
      },
      budget: {
        maxTotalCost: update.budget?.maxTotalCost ?? this.storageConfig?.budget?.maxTotalCost ?? DEFAULT_CONFIG.budget.maxTotalCost,
        maxCostPerTask: update.budget?.maxCostPerTask ?? this.storageConfig?.budget?.maxCostPerTask ?? DEFAULT_CONFIG.budget.maxCostPerTask,
        maxCostPerAgent: update.budget?.maxCostPerAgent ?? this.storageConfig?.budget?.maxCostPerAgent ?? DEFAULT_CONFIG.budget.maxCostPerAgent,
        alertThreshold: update.budget?.alertThreshold ?? this.storageConfig?.budget?.alertThreshold ?? DEFAULT_CONFIG.budget.alertThreshold
      },
      selfHealing: {
        enabled: update.selfHealing?.enabled ?? this.storageConfig?.selfHealing?.enabled ?? DEFAULT_CONFIG.selfHealing.enabled,
        maxRetries: update.selfHealing?.maxRetries ?? this.storageConfig?.selfHealing?.maxRetries ?? DEFAULT_CONFIG.selfHealing.maxRetries,
        contextTransfer: update.selfHealing?.contextTransfer ?? this.storageConfig?.selfHealing?.contextTransfer ?? DEFAULT_CONFIG.selfHealing.contextTransfer
      }
    }
  }

  // Update single model in storage
  setModel(role: string, model: string): void {
    this.storageConfig = this.storageConfig || { ...DEFAULT_CONFIG }
    this.storageConfig.models = this.storageConfig.models || {}
    this.storageConfig.models[role] = model
  }

  // Get all available roles
  getRoles(): string[] {
    return ['architect', 'coder', 'reviewer', 'tester', 'explorer', 'documenter']
  }

  // Get role display name
  getRoleDisplayName(role: string): string {
    const names: Record<string, string> = {
      architect: 'Architect',
      coder: 'Coder',
      reviewer: 'Reviewer',
      tester: 'Tester',
      explorer: 'Explorer',
      documenter: 'Documenter'
    }
    return names[role] || role
  }

  // Get role emoji for TUI display
  getRoleEmoji(role: string): string {
    const emojis: Record<string, string> = {
      architect: '🏗️',
      coder: '💻',
      reviewer: '🔍',
      tester: '🧪',
      explorer: '🔬',
      documenter: '📝'
    }
    return emojis[role] || '🤖'
  }

  // Export config for saving
  exportConfig(): NexusFullConfig {
    return this.getConfig()
  }

  // Import config from storage
  importConfig(config: NexusFullConfig): void {
    this.storageConfig = { ...config }
  }

  /**
   * Write a partial config to a JSONC file on disk.
   * Creates parent directories recursively if needed.
   */
  writeJsoncFile(filePath: string, config: Partial<NexusFullConfig>): void {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const jsonc = [
      '// Nexus Configuration — https://github.com/serkanalgur/opencode-nexus',
      '// Precedence: this file > global config > TUI settings > defaults',
      '',
      JSON.stringify(config, null, 2)
    ].join('\n')

    writeFileSync(filePath, jsonc + '\n', 'utf-8')
  }

  /**
   * Save project-level config to disk.
   * Writes to `{basePath}/.opencode/nexus.jsonc` with only non-default values.
   */
  saveProjectConfig(basePath: string): void {
    const projectPath = join(basePath, '.opencode', 'nexus.jsonc')
    const config = this.getNonDefaultConfig()
    this.writeJsoncFile(projectPath, config)
  }

  /**
   * Save global-level config to disk.
   * Writes to `~/.config/opencode/nexus.jsonc` with only non-default values.
   */
  saveGlobalConfig(): void {
    const globalPath = join(homedir(), '.config', 'opencode', 'nexus.jsonc')
    const config = this.getNonDefaultConfig()
    this.writeJsoncFile(globalPath, config)
  }

  /**
   * Save config at the specified level.
   * @param level - 'project' or 'global'
   * @param basePath - Project root directory (required for project level)
   */
  saveConfig(level: 'project' | 'global', basePath?: string): void {
    if (level === 'project') {
      this.saveProjectConfig(basePath || process.cwd())
    } else {
      this.saveGlobalConfig()
    }
  }

  /**
   * Extract only values that differ from defaults.
   * Produces a clean config file without redundant default values.
   */
  private getNonDefaultConfig(): Partial<NexusFullConfig> {
    const current = this.getConfig()
    const result: Partial<NexusFullConfig> = {}

    // Models — include only if at least one role differs
    const models: Partial<NexusModelConfig> = {}
    for (const role of this.getRoles()) {
      if (current.models[role] !== DEFAULT_CONFIG.models[role]) {
        models[role] = current.models[role]
      }
    }
    if (Object.keys(models).length > 0) {
      result.models = models as NexusModelConfig
    }

    // Budget — include only changed fields
    const budget: Partial<NexusFullConfig['budget']> = {}
    const budgetKeys = ['maxTotalCost', 'maxCostPerTask', 'maxCostPerAgent', 'alertThreshold'] as const
    for (const key of budgetKeys) {
      if (current.budget[key] !== DEFAULT_CONFIG.budget[key]) {
        budget[key] = current.budget[key]
      }
    }
    if (Object.keys(budget).length > 0) {
      result.budget = budget as NexusFullConfig['budget']
    }

    // Self-healing — include only changed fields
    const selfHealing: Partial<NexusFullConfig['selfHealing']> = {}
    const shKeys = ['enabled', 'maxRetries', 'contextTransfer'] as const
    for (const key of shKeys) {
      if (current.selfHealing[key] !== DEFAULT_CONFIG.selfHealing[key]) {
        ;(selfHealing as any)[key] = current.selfHealing[key]
      }
    }
    if (Object.keys(selfHealing).length > 0) {
      result.selfHealing = selfHealing as NexusFullConfig['selfHealing']
    }

    return result
  }

  // Reset to defaults
  resetToDefaults(): void {
    this.storageConfig = null
  }

  // Apply a named preset configuration
  applyPreset(name: string): void {
    const preset = PRESETS[name]
    if (!preset) throw new Error(`Unknown preset: ${name}. Available: ${Object.keys(PRESETS).join(', ')}`)
    this.storageConfig = { ...this.storageConfig, ...preset.config } as NexusFullConfig
  }

  // List available preset names
  listPresets(): string[] {
    return Object.keys(PRESETS)
  }

  // Get config summary for display
  getSummary(): string {
    const config = this.getConfig()
    const lines = [
      '📊 Nexus Configuration',
      '═══════════════════════',
      '',
      '🤖 Agent Models:',
    ]

    for (const role of this.getRoles()) {
      const model = config.models[role] || '(not set)'
      const displayName = this.getRoleDisplayName(role)
      lines.push(`  ${displayName}: ${model}`)
    }

    lines.push('')
    lines.push('💰 Budget:')
    lines.push(`  Max Total: $${config.budget.maxTotalCost}`)
    lines.push(`  Max Per Task: $${config.budget.maxCostPerTask}`)
    lines.push(`  Alert Threshold: ${config.budget.alertThreshold * 100}%`)
    lines.push('')
    lines.push('🛡️ Self-Healing:')
    lines.push(`  Enabled: ${config.selfHealing.enabled ? '✅' : '❌'}`)
    lines.push(`  Max Retries: ${config.selfHealing.maxRetries}`)
    lines.push(`  Context Transfer: ${config.selfHealing.contextTransfer ? '✅' : '❌'}`)

    return lines.join('\n')
  }
}

// Preset configurations
export interface NexusPreset {
  name: string
  description: string
  config: Partial<NexusFullConfig>
}

export const PRESETS: Record<string, NexusPreset> = {
  minimal: {
    name: 'Minimal',
    description: 'Low-cost setup with free/cheap models, minimal budget',
    config: {
      models: {
        architect: 'google/gemini-2.5-flash',
        coder: 'google/gemini-2.5-flash',
        reviewer: 'google/gemini-2.5-flash',
        tester: 'google/gemini-2.5-flash',
        explorer: 'google/gemini-2.5-flash',
        documenter: 'google/gemini-2.5-flash',
      },
      budget: {
        maxTotalCost: 1.00,
        maxCostPerTask: 0.10,
        maxCostPerAgent: 0.50,
        alertThreshold: 0.5,
      },
      selfHealing: {
        enabled: false,
        maxRetries: 1,
        contextTransfer: false,
      },
    }
  },
  balanced: {
    name: 'Balanced',
    description: 'Good quality models with moderate budget',
    config: {
      models: {
        architect: 'anthropic/claude-sonnet-4-6',
        coder: 'anthropic/claude-sonnet-4-6',
        reviewer: 'openai/gpt-5-mini',
        tester: 'anthropic/claude-haiku-4-5',
        explorer: 'google/gemini-2.5-flash',
        documenter: 'anthropic/claude-haiku-4-5',
      },
      budget: {
        maxTotalCost: 10.00,
        maxCostPerTask: 1.00,
        maxCostPerAgent: 2.00,
        alertThreshold: 0.2,
      },
      selfHealing: {
        enabled: true,
        maxRetries: 3,
        contextTransfer: true,
      },
    }
  },
  enterprise: {
    name: 'Enterprise',
    description: 'High-quality models with generous budget and full self-healing',
    config: {
      models: {
        architect: 'anthropic/claude-sonnet-4-6',
        coder: 'anthropic/claude-sonnet-4-6',
        reviewer: 'openai/gpt-5',
        tester: 'anthropic/claude-sonnet-4-6',
        explorer: 'anthropic/claude-sonnet-4-6',
        documenter: 'anthropic/claude-haiku-4-5',
      },
      budget: {
        maxTotalCost: 50.00,
        maxCostPerTask: 5.00,
        maxCostPerAgent: 10.00,
        alertThreshold: 0.1,
      },
      selfHealing: {
        enabled: true,
        maxRetries: 5,
        contextTransfer: true,
      },
    }
  },
  'cost-optimized': {
    name: 'Cost-Optimized',
    description: 'Minimize costs while maintaining reasonable quality',
    config: {
      models: {
        architect: 'anthropic/claude-haiku-4-5',
        coder: 'google/gemini-2.5-flash',
        reviewer: 'openai/gpt-5-mini',
        tester: 'google/gemini-2.5-flash',
        explorer: 'google/gemini-2.5-flash',
        documenter: 'google/gemini-2.5-flash',
      },
      budget: {
        maxTotalCost: 3.00,
        maxCostPerTask: 0.30,
        maxCostPerAgent: 1.00,
        alertThreshold: 0.3,
      },
      selfHealing: {
        enabled: true,
        maxRetries: 2,
        contextTransfer: false,
      },
    }
  }
}

export { DEFAULT_CONFIG }
