export interface LearningEntry {
  id: string
  pattern: string        // e.g., "TypeScript build error: TS2345"
  solution: string       // e.g., "Add type cast or fix import"
  context: string        // e.g., "during code review task"
  confidence: number     // 0-1, increases with successful reuse
  successCount: number
  failCount: number
  lastSeen: Date
  tags: string[]
}

export interface PatternMatch {
  entry: LearningEntry
  similarity: number    // 0-1
}

export class LearningModule {
  private entries: Map<string, LearningEntry> = new Map()
  private minConfidence: number

  constructor(minConfidence: number = 0.5) {
    this.minConfidence = minConfidence
  }

  /**
   * Record a failure pattern and its solution
   */
  recordFailure(pattern: string, solution: string, context: string, tags: string[] = []): LearningEntry {
    const existing = this.findByPattern(pattern)
    
    if (existing) {
      existing.failCount++
      existing.lastSeen = new Date()
      existing.confidence = Math.max(0, existing.confidence - 0.1)
      return existing
    }

    const entry: LearningEntry = {
      id: `learn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      pattern,
      solution,
      context,
      confidence: 0.3,
      successCount: 0,
      failCount: 1,
      lastSeen: new Date(),
      tags
    }
    this.entries.set(entry.id, entry)
    return entry
  }

  /**
   * Record a successful application of a pattern
   */
  recordSuccess(entryId: string): void {
    const entry = this.entries.get(entryId)
    if (entry) {
      entry.successCount++
      entry.confidence = Math.min(1, entry.confidence + 0.15)
      entry.lastSeen = new Date()
    }
  }

  /**
   * Find solutions for a given error pattern
   */
  findSolutions(errorPattern: string): PatternMatch[] {
    const matches: PatternMatch[] = []
    
    for (const entry of this.entries.values()) {
      if (entry.confidence < this.minConfidence) continue
      
      const similarity = this.calculateSimilarity(errorPattern, entry.pattern)
      if (similarity > 0.3) {
        matches.push({ entry, similarity })
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity)
  }

  /**
   * Get the most reliable solutions
   */
  getReliable(): LearningEntry[] {
    return [...this.entries.values()]
      .filter(e => e.confidence >= this.minConfidence && e.successCount > 0)
      .sort((a, b) => b.confidence - a.confidence)
  }

  /**
   * Get stats about learned patterns
   */
  getStats(): { total: number; reliable: number; avgConfidence: number } {
    const all = [...this.entries.values()]
    const reliable = all.filter(e => e.confidence >= this.minConfidence && e.successCount > 0)
    const avgConfidence = all.length > 0 
      ? all.reduce((sum, e) => sum + e.confidence, 0) / all.length 
      : 0
    return { total: all.length, reliable: reliable.length, avgConfidence }
  }

  /**
   * Get all entries (for inspection/debugging)
   */
  getEntries(): LearningEntry[] {
    return [...this.entries.values()]
  }

  private findByPattern(pattern: string): LearningEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.pattern === pattern) return entry
    }
    return undefined
  }

  private calculateSimilarity(a: string, b: string): number {
    // Simple word-based similarity
    const wordsA = new Set(a.toLowerCase().split(/\s+/))
    const wordsB = new Set(b.toLowerCase().split(/\s+/))
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)))
    const union = new Set([...wordsA, ...wordsB])
    return union.size > 0 ? intersection.size / union.size : 0
  }

  clear(): void {
    this.entries.clear()
  }
}
