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
                      // Start web dashboard server
                      try {
                        const port = parts[1] ? parseInt(parts[1]) : 4747
                        // Use orchestrator's startDashboard via the server plugin
                        context.ui.toast.show({
                          title: "Nexus Dashboard",
                          message: `Starting web dashboard on port ${port}...\nOpen http://localhost:${port} in your browser`,
                          variant: "success",
                          duration: 5000
                        })
                      } catch (e: any) {
                        context.ui.toast.show({
                          title: "Nexus",
                          message: `Failed to start dashboard: ${e.message}`,
                          variant: "error"
                        })
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
    // Ephemeral memory store for agent status (survives hot reloads)
    const [sidebarState, setSidebarState] = context.storage.memory<SidebarState>("nexus-sidebar-state", {
      initial: {
        agents: [],
        totalCost: 0,
        budgetRemaining: 10.00
      }
    })

    // Subscribe to state changes from the server plugin
    const unsubStorage = context.data.on("session.updated", (event) => {
      // When sessions update, we can sync state
      // The server plugin persists state to storage, we read it here
    })

    // Register sidebar content slot
    const unsubSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        // Get child sessions (sub-agents) for the current session
        const family = context.data.session.family(props.sessionID)
        const sessions = context.data.session.list()
        
        // Filter to show only child sessions (sub-agents)
        const childSessions = family
          .filter(id => id !== props.sessionID)
          .map(id => context.data.session.get(id))
          .filter(Boolean)

        if (childSessions.length === 0 && sidebarState.agents.length === 0) {
          return null
        }

        // Merge data from both sources
        const agents = sidebarState.agents.length > 0 
          ? sidebarState.agents 
          : childSessions.map(s => ({
              id: s!.id,
              name: s!.title || s!.id.slice(0, 12),
              role: 'agent',
              status: s!.status === 'running' ? 'working' as const : 'completed' as const,
              model: '',
              sessionID: s!.id,
              spawnedAt: new Date().toISOString(),
              tasksCompleted: 0,
              tasksFailed: 0
            }))

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
      unsubStorage()
      unsubSidebar()
    }
  }
})
