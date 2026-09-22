// Goal tracking system for persistent objectives and auto-continuation

export interface Goal {
  id: string
  description: string
  status: 'active' | 'completed' | 'paused' | 'cancelled'
  tasks: string[]  // related task IDs
  createdAt: Date
  completedAt?: Date
  autoContinue: boolean
}

let goalCounter = 0

export class GoalManager {
  private goals: Map<string, Goal> = new Map()
  private activeGoalId: string | null = null

  set(description: string, autoContinue: boolean = true): Goal {
    // Complete any existing active goal
    if (this.activeGoalId) {
      const prev = this.goals.get(this.activeGoalId)
      if (prev && prev.status === 'active') {
        prev.status = 'completed'
        prev.completedAt = new Date()
      }
    }

    const goal: Goal = {
      id: `goal-${Date.now()}-${++goalCounter}`,
      description,
      status: 'active',
      tasks: [],
      createdAt: new Date(),
      autoContinue
    }
    this.goals.set(goal.id, goal)
    this.activeGoalId = goal.id
    return goal
  }

  addTask(goalId: string, taskId: string): void {
    const goal = this.goals.get(goalId)
    if (goal) goal.tasks.push(taskId)
  }

  complete(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal) {
      goal.status = 'completed'
      goal.completedAt = new Date()
      if (this.activeGoalId === goalId) {
        this.activeGoalId = null
      }
    }
  }

  pause(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal) goal.status = 'paused'
  }

  resume(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal) goal.status = 'active'
  }

  getActive(): Goal | null {
    if (!this.activeGoalId) return null
    const goal = this.goals.get(this.activeGoalId)
    if (!goal || goal.status !== 'active') return null
    return goal
  }

  getAll(): Goal[] {
    return [...this.goals.values()]
  }

  shouldContinue(): boolean {
    const active = this.getActive()
    return active?.autoContinue === true && active.status === 'active'
  }

  get(goalId: string): Goal | undefined {
    return this.goals.get(goalId)
  }
}
