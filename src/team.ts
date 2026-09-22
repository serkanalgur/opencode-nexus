export interface TeamMember {
  id: string
  role: string
  agentId?: string
  status: 'idle' | 'working' | 'completed' | 'failed'
  model: string
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

  addMember(teamId: string, role: string, model: string): TeamMember | null {
    const team = this.teams.get(teamId)
    if (!team) return null

    this.memberCounter++
    const member: TeamMember = {
      id: `member-${Date.now()}-${this.memberCounter}`,
      role,
      status: 'idle',
      model
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
