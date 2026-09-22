export interface ExecutionRecord {
  id: string
  taskId: string
  taskName: string
  role: string
  model: string
  status: 'success' | 'failed' | 'cancelled'
  cost: number
  duration: number
  tokensUsed: number
  startedAt: Date
  completedAt: Date
  error?: string
}

export class ExecutionHistory {
  private records: ExecutionRecord[] = []
  private maxRecords: number

  constructor(maxRecords: number = 500) {
    this.maxRecords = maxRecords
  }

  record(entry: Omit<ExecutionRecord, 'id'>): ExecutionRecord {
    const full: ExecutionRecord = {
      ...entry,
      id: `exec-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
    }
    this.records.push(full)
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords)
    }
    return full
  }

  getAll(): ExecutionRecord[] {
    return [...this.records]
  }

  getRecent(count: number): ExecutionRecord[] {
    return this.records.slice(-count)
  }

  getByRole(role: string): ExecutionRecord[] {
    return this.records.filter(r => r.role === role)
  }

  getByStatus(status: ExecutionRecord['status']): ExecutionRecord[] {
    return this.records.filter(r => r.status === status)
  }

  getStats(): {
    total: number
    successRate: number
    totalCost: number
    avgDuration: number
    byRole: Record<string, number>
  } {
    const total = this.records.length
    const successful = this.records.filter(r => r.status === 'success').length
    const totalCost = this.records.reduce((sum, r) => sum + r.cost, 0)
    const avgDuration = total > 0 ? this.records.reduce((sum, r) => sum + r.duration, 0) / total : 0
    const byRole: Record<string, number> = {}
    for (const r of this.records) {
      byRole[r.role] = (byRole[r.role] || 0) + 1
    }
    return { total, successRate: total > 0 ? successful / total : 0, totalCost, avgDuration, byRole }
  }

  clear(): void {
    this.records = []
  }
}
