import { describe, it, expect } from "bun:test"
import {
  collectSidebarAgents,
  mergeSidebarAgents,
  sidebarChildSessionIDs,
  sidebarAgentFor,
  type SidebarSession,
  type SidebarSessionSource
} from "../src/tui"

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * Stands in for `context.data.session`. Only `family` and `get` are read by the
 * scanner; `list` exists so the fake can also assert that the sidebar no longer
 * needs it (see "no stray scan" below).
 */
class FakeSessionData implements SidebarSessionSource {
  public listCalls = 0

  constructor(
    private readonly sessions: ReadonlyMap<string, SidebarSession>,
    private readonly families: ReadonlyMap<string, readonly string[]>,
    private readonly statuses: ReadonlyMap<string, "idle" | "running"> = new Map()
  ) {}

  family(sessionID: string): readonly string[] {
    return this.families.get(sessionID) ?? []
  }

  get(sessionID: string): SidebarSession | undefined {
    return this.sessions.get(sessionID)
  }

  list(): SidebarSession[] {
    this.listCalls++
    return [...this.sessions.values()]
  }

  status(id: string): "idle" | "running" {
    const status = this.statuses.get(id)
    if (status === undefined) throw new Error(`no status for ${id}`)
    return status
  }
}

/** A session as the host populates it for a nexus-spawned subagent. */
function nexusSubagent(
  id: string,
  role: string,
  overrides: Partial<SidebarSession> = {}
): SidebarSession {
  return {
    id,
    title: `Fix cost accounting (${role})`,
    agent: `nexus-${role}`,
    model: { providerID: "opencode-go", id: "space-bunny-free" },
    ...overrides
  }
}

const NOW = "2026-01-01T00:00:00.000Z"

function collect(
  data: FakeSessionData,
  currentSessionID: string
): ReturnType<typeof collectSidebarAgents> {
  return collectSidebarAgents(data, currentSessionID, id =>
    data.status(id) === "running" ? "working" : "completed"
  , NOW)
}

// ── Role and model come from session.agent / session.model ─────────

describe("sidebar: labels come from session.agent and session.model", () => {
  it("derives role and name from the agent id", () => {
    const agent = sidebarAgentFor(
      nexusSubagent("ses-coder", "coder"),
      "working",
      NOW
    )

    expect(agent.role).toBe("coder")
    expect(agent.name).toBe("Coder")
  })

  it("derives the model label from the ModelRef", () => {
    const agent = sidebarAgentFor(
      nexusSubagent("ses-coder", "coder"),
      "working",
      NOW
    )

    expect(agent.model).toBe("opencode-go/space-bunny-free")
    // The render splits on "/" and shows the model half.
    expect(agent.model.split("/").pop()).toBe("space-bunny-free")
  })

  it("never falls back to the 'agent' placeholder for a nexus subagent", () => {
    // The regression: metadata.nexusRole is gone, so the old code produced
    // role === "agent" and model === "" for every real child session.
    const data = new FakeSessionData(
      new Map([
        ["ses-coder", nexusSubagent("ses-coder", "coder")],
        ["ses-reviewer", nexusSubagent("ses-reviewer", "reviewer")]
      ]),
      new Map([["ses-root", ["ses-root", "ses-coder", "ses-reviewer"]]]),
      new Map([
        ["ses-coder", "running"],
        ["ses-reviewer", "running"]
      ])
    )

    const agents = collect(data, "ses-root")

    expect(agents.map(a => a.role)).toEqual(["coder", "reviewer"])
    expect(agents.map(a => a.name)).toEqual(["Coder", "Reviewer"])
    expect(agents.every(a => a.model !== "")).toBe(true)
  })

  it("labels several real spawned sessions the way their SessionInfo reads", () => {
    const data = new FakeSessionData(
      new Map([
        ["ses-1", nexusSubagent("ses-1", "coder")],
        ["ses-2", nexusSubagent("ses-2", "reviewer")],
        ["ses-3", nexusSubagent("ses-3", "explorer")]
      ]),
      new Map([["ses-root", ["ses-root", "ses-1", "ses-2", "ses-3"]]]),
      new Map([
        ["ses-1", "running"],
        ["ses-2", "idle"],
        ["ses-3", "running"]
      ])
    )

    const agents = collect(data, "ses-root")

    expect(agents).toEqual([
      {
        id: "ses-1",
        name: "Coder",
        role: "coder",
        status: "working",
        model: "opencode-go/space-bunny-free",
        sessionID: "ses-1",
        spawnedAt: NOW,
        tasksCompleted: 0,
        tasksFailed: 0
      },
      {
        id: "ses-2",
        name: "Reviewer",
        role: "reviewer",
        status: "completed",
        model: "opencode-go/space-bunny-free",
        sessionID: "ses-2",
        spawnedAt: NOW,
        tasksCompleted: 0,
        tasksFailed: 0
      },
      {
        id: "ses-3",
        name: "Explorer",
        role: "explorer",
        status: "working",
        model: "opencode-go/space-bunny-free",
        sessionID: "ses-3",
        spawnedAt: NOW,
        tasksCompleted: 0,
        tasksFailed: 0
      }
    ])
  })

  it("takes a non-nexus agent id as the role rather than the 'agent' default", () => {
    const agent = sidebarAgentFor(
      { id: "ses-x", agent: "build", title: "Some task" },
      "working",
      NOW
    )

    expect(agent.role).toBe("build")
    expect(agent.name).toBe("Build")
  })

  it("falls back to the title, then a short id, when there is no role", () => {
    expect(sidebarAgentFor({ id: "ses-t", title: "Custom Agent Name" }, "working", NOW)).toMatchObject({
      name: "Custom Agent Name",
      role: "agent",
      model: ""
    })
    expect(sidebarAgentFor({ id: "ses-abcdef0123456" }, "working", NOW).name).toBe("ses-abcdef01")
  })

  it("ignores a model without a provider or an id", () => {
    expect(
      sidebarAgentFor(
        { id: "ses-x", model: { providerID: "", id: "m" } },
        "working",
        NOW
      ).model
    ).toBe("")
    expect(
      sidebarAgentFor(
        { id: "ses-x", model: { providerID: "p", id: "" } },
        "working",
        NOW
      ).model
    ).toBe("")
  })
})

// ── Metadata as a forward-compatible preferred source ──────────────

describe("sidebar: session metadata is a preferred, not exclusive, source", () => {
  it("prefers metadata.nexusRole / nexusModel when they are present", () => {
    const agent = sidebarAgentFor(
      nexusSubagent("ses-1", "coder", {
        metadata: { nexusRole: "reviewer", nexusModel: "anthropic/claude-sonnet-4-5" }
      }),
      "working",
      NOW
    )

    expect(agent.role).toBe("reviewer")
    expect(agent.name).toBe("Reviewer")
    expect(agent.model).toBe("anthropic/claude-sonnet-4-5")
  })

  it("ignores non-string metadata values instead of rendering [object Object]", () => {
    const agent = sidebarAgentFor(
      nexusSubagent("ses-1", "coder", { metadata: { nexusRole: { nested: true } } }),
      "working",
      NOW
    )

    expect(agent.role).toBe("coder")
  })

  it("falls through to agent/model when the metadata keys are empty", () => {
    const agent = sidebarAgentFor(
      nexusSubagent("ses-1", "coder", { metadata: { nexusRole: "", nexusModel: "" } }),
      "working",
      NOW
    )

    expect(agent.role).toBe("coder")
    expect(agent.model).toBe("opencode-go/space-bunny-free")
  })
})

// ── family() is the only source; there is no stray scan ────────────

describe("sidebar: child sessions come from family() only", () => {
  it("excludes the current session from its own family", () => {
    expect(sidebarChildSessionIDs(["ses-root", "ses-a", "ses-b"], "ses-root")).toEqual([
      "ses-a",
      "ses-b"
    ])
    // family() is root-based, so a nested session's family still contains the
    // root and its siblings; only the session itself is dropped.
    expect(sidebarChildSessionIDs(["ses-root", "ses-a"], "ses-a")).toEqual(["ses-root"])
  })

  it("returns nothing for a missing or malformed family", () => {
    expect(sidebarChildSessionIDs(undefined, "ses-root")).toEqual([])
    expect(sidebarChildSessionIDs([], "ses-root")).toEqual([])
  })

  it("does not pull in another root's nexus sessions", () => {
    // The old stray scan looked for nexus sessions outside the family. Nothing
    // carries metadata.nexusRole any more, and re-arming it on session.agent
    // could not tell a previous orchestrator's subagents from this one's, so
    // the scan is gone: a session outside the family is simply not shown.
    const data = new FakeSessionData(
      new Map([
        ["ses-mine", nexusSubagent("ses-mine", "coder")],
        ["ses-theirs", nexusSubagent("ses-theirs", "reviewer")],
        ["ses-old-root", { id: "ses-old-root", agent: "nexus-orchestrator" }]
      ]),
      new Map([["ses-root", ["ses-root", "ses-mine"]]]),
      new Map([["ses-mine", "running"]])
    )

    const agents = collect(data, "ses-root")

    expect(agents.map(a => a.sessionID)).toEqual(["ses-mine"])
    expect(data.listCalls).toBe(0)
  })

  it("does not render a nexus-orchestrator session as a subagent", () => {
    // nexus-orchestrator carries a nexus- prefixed agent id but is a primary
    // agent. The scan is gone, so nothing matches on the prefix at all.
    const data = new FakeSessionData(
      new Map([["ses-prev-orch", { id: "ses-prev-orch", agent: "nexus-orchestrator" }]]),
      new Map([["ses-root", ["ses-root"]]])
    )

    expect(collect(data, "ses-root")).toEqual([])
  })
})

// ── Resilience ─────────────────────────────────────────────────────

describe("sidebar: scanning survives an unreadable session", () => {
  it("skips a child that can no longer be read", () => {
    const data = new FakeSessionData(
      new Map([["ses-ok", nexusSubagent("ses-ok", "coder")]]),
      new Map([["ses-root", ["ses-root", "ses-gone", "ses-ok"]]]),
      new Map([["ses-ok", "running"]])
    )

    const agents = collect(data, "ses-root")

    expect(agents.map(a => a.sessionID)).toEqual(["ses-ok"])
  })

  it("defaults to 'completed' when session.status() throws", () => {
    const data = new FakeSessionData(
      new Map([["ses-ok", nexusSubagent("ses-ok", "coder")]]),
      new Map([["ses-root", ["ses-root", "ses-ok"]]])
    )

    expect(collect(data, "ses-root")[0].status).toBe("completed")
  })
})

// ── mergeSidebarAgents ─────────────────────────────────────────────

describe("sidebar: merging a poll into existing state", () => {
  const coder = sidebarAgentFor(nexusSubagent("ses-1", "coder"), "working", NOW)

  it("appends an unseen agent", () => {
    const merged = mergeSidebarAgents([], [coder], ["ses-1"])
    expect(merged).toEqual([coder])
  })

  it("updates rather than duplicates an agent it already tracks", () => {
    const first = mergeSidebarAgents([], [coder], ["ses-1"])
    const done = sidebarAgentFor(nexusSubagent("ses-1", "coder"), "completed", NOW)

    const second = mergeSidebarAgents(first, [done], ["ses-1"])

    expect(second).toHaveLength(1)
    expect(second[0].status).toBe("completed")
  })

  it("carries a re-read model over onto a tracked agent", () => {
    const first = mergeSidebarAgents([], [coder], ["ses-1"])
    // Simulates the user switching the role's model config mid-run.
    const moved = sidebarAgentFor(
      nexusSubagent("ses-1", "coder", {
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" }
      }),
      "working",
      NOW
    )

    const second = mergeSidebarAgents(first, [moved], ["ses-1"])

    expect(second[0].model).toBe("anthropic/claude-sonnet-4-5")
  })

  it("does not mutate the agents it was given", () => {
    const first = mergeSidebarAgents([], [coder], ["ses-1"])
    const snapshot = structuredClone(first)

    mergeSidebarAgents(first, [sidebarAgentFor(nexusSubagent("ses-1", "coder"), "failed", NOW)], ["ses-1"])

    expect(first).toEqual(snapshot)
  })

  it("preserves the task counters an event handler already incremented", () => {
    const first = mergeSidebarAgents([], [coder], ["ses-1"])
    first[0].tasksCompleted = 3

    const second = mergeSidebarAgents(
      first,
      [sidebarAgentFor(nexusSubagent("ses-1", "coder"), "completed", NOW)],
      ["ses-1"]
    )

    expect(second[0].tasksCompleted).toBe(3)
  })

  it("drops a working agent whose session left the family", () => {
    const stale = sidebarAgentFor(nexusSubagent("ses-old", "coder"), "working", NOW)
    const merged = mergeSidebarAgents([stale], [coder], ["ses-1"])

    expect(merged.map(a => a.sessionID)).toEqual(["ses-1"])
  })

  it("keeps completed and failed agents as history once they leave the family", () => {
    const done = sidebarAgentFor(nexusSubagent("ses-done", "coder"), "completed", NOW)
    const failed = sidebarAgentFor(nexusSubagent("ses-failed", "reviewer"), "failed", NOW)

    const merged = mergeSidebarAgents([done, failed], [coder], ["ses-1"])

    expect(merged.map(a => a.sessionID).sort()).toEqual([
      "ses-1",
      "ses-done",
      "ses-failed"
    ])
  })

  it("reduces to history only when the family has no children", () => {
    const done = sidebarAgentFor(nexusSubagent("ses-done", "coder"), "completed", NOW)
    const working = sidebarAgentFor(nexusSubagent("ses-live", "coder"), "working", NOW)

    const merged = mergeSidebarAgents([done, working], [], [])

    expect(merged.map(a => a.sessionID)).toEqual(["ses-done"])
  })
})
