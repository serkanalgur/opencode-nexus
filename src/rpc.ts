import type { Rpc } from "@opencode/plugin/rpc"

/**
 * `Rpc.define` with the same signature, kept local so this module has no
 * runtime import from the SDK. `Rpc.define` returns its argument unchanged, but
 * importing it pulls `@opencode/schema/dist/rpc.js` into the TUI bundle, and the
 * TUI bundle is held to carrying nothing from `@opencode/schema` (see
 * `test/model-ref.test.ts`). The type parameter keeps the full
 * `Rpc.PortableDefinition` check that `ctx.rpc.register` and `client.rpc` rely on.
 */
function defineRpc<const D extends Rpc.PortableDefinition>(definition: D): D {
  return definition
}

/**
 * The contract between the Nexus server plugin and its clients.
 *
 * WHY THIS EXISTS. The TUI plugin runs in the TUI process and the orchestrator
 * lives in the server process. The TUI used to reach the orchestrator by
 * submitting `/nexus …` as a PROMPT into the open session, where a
 * `session.hook("prompt")` rewrote the text into the command's result. That
 * hook cannot cancel the turn, so every `/nexus costs` started a model
 * request whose only job was to read the answer back, needed an open session
 * to land in, and left the exchange in the conversation history.
 *
 * Plugin RPC is the documented server/client channel: the server registers a
 * handler with `ctx.rpc.register`, and the TUI calls it with
 * `context.client.rpc(NexusRpc)`. The result comes back to the caller as data:
 * no session, no model turn, and the full text, which the TUI shows in a
 * dialog.
 *
 * JSON Schema rather than a validator library, so the contract adds no
 * dependency. The output always carries text, including when the command fails,
 * because `handleCommand` already reports failures as text (a bind failure on
 * `/nexus dashboard` is an ordinary outcome, not an exception); `ok` is false
 * only when the command threw, so a caller can tell the two apart without
 * parsing the text.
 */
export const NexusRpc = defineRpc({
  id: "nexus",
  methods: {
    command: {
      input: {
        type: "object",
        properties: {
          // The whole command line as the user typed it, `/nexus` included:
          // `handleCommand` parses `parts[1]` onwards.
          text: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          text: { type: "string" },
        },
        required: ["ok", "text"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

export interface NexusCommandResult {
  readonly ok: boolean
  readonly text: string
}

/**
 * Run a `/nexus …` line through the orchestrator and turn every outcome into a
 * result. Shared by the RPC handler and the server-side `nexus` command, so the
 * two entry points cannot report the same failure differently.
 *
 * A throw is caught here because both callers run inside the host: an escaping
 * exception would surface as an opaque RPC failure or a failed command instead
 * of the one sentence that says what went wrong.
 */
export function runNexusCommand(
  handleCommand: (text: string) => string,
  text: string,
): NexusCommandResult {
  const line = text.trim()
  try {
    return { ok: true, text: handleCommand(line) }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, text: `The \`${line}\` command failed: ${detail}\nNothing was changed.` }
  }
}
