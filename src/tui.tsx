/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { NexusConfigManager } from "./config"

// Types for agent status in the sidebar
interface AgentStatus {
  id: string
  name: string
  role: string
  status: 'idle' | 'working' | 'completed' | 'failed' | 'terminated'
  model: string
  sessionID?: string
  spawnedAt: string
  tasksCompleted: number
  tasksFailed: number
}

interface SidebarState {
  agents: AgentStatus[]
  totalCost: number
  budgetRemaining: number
}

// ── Sidebar session scanning ───────────────────────────────────────
// Kept as free functions so the TUI entrypoint stays a thin adapter over the
// live context and the scanning logic can be driven directly in tests.

/** Agent-id prefix this plugin registers its roles under (`nexus-coder`, …). */
const NEXUS_AGENT_PREFIX = "nexus-"

/**
 * The subset of `SessionInfo` the sidebar reads.
 *
 * Structural rather than an import from `@opencode/client`, which is not a
 * direct dependency of this package: every real `SessionInfo` is assignable to
 * this shape, and the narrow shape is what the scanner below is written
 * against.
 */
export interface SidebarSession {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** The read-only slice of `context.data.session` the scanner needs. */
export interface SidebarSessionSource {
  family(sessionID: string): readonly string[]
  get(sessionID: string): SidebarSession | undefined
}

/**
 * Reads a string field from `session.metadata`.
 *
 * `spawnAgent` no longer writes session-level metadata — it is not a field of
 * `SessionUpdateInput`, so the write was a silent no-op — and the nexus role
 * and model live on the orchestrator's own `Agent` record, which the TUI cannot
 * reach (its `nexus-sidebar-state` is TUI-local storage, a different scope from
 * the server-side `ctx.storage` the orchestrator writes). What the TUI *can*
 * read is `session.agent` and `session.model`, which the host populates for
 * every session; those are the authoritative sources and are used everywhere
 * below. Metadata is still consulted first purely as a forward-compatible
 * preferred source: if a future release does manage to write it, the exact
 * role/model spelling wins without this code changing.
 */
function metadataString(
  metadata: SidebarSession["metadata"],
  key: string
): string | undefined {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Role behind a session's agent id: `nexus-coder` → `coder`.
 *
 * A non-nexus agent id is taken as-is, since the sidebar is already scoped to
 * this session's family and the real agent name is more informative than the
 * `'agent'` placeholder the old dead metadata read produced.
 */
function roleFromAgent(agent: string | undefined): string | undefined {
  if (!agent) return undefined
  const role = agent.startsWith(NEXUS_AGENT_PREFIX)
    ? agent.slice(NEXUS_AGENT_PREFIX.length)
    : agent
  return role.length > 0 ? role : undefined
}

/** `ModelRef` → the `provider/id` string the sidebar renders. */
function modelLabel(model: SidebarSession["model"]): string | undefined {
  if (!model?.providerID || !model.id) return undefined
  return `${model.providerID}/${model.id}`
}

/** `coder` → `Coder`, matching how the sidebar has always displayed roles. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Sidebar record for one child session.
 *
 * `name` keeps its previous meaning — the capitalised role when one is known,
 * otherwise the session title, otherwise a short id — so the sidebar reads the
 * same as it did when the (now absent) metadata path worked.
 */
export function sidebarAgentFor(
  session: SidebarSession,
  status: AgentStatus["status"],
  now: string
): AgentStatus {
  const role =
    metadataString(session.metadata, "nexusRole") ??
    roleFromAgent(session.agent)
  return {
    id: session.id,
    name: role ? titleCase(role) : session.title || session.id.slice(0, 12),
    role: role ?? "agent",
    status,
    model:
      metadataString(session.metadata, "nexusModel") ??
      modelLabel(session.model) ??
      "",
    sessionID: session.id,
    spawnedAt: now,
    tasksCompleted: 0,
    tasksFailed: 0
  }
}

/**
 * The nexus subagent sessions to show for the current session, from
 * `session.family()` alone.
 *
 * `family()` resolves to the *root* of the given session and returns that
 * root's entire tree, so a subagent spawned by this plugin is always in it.
 *
 * There is deliberately no "scan every session for a nexus role" fallback. One
 * used to exist to recover nexus sessions that `family()` missed, back when
 * spawned sessions came out unparented. That parentage bug is fixed at the
 * source, and the scan has been dead ever since: it keyed off
 * `metadata.nexusRole`, which no session carries any more. Re-arming it against
 * `session.agent` would be worse than dead. Anything `family()` excludes
 * belongs to a *different* root's tree, so a scan could only ever pull in
 * another session's agents — and it has no way to tell them apart, because
 * `nexus-orchestrator` carries a `nexus-`-prefixed agent id while being a
 * primary agent rather than a subagent. A `startsWith("nexus-")` filter would
 * therefore sweep every previous orchestrator session into the sidebar, and the
 * entries would then flicker in and out as the family result oscillated.
 */
export function sidebarChildSessionIDs(
  family: readonly string[] | undefined,
  currentSessionID: string
): string[] {
  if (!Array.isArray(family)) return []
  return family.filter(id => id !== currentSessionID)
}

/**
 * One polling pass: resolve each child session of `currentSessionID` into an
 * `AgentStatus`. Per-session lookups are individually guarded because a session
 * can be evicted between listing and reading it, and a missing or unreadable
 * child must drop out of the sidebar rather than crash the poll.
 */
export function collectSidebarAgents(
  source: SidebarSessionSource,
  currentSessionID: string,
  statusOf: (sessionID: string) => AgentStatus["status"],
  now: string
): AgentStatus[] {
  const childIDs = sidebarChildSessionIDs(source.family(currentSessionID), currentSessionID)
  if (childIDs.length === 0) return []

  const agents: AgentStatus[] = []
  for (const id of childIDs) {
    try {
      const session = source.get(id)
      if (!session) continue
      let status: AgentStatus["status"] = "completed"
      try {
        status = statusOf(id)
      } catch {
        // session.status() is best-effort; fall back to "completed"
      }
      agents.push(sidebarAgentFor(session, status, now))
    } catch {
      // a single unreadable child must not abort the whole poll
    }
  }
  return agents
}

/**
 * Folds one poll's findings into the sidebar's agent list: update agents we
 * already track, append the new ones, and drop working agents whose session has
 * left the family. Completed and failed agents are kept as history.
 */
export function mergeSidebarAgents(
  agents: readonly AgentStatus[],
  polled: readonly AgentStatus[],
  childIDs: readonly string[]
): AgentStatus[] {
  const next = agents.map(agent => ({ ...agent }))

  for (const agent of polled) {
    const existing = next.find(a => a.sessionID === agent.sessionID)
    if (existing) {
      existing.status = agent.status
      existing.name = agent.name
      existing.role = agent.role
      existing.model = agent.model
    } else {
      next.push(agent)
    }
  }

  return next.filter(
    a =>
      (a.sessionID && childIDs.includes(a.sessionID)) ||
      a.status === "completed" ||
      a.status === "failed"
  )
}

export default Plugin.define({
  id: "nexus.cli",
  setup(context) {
    const configManager = new NexusConfigManager()
    // Load config from disk so TUI shows actual project/global config values
    try {
      const loc = context.location ?? context.data.location.default()
      if (loc?.directory) {
        configManager.loadFromPath(loc.directory)
      }
    } catch {
      // If we can't determine project dir, continue with defaults
    }

    // Model selection handler
    // Persistent save scope for the config session
    let configSaveScope: 'project' | 'global' = 'global'

    const handleModelSelect = async (role: string) => {
      if (!configManager.getRoles().includes(role)) {
        context.ui.toast.show({
          title: "Nexus",
          message: `Unknown role: ${role}. Valid: ${configManager.getRoles().join(', ')}`,
          variant: "error"
        })
        return
      }

      const location = context.location ?? context.data.location.default()
      await context.data.location.model.sync(location)
      const availableModels = context.data.location.model.list(location) ?? []

      const options = availableModels.map((m: any) => ({
        title: m.name || m.id,
        value: `${m.providerID}/${m.id}`,
        description: m.providerID
      }))

      options.push({
        title: "Use default",
        value: "",
        description: "Reset to default model"
      })

      const current = configManager.getModelForRole(role)
      const selected = await context.ui.dialog.select({
        title: `${configManager.getRoleDisplayName(role)} Model`,
        current: current || "",
        options
      })

      if (selected !== null && selected !== undefined) {
        configManager.setModel(role, selected)
        persistConfig()
      }
    }

    // Persist config to the selected scope
    const persistConfig = () => {
      if (configSaveScope === 'project') {
        configManager.saveProjectConfig(process.cwd())
      } else {
        configManager.saveGlobalConfig()
      }
    }

    // Config dialog handler
    const handleConfigDialog = async () => {
      const config = configManager.getConfig()
      const budgetStr = await context.ui.dialog.prompt({
        title: "Max Total Budget ($)",
        placeholder: String(config.budget.maxTotalCost)
      })
      if (budgetStr !== null && budgetStr !== undefined) {
        const budget = parseFloat(budgetStr)
        if (!isNaN(budget) && budget > 0) {
          configManager.updateStorageConfig({
            budget: { ...config.budget, maxTotalCost: budget }
          })
          persistConfig()
          context.ui.toast.show({
            title: "Nexus",
            message: `Budget updated: $${budget}`,
            variant: "success"
          })
        }
      }
    }

    // All-in-one config handler
    const handleFullConfig = async () => {
      // Ask scope once at the beginning
      const scope = await context.ui.dialog.select({
        title: "Where to save config?",
        options: [
          { title: "📁 Project (.opencode/)", value: "project", description: "This project only" },
          { title: "🌍 Global (~/.config/opencode/)", value: "global", description: "All projects" }
        ]
      })
      configSaveScope = (scope === 'project' ? 'project' : 'global') as 'project' | 'global'

      for (const role of configManager.getRoles()) {
        await handleModelSelect(role)
      }
      await handleConfigDialog()
      context.ui.toast.show({
        title: "Nexus",
        message: `Configuration complete! (saved to ${configSaveScope === 'project' ? '.opencode/' : '~/.config/opencode/'})`,
        variant: "success"
      })
    }

    // Dashboard handler - shows config and orchestrator info
    const handleDashboard = async () => {
      const config = configManager.getConfig()
      const lines = [
        "⚡ Nexus Dashboard",
        "═══════════════════════════════════",
        "",
        "🤖 Agent Models:",
      ]

      for (const role of configManager.getRoles()) {
        const model = config.models[role] || '(not set)'
        const displayName = configManager.getRoleDisplayName(role)
        lines.push(`  ${displayName}: ${model}`)
      }

      lines.push("")
      lines.push("💰 Budget:")
      lines.push(`  Max Total: $${config.budget.maxTotalCost}`)
      lines.push(`  Max Per Task: $${config.budget.maxCostPerTask}`)
      lines.push(`  Alert Threshold: ${config.budget.alertThreshold * 100}%`)
      lines.push("")
      lines.push("🛡️ Self-Healing:")
      lines.push(`  Enabled: ${config.selfHealing.enabled ? '✅' : '❌'}`)
      lines.push(`  Max Retries: ${config.selfHealing.maxRetries}`)
      lines.push("")
      lines.push("💡 Commands:")
      lines.push("  /nexus status   - Show config summary")
      lines.push("  /nexus config   - Configure models & budget")
      lines.push("  /nexus model    - Select model for role")
      lines.push("  /nexus reset    - Reset to defaults")
      lines.push("")
      lines.push("🔧 Tools (use in agent prompt):")
      lines.push("  nexus.status    - Orchestrator status")
      lines.push("  nexus.agents    - List spawned agents")
      lines.push("  nexus.costs     - Cost report")
      lines.push("  nexus.spawn     - Spawn a sub-agent")

      context.ui.toast.show({
        title: "Nexus Dashboard",
        message: lines.join('\n'),
        variant: "info",
        duration: 15000
      })
    }

    // Keymap layer - registered in slot render via closure
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "nexus",
              title: "Nexus Configuration",
              group: "Nexus",
              bind: "ctrl+n",
              palette: true,
              slash: { name: "nexus", aliases: [], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                if (input) {
                  const parts = input.split(' ')
                  const cmd = parts[0]
                  switch (cmd) {
                    case 'config':
                    case 'c':
                      await handleFullConfig()
                      break
                    case 'status':
                    case 's':
                      context.ui.toast.show({
                        title: "Nexus Status",
                        message: configManager.getSummary(),
                        variant: "info",
                        duration: 8000
                      })
                      break
                    case 'dashboard':
                    case 'd':
                      await handleDashboard()
                      break
                    case 'web':
                    case 'w':
                      {
                        const port = parts[1] ? parseInt(parts[1]) : 4747
                        const host = parts[2] || '127.0.0.1'
                        
                        // Show instructions and start via toast action
                        context.ui.toast.show({
                          title: "⚡ Nexus Web Dashboard",
                          message: [
                            `Starting dashboard on port ${port}...`,
                            "",
                            `Ask the agent to run: nexus.dashboard.start(port=${port})`,
                            "",
                            `Or type: nexus.dashboard.start with port=${port} in your next message`,
                            "",
                            `Then open: http://${host}:${port}`
                          ].join('\n'),
                          variant: "success",
                          duration: 8000
                        })
                        
                        // Try to open browser
                        try {
                          const { exec } = await import('node:child_process')
                          const cmd = process.platform === 'darwin' ? 'open' : 
                                     process.platform === 'win32' ? 'start' : 'xdg-open'
                          exec(`${cmd} http://${host}:${port}`)
                        } catch {}
                      }
                      break
                    case 'model':
                    case 'm':
                      if (parts[1]) {
                        await handleModelSelect(parts[1])
                      } else {
                        const role = await context.ui.dialog.select({
                          title: "Select Agent Role",
                          options: configManager.getRoles().map(r => ({
                            title: configManager.getRoleDisplayName(r),
                            value: r,
                            description: `Current: ${configManager.getModelForRole(r)}`
                          }))
                        })
                        if (role) {
                          await handleModelSelect(role)
                        }
                      }
                      break
                    case 'reset':
                      const confirmed = await context.ui.dialog.confirm({
                        title: "Reset Configuration",
                        message: "Reset all Nexus settings to defaults?",
                        label: { confirm: "Reset", cancel: "Cancel" }
                      })
                      if (confirmed) {
                        configManager.resetToDefaults()
                        context.ui.toast.show({
                          title: "Nexus",
                          message: "Configuration reset to defaults",
                          variant: "success"
                        })
                      }
                      break
                    default:
                      context.ui.toast.show({
                        title: "Nexus",
                        message: "Commands: config, status, dashboard, web [port], model <role>, reset",
                        variant: "info"
                      })
                  }
                } else {
                  await handleFullConfig()
                }
              }
            },
            {
              id: "nexus.config",
              title: "Nexus Configuration",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-config", aliases: ["nc"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                await handleFullConfig()
              }
            },
            {
              id: "nexus.dashboard",
              title: "Nexus Dashboard",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-dashboard", aliases: ["nd"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                await handleDashboard()
              }
            },
            {
              id: "nexus.web",
              title: "Start Nexus Web Dashboard",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-web", aliases: ["nw"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                const port = input ? parseInt(input) : 4747
                const host = '127.0.0.1'
                context.ui.toast.show({
                  title: "⚡ Nexus Web Dashboard",
                  message: [
                    `Port: ${port}  Host: ${host}`,
                    "",
                    "To start the dashboard, ask the agent:",
                    `  nexus.dashboard.start(port=${port}, host="${host}")`,
                    "",
                    `Then open: http://${host}:${port}`,
                    "",
                    "Tip: The dashboard shows live agent status, costs, and history."
                  ].join('\n'),
                  variant: "info",
                  duration: 12000
                })
              }
            },
            {
              id: "nexus.model",
              title: "Select Agent Model",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-model", aliases: ["nm"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                if (input) {
                  await handleModelSelect(input)
                } else {
                  const role = await context.ui.dialog.select({
                    title: "Select Agent Role",
                    options: configManager.getRoles().map(r => ({
                      title: configManager.getRoleDisplayName(r),
                      value: r,
                      description: `Current: ${configManager.getModelForRole(r)}`
                    }))
                  })
                  if (role) {
                    await handleModelSelect(role)
                  }
                }
              }
            },
            {
              id: "nexus.status",
              title: "Nexus Status",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-status", aliases: ["ns"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                context.ui.toast.show({
                  title: "Nexus Status",
                  message: configManager.getSummary(),
                  variant: "info",
                  duration: 8000
                })
              }
            },
            {
              id: "nexus.reset",
              title: "Reset Nexus Config",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-reset", aliases: [], arguments: true },
              enabled: () => true,
              run: async () => {
                const confirmed = await context.ui.dialog.confirm({
                  title: "Reset Configuration",
                  message: "Reset all Nexus settings to defaults?",
                  label: { confirm: "Reset", cancel: "Cancel" }
                })
                if (confirmed) {
                  configManager.resetToDefaults()
                  context.ui.toast.show({
                    title: "Nexus",
                    message: "Configuration reset to defaults",
                    variant: "success"
                  })
                }
              }
            }
          ],
          bindings: ["nexus"]
        }))
        return <></>
      }
    })

    // Welcome message
    context.ui.toast.show({
      title: "⚡ Nexus Loaded",
      message: "Type /nexus or Ctrl+N to configure",
      variant: "info",
      duration: 3000
    })

    // === Sidebar Agent Status ===
    // Durable storage for sidebar state (TUI's own state, not shared with server)
    const [sidebarState, setSidebarState] = context.storage.store<SidebarState>("nexus-sidebar-state", {
      initial: {
        agents: [],
        totalCost: 0,
        budgetRemaining: 10.00
      }
    })

    // Poll for child sessions — wrapped in try/catch to prevent sidebar crash
    let lastPollTime = 0
    const pollChildSessions = () => {
      try {
        const now = Date.now()
        if (now - lastPollTime < 2000) return
        lastPollTime = now

        const currentRoute = context.ui.router.current()
        if (!currentRoute || currentRoute.type !== "session") return

        const currentSessionID = currentRoute.sessionID
        if (!currentSessionID) return

        const source: SidebarSessionSource = context.data.session
        const childIDs = sidebarChildSessionIDs(
          source.family(currentSessionID),
          currentSessionID
        )

        // No children at all: keep only the finished ones as history.
        if (childIDs.length === 0) {
          setSidebarState((draft) => {
            draft.agents = mergeSidebarAgents(draft.agents, [], [])
          })
          return
        }

        const newAgents = collectSidebarAgents(
          source,
          currentSessionID,
          id => (context.data.session.status(id) === 'running' ? 'working' : 'completed'),
          new Date().toISOString()
        )

        // Every child was unreadable — leave the sidebar as it is.
        if (newAgents.length === 0) return

        setSidebarState((draft) => {
          draft.agents = mergeSidebarAgents(draft.agents, newAgents, childIDs)
        })
      } catch {
        // poll must never crash the sidebar
      }
    }

    // Subscribe to session execution events — wrapped in try/catch
    const unsubSessionSucceeded = context.data.on("session.execution.succeeded", (event) => {
      try {
        const sessionId = event.data.sessionID
        setSidebarState((draft) => {
          const agent = draft.agents.find(a => a.sessionID === sessionId)
          if (agent) {
            agent.status = 'completed'
            agent.tasksCompleted++
          }
        })
      } catch {}
    })

    const unsubSessionFailed = context.data.on("session.execution.failed", (event) => {
      try {
        const sessionId = event.data.sessionID
        setSidebarState((draft) => {
          const agent = draft.agents.find(a => a.sessionID === sessionId)
          if (agent) {
            agent.status = 'failed'
            agent.tasksFailed++
          }
        })
      } catch {}
    })

    const unsubSessionCreated = context.data.on("session.created", (event) => {
      try {
        setTimeout(pollChildSessions, 100)
      } catch {}
    })

    // Register sidebar content slot
    const unsubSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        try {
          pollChildSessions()
        } catch {
          // poll must never crash the sidebar
        }

        const agents = sidebarState.agents
        if (!agents || agents.length === 0) return null

        try {
          const activeAgents = agents.filter(a => a.status === 'working' || a.status === 'idle')
          const completedAgents = agents.filter(a => a.status === 'completed')
          const failedAgents = agents.filter(a => a.status === 'failed')

          return (
            <box padding={1} marginTop={1}>
              {/* Header */}
              <box>
                <text>🤖 Nexus Agents — {activeAgents.length} active</text>
              </box>

              {/* Active Agents */}
              {activeAgents.map(agent => (
                <box>
                  <text fg={agent.status === 'working' ? '#4ade80' : '#94a3b8'}>
                    {agent.status === 'working' ? '🔄' : '⏸️'} {agent.name}
                    {agent.model ? ` — ${agent.model.split('/').pop()}` : ''}
                  </text>
                </box>
              ))}

              {/* Completed Agents */}
              {completedAgents.length > 0 && (
                <box marginTop={1}>
                  <text fg="#666">✅ {completedAgents.length} completed</text>
                </box>
              )}

              {/* Failed Agents */}
              {failedAgents.length > 0 && (
                <box marginTop={1}>
                  <text fg="#ef4444">❌ {failedAgents.length} failed</text>
                </box>
              )}

              {/* Cost Summary */}
              {sidebarState.totalCost > 0 && (
                <box marginTop={1}>
                  <text fg="#666">💰 ${sidebarState.totalCost.toFixed(4)} / ${sidebarState.budgetRemaining.toFixed(2)} remaining</text>
                </box>
              )}
            </box>
          )
        } catch (err) {
          // Log the real error so we can diagnose why JSX failed
          console.error("[nexus] sidebar render error:", err)
          try {
            context.ui.toast.show({
              title: "Nexus Sidebar Error",
              message: err instanceof Error ? err.message : String(err),
              variant: "error",
              duration: 5000
            })
          } catch {}
          return null
        }
      }
    })

    return () => {
      unsubSessionSucceeded()
      unsubSessionFailed()
      unsubSessionCreated()
      unsubSidebar()
    }
  }
})
