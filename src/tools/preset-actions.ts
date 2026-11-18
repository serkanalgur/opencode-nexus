import { NexusOrchestrator } from "../orchestrator"

/** Result body every `preset` tool invocation returns. */
interface PresetToolResult {
  content: string
}

/**
 * `preset` with mode 'clear': drop the session-scoped preset override so the
 * disk config is in control again.
 *
 * Goes through `resetToDefaults()` rather than touching `storageConfig`, so
 * the TUI and this tool share one definition of "hand control back to disk".
 * The resolved map is read *after* the clear, so the caller can confirm the
 * outcome instead of taking it on trust — and when there was no override to
 * drop, that is stated rather than dressed up as a successful change.
 */
export function clearPresetOverride(orchestrator: NexusOrchestrator): PresetToolResult {
  const configManager = orchestrator.configManager
  const hadOverride = configManager.resetToDefaults()
  const models = configManager.getResolvedModels()
  const resolved = Object.entries(models)
    .map(([role, model]) => `${role}=${model}`)
    .join(' ')

  return {
    content: hadOverride
      ? `Cleared the session preset override. nexus.jsonc is in control again — no config file was modified.\n`
        + `Resolved models now: ${resolved}\n`
        + `sessionOverride: false`
      : `No session preset override was set, so nothing was cleared — nexus.jsonc was already in control. No config file was modified.\n`
        + `Resolved models now: ${resolved}\n`
        + `sessionOverride: false`
  }
}
