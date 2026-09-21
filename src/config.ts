// Configuration management for Nexus
// Supports project-level and global configuration with precedence

import type { NexusConfig } from "./types"

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
    this.loadConfigs()
  }

  private loadConfigs(): void {
    // In real implementation, this would read from filesystem
    // For now, we use defaults
    this.projectConfig = null
    this.globalConfig = null
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
      architect: '🏗️ Architect',
      coder: '💻 Coder',
      reviewer: '🔍 Reviewer',
      tester: '🧪 Tester',
      explorer: '🔬 Explorer',
      documenter: '📝 Documenter'
    }
    return names[role] || role
  }

  // Export config for saving
  exportConfig(): NexusFullConfig {
    return this.getConfig()
  }

  // Import config from storage
  importConfig(config: NexusFullConfig): void {
    this.storageConfig = { ...config }
  }

  // Reset to defaults
  resetToDefaults(): void {
    this.storageConfig = null
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

export { DEFAULT_CONFIG }
