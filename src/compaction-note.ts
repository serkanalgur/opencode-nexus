import type { Goal } from "./goal"
import type { TodoItem } from "./todo"

/**
 * Keep the Nexus plan through context compaction.
 *
 * WHY THIS EXISTS. When OpenCode compacts a long session, a model writes a
 * summary that replaces the history. The active goal (`nexus.goal.set`) and the
 * open todos (`nexus.todo.add`) live in Nexus, not in the conversation, so the
 * summary has no reason to mention them, and an orchestrator that resumes from
 * the summary may lose track of what it was doing. The `compaction` hook runs
 * on that summarisation request; its `system` parts are the summariser's
 * instructions, so adding one asking it to carry the goal and open todos is
 * enough. Nothing is skipped or replaced: the hook does not set `result`, so the
 * normal summary is still generated.
 *
 * SCOPED TO NEXUS SESSIONS. The goal and todos are plugin-wide, not per session,
 * so they are added only when the session's agent is a Nexus agent. Compacting
 * an unrelated session must not inject one project's plan into another
 * conversation.
 */

/** The fields of `SessionCompaction` this reads and writes. */
export interface CompactionRequestLike {
  readonly agent: string
  system: Array<{ type: "text"; text: string }>
}

/** Cap on todos listed, so a long backlog cannot crowd out the summary itself. */
export const MAX_TODOS_IN_NOTE = 20

/**
 * The instruction to add, or `null` when there is nothing to carry. Only open
 * work is listed: completed todos and finished goals are history the summary
 * can already describe.
 */
export function buildCompactionNote(state: {
  activeGoal: Pick<Goal, "description"> | null
  openTodos: ReadonlyArray<Pick<TodoItem, "id" | "description" | "status" | "assignedTo">>
}): string | null {
  const { activeGoal, openTodos } = state
  if (!activeGoal && openTodos.length === 0) return null

  const lines = [
    "Nexus orchestration state. Carry it into the summary verbatim, under a heading",
    "\"Nexus state\", so work can resume from the summary:",
  ]
  if (activeGoal) lines.push("", `Active goal: ${activeGoal.description}`)
  if (openTodos.length > 0) {
    lines.push("", "Open todos:")
    for (const todo of openTodos.slice(0, MAX_TODOS_IN_NOTE)) {
      const owner = todo.assignedTo ? ` (${todo.assignedTo})` : ""
      lines.push(`- [${todo.status}] ${todo.id}: ${todo.description}${owner}`)
    }
    if (openTodos.length > MAX_TODOS_IN_NOTE) {
      lines.push(`- …and ${openTodos.length - MAX_TODOS_IN_NOTE} more; nexus.todo.list shows all of them`)
    }
  }
  return lines.join("\n")
}

/**
 * Add the note to a compaction request for a Nexus session. Mutates `event` in
 * place, as the hook contract requires, and returns whether it did.
 */
export function applyCompactionNote(event: CompactionRequestLike, note: string | null): boolean {
  if (note === null) return false
  if (!event.agent.startsWith("nexus-")) return false
  event.system.push({ type: "text", text: note })
  return true
}
