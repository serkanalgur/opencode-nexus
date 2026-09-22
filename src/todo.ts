export interface TodoItem {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  assignedTo?: string
  createdAt: Date
  completedAt?: Date
}

export class TodoEnforcer {
  private items: Map<string, TodoItem> = new Map()
  private maxItems: number

  constructor(maxItems: number = 50) {
    this.maxItems = maxItems
  }

  add(description: string, assignedTo?: string): TodoItem {
    // Enforce max items limit
    if (this.items.size >= this.maxItems) {
      // Remove oldest completed items first
      const completedItems = [...this.items.values()]
        .filter(i => i.status === 'completed')
        .sort((a, b) => (a.completedAt?.getTime() || 0) - (b.completedAt?.getTime() || 0))

      if (completedItems.length > 0) {
        this.items.delete(completedItems[0].id)
      } else {
        // No completed items to evict — evict oldest pending
        const oldestPending = [...this.items.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        if (oldestPending.length > 0) {
          this.items.delete(oldestPending[0].id)
        }
      }
    }

    const item: TodoItem = {
      id: `todo-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      description,
      status: 'pending',
      assignedTo,
      createdAt: new Date()
    }
    this.items.set(item.id, item)
    return item
  }

  start(id: string): void {
    const item = this.items.get(id)
    if (item) item.status = 'in_progress'
  }

  complete(id: string): void {
    const item = this.items.get(id)
    if (item) {
      item.status = 'completed'
      item.completedAt = new Date()
    }
  }

  block(id: string): void {
    const item = this.items.get(id)
    if (item) item.status = 'blocked'
  }

  get(id: string): TodoItem | undefined {
    return this.items.get(id)
  }

  getPending(): TodoItem[] {
    return [...this.items.values()].filter(i => i.status === 'pending')
  }

  getInProgress(): TodoItem[] {
    return [...this.items.values()].filter(i => i.status === 'in_progress')
  }

  getCompleted(): TodoItem[] {
    return [...this.items.values()].filter(i => i.status === 'completed')
  }

  getAll(): TodoItem[] {
    return [...this.items.values()]
  }

  getStats(): { total: number; pending: number; inProgress: number; completed: number; blocked: number } {
    const all = [...this.items.values()]
    return {
      total: all.length,
      pending: all.filter(i => i.status === 'pending').length,
      inProgress: all.filter(i => i.status === 'in_progress').length,
      completed: all.filter(i => i.status === 'completed').length,
      blocked: all.filter(i => i.status === 'blocked').length
    }
  }

  clear(): void {
    this.items.clear()
  }

  /**
   * Auto-add a todo when a task is spawned
   */
  trackTask(taskId: string, description: string, role: string): TodoItem {
    return this.add(`[Task: ${taskId}] ${description}`, role)
  }

  /**
   * Complete the todo associated with a task
   */
  completeTask(taskId: string): void {
    for (const item of this.items.values()) {
      if (item.description.startsWith(`[Task: ${taskId}]`)) {
        this.complete(item.id)
        break
      }
    }
  }

  /**
   * Format all todos as a readable string
   */
  formatAll(): string {
    const all = this.getAll()
    if (all.length === 0) return '📋 No todo items.'

    const statusIcon: Record<string, string> = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      blocked: '🚫'
    }

    const lines = all.map(item => {
      const icon = statusIcon[item.status] || '❓'
      const assigned = item.assignedTo ? ` (${item.assignedTo})` : ''
      const time = item.completedAt
        ? `completed ${item.completedAt.toISOString()}`
        : `created ${item.createdAt.toISOString()}`
      return `  ${icon} ${item.id}: ${item.description}${assigned} — ${time}`
    })

    const stats = this.getStats()
    const summary = `📋 Todo: ${stats.total} total | ⏳ ${stats.pending} pending | 🔄 ${stats.inProgress} in progress | ✅ ${stats.completed} completed | 🚫 ${stats.blocked} blocked`

    return `${summary}\n\n${lines.join('\n')}`
  }
}
