/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, onMount } from "solid-js"

export default Plugin.define({
  id: "nexus.cli",
  setup(context) {
    // Register slash commands
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "nexus.status",
          title: "Nexus Status",
          group: "Nexus",
          bind: "ctrl+n",
          palette: true,
          slash: { name: "nexus", aliases: ["status"], arguments: false },
          enabled: () => true,
          suggested: true,
          run: async () => {
            context.ui.toast.show({
              title: "Nexus",
              message: "Opening Nexus dashboard...",
              variant: "info"
            })
          }
        }
      ],
      bindings: ["nexus.status"]
    }))

    // Register sidebar slot
    context.ui.slot({
      append: "sidebar.content",
      render: () => <NexusSidebar context={context} />
    })

    return () => {
      // Cleanup
    }
  }
})

function NexusSidebar(props: { context: any }) {
  const [status, setStatus] = createSignal("Loading...")
  
  onMount(async () => {
    // In real implementation, this would fetch from the orchestrator
    setStatus("Nexus Ready")
  })

  return (
    <box>
      <text fg={props.context.theme.text.accent}>⚡ OpenCode Nexus</text>
      <text fg={props.context.theme.text.muted}>{status()}</text>
    </box>
  )
}
