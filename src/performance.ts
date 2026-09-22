export interface PerformanceEntry {
  model: string
  role: string
  success: boolean
  duration: number
  cost: number
  tokensUsed: number
  timestamp: Date
}

export interface PerformanceScore {
  model: string
  role: string
  totalTasks: number
  successRate: number
  avgDuration: number
  avgCost: number
  costEfficiency: number  // success per dollar
  overallScore: number     // 0-100 weighted composite
}

export class PerformanceTracker {
  private entries: PerformanceEntry[] = []
  private maxEntries: number

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries
  }

  record(entry: Omit<PerformanceEntry, 'timestamp'>): void {
    this.entries.push({ ...entry, timestamp: new Date() })
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
  }

  /**
   * Get performance scores grouped by model+role
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
      const costEfficiency = avgCost > 0 ? successRate / avgCost : 0

      // Weighted composite: 40% success, 30% speed, 30% cost efficiency
      const speedScore = Math.max(0, 1 - avgDuration / 30000)  // Normalize to 30s
      const costScore = Math.min(1, costEfficiency * 100)
      const overallScore = (successRate * 40) + (speedScore * 30) + (costScore * 30)

      scores.push({ model, role, totalTasks: total, successRate, avgDuration, avgCost, costEfficiency, overallScore })
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
