import { describe, it, expect, beforeEach } from 'bun:test'
import { LearningModule } from '../src/learning'

describe('LearningModule', () => {
  let learning: LearningModule

  beforeEach(() => {
    // Use low minConfidence for most tests so entries at 0.3 are included
    learning = new LearningModule(0.1)
  })

  describe('recordFailure', () => {
    it('should record a new failure pattern', () => {
      const entry = learning.recordFailure(
        'TypeScript build error: TS2345',
        'Add type cast or fix import',
        'during code review task',
        ['typescript', 'build']
      )

      expect(entry).toBeDefined()
      expect(entry.id).toMatch(/^learn-/)
      expect(entry.pattern).toBe('TypeScript build error: TS2345')
      expect(entry.solution).toBe('Add type cast or fix import')
      expect(entry.context).toBe('during code review task')
      expect(entry.confidence).toBeCloseTo(0.3)
      expect(entry.successCount).toBe(0)
      expect(entry.failCount).toBe(1)
      expect(entry.tags).toEqual(['typescript', 'build'])
    })

    it('should update existing pattern on repeated failure', () => {
      const entry1 = learning.recordFailure(
        'TS2345 error',
        'Fix imports',
        'context'
      )

      const entry2 = learning.recordFailure(
        'TS2345 error',
        'Fix imports',
        'context'
      )

      expect(entry1.id).toBe(entry2.id)
      expect(entry2.failCount).toBe(2)
      expect(entry2.confidence).toBeCloseTo(0.2) // 0.3 - 0.1
    })

    it('should not decrease confidence below 0', () => {
      learning.recordFailure('pattern', 'solution', 'context')
      learning.recordFailure('pattern', 'solution', 'context')
      learning.recordFailure('pattern', 'solution', 'context')
      learning.recordFailure('pattern', 'solution', 'context')
      learning.recordFailure('pattern', 'solution', 'context')

      const entries = learning.getEntries()
      expect(entries.length).toBe(1)
      expect(entries[0].confidence).toBe(0)
    })
  })

  describe('recordSuccess', () => {
    it('should increase confidence on success', () => {
      const entry = learning.recordFailure(
        'Build error',
        'Fix config',
        'during coder task'
      )

      learning.recordSuccess(entry.id)

      const entries = learning.getEntries()
      const updated = entries.find(e => e.id === entry.id)
      expect(updated?.successCount).toBe(1)
      expect(updated?.confidence).toBeCloseTo(0.45) // 0.3 + 0.15
    })

    it('should not exceed confidence of 1.0', () => {
      const entry = learning.recordFailure(
        'pattern',
        'solution',
        'context'
      )

      // Record many successes
      for (let i = 0; i < 10; i++) {
        learning.recordSuccess(entry.id)
      }

      const entries = learning.getEntries()
      const updated = entries.find(e => e.id === entry.id)
      expect(updated?.confidence).toBe(1)
    })

    it('should update lastSeen on success', () => {
      const entry = learning.recordFailure('pattern', 'solution', 'context')
      const before = entry.lastSeen.getTime()

      learning.recordSuccess(entry.id)

      const entries = learning.getEntries()
      const updated = entries.find(e => e.id === entry.id)
      expect(updated?.lastSeen.getTime()).toBeGreaterThanOrEqual(before)
    })

    it('should be a no-op for non-existent entry', () => {
      learning.recordSuccess('non-existent-id')
      // Should not throw
      expect(learning.getStats().total).toBe(0)
    })
  })

  describe('findSolutions', () => {
    it('should find solutions for similar patterns', () => {
      learning.recordFailure(
        'TypeScript error: cannot find module',
        'Check tsconfig paths and import paths',
        'during coder task',
        ['typescript', 'module']
      )

      const matches = learning.findSolutions('TypeScript error: module not found')

      expect(matches.length).toBe(1)
      expect(matches[0].similarity).toBeGreaterThan(0.3)
    })

    it('should not return low-confidence patterns', () => {
      // Use default minConfidence (0.5) for this test
      const strictLearning = new LearningModule(0.5)
      strictLearning.recordFailure('Some error', 'Some solution', 'context')

      const matches = strictLearning.findSolutions('Some error')
      expect(matches.length).toBe(0) // 0.3 < 0.5
    })

    it('should return matches sorted by similarity', () => {
      learning.recordFailure(
        'Python ImportError: cannot import name',
        'Check __init__.py',
        'during coder task'
      )
      learning.recordFailure(
        'Python IndexError: list index out of range',
        'Check list bounds',
        'during coder task'
      )

      const matches = learning.findSolutions('Python ImportError: cannot import')

      expect(matches.length).toBeGreaterThanOrEqual(1)
      // First match should be the most similar
      expect(matches[0].entry.pattern).toContain('ImportError')
    })

    it('should return empty array for no matches', () => {
      learning.recordFailure('TypeScript error', 'Fix it', 'context')
      const matches = learning.findSolutions('Rust compile error')
      expect(matches.length).toBe(0)
    })
  })

  describe('getReliable', () => {
    it('should return only high-confidence entries with successes', () => {
      const entry1 = learning.recordFailure('error1', 'sol1', 'context')
      learning.recordFailure('error2', 'sol2', 'context')

      // Make entry1 reliable
      learning.recordSuccess(entry1.id)
      learning.recordSuccess(entry1.id)

      const reliable = learning.getReliable()
      expect(reliable.length).toBe(1)
      expect(reliable[0].id).toBe(entry1.id)
    })

    it('should sort by confidence descending', () => {
      const entry1 = learning.recordFailure('error1', 'sol1', 'context')
      const entry2 = learning.recordFailure('error2', 'sol2', 'context')

      learning.recordSuccess(entry1.id)
      learning.recordSuccess(entry1.id)
      learning.recordSuccess(entry2.id)

      const reliable = learning.getReliable()
      if (reliable.length >= 2) {
        expect(reliable[0].confidence).toBeGreaterThanOrEqual(reliable[1].confidence)
      }
    })

    it('should return empty array when no reliable entries', () => {
      const reliable = learning.getReliable()
      expect(reliable.length).toBe(0)
    })
  })

  describe('getStats', () => {
    it('should return correct stats', () => {
      learning.recordFailure('error1', 'sol1', 'context')
      learning.recordFailure('error2', 'sol2', 'context')

      const entry1 = learning.getEntries()[0]
      learning.recordSuccess(entry1.id)

      const stats = learning.getStats()
      expect(stats.total).toBe(2)
      expect(stats.reliable).toBeGreaterThanOrEqual(1)
      expect(stats.avgConfidence).toBeGreaterThan(0)
    })

    it('should return zero stats for empty module', () => {
      const stats = learning.getStats()
      expect(stats.total).toBe(0)
      expect(stats.reliable).toBe(0)
      expect(stats.avgConfidence).toBe(0)
    })
  })

  describe('clear', () => {
    it('should clear all entries', () => {
      learning.recordFailure('error1', 'sol1', 'context')
      learning.recordFailure('error2', 'sol2', 'context')

      learning.clear()

      const stats = learning.getStats()
      expect(stats.total).toBe(0)
    })
  })

  describe('getEntries', () => {
    it('should return all entries', () => {
      learning.recordFailure('error1', 'sol1', 'context')
      learning.recordFailure('error2', 'sol2', 'context')

      const entries = learning.getEntries()
      expect(entries.length).toBe(2)
    })
  })

  describe('minConfidence', () => {
    it('should respect custom min confidence', () => {
      const strict = new LearningModule(0.8)
      const entry = strict.recordFailure('error', 'solution', 'context')

      // With minConfidence 0.8, entry at 0.3 should not be returned
      const matches = strict.findSolutions('error')
      expect(matches.length).toBe(0)

      // After enough successes to reach 0.8
      for (let i = 0; i < 4; i++) {
        strict.recordSuccess(entry.id)
      }
      // confidence: 0.3 + 0.15*4 = 0.9
      const matchesAfter = strict.findSolutions('error')
      expect(matchesAfter.length).toBe(1)
    })
  })
})
