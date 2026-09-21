/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { NexusConfigManager } from "./config"

export default Plugin.define({
  id: "nexus.cli",
  setup(context) {
    const configManager = new NexusConfigManager()

    // Model selection handler - sadece dialog kullanır, panel ezmez
    const handleModelSelect = async (role: string) => {
      if (!configManager.getRoles().includes(role)) {
        context.ui.toast.show({
          title: "Nexus",
          message: `Unknown role: ${role}. Valid: ${configManager.getRoles().join(', ')}`,
          variant: "error"
        })
        return
      }

      // Get available models
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
        context.ui.toast.show({
          title: "Nexus",
          message: `${role} → ${selected || 'default'}`,
          variant: "success"
        })
      }
    }

    // Config dialog handler - sadece prompt kullanır
    const handleConfigDialog = async () => {
      const config = configManager.getConfig()
      
      // Budget dialog
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
      // Her rol için model seçimi
      for (const role of configManager.getRoles()) {
        await handleModelSelect(role)
      }
      
      // Budget ayarı
      await handleConfigDialog()
      
      // Sonucu göster
      context.ui.toast.show({
        title: "Nexus",
        message: "Configuration complete!",
        variant: "success"
      })
    }

    // Register slash commands
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        // /nexus - Ana menü (tüm konfigürasyon)
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
                    message: "Commands: config, status, model <role>, reset",
                    variant: "info"
                  })
              }
            } else {
              // No input - show full config
              await handleFullConfig()
            }
          }
        },
        // /nexus-config - Config dialog
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
        // /nexus-model - Hızlı model seçimi
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
        // /nexus-status - Durum göster
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
        // /nexus-reset - Config'i sıfırla
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

    // Welcome message
    context.ui.toast.show({
      title: "⚡ Nexus Loaded",
      message: "Type /nexus or Ctrl+N to configure",
      variant: "info",
      duration: 3000
    })

    return () => {
      // Cleanup
    }
  }
})
