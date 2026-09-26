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

  /**
   * Add to an already-recorded entry's COST fields, in place.
   *
   * THE ARGUMENTS ARE INCREMENTS, not replacements. A record's `cost` is what
   * its task cost; when a late correction arrives, the task's real total is the
   * old figure plus the increment, and a record that ends up holding only the
   * increment is worse than one that was never touched. The invariant this
   * gives is the one worth having: after a timed-out task's session settles,
   * `getStats().totalCost` for that task equals its share of `totalSpent`,
   * because `trackCost` added the same number.
   *
   * WHY ADJUST AND NOT A SECOND `record`. Both this class and
   * `PerformanceTracker` are append-only, and both `record` call sites in
   * `executeTask` discarded the return value — so an append-based correction
   * would double `getStats().totalCost`, show the user two history rows for one
   * task, double `totalTasks` in `getScores` (halving every mean and putting a
   * phantom task into the success-rate denominator), and overstate
   * `measuredTasks`. Adjusting is the only version of this that keeps every
   * count honest.
   *
   * ONLY `cost` and `tokensUsed` ARE TOUCHED. `status`, `duration`,
   * `completedAt` and `error` describe what the task DID, and the task really
   * did complete, or really did fail, at the moment it did. A late cost
   * correction is accounting, not progress: a timed-out task stays `failed`
   * however much it went on to spend afterwards.
   *
   * `costProvenance` is not adjusted either, deliberately. The entry keeps the
   * provenance of the ORIGINAL charge, which is what the entry is a record of;
   * the correction is applied to `trackCost` as its own `measured` entry, so
   * the measured/estimated split of `totalSpent` still accounts for the whole
   * amount. Rewriting the record's provenance instead would make
   * `costSplit` (which sums these records) disagree with `spendSplit` (which
   * sums `trackCost` entries) for no gain.
   *
   * CHANGELOG NOTE, and it is a real one: this makes `ExecutionRecord` values
   * MUTABLE where they were previously write-once, which is a change to the
   * mutability contract of an exported class in the package's public surface.
   * A caller holding a record from `getAll()` will now observe its `cost`
   * change underneath them. `getAll()` already returned the live objects
   * (a shallow copy of the array, not of the records), so the aliasing is not
   * new — but before this, nothing ever wrote through it.
   *
   * Returns `false` for an unknown id. `records` trims to `maxRecords`
   * (500 by default), so eviction is a real possibility and a caller must be
   * able to tell "corrected" from "not there" rather than assume the first.
   */
  adjust(id: string, { cost, tokensUsed }: { cost?: number; tokensUsed?: number }): boolean {
    const record = this.records.find(r => r.id === id)
    if (!record) return false
    if (cost !== undefined) record.cost += cost
    if (tokensUsed !== undefined) record.tokensUsed += tokensUsed
    return true
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
