import { describe, it, expect, beforeEach } from 'bun:test'
import { GoalManager } from '../src/goal'

describe('GoalManager', () => {
  let manager: GoalManager

  beforeEach(() => {
    manager = new GoalManager()
  })

  describe('set', () => {
    it('should create a new goal with active status', () => {
      const goal = manager.set('Build user authentication')
      expect(goal.status).toBe('active')
      expect(goal.description).toBe('Build user authentication')
      expect(goal.id).toMatch(/^goal-\d+-\d+$/)
      expect(goal.tasks).toEqual([])
      expect(goal.autoContinue).toBe(true)
      expect(goal.createdAt).toBeInstanceOf(Date)
    })

    it('should set autoContinue to false when specified', () => {
      const goal = manager.set('Explore codebase', false)
      expect(goal.autoContinue).toBe(false)
    })

    it('should default autoContinue to true', () => {
      const goal = manager.set('Some goal')
      expect(goal.autoContinue).toBe(true)
    })

    it('should set the new goal as active', () => {
      manager.set('First goal')
      const active = manager.getActive()
      expect(active).not.toBeNull()
      expect(active!.description).toBe('First goal')
    })

    it('should complete the previous active goal when setting a new one', () => {
      const first = manager.set('First goal')
      const second = manager.set('Second goal')
      expect(first.status).toBe('completed')
      expect(first.completedAt).toBeInstanceOf(Date)
      expect(second.status).toBe('active')
      expect(manager.getActive()?.id).toBe(second.id)
    })
  })

  describe('addTask', () => {
    it('should add a task to a goal', () => {
      const goal = manager.set('Build auth')
      manager.addTask(goal.id, 'task-001')
      manager.addTask(goal.id, 'task-002')
      expect(goal.tasks).toEqual(['task-001', 'task-002'])
    })

    it('should silently ignore unknown goal ID', () => {
      manager.addTask('goal-nonexistent', 'task-001')
      // Should not throw
    })
  })

  describe('complete', () => {
    it('should mark goal as completed with completedAt', () => {
      const goal = manager.set('Build auth')
      manager.complete(goal.id)
      expect(goal.status).toBe('completed')
      expect(goal.completedAt).toBeInstanceOf(Date)
    })

    it('should silently ignore unknown goal ID', () => {
      manager.complete('goal-nonexistent')
      // Should not throw
    })
  })

  describe('pause and resume', () => {
    it('should pause an active goal', () => {
      const goal = manager.set('Build auth')
      manager.pause(goal.id)
      expect(goal.status).toBe('paused')
    })

    it('should resume a paused goal', () => {
      const goal = manager.set('Build auth')
      manager.pause(goal.id)
      manager.resume(goal.id)
      expect(goal.status).toBe('active')
    })
  })

  describe('getActive', () => {
    it('should return null when no goals exist', () => {
      expect(manager.getActive()).toBeNull()
    })

    it('should return the active goal', () => {
      const goal = manager.set('Build auth')
      expect(manager.getActive()?.id).toBe(goal.id)
    })

    it('should return null after goal is completed', () => {
      const goal = manager.set('Build auth')
      manager.complete(goal.id)
      expect(manager.getActive()).toBeNull()
    })
  })

  describe('getAll', () => {
    it('should return empty array when no goals', () => {
      expect(manager.getAll()).toEqual([])
    })

    it('should return all goals', () => {
      manager.set('Goal 1')
      manager.set('Goal 2')
      const goals = manager.getAll()
      expect(goals.length).toBe(2)
      // First goal should be completed (superseded by second)
      expect(goals[0].status).toBe('completed')
      expect(goals[1].status).toBe('active')
    })
  })

  describe('shouldContinue', () => {
    it('should return false when no active goal', () => {
      expect(manager.shouldContinue()).toBe(false)
    })

    it('should return true when active goal has autoContinue enabled', () => {
      manager.set('Build auth', true)
      expect(manager.shouldContinue()).toBe(true)
    })

    it('should return false when active goal has autoContinue disabled', () => {
      manager.set('Build auth', false)
      expect(manager.shouldContinue()).toBe(false)
    })

    it('should return false when goal is paused', () => {
      const goal = manager.set('Build auth', true)
      manager.pause(goal.id)
      expect(manager.shouldContinue()).toBe(false)
    })

    it('should return false when goal is completed', () => {
      const goal = manager.set('Build auth', true)
      manager.complete(goal.id)
      expect(manager.shouldContinue()).toBe(false)
    })
  })

  describe('get', () => {
    it('should return a goal by ID', () => {
      const goal = manager.set('Build auth')
      expect(manager.get(goal.id)?.description).toBe('Build auth')
    })

    it('should return undefined for unknown ID', () => {
      expect(manager.get('goal-nonexistent')).toBeUndefined()
    })
  })
})
