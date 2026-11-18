/**
 * Reading assistant text out of V2 session messages. Moved out of
 * `src/orchestrator.ts` unchanged; that module re-exports both functions.
 */
import type { NexusSessionMessage } from "./orchestrator-types"

/**
 * Text of an assistant message. V2 assistant messages are discriminated by
 * `type` and their text lives in typed `content` parts — there is no `role`
 * field and `content` is an array, not a string.
 *
 * The `part.type === "text"` filter is load-bearing, not a redundant narrowing.
 * A V2 `reasoning` part also carries a `.text` field, so filtering on the
 * presence of `.text` instead — or dropping the filter and concatenating
 * `.text` unconditionally — would silently splice the model's chain of thought
 * into the task output reported back to the caller. Only `text` parts are
 * user-facing output.
 */
export function assistantMessageText(message: NexusSessionMessage): string {
  if (message.type !== "assistant") return ""
  return message.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("")
}


/**
 * Text of the most recent assistant message, or `""` when the session has
 * produced none. Replaces the V1-era `messages.filter(m => m.role ===
 * 'assistant')` read, which never matched and silently degraded every result
 * to a placeholder string.
 */
export function lastAssistantText(messages: readonly NexusSessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== "assistant") continue
    const text = assistantMessageText(messages[i])
    if (text) return text
  }
  return ""
}
