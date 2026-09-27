/**
 * A member of a team, as `TeamManager` records it.
 *
 * There is deliberately NO `model` field here. It was on this interface, it was
 * a REQUIRED argument to `addMember`, and `team.addMember`'s input schema
 * demanded it from the model writing the call — and nothing ever read it. A
 * `grep` for `member.model` returned exactly one line in the whole repository:
 * the tool's own success echo, reporting back the string it had just been
 * handed. No spawn path consumes a `TeamMember` at all: `TeamManager` is a
 * standalone registry, and teams are not wired to the orchestrator's agent
 * spawning, so there is nowhere for the value to have gone.
 *
 * It could not be WIRED either, and that is the reason for deleting rather than
 * deferring. Model selection for a real task is the ranker's
 * (`selectModel` / `selectQualifiedModel`), and it takes its candidates from
 * `NexusConfig.models` by role. Honoring a per-member model string would mean a
 * second, competing way to choose a model for a role — the same duplication
 * `NexusCustomRoleConfig.model` documents and explains when it is the FIRST
 * candidate rather than the winner. Building that bridge is a feature, not a
 * repair, and it is not this one's job to invent it.
 *
 * A field a caller must supply, that is stored and never read, is worse than no
 * field: the caller has no way to tell that the value did nothing.
 *
 * This is a BREAKING change to the exported `TeamMember` type and to the
 * `team.addMember` tool's input schema, which no longer accepts or requires
 * `model`. There is no behaviour to lose — the value never had any.
 */
export interface TeamMember {
  id: string
  role: string
  agentId?: string
  status: 'idle' | 'working' | 'completed' | 'failed'
}

export interface Team {
  id: string
  name: string
  lead: string
  members: TeamMember[]
  status: 'forming' | 'active' | 'completed'
  createdAt: Date
}

export class TeamManager {
  private teams: Map<string, Team> = new Map()
  private teamCounter = 0
  private memberCounter = 0

  create(name: string, leadRole: string): Team {
    this.teamCounter++
    const team: Team = {
      id: `team-${Date.now()}-${this.teamCounter}`,
      name,
      lead: leadRole,
      members: [],
      status: 'forming',
      createdAt: new Date()
    }
    this.teams.set(team.id, team)
    return team
  }

  addMember(teamId: string, role: string): TeamMember | null {
    const team = this.teams.get(teamId)
    if (!team) return null

    this.memberCounter++
    const member: TeamMember = {
      id: `member-${Date.now()}-${this.memberCounter}`,
      role,
      status: 'idle'
    }
    team.members.push(member)
    return member
  }

  activate(teamId: string): void {
    const team = this.teams.get(teamId)
    if (team) team.status = 'active'
  }

  complete(teamId: string): void {
    const team = this.teams.get(teamId)
    if (team) team.status = 'completed'
  }

  get(teamId: string): Team | undefined {
    return this.teams.get(teamId)
  }

  getAll(): Team[] {
    return [...this.teams.values()]
  }

  getActive(): Team | null {
    return [...this.teams.values()].find(t => t.status === 'active') || null
  }
}
