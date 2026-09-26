import type { CostProvenance } from "./types"

export interface PerformanceEntry {
  /**
   * Stable identity for the entry, so a later cost correction can find and
   * ADJUST it rather than append a second one. `ExecutionRecord` has had an id
   * for the same reason; this class did not, and appending a correction here
   * would double `totalTasks` (halving every mean and putting a phantom task
   * into the success-rate denominator) and overstate `measuredTasks`.
   */
  readonly id: string
  model: string
  role: string
  success: boolean
  duration: number
  cost: number
  /**
   * Required, not defaulted: 30% of a model's `overallScore` is derived from
   * its costs, so an entry that does not say whether its numbers were real is
   * an entry that can move a ranking on a guess. Same rule as
   * `NexusOrchestrator.trackCost`.
   */
  costProvenance: CostProvenance
  tokensUsed: number
  timestamp: Date
}

/**
 * Whether a score's cost terms were computed from real figures.
 *
 * `measured` — at least one entry carried a real token count; `costEfficiency`
 * and the cost third of `overallScore` come from the measured subset only.
 *
 * `none` — every entry in the group was predicted. The cost terms carry no
 * evidence, and `costEfficiency` is `0` as a stated absence of signal, NOT as
 * a measurement of an expensive model. This is the state that keeps
 * "we could not measure it" from being read as "we measured it and it was
 * bad", which is what a bare `0` would say.
 */
export type CostBasis = 'measured' | 'none'

export interface PerformanceScore {
  model: string
  role: string
  totalTasks: number
  successRate: number
  avgDuration: number
  /**
   * Mean of EVERY entry's cost, measured or not. Retained unchanged so existing
   * consumers keep working; it is a mean of recorded charges, and provenance
   * is reported separately rather than folded into the figure.
   */
  avgCost: number
  costEfficiency: number  // measured successes per measured dollar
  overallScore: number     // 0-100 weighted composite
  /** How many of `totalTasks` were measured. Coverage of the cost terms. */
  measuredTasks: number
  /** How many of `totalTasks` were predicted. `measuredTasks + estimatedTasks === totalTasks`. */
  estimatedTasks: number
  /** Whether the cost terms rest on measurements. See `CostBasis`. */
  costBasis: CostBasis
}

export class PerformanceTracker {
  private entries: PerformanceEntry[] = []
  private maxEntries: number

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries
  }

  /**
   * Record one observation. Returns its `id`, which is what `adjust` needs.
   *
   * CHANGELOG NOTE: this used to return `void`. Widening a return type is
   * source-compatible for every existing caller, so nothing that compiled
   * before stops compiling.
   */
  record(entry: Omit<PerformanceEntry, 'id' | 'timestamp'>): string {
    const id = `perf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
    this.entries.push({ ...entry, id, timestamp: new Date() })
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
    return id
  }

  /**
   * Add to an already-recorded entry's COST, in place. THE ARGUMENT IS AN
   * INCREMENT, not a replacement — the same rule and the same reason as
   * `ExecutionHistory.adjust`: an entry's cost is what its task cost, and a
   * late correction makes that the old figure plus the increment.
   *
   * See `ExecutionHistory.adjust` for why adjustment rather than a second
   * entry, and for why only the cost fields are touched: `success`, `duration`
   * and `timestamp` describe what the task did, and a late cost correction is
   * accounting rather than progress.
   *
   * `costProvenance` is left as the ORIGINAL charge's, so the measured/estimated
   * split in `getScores` still describes what was measured — and because the
   * correction is applied through the orchestrator's `trackCost` as its own
   * `measured` entry, `totalSpent` accounts for the whole amount either way.
   *
   * CHANGELOG NOTE, and it is a real one: `PerformanceEntry` values are now
   * MUTABLE where they were previously write-once. `getScores` does not expose
   * entries, so there is no live-object exposure through this class's own API,
   * but it is a change to the mutability contract of an exported type in the
   * package's public surface and is called out rather than slipped in.
   *
   * A SIDE EFFECT WORTH NAMING, because it is correct and surprising: this
   * moves `overallScore`, and so can change the answer `getBestModel` returns
   * minutes after it was consulted. The model really did cost that money, so
   * the new ranking is the accurate one — but anything caching a ranking needs
   * to know it can move.
   *
   * Returns `false` for an unknown id: `entries` trims to `maxEntries` (1000
   * by default), so eviction is real and a caller must be able to tell
   * "corrected" from "not there".
   */
  adjust(id: string, { cost }: { cost?: number }): boolean {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return false
    if (cost !== undefined) entry.cost += cost
    return true
  }

  /**
   * Get performance scores grouped by model+role
   *
   * The cost terms are computed from MEASURED entries only. A predicted cost is
   * the forecaster's guess at a token count we never saw, and 30% of a model's
   * score is too much weight to put on a guess — worse, `costScore` saturates
   * at 1, so a group whose recorded costs are mostly cheap estimates pinned at
   * a perfect cost score and the ceiling hid it, making a model with no cost
   * evidence at all indistinguishable from a genuinely cheap one. Excluding
   * them removes the guess from the ranking; the counters below say how thin
   * the remaining evidence is, so a score from one measurement is visibly not
   * the same kind of object as a score from fifty.
   *
   * SUCCESS AND SPEED ARE UNAFFECTED: `successRate` and `speedScore` are
   * computed over every entry exactly as before. Only the cost terms narrow,
   * and only to what was actually billed.
   *
   * NO MEASURED ENTRIES — the cost term contributes 0 and `costBasis` is
   * `none`. The alternative, re-weighting the 40 success points and 30 speed
   * points up to fill the vacated 30, keeps the arithmetic finite and is the
   * tidier-looking option, but it makes `overallScore` mean two different
   * things: 100 points when a group has cost evidence, 70 renormalised when it
   * does not. `getBestModel` and `getScores` rank on that number, so a group
   * with no cost evidence would outrank a fully measured group that merely
   * looked expensive — a ranking decided by which sessions happened to be
   * readable, which is exactly the failure the provenance discipline exists to
   * prevent. Holding the scale fixed instead charges a group for its missing
   * measurement, which is a real and visible cost: `estimatedTasks` and
   * `costBasis` say why it was charged. A `0` cost term is also not a zero or
   * perfect cost score by accident — it is the documented absence, and
   * `costBasis` is what distinguishes it from a measurement of $0.
   */
  getScores(): PerformanceScore[] {
    const groups = new Map<string, PerformanceEntry[]>()
    for (const entry of this.entries) {
      const key = `${entry.model}::${entry.role}`
      const group = groups.get(key) || []
      group.push(entry)
      groups.set(key, group)
    }

    const scores: PerformanceScore[] = []
    for (const [key, entries] of groups) {
      const [model, role] = key.split('::')
      const total = entries.length
      const successful = entries.filter(e => e.success).length
      const successRate = total > 0 ? successful / total : 0
      const avgDuration = entries.reduce((s, e) => s + e.duration, 0) / total
      const avgCost = entries.reduce((s, e) => s + e.cost, 0) / total

      // Cost terms, restricted to real token counts. Success is re-read WITHIN
      // that subset rather than paired with the all-entries success rate: a
      // rate over all tasks divided by a cost over measured tasks would mix two
      // populations into one "successes per dollar" figure.
      const measured = entries.filter(e => e.costProvenance.usage === 'measured')
      const measuredTasks = measured.length
      const estimatedTasks = total - measuredTasks
      const measuredSuccessRate = measuredTasks > 0
        ? measured.filter(e => e.success).length / measuredTasks
        : 0
      const measuredAvgCost = measuredTasks > 0
        ? measured.reduce((s, e) => s + e.cost, 0) / measuredTasks
        : 0
      const costEfficiency = measuredAvgCost > 0 ? measuredSuccessRate / measuredAvgCost : 0

      // Weighted composite: 40% success, 30% speed, 30% cost efficiency.
      // Unchanged arithmetic; with no measured entries `costEfficiency` is 0,
      // so the cost third contributes 0 and the total stays finite.
      const speedScore = Math.max(0, 1 - avgDuration / 30000)  // Normalize to 30s
      const costScore = Math.min(1, costEfficiency * 100)
      const overallScore = (successRate * 40) + (speedScore * 30) + (costScore * 30)

      scores.push({
        model,
        role,
        totalTasks: total,
        successRate,
        avgDuration,
        avgCost,
        costEfficiency,
        overallScore,
        measuredTasks,
        estimatedTasks,
        costBasis: measuredTasks > 0 ? 'measured' : 'none',
      })
    }

    return scores.sort((a, b) => b.overallScore - a.overallScore)
  }

  /**
   * Get best model for a role
   */
  getBestModel(role: string): PerformanceScore | null {
    const scores = this.getScores().filter(s => s.role === role)
    return scores[0] || null
  }

  /**
   * Get stats summary
   */
  getStats(): { totalEntries: number; uniqueCombinations: number; avgSuccessRate: number } {
    const unique = new Set(this.entries.map(e => `${e.model}::${e.role}`))
    const successRate = this.entries.length > 0 ? this.entries.filter(e => e.success).length / this.entries.length : 0
    return { totalEntries: this.entries.length, uniqueCombinations: unique.size, avgSuccessRate: successRate }
  }

  clear(): void {
    this.entries = []
  }
}
