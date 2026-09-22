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

export default Plugin.define({
  id: "nexus.cli",
  setup(context) {
    const configManager = new NexusConfigManager()

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
    // Durable storage: persists to disk, syncs with server-side storage
    // where the orchestrator writes agent state via ctx.storage.set
    const [sidebarState, setSidebarState] = context.storage.store<SidebarState>("nexus-sidebar-state", {
      initial: {
        agents: [],
        totalCost: 0,
        budgetRemaining: 10.00
      }
    })

    // Subscribe to session execution events to track agent lifecycle
    const unsubSessionSucceeded = context.data.on("session.execution.succeeded", (event) => {
      const sessionId = event.data.sessionID
      setSidebarState((draft) => {
        const agent = draft.agents.find(a => a.sessionID === sessionId)
        if (agent) {
          agent.status = 'completed'
          agent.tasksCompleted++
        }
      })
    })

    const unsubSessionFailed = context.data.on("session.execution.failed", (event) => {
      const sessionId = event.data.sessionID
      setSidebarState((draft) => {
        const agent = draft.agents.find(a => a.sessionID === sessionId)
        if (agent) {
          agent.status = 'failed'
          agent.tasksFailed++
        }
      })
    })

    // Track child sessions created in the current session (via nexus.spawn)
    // This catches sessions spawned through the orchestrator and adds them to sidebar
    const unsubSessionCreated = context.data.on("session.created", (event) => {
      const newSession = event.data
      const newSessionID = newSession.sessionID as string
      const currentRoute = context.ui.router.current()
      const currentSessionID = currentRoute.type === "session" ? currentRoute.sessionID : null
      if (!currentSessionID || !newSessionID) return

      // Check if the new session is a child of the current session
      const family = context.data.session.family(newSessionID)
      if (family.includes(currentSessionID) && newSessionID !== currentSessionID) {
        // This is a child session — add to sidebar if not already tracked
        const meta = (newSession.metadata || {}) as Record<string, string>
        setSidebarState((draft) => {
          const exists = draft.agents.some(a => a.sessionID === newSessionID)
          if (!exists) {
            draft.agents.push({
              id: newSessionID,
              name: (newSession.title as string) || newSessionID.slice(0, 12),
              role: meta.nexusRole || 'agent',
              status: 'working',
              model: meta.nexusModel || '',
              sessionID: newSessionID,
              spawnedAt: new Date().toISOString(),
              tasksCompleted: 0,
              tasksFailed: 0
            })
          }
        })
      }
    })

    // Register sidebar content slot
    const unsubSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        // Safe access: guard against undefined sessionID and empty agents
        const agents = sidebarState.agents
        if (!agents || agents.length === 0) {
          return null
        }

        const activeAgents = agents.filter(a => a.status === 'working' || a.status === 'idle')
        const completedAgents = agents.filter(a => a.status === 'completed')
        const failedAgents = agents.filter(a => a.status === 'failed')

        return (
          <div style={{
            padding: '8px',
            borderTop: '1px solid #333',
            marginTop: '8px'
          }}>
            {/* Header */}
            <div style={{
              fontSize: '11px',
              color: '#888',
              marginBottom: '4px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span>🤖 Nexus Agents</span>
              <span style={{ color: '#666' }}>
                {activeAgents.length} active
              </span>
            </div>

            {/* Active Agents */}
            {activeAgents.map(agent => (
              <div
                key={agent.id}
                style={{
                  fontSize: '10px',
                  padding: '2px 0',
                  color: agent.status === 'working' ? '#4ade80' : '#94a3b8'
                }}
              >
                <span>{agent.status === 'working' ? '🔄' : '⏸️'}</span>
                {' '}{agent.name}
                {agent.model && (
                  <span style={{ color: '#64748b' }}> — {agent.model.split('/').pop()}</span>
                )}
              </div>
            ))}

            {/* Completed Agents */}
            {completedAgents.length > 0 && (
              <div style={{
                marginTop: '4px',
                paddingTop: '4px',
                borderTop: '1px solid #222'
              }}>
                <div style={{ fontSize: '10px', color: '#666', marginBottom: '2px' }}>
                  ✅ {completedAgents.length} completed
                </div>
              </div>
            )}

            {/* Failed Agents */}
            {failedAgents.length > 0 && (
              <div style={{ marginTop: '2px' }}>
                <div style={{ fontSize: '10px', color: '#ef4444', marginBottom: '2px' }}>
                  ❌ {failedAgents.length} failed
                </div>
              </div>
            )}

            {/* Cost Summary */}
            {sidebarState.totalCost > 0 && (
              <div style={{
                marginTop: '4px',
                fontSize: '10px',
                color: '#666'
              }}>
                💰 ${sidebarState.totalCost.toFixed(4)} / ${sidebarState.budgetRemaining.toFixed(2)} remaining
              </div>
            )}
          </div>
        )
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
