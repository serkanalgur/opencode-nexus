// Configuration management for Nexus
// Supports project-level and global configuration with precedence

import type { NexusConfig } from "./types"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, resolve } from "node:path"

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
 * Outcome of consulting one config file.
 *
 * `existed` and `parsed` are kept apart on purpose: "there is no project
 * config" and "there is a project config but it is broken" are different
 * problems, and conflating them is what made a missing project file
 * indistinguishable from a normal load in the field.
 */
export interface NexusConfigFileInfo {
  /**
   * Path that was consulted, with the home directory collapsed to `~`. Safe to
   * log and to hand to a model — an absolute home path leaks the OS account
   * name into CI output and pasted bug reports. Anything that genuinely needs
   * the absolute path builds it with `nexusProjectConfigPath` /
   * `nexusGlobalConfigPath`.
   */
  path: string
  /** Whether a readable file was present where the config path points. */
  existed: boolean
  /** Whether the file parsed into a usable config object. */
  parsed: boolean
}

/**
 * What caused a config load.
 *
 * `initial` is the load at orchestrator startup; `event` and `poll` are the two
 * reload triggers. Recorded on every load so a stale model can be traced to the
 * mechanism that should have refreshed it — notably, `poll` on every reload
 * means the host is not delivering `filesystem.changed` for these files.
 */
export type NexusConfigReloadTrigger = 'initial' | 'event' | 'poll'

/** Everything a single config load consulted, and what it resolved to. */
export interface NexusConfigLoadInfo {
  project: NexusConfigFileInfo
  global: NexusConfigFileInfo
  /**
   * Resolved `role -> model` map after defaults -> global -> project -> storage.
   * When `sessionOverride` is true this includes an in-process override, so the
   * map is NOT a statement about what is on disk.
   */
  models: Record<string, string>
  /**
   * True when a session-scoped override (the `preset` tool, TUI settings) is
   * layered on top of the disk config. Reported alongside `models` so a
   * disk-only reading of that map is never presented as the whole story.
   */
  sessionOverride: boolean
  /** ISO timestamp of this load. */
  loadedAt: string
  /** 1 for the initial load, >1 for reloads. */
  loadCount: number
  /** Which mechanism caused this load. */
  trigger: NexusConfigReloadTrigger
}

/** The two config files a load consulted. */
interface NexusConfigLoadSources {
  project: NexusConfigFileInfo
  global: NexusConfigFileInfo
}

/** Result of trying to read and parse one JSONC file from disk. */
interface JsoncReadResult {
  config: Partial<NexusFullConfig> | null
  existed: boolean
}

/**
 * Try to read and parse a JSONC file from disk. `config` is null on any error;
 * `existed` reports whether a readable file was there at all.
 */
function readJsoncFile(filePath: string): JsoncReadResult {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const stripped = stripJsonComments(raw)
    const parsed: unknown = JSON.parse(stripped)
    // `JSON.parse` accepts `42`, `"oops"` and `[]`. Those parse fine and then
    // contribute nothing, so accepting them would log `[loaded]` for a file
    // that is in fact doing nothing — a false assurance in exactly the case
    // this reporting exists to catch.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[nexus] Ignoring config from ${filePath}: expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
      return { config: null, existed: true }
    }
    return { config: parsed as Partial<NexusFullConfig>, existed: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const message = err instanceof Error ? err.message : String(err)
    // ENOENT and ENOTDIR both mean "there is no config file here": the path is
    // missing, or a parent component is a regular file. Everything else
    // (EACCES on a real config, EISDIR, a syntax error) means a file IS there
    // and we simply could not use it, which must keep reporting existed=true.
    const absent = code === 'ENOENT' || code === 'ENOTDIR'
    if (!absent) {
      console.warn(`[nexus] Failed to load config from ${filePath}: ${message}`)
    }
    return { config: null, existed: !absent }
  }
}

/** Absolute path of the project-level config: `{basePath}/.opencode/nexus.jsonc`. */
export function nexusProjectConfigPath(basePath: string): string {
  return resolve(join(basePath, '.opencode', 'nexus.jsonc'))
}

/** Absolute path of the global-level config: `~/.config/opencode/nexus.jsonc`. */
export function nexusGlobalConfigPath(): string {
  return resolve(join(homedir(), '.config', 'opencode', 'nexus.jsonc'))
}

/**
 * Collapse a leading home directory to `~`. The global config path is fully
 * derivable from `~`, so spelling out `/Users/<name>/...` in a log line or in
 * the status payload buys no diagnosis and costs the user's account name.
 */
function redactHome(filePath: string): string {
  const home = homedir()
  if (filePath === home) return '~'
  const prefix = home.endsWith('/') ? home : `${home}/`
  return filePath.startsWith(prefix) ? `~${filePath.slice(home.length)}` : filePath
}

/** Compact per-file state for the one-line load log. */
function describeFile(file: NexusConfigFileInfo): string {
  if (file.parsed) return 'loaded'
  if (file.existed) return 'unparseable'
  return 'absent'
}

/**
 * One-line summary of a load: which paths were consulted, which existed, and
 * the role -> model map they resolved to. Printed on every load and reload.
 */
export function formatConfigLoadLog(info: NexusConfigLoadInfo): string {
  const models = Object.entries(info.models)
    .map(([role, model]) => `${role}=${model}`)
    .join(' ')
  // A preset replaces the whole `models` level, so while one is set the models
  // above are NOT the disk file. Say so explicitly, and say how to get control
  // back — a user who edits the file and watches nothing change needs that.
  // `resetToDefaults()` is only reachable from the TUI, so name that, not a
  // tool that does not exist.
  const override = info.sessionOverride
    ? ' (+session override: storage; disk edits to models are IGNORED while a preset is set — clear the preset in the TUI to hand control back to disk)'
    : ''
  return `[nexus] config loaded (#${info.loadCount} trigger=${info.trigger} at=${info.loadedAt}) `
    + `project=${info.project.path} [${describeFile(info.project)}] `
    + `global=${info.global.path} [${describeFile(info.global)}] `
    + `models:${override} ${models}`
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
  private loadInfo: NexusConfigLoadInfo | null = null

  constructor() {
    // Config files are loaded later via loadFromPath(basePath)
    this.projectConfig = null
    this.globalConfig = null
  }

  /**
   * Load config files from disk and store as project/global config.
   * Called by loadFromPath() — not during construction anymore.
   */
  private loadConfigs(basePath: string): NexusConfigLoadSources {
    // Reset the session-scoped override on the FIRST load only. The initial
    // load runs at init, before anything can have set `storageConfig`, so
    // clearing it there only guarantees disk wins. A reload, however, can
    // happen at any time — including after `nexus.preset` layered an override
    // on top — and clearing unconditionally would silently discard it.
    if (this.loadInfo === null) this.storageConfig = null

    // Project-level: .opencode/nexus.jsonc
    const projectPath = nexusProjectConfigPath(basePath)
    const project = readJsoncFile(projectPath)
    this.projectConfig = project.config

    // Global-level: ~/.config/opencode/nexus.jsonc
    const globalPath = nexusGlobalConfigPath()
    const global = readJsoncFile(globalPath)
    this.globalConfig = global.config

    return {
      project: { path: redactHome(projectPath), existed: project.existed, parsed: project.config !== null },
      global: { path: redactHome(globalPath), existed: global.existed, parsed: global.config !== null }
    }
  }

  /**
   * Public entry point for config file loading.
   * Call during orchestrator initialization with the workspace root, and again
   * on every reload. A reload uses this same path, so all precedence levels are
   * re-read consistently.
   *
   * A session-scoped override applied in-process (the `preset` tool, TUI
   * settings) survives a reload: only the first load clears it, so editing a
   * config file on disk never silently discards a preset the user just chose.
   * The load reports `sessionOverride` so the resulting `models` map is never
   * mistaken for a disk-only reading.
   */
  loadFromPath(basePath: string, trigger: NexusConfigReloadTrigger = 'initial'): void {
    const sources = this.loadConfigs(basePath)
    this.loadInfo = {
      project: sources.project,
      global: sources.global,
      models: this.getResolvedModels(),
      sessionOverride: this.hasSessionOverride(),
      loadedAt: new Date().toISOString(),
      loadCount: (this.loadInfo?.loadCount ?? 0) + 1,
      trigger
    }
    console.log(formatConfigLoadLog(this.loadInfo))
  }

  /**
   * What the most recent load consulted and resolved, or null if no load has
   * run yet. Lets callers answer "which config am I actually using?" without
   * scraping logs.
   */
  getLoadInfo(): NexusConfigLoadInfo | null {
    return this.loadInfo
  }

  /**
   * The `role -> model` map as currently in effect — defaults -> global ->
   * project -> storage.
   *
   * Read live rather than off `getLoadInfo()`, because a session-scoped
   * override can be applied (or reset) between loads. A load-time snapshot
   * would answer "which model will my next subagent use?" with the value from
   * before the user applied a preset.
   */
  getResolvedModels(): Record<string, string> {
    const models: Record<string, string> = {}
    for (const [role, model] of Object.entries(this.getConfig().models)) {
      if (model) models[role] = model
    }
    return models
  }

  /**
   * True when a session-scoped override (the `preset` tool, TUI settings) is
   * currently layered on top of the disk config.
   */
  hasSessionOverride(): boolean {
    return this.storageConfig !== null
  }

  // Get merged config with precedence: storage > project > global > defaults
  // (`storageConfig` is the session-scoped override, cleared only by the first
  // load and by resetToDefaults())
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
  // Returns "providerID/modelID" format. Falls back to coder role, then defaults.
  getModelForRole(role: string): string {
    const config = this.getConfig()
    const model = config.models[role] || config.models.coder || DEFAULT_CONFIG.models.coder!
    // Safety: ensure model has provider/model format
    if (!model.includes('/')) {
      console.warn(`[nexus] Model "${model}" for role "${role}" is missing provider prefix. Expected "providerID/modelID" format.`)
    }
    return model
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
    const projectPath = nexusProjectConfigPath(basePath)
    const config = this.getSaveableConfig()
    this.writeJsoncFile(projectPath, config)
  }

  /**
   * Save global-level config to disk.
   * Writes to `~/.config/opencode/nexus.jsonc` with only non-default values.
   */
  saveGlobalConfig(): void {
    const globalPath = nexusGlobalConfigPath()
    const config = this.getSaveableConfig()
    this.writeJsoncFile(globalPath, config)
  }

  /**
   * Initialize project-level config with full defaults.
   * Writes to `{basePath}/.opencode/nexus.jsonc` with all default values.
   */
  initProjectConfig(basePath: string): void {
    const projectPath = nexusProjectConfigPath(basePath)
    // Don't overwrite existing user config
    try {
      readFileSync(projectPath, 'utf-8')
      return // File exists, skip to preserve user settings
    } catch {
      // File doesn't exist, initialize with defaults
    }
    this.writeJsoncFile(projectPath, { ...DEFAULT_CONFIG })
  }

  /**
   * Initialize global-level config with full defaults.
   * Writes to `~/.config/opencode/nexus.jsonc` with all default values.
   */
  initGlobalConfig(): void {
    const globalPath = nexusGlobalConfigPath()
    // Don't overwrite existing user config
    try {
      readFileSync(globalPath, 'utf-8')
      return // File exists, skip to preserve user settings
    } catch {
      // File doesn't exist, initialize with defaults
    }
    this.writeJsoncFile(globalPath, { ...DEFAULT_CONFIG })
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
   * Extract current config for saving.
   * Always writes all model selections (not just non-defaults)
   * so user choices are preserved across restarts.
   */
  private getSaveableConfig(): Partial<NexusFullConfig> {
    const current = this.getConfig()
    const result: Partial<NexusFullConfig> = {}

    // Models — always include all roles so user selections are preserved
    result.models = { ...current.models }

    // Budget — include all fields
    result.budget = { ...current.budget }

    // Self-healing — include all fields
    result.selfHealing = { ...current.selfHealing }

    return result
  }

  // Reset to defaults
  resetToDefaults(): void {
    this.storageConfig = null
  }

  /**
   * Apply a named preset configuration.
   *
   * A preset is a complete model selection and its `models` object replaces
   * the whole level, so while it is in effect a disk edit to `models` cannot
   * win. It survives a config reload (see `loadFromPath`); `resetToDefaults()`
   * is how the user hands control back to disk.
   */
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
