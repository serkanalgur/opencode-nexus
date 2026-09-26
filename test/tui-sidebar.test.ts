import { describe, it, expect, beforeEach } from "bun:test"
import {
  collectSidebarAgents,
  mergeSidebarAgents,
  sidebarChildSessionIDs
} from "../src/tui"

// ── Types matching tui.tsx ──────────────────────────────────────────
interface AgentStatus {
  id: string
  name: string
  role: string
  status: "idle" | "working" | "completed" | "failed" | "terminated"
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

// ── Helpers ─────────────────────────────────────────────────────────
function createAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-agent",
    role: "coder",
    status: "idle",
    model: "anthropic/claude-sonnet-4-5",
    spawnedAt: new Date().toISOString(),
    tasksCompleted: 0,
    tasksFailed: 0,
    ...overrides,
  }
}

function createInitialState(): SidebarState {
  return {
    agents: [],
    totalCost: 0,
    budgetRemaining: 10.0,
  }
}

/**
 * Simulates the sidebar render guard logic from tui.tsx.
 * Returns null when there's nothing to show.
 */
function sidebarRenderGuard(state: SidebarState): boolean {
  const agents = state.agents
  if (!agents || agents.length === 0) {
    return false // render returns null
  }
  return true // would render
}

/**
 * Simulates the session.execution.succeeded handler from tui.tsx.
 */
function onSessionSucceeded(state: SidebarState, sessionID: string): SidebarState {
  const next = structuredClone(state)
  const agent = next.agents.find((a) => a.sessionID === sessionID)
  if (agent) {
    agent.status = "completed"
    agent.tasksCompleted++
  }
  return next
}

/**
 * Simulates the session.execution.failed handler from tui.tsx.
 */
function onSessionFailed(state: SidebarState, sessionID: string): SidebarState {
  const next = structuredClone(state)
  const agent = next.agents.find((a) => a.sessionID === sessionID)
  if (agent) {
    agent.status = "failed"
    agent.tasksFailed++
  }
  return next
}

/**
 * Computes sidebar display groups (active / completed / failed).
 */
function computeDisplayGroups(
  state: SidebarState
) {
  const agents = state.agents
  const active = agents.filter(
    (a) => a.status === "working" || a.status === "idle"
  )
  const completed = agents.filter((a) => a.status === "completed")
  const failed = agents.filter((a) => a.status === "failed")
  return { active, completed, failed }
}

// ── Tests ───────────────────────────────────────────────────────────
describe("Sidebar: state initialization", () => {
  it("should start with empty agents and zero cost", () => {
    const state = createInitialState()
    expect(state.agents).toEqual([])
    expect(state.totalCost).toBe(0)
    expect(state.budgetRemaining).toBe(10.0)
  })

  it("render guard returns false when agents is empty", () => {
    const state = createInitialState()
    expect(sidebarRenderGuard(state)).toBe(false)
  })

  it("render guard returns false when agents array is null-ish", () => {
    const state = { agents: null as any, totalCost: 0, budgetRemaining: 10 }
    expect(sidebarRenderGuard(state)).toBe(false)
  })
})

describe("Sidebar: agent lifecycle via events", () => {
  let state: SidebarState

  beforeEach(() => {
    state = createInitialState()
    state.agents.push(
      createAgent({ id: "a1", sessionID: "ses-aaa", status: "working" }),
      createAgent({ id: "a2", sessionID: "ses-bbb", status: "idle" }),
      createAgent({ id: "a3", sessionID: "ses-ccc", status: "working" })
    )
  })

  it("render guard returns true when agents exist", () => {
    expect(sidebarRenderGuard(state)).toBe(true)
  })

  it("session.execution.succeeded marks agent completed and increments tasksCompleted", () => {
    const next = onSessionSucceeded(state, "ses-aaa")
    const agent = next.agents.find((a) => a.id === "a1")!
    expect(agent.status).toBe("completed")
    expect(agent.tasksCompleted).toBe(1)
    // other agents unchanged
    expect(next.agents.find((a) => a.id === "a2")!.status).toBe("idle")
    expect(next.agents.find((a) => a.id === "a3")!.status).toBe("working")
  })

  it("session.execution.failed marks agent failed and increments tasksFailed", () => {
    const next = onSessionFailed(state, "ses-bbb")
    const agent = next.agents.find((a) => a.id === "a2")!
    expect(agent.status).toBe("failed")
    expect(agent.tasksFailed).toBe(1)
  })

  it("multiple succeeded events accumulate tasksCompleted", () => {
    let next = onSessionSucceeded(state, "ses-aaa")
    next = onSessionSucceeded(next, "ses-aaa")
    next = onSessionSucceeded(next, "ses-aaa")
    const agent = next.agents.find((a) => a.id === "a1")!
    expect(agent.tasksCompleted).toBe(3)
  })

  it("event for unknown sessionID is a no-op", () => {
    const next = onSessionSucceeded(state, "ses-unknown")
    expect(next.agents).toEqual(state.agents)
  })

  it("event for agent without sessionID is a no-op", () => {
    state.agents.push(
      createAgent({ id: "a-no-session", status: "working" }) // no sessionID
    )
    const next = onSessionSucceeded(state, "ses-aaa")
    const noSession = next.agents.find((a) => a.id === "a-no-session")!
    expect(noSession.status).toBe("working") // unchanged
  })
})

describe("Sidebar: display groups", () => {
  it("classifies agents by status correctly", () => {
    const state = createInitialState()
    state.agents.push(
      createAgent({ id: "idle-1", status: "idle" }),
      createAgent({ id: "work-1", status: "working" }),
      createAgent({ id: "comp-1", status: "completed" }),
      createAgent({ id: "fail-1", status: "failed" }),
      createAgent({ id: "term-1", status: "terminated" })
    )
    const { active, completed, failed } = computeDisplayGroups(state)
    expect(active.map((a) => a.id)).toEqual(["idle-1", "work-1"])
    expect(completed.map((a) => a.id)).toEqual(["comp-1"])
    expect(failed.map((a) => a.id)).toEqual(["fail-1"])
    // terminated agents don't appear in any group
    expect(active.concat(completed, failed).find((a) => a.id === "term-1")).toBeUndefined()
  })

  it("returns empty arrays for empty state", () => {
    const state = createInitialState()
    const { active, completed, failed } = computeDisplayGroups(state)
    expect(active).toEqual([])
    expect(completed).toEqual([])
    expect(failed).toEqual([])
  })
})

describe("Sidebar: cost display", () => {
  it("hides cost section when totalCost is 0", () => {
    const state = createInitialState()
    expect(state.totalCost).toBe(0)
    // In the real render: `{sidebarState.totalCost > 0 && ...}` — renders nothing
  })

  it("shows cost section when totalCost > 0", () => {
    const state = createInitialState()
    state.totalCost = 0.042
    state.budgetRemaining = 9.958
    expect(state.totalCost).toBeGreaterThan(0)
    // Format check: should display as $0.0420 / $9.96 remaining
    const formatted = `$${state.totalCost.toFixed(4)} / $${state.budgetRemaining.toFixed(2)} remaining`
    expect(formatted).toBe("$0.0420 / $9.96 remaining")
  })
})

describe("Sidebar: agent model display", () => {
  it("extracts model name from provider/model format", () => {
    const agent = createAgent({ model: "anthropic/claude-sonnet-4-5" })
    // In render: agent.model.split('/').pop()
    const displayName = agent.model.split("/").pop()
    expect(displayName).toBe("claude-sonnet-4-5")
  })

  it("handles model without provider prefix", () => {
    const agent = createAgent({ model: "claude-sonnet-4-5" })
    const displayName = agent.model.split("/").pop()
    expect(displayName).toBe("claude-sonnet-4-5")
  })

  it("hides model span when model is empty", () => {
    const agent = createAgent({ model: "" })
    // In render: `{agent.model && <span>...}</span>}` — falsy → no render
    expect(agent.model).toBeFalsy()
  })
})

describe("Sidebar: edge cases from V2 crash fix", () => {
  it("does not crash when agents is undefined", () => {
    const state = { agents: undefined as any, totalCost: 0, budgetRemaining: 10 }
    expect(() => sidebarRenderGuard(state)).not.toThrow()
    expect(sidebarRenderGuard(state)).toBe(false)
  })

  it("does not crash when find returns undefined for event handler", () => {
    const state = createInitialState()
    state.agents.push(createAgent({ id: "a1", sessionID: "ses-1" }))
    // No agent with sessionID "ses-999" — should be a no-op, not crash
    expect(() => onSessionSucceeded(state, "ses-999")).not.toThrow()
    expect(() => onSessionFailed(state, "ses-999")).not.toThrow()
  })

  it("does not mutate original state on event handler", () => {
    const state = createInitialState()
    state.agents.push(createAgent({ id: "a1", sessionID: "ses-1", status: "working" }))
    const original = structuredClone(state)
    onSessionSucceeded(state, "ses-1")
    // Original should be untouched
    expect(state.agents[0].status).toBe("working")
    expect(state.agents[0].tasksCompleted).toBe(0)
  })
})

// ── Sidebar creation/update logic ──────────────────────────────────
// The scanner itself is exercised against the real implementation in
// tui-sidebar-sessions.test.ts; these tests cover how its output folds into
// the sidebar's own state.

interface MockSession {
  id: string
  title?: string
  agent?: string
  model?: { providerID: string; id: string }
  metadata?: Record<string, string>
}

/**
 * Drives the real tui.tsx scanner over a session store, then folds the result
 * into the sidebar state the way pollChildSessions does.
 */
function pollChildSessions(
  state: SidebarState,
  currentSessionID: string,
  family: string[],
  sessions: Map<string, MockSession>
): SidebarState {
  const source = {
    family: () => family,
    get: (id: string) => sessions.get(id)
  }
  const childIDs = sidebarChildSessionIDs(family, currentSessionID)
  if (childIDs.length === 0) {
    return { ...state, agents: mergeSidebarAgents(state.agents, [], []) }
  }
  const polled = collectSidebarAgents(
    source,
    currentSessionID,
    id => 'working',
    new Date().toISOString()
  )
  if (polled.length === 0) return state
  return { ...state, agents: mergeSidebarAgents(state.agents, polled, childIDs) }
}

describe("Sidebar: pollChildSessions — creation", () => {
  it("creates agent from the session's agent and model", () => {
    const state = createInitialState()
    const sessions = new Map<string, MockSession>([
      ["ses-child-1", { id: "ses-child-1", title: "🔍 Reviewer", agent: "nexus-reviewer", model: { providerID: "opencode-go", id: "mimo-v2.5" } }]
    ])
    const family = ["ses-parent", "ses-child-1"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents).toHaveLength(1)
    expect(next.agents[0].name).toBe("Reviewer")
    expect(next.agents[0].role).toBe("reviewer")
    expect(next.agents[0].model).toBe("opencode-go/mimo-v2.5")
    expect(next.agents[0].sessionID).toBe("ses-child-1")
    expect(next.agents[0].status).toBe("working")
  })

  it("prefers session metadata when a future release writes it again", () => {
    const state = createInitialState()
    const sessions = new Map<string, MockSession>([
      ["ses-child-1", { id: "ses-child-1", agent: "nexus-coder", model: { providerID: "opencode-go", id: "mimo-v2.5" }, metadata: { nexusRole: "reviewer", nexusModel: "opencode-go/mimo-v2.6" } }]
    ])

    const next = pollChildSessions(state, "ses-parent", ["ses-parent", "ses-child-1"], sessions)

    expect(next.agents[0].role).toBe("reviewer")
    expect(next.agents[0].model).toBe("opencode-go/mimo-v2.6")
  })

  it("creates multiple agents from multiple sessions", () => {
    const state = createInitialState()
    const sessions = new Map<string, MockSession>([
      ["ses-1", { id: "ses-1", agent: "nexus-reviewer", model: { providerID: "p", id: "mimo-v2.5" } }],
      ["ses-2", { id: "ses-2", agent: "nexus-explorer", model: { providerID: "p", id: "big-pickle" } }],
      ["ses-3", { id: "ses-3", agent: "nexus-coder", model: { providerID: "p", id: "mimo-v2.6-flash-free" } }],
    ])
    const family = ["ses-parent", "ses-1", "ses-2", "ses-3"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents).toHaveLength(3)
    expect(next.agents.map(a => a.name)).toEqual(["Reviewer", "Explorer", "Coder"])
    expect(next.agents.map(a => a.model)).toEqual([
      "p/mimo-v2.5",
      "p/big-pickle",
      "p/mimo-v2.6-flash-free"
    ])
  })

  it("uses session title as fallback when the session has no agent", () => {
    const state = createInitialState()
    const sessions = new Map<string, MockSession>([
      ["ses-1", { id: "ses-1", title: "Custom Agent Name" }]
    ])
    const family = ["ses-parent", "ses-1"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents[0].name).toBe("Custom Agent Name")
    expect(next.agents[0].role).toBe("agent") // default role
  })

  it("does not create agent for parent session itself", () => {
    const state = createInitialState()
    const sessions = new Map<string, MockSession>([
      ["ses-parent", { id: "ses-parent", agent: "nexus-orchestrator" }]
    ])
    const family = ["ses-parent"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents).toHaveLength(0)
  })
})

describe("Sidebar: pollChildSessions — update", () => {
  it("updates existing agent status", () => {
    const state = createInitialState()
    state.agents.push(createAgent({
      id: "ses-1",
      sessionID: "ses-1",
      name: "Reviewer",
      status: "working",
      model: "mimo-v2.5"
    }))

    const sessions = new Map<string, MockSession>([
      ["ses-1", { id: "ses-1", agent: "nexus-reviewer", model: { providerID: "p", id: "mimo-v2.5" } }]
    ])
    const family = ["ses-parent", "ses-1"]

    // Poll again — agent should be updated, not duplicated
    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents).toHaveLength(1)
    expect(next.agents[0].status).toBe("working")
  })

  it("removes agents that are no longer in family", () => {
    const state = createInitialState()
    state.agents.push(createAgent({
      id: "ses-old",
      sessionID: "ses-old",
      name: "Old Agent",
      status: "working"
    }))
    state.agents.push(createAgent({
      id: "ses-active",
      sessionID: "ses-active",
      name: "Active Agent",
      status: "completed"
    }))

    const sessions = new Map<string, MockSession>([
      ["ses-active", { id: "ses-active", agent: "nexus-reviewer" }]
    ])
    // ses-old is no longer in family
    const family = ["ses-parent", "ses-active"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    // ses-old removed (not in family, not completed/failed), ses-active kept
    expect(next.agents.find(a => a.sessionID === "ses-old")).toBeUndefined()
    expect(next.agents.find(a => a.sessionID === "ses-active")).toBeDefined()
  })

  it("keeps completed agents even if no longer in family", () => {
    const state = createInitialState()
    state.agents.push(createAgent({
      id: "ses-done",
      sessionID: "ses-done",
      name: "Done Agent",
      status: "completed"
    }))

    const sessions = new Map<string, MockSession>()
    const family = ["ses-parent"] // ses-done not in family

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    // Completed agents are kept for history
    expect(next.agents.find(a => a.sessionID === "ses-done")).toBeDefined()
  })

  it("keeps failed agents even if no longer in family", () => {
    const state = createInitialState()
    state.agents.push(createAgent({
      id: "ses-failed",
      sessionID: "ses-failed",
      name: "Failed Agent",
      status: "failed"
    }))

    const sessions = new Map<string, MockSession>()
    const family = ["ses-parent"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents.find(a => a.sessionID === "ses-failed")).toBeDefined()
  })
})

describe("Sidebar: pollChildSessions — edge cases", () => {
  it("returns same state when no children in family", () => {
    const state = createInitialState()
    const next = pollChildSessions(state, "ses-parent", ["ses-parent"], new Map())
    expect(next.agents).toHaveLength(0)
  })

  it("skips sessions not found in sessions map", () => {
    const state = createInitialState()
    const family = ["ses-parent", "ses-unknown"]
    const sessions = new Map<string, MockSession>() // empty

    const next = pollChildSessions(state, "ses-parent", family, sessions)
    expect(next.agents).toHaveLength(0)
  })

  it("handles a session with neither agent, model nor title", () => {
    const state = createInitialState()
    const sessions = new Map<string, MockSession>([
      ["ses-1", { id: "ses-1", metadata: {} }]
    ])
    const family = ["ses-parent", "ses-1"]

    const next = pollChildSessions(state, "ses-parent", family, sessions)

    expect(next.agents).toHaveLength(1)
    expect(next.agents[0].name).toBe("ses-1") // falls back to ID
    expect(next.agents[0].role).toBe("agent") // default
    expect(next.agents[0].model).toBe("") // no model
  })
})

describe("Sidebar: agent name formatting", () => {
  it("capitalizes role name for display", () => {
    const cases = [
      { role: "reviewer", expected: "Reviewer" },
      { role: "explorer", expected: "Explorer" },
      { role: "coder", expected: "Coder" },
      { role: "architect", expected: "Architect" },
      { role: "tester", expected: "Tester" },
      { role: "documenter", expected: "Documenter" },
    ]
    for (const { role, expected } of cases) {
      const name = role.charAt(0).toUpperCase() + role.slice(1)
      expect(name).toBe(expected)
    }
  })

  it("extracts model name from provider/model format", () => {
    const model = "opencode-go/mimo-v2.5"
    const display = model.split("/").pop()
    expect(display).toBe("mimo-v2.5")
  })
})
