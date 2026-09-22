import type { DAGNode } from "./types"

/**
 * Detect all circular dependencies in a DAG.
 *
 * Uses DFS with a recursion stack to find every cycle, not just the first one.
 * Returns an array of cycles, where each cycle is an array of node IDs
 * representing the circular path (last node connects back to first).
 *
 * @param nodes - Array of DAG nodes to check
 * @returns Array of cycles found, each as a path of node IDs
 */
export function detectCycles(nodes: DAGNode[]): string[][] {
  const cycles: string[][] = []
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const path: string[] = []

  function dfs(nodeId: string) {
    if (inStack.has(nodeId)) {
      // Found a cycle — extract the cycle path
      const cycleStart = path.indexOf(nodeId)
      cycles.push([...path.slice(cycleStart), nodeId])
      return
    }
    if (visited.has(nodeId)) return

    visited.add(nodeId)
    inStack.add(nodeId)
    path.push(nodeId)

    const node = nodes.find(n => n.id === nodeId)
    if (node) {
      for (const depId of node.dependencies) {
        dfs(depId)
      }
    }

    path.pop()
    inStack.delete(nodeId)
  }

  for (const node of nodes) {
    dfs(node.id)
  }

  return cycles
}
