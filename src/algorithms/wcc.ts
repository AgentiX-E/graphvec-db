/**
 * Weakly Connected Components (WCC)
 *
 * Uses BFS directly on the graph via getNeighbors, avoiding graphology
 * Graph copy for memory efficiency at scale (100k+ nodes).
 *
 * Time Complexity: O(V + E)
 * Space Complexity: O(V)
 */

import { NodeId } from '../types'

export interface WccResult {
  /** Each component is an array of node IDs */
  components: NodeId[][]
  /** Number of connected components */
  count: number
}

/**
 * Compute weakly connected components using BFS traversal.
 *
 * @param nodeIds - All node IDs in the graph
 * @param getNeighbors - Function that returns neighbor node IDs for a given node
 * @returns WccResult with components array and count
 */
export function wcc(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
): WccResult {
  if (nodeIds.length === 0) {
    return { components: [], count: 0 }
  }

  const visited = new Set<NodeId>()
  const components: NodeId[][] = []

  for (const start of nodeIds) {
    if (visited.has(start)) continue

    // BFS from start
    const component: NodeId[] = []
    const queue: NodeId[] = [start]
    visited.add(start)
    let idx = 0

    while (idx < queue.length) {
      const node = queue[idx++]
      component.push(node)

      for (const neighbor of getNeighbors(node)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
    }

    components.push(component)
  }

  return { components, count: components.length }
}
