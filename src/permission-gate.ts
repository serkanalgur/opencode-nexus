/**
 * The budget gate on OpenCode's permission check.
 *
 * WHY THIS EXISTS. When the hard budget limit trips, `spawnAgent` refuses with
 * "Budget exceeded". That only covers spawns that go through Nexus. The
 * orchestrator agent's own permissions allow `subagent` on `nexus-*`, so it can
 * still start a Nexus agent through OpenCode's built-in `subagent` tool, which
 * never asks Nexus about the budget. Every such start does go through
 * OpenCode's permission check, though: the built-in tool asserts
 * `{ action: "subagent", resources: [agentId] }`. The `evaluate` hook runs on
 * that check, so this is the one place both paths meet.
 *
 * WHAT IT CAN AND CANNOT DO. Core evaluates the user's configured deny rules
 * before calling the hook and returns early on a deny, so this can only make a
 * request stricter, never loosen one the user denied. It turns `allow` or
 * `ask` into `deny` for a Nexus agent once the limit has tripped, and leaves
 * everything else exactly as it was: other actions, other agents, and every
 * request while the budget holds.
 */

/** The fields of `PermissionEvaluation` this gate reads and writes. */
export interface PermissionEvaluationLike {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: "allow" | "deny" | "ask"
  message?: string
}

/** Every agent Nexus spawns has this prefix, custom roles included (they run as `nexus-coder`). */
export const NEXUS_AGENT_PREFIX = "nexus-"

/**
 * Deny starting a Nexus agent once the hard budget limit has tripped.
 * Mutates `event` in place, as the hook contract requires, and returns whether
 * it changed anything so callers and tests can tell.
 */
export function applyBudgetGate(
  event: PermissionEvaluationLike,
  budget: { exceeded: boolean; spent: number },
): boolean {
  if (!budget.exceeded) return false
  if (event.action !== "subagent") return false
  if (event.effect === "deny") return false
  const nexusAgents = event.resources.filter((resource) => resource.startsWith(NEXUS_AGENT_PREFIX))
  if (nexusAgents.length === 0) return false

  event.effect = "deny"
  // Says what happened and what it means for the rest of the run. It does not
  // suggest a nexus.jsonc change: `hardLimit` is not file-settable (see the
  // README), and the latch it sets lasts for the run.
  event.message =
    `Nexus's hard budget limit was reached at $${budget.spent.toFixed(2)}, so ${nexusAgents.join(", ")} ` +
    `cannot be started. Nexus agents are refused for the rest of this run.`
  return true
}
