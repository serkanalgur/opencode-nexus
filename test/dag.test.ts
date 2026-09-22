import { describe, it, expect } from 'bun:test'
import { detectCycles } from '../src/dag'
import type { DAGNode, Task, ComplexityScore } from '../src/types'

function makeNode(id: string, dependencies: string[] = []): DAGNode {
  const task: Task = {
    id,
    name: `Task ${id}`,
    description: `Description for ${id}`,
    requiredRole: 'coder',
    complexity: { overall: 50, factors: { fileCount: 1, codeLines: 50, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } },
    dependencies,
    files: { include: [`${id}.ts`] },
    priority: 'normal',
    status: 'pending'
  }
  return { id, task, dependencies, status: 'pending' }
}

describe('detectCycles', () => {
  it('should return empty array for a valid DAG with no cycles', () => {
    const nodes: DAGNode[] = [
      makeNode('A'),
      makeNode('B', ['A']),
      makeNode('C', ['A', 'B']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles).toEqual([])
  })

  it('should return empty array for a single node with no dependencies', () => {
    const nodes: DAGNode[] = [makeNode('A')]
    const cycles = detectCycles(nodes)
    expect(cycles).toEqual([])
  })

  it('should return empty array for an empty DAG', () => {
    const cycles = detectCycles([])
    expect(cycles).toEqual([])
  })

  it('should detect a simple 2-node cycle', () => {
    const nodes: DAGNode[] = [
      makeNode('A', ['B']),
      makeNode('B', ['A']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    // The cycle should include both A and B
    const cycle = cycles[0]
    expect(cycle).toContain('A')
    expect(cycle).toContain('B')
    // First and last should be the same (cycle closes)
    expect(cycle[0]).toBe(cycle[cycle.length - 1])
  })

  it('should detect a 3-node cycle (A → B → C → A)', () => {
    const nodes: DAGNode[] = [
      makeNode('A', ['C']),
      makeNode('B', ['A']),
      makeNode('C', ['B']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    const cycle = cycles[0]
    expect(cycle).toContain('A')
    expect(cycle).toContain('B')
    expect(cycle).toContain('C')
    expect(cycle[0]).toBe(cycle[cycle.length - 1])
  })

  it('should detect self-referencing cycle', () => {
    const nodes: DAGNode[] = [
      makeNode('A', ['A']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBe(1)
    expect(cycles[0]).toEqual(['A', 'A'])
  })

  it('should detect multiple independent cycles', () => {
    const nodes: DAGNode[] = [
      makeNode('A', ['B']),
      makeNode('B', ['A']),
      makeNode('C', ['D']),
      makeNode('D', ['C']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBe(2)
  })

  it('should detect cycles in a larger graph', () => {
    // A → B → C → D → B (cycle B-C-D)
    // E is independent
    const nodes: DAGNode[] = [
      makeNode('A', []),
      makeNode('B', ['A', 'D']),
      makeNode('C', ['B']),
      makeNode('D', ['C']),
      makeNode('E', []),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    // At least one cycle should involve B, C, D
    const hasCycleWithBCD = cycles.some(c => c.includes('B') && c.includes('C') && c.includes('D'))
    expect(hasCycleWithBCD).toBe(true)
  })

  it('should not produce false positives on a linear chain', () => {
    const nodes: DAGNode[] = [
      makeNode('A'),
      makeNode('B', ['A']),
      makeNode('C', ['B']),
      makeNode('D', ['C']),
      makeNode('E', ['D']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles).toEqual([])
  })

  it('should not produce false positives on a diamond DAG', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    const nodes: DAGNode[] = [
      makeNode('A'),
      makeNode('B', ['A']),
      makeNode('C', ['A']),
      makeNode('D', ['B', 'C']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles).toEqual([])
  })

  it('should show cycle path in error-friendly format', () => {
    const nodes: DAGNode[] = [
      makeNode('task-1', ['task-2']),
      makeNode('task-2', ['task-1']),
    ]
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBe(1)
    const cycleStr = cycles[0].join(' → ')
    expect(cycleStr).toContain('→')
  })
})
