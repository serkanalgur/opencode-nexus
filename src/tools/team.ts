/** Team tools. Registered from `setup()` in `src/index.ts`. */
import { TeamManager } from "../team"
import type { ToolEditor, ToolDeps } from "./deps"

export function registerTeamTools(editor: ToolEditor, deps: ToolDeps): void {
  const teamManager = new TeamManager()

  // Team management tools

  editor.add({
    name: "team.create",
    description: "Create a new team with a lead role",
    input: {
      type: "object",
      properties: {
        name: { type: "string", description: "Team name" },
        leadRole: { type: "string", description: "Role of the team lead" }
      },
      required: ["name", "leadRole"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { name, leadRole } = input as { name: string; leadRole: string }
      const team = teamManager.create(name, leadRole)
      return { content: `Team '${team.name}' created with ID: ${team.id}\nLead: ${leadRole}\nStatus: ${team.status}\n\nAdd members with nexus.team.addMember(teamId="${team.id}", role="...")` }
    }
  })

  editor.add({
    name: "team.addMember",
    description: "Add a member to a team",
    // `model` is GONE, and it is a BREAKING schema change: it was `required`
    // and no longer exists. It was stored on the member and read by nothing
    // — `member.model` appeared in exactly one place in the repository, the
    // success echo below, which reported back the string the caller had just
    // supplied. See `TeamMember` in `src/team.ts` for why wiring it was not
    // the alternative.
    input: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID" },
        role: { type: "string", description: "Role for this member" }
      },
      required: ["teamId", "role"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { teamId, role } = input as { teamId: string; role: string }
      const member = teamManager.addMember(teamId, role)
      if (!member) {
        return { content: `Team ${teamId} not found.` }
      }
      const team = teamManager.get(teamId)
      return { content: `Member added to team '${team?.name}':\nID: ${member.id}\nRole: ${member.role}\nStatus: ${member.status}\n\nTotal members: ${team?.members.length || 0}` }
    }
  })

  editor.add({
    name: "team.status",
    description: "Show team status",
    input: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID (optional, shows all if omitted)" }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { teamId } = input as { teamId?: string }
      
      if (teamId) {
        const team = teamManager.get(teamId)
        if (!team) {
          return { content: `Team ${teamId} not found.` }
        }
        // No `m.model`: the field is gone from `TeamMember` because nothing
        // ever read it. See the note on the interface in `src/team.ts`.
        const memberLines = team.members.map(m => `  - ${m.role}: ${m.status}`).join('\n')
        return { content: `Team: ${team.name} (${team.id})\nLead: ${team.lead}\nStatus: ${team.status}\nCreated: ${team.createdAt.toISOString()}\nMembers (${team.members.length}):\n${memberLines || '  No members yet'}` }
      }

      const teams = teamManager.getAll()
      if (teams.length === 0) {
        return { content: "No teams created yet." }
      }
      const lines = teams.map(t => `${t.status === 'active' ? '🟢' : t.status === 'completed' ? '✅' : '🔵'} ${t.name} (${t.id}) - Lead: ${t.lead} - Members: ${t.members.length}`)
      return { content: `Teams (${teams.length}):\n${lines.join('\n')}` }
    }
  })

  editor.add({
    name: "team.activate",
    description: "Activate a team to start execution",
    input: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID" }
      },
      required: ["teamId"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { teamId } = input as { teamId: string }
      const team = teamManager.get(teamId)
      if (!team) {
        return { content: `Team ${teamId} not found.` }
      }
      if (team.members.length === 0) {
        return { content: `Team '${team.name}' has no members. Add members before activating.` }
      }
      teamManager.activate(teamId)
      return { content: `Team '${team.name}' activated!\n\nTeam is now ready for parallel execution with ${team.members.length} members:\n${team.members.map(m => `  - ${m.role}: ${m.status}`).join('\n')}` }
    }
  })
}
