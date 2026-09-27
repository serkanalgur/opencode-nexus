import { describe, it, expect } from 'bun:test'
import { TeamManager } from '../src/team'

describe('TeamManager', () => {
  it('should create a new team', () => {
    const manager = new TeamManager()
    const team = manager.create('Test Team', 'architect')
    
    expect(team.id).toMatch(/^team-\d+-\d+$/)
    expect(team.name).toBe('Test Team')
    expect(team.lead).toBe('architect')
    expect(team.members).toEqual([])
    expect(team.status).toBe('forming')
    expect(team.createdAt).toBeInstanceOf(Date)
  })

  it('should add members to a team', () => {
    const manager = new TeamManager()
    const team = manager.create('Test Team', 'architect')
    
    const member = manager.addMember(team.id, 'coder')
    
    expect(member).not.toBeNull()
    expect(member!.id).toMatch(/^member-\d+-\d+$/)
    expect(member!.role).toBe('coder')
    expect(member!.status).toBe('idle')
    // `model` is GONE from `TeamMember`, and this is the pin for its absence:
    // it was stored, required from the caller, and read by nothing. Asserted
    // on the runtime object rather than only on the type, so a `model` that
    // came back through some other path would still fail here.
    expect(Object.keys(member as object).sort()).toEqual(['id', 'role', 'status'])
    
    const updatedTeam = manager.get(team.id)
    expect(updatedTeam!.members.length).toBe(1)
  })

  it('should return null when adding member to non-existent team', () => {
    const manager = new TeamManager()
    const member = manager.addMember('non-existent', 'coder')
    expect(member).toBeNull()
  })

  it('should activate a team', () => {
    const manager = new TeamManager()
    const team = manager.create('Test Team', 'architect')
    
    manager.activate(team.id)
    
    const updatedTeam = manager.get(team.id)
    expect(updatedTeam!.status).toBe('active')
  })

  it('should complete a team', () => {
    const manager = new TeamManager()
    const team = manager.create('Test Team', 'architect')
    
    manager.activate(team.id)
    manager.complete(team.id)
    
    const updatedTeam = manager.get(team.id)
    expect(updatedTeam!.status).toBe('completed')
  })

  it('should get all teams', () => {
    const manager = new TeamManager()
    manager.create('Team 1', 'architect')
    manager.create('Team 2', 'lead')
    
    const teams = manager.getAll()
    expect(teams.length).toBe(2)
  })

  it('should get active team', () => {
    const manager = new TeamManager()
    const team1 = manager.create('Team 1', 'architect')
    const team2 = manager.create('Team 2', 'lead')
    
    manager.activate(team1.id)
    
    const active = manager.getActive()
    expect(active).not.toBeNull()
    expect(active!.id).toBe(team1.id)
  })

  it('should return null when no active team', () => {
    const manager = new TeamManager()
    manager.create('Team 1', 'architect')
    
    const active = manager.getActive()
    expect(active).toBeNull()
  })

  it('should handle multiple members', () => {
    const manager = new TeamManager()
    const team = manager.create('Full Team', 'architect')
    
    manager.addMember(team.id, 'coder')
    manager.addMember(team.id, 'reviewer')
    manager.addMember(team.id, 'tester')
    
    const updatedTeam = manager.get(team.id)
    expect(updatedTeam!.members.length).toBe(3)
    expect(updatedTeam!.members.map(m => m.role)).toEqual(['coder', 'reviewer', 'tester'])
  })
})
