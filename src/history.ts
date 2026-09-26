import type { CostProvenance } from "./types"

export interface ExecutionRecord {
  id: string
  taskId: string
  taskName: string
  role: string
  model: string
  status: 'success' | 'failed' | 'cancelled'
  cost: number
  /**
   * Required, not defaulted: a persisted record whose cost does not say whether
   * it was measured or predicted is read as a bill by every consumer that sees
   * it, and the history tool renders one of these per task. A default here
   * would be a guess presented as a fact.
   */
  costProvenance: CostProvenance
  duration: number
  tokensUsed: number
  startedAt: Date
  completedAt: Date
  error?: string
}

/** The measured/estimated split of a set of records' costs. */
export interface HistoryCostSplit {
  measuredCost: number
  estimatedCost: number
  measuredEntries: number
  estimatedEntries: number
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
    /**
     * Split of `totalCost` over the same records. `totalCost` is the sum of
     * mixed charges and stays as it is for existing consumers, but it is no
     * longer the only thing a caller can read: the split says how much of it
     * was a prediction.
     */
    costSplit: HistoryCostSplit
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
    const costSplit: HistoryCostSplit = this.records.reduce<HistoryCostSplit>(
      (split, r) => {
        if (r.costProvenance.usage === 'measured') {
          split.measuredCost += r.cost
          split.measuredEntries++
        } else {
          split.estimatedCost += r.cost
          split.estimatedEntries++
        }
        return split
      },
      { measuredCost: 0, estimatedCost: 0, measuredEntries: 0, estimatedEntries: 0 }
    )
    return { total, successRate: total > 0 ? successful / total : 0, totalCost, costSplit, avgDuration, byRole }
  }

  clear(): void {
    this.records = []
  }
}
