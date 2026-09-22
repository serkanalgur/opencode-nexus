import { describe, it, expect, beforeEach } from 'bun:test'
import { TodoEnforcer, TodoItem } from '../src/todo'

describe('TodoEnforcer', () => {
  let enforcer: TodoEnforcer

  beforeEach(() => {
    enforcer = new TodoEnforcer()
  })

  describe('add', () => {
    it('should add a todo item', () => {
      const item = enforcer.add('Implement JWT auth')
      expect(item).toBeDefined()
      expect(item.id).toMatch(/^todo-/)
      expect(item.description).toBe('Implement JWT auth')
      expect(item.status).toBe('pending')
      expect(item.createdAt).toBeInstanceOf(Date)
    })

    it('should add a todo with assigned role', () => {
      const item = enforcer.add('Write tests', 'tester')
      expect(item.assignedTo).toBe('tester')
    })

    it('should generate unique IDs', () => {
      const item1 = enforcer.add('Task 1')
      const item2 = enforcer.add('Task 2')
      expect(item1.id).not.toBe(item2.id)
    })

    it('should respect maxItems limit by evicting oldest completed', () => {
      const smallEnforcer = new TodoEnforcer(3)
      // Fill with completed items
      const i1 = smallEnforcer.add('Done 1')
      smallEnforcer.complete(i1.id)
      const i2 = smallEnforcer.add('Done 2')
      smallEnforcer.complete(i2.id)
      smallEnforcer.add('Pending 1')

      // Adding a 4th should evict the oldest completed
      const i4 = smallEnforcer.add('New task')
      expect(smallEnforcer.getAll().length).toBe(3)
      // The oldest completed (i1) should be evicted
      expect(smallEnforcer.get(i1.id)).toBeUndefined()
      expect(smallEnforcer.get(i2.id)).toBeDefined()
      expect(smallEnforcer.get(i4.id)).toBeDefined()
    })
  })

  describe('start', () => {
    it('should mark item as in_progress', () => {
      const item = enforcer.add('Task')
      enforcer.start(item.id)
      expect(enforcer.get(item.id)?.status).toBe('in_progress')
    })

    it('should not throw for unknown ID', () => {
      expect(() => enforcer.start('nonexistent')).not.toThrow()
    })
  })

  describe('complete', () => {
    it('should mark item as completed', () => {
      const item = enforcer.add('Task')
      enforcer.complete(item.id)
      const completed = enforcer.get(item.id)
      expect(completed?.status).toBe('completed')
      expect(completed?.completedAt).toBeInstanceOf(Date)
    })

    it('should not throw for unknown ID', () => {
      expect(() => enforcer.complete('nonexistent')).not.toThrow()
    })
  })

  describe('block', () => {
    it('should mark item as blocked', () => {
      const item = enforcer.add('Task')
      enforcer.block(item.id)
      expect(enforcer.get(item.id)?.status).toBe('blocked')
    })
  })

  describe('getPending', () => {
    it('should return only pending items', () => {
      const i1 = enforcer.add('Pending')
      const i2 = enforcer.add('In progress')
      enforcer.start(i2.id)

      const pending = enforcer.getPending()
      expect(pending.length).toBe(1)
      expect(pending[0].id).toBe(i1.id)
    })
  })

  describe('getInProgress', () => {
    it('should return only in_progress items', () => {
      const i1 = enforcer.add('Pending')
      const i2 = enforcer.add('Working')
      enforcer.start(i2.id)

      const inProgress = enforcer.getInProgress()
      expect(inProgress.length).toBe(1)
      expect(inProgress[0].id).toBe(i2.id)
    })
  })

  describe('getCompleted', () => {
    it('should return only completed items', () => {
      const i1 = enforcer.add('Done')
      enforcer.complete(i1.id)
      enforcer.add('Pending')

      const completed = enforcer.getCompleted()
      expect(completed.length).toBe(1)
      expect(completed[0].id).toBe(i1.id)
    })
  })

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const i1 = enforcer.add('Pending 1')
      const i2 = enforcer.add('Pending 2')
      const i3 = enforcer.add('Working')
      enforcer.start(i3.id)
      const i4 = enforcer.add('Done')
      enforcer.complete(i4.id)
      const i5 = enforcer.add('Blocked')
      enforcer.block(i5.id)

      const stats = enforcer.getStats()
      expect(stats.total).toBe(5)
      expect(stats.pending).toBe(2)
      expect(stats.inProgress).toBe(1)
      expect(stats.completed).toBe(1)
      expect(stats.blocked).toBe(1)
    })
  })

  describe('clear', () => {
    it('should remove all items', () => {
      enforcer.add('Task 1')
      enforcer.add('Task 2')
      enforcer.clear()
      expect(enforcer.getAll().length).toBe(0)
    })
  })

  describe('trackTask', () => {
    it('should add a task-tracking todo with role prefix', () => {
      const item = enforcer.trackTask('task-123', 'Implement feature', 'coder')
      expect(item.description).toBe('[Task: task-123] Implement feature')
      expect(item.assignedTo).toBe('coder')
    })
  })

  describe('completeTask', () => {
    it('should complete todo by task ID prefix', () => {
      const item = enforcer.trackTask('task-456', 'Run tests', 'tester')
      enforcer.completeTask('task-456')
      expect(enforcer.get(item.id)?.status).toBe('completed')
    })

    it('should not affect unrelated todos', () => {
      const i1 = enforcer.trackTask('task-1', 'Task A', 'coder')
      const i2 = enforcer.trackTask('task-2', 'Task B', 'tester')
      enforcer.completeTask('task-1')
      expect(enforcer.get(i1.id)?.status).toBe('completed')
      expect(enforcer.get(i2.id)?.status).toBe('pending')
    })
  })

  describe('formatAll', () => {
    it('should format empty list', () => {
      expect(enforcer.formatAll()).toBe('📋 No todo items.')
    })

    it('should format items with icons', () => {
      enforcer.add('Pending task')
      const output = enforcer.formatAll()
      expect(output).toContain('📋 Todo:')
      expect(output).toContain('⏳')
      expect(output).toContain('Pending task')
    })
  })
})
