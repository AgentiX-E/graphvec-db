/**
 * Strongly Connected Components (SCC)
 *
 * Uses Tarjan's algorithm directly on the graph via getNeighbors, avoiding
 * graphology Graph copy for memory efficiency at scale (100k+ nodes).
 *
 * Time Complexity: O(V + E)
 * Space Complexity: O(V)
 */

import { NodeId } from '../types'

export interface SccResult {
  /** Each component is an array of node IDs */
  components: NodeId[][]
  /** Number of strongly connected components */
  count: number
}

/**
 * Compute strongly connected components using Tarjan's algorithm.
 *
 * @param nodeIds - All node IDs in the graph (order is preserved for DAG case)
 * @param getNeighbors - Function that returns neighbor node IDs for a given node (directed traversal)
 * @returns SccResult with components array and count
 */
export function scc(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
): SccResult {
  if (nodeIds.length === 0) {
    return { components: [], count: 0 }
  }

  const index = new Map<NodeId, number>()
  const lowlink = new Map<NodeId, number>()
  const onStack = new Set<NodeId>()
  const stack: NodeId[] = []
  const components: NodeId[][] = []

  let currentIndex = 0

  function strongConnect(v: NodeId): void {
    index.set(v, currentIndex)
    lowlink.set(v, currentIndex)
    currentIndex++
    stack.push(v)
    onStack.add(v)

    for (const neighbor of getNeighbors(v)) {
      if (!index.has(neighbor)) {
        // Successor has not yet been visited; recurse on it
        strongConnect(neighbor)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(neighbor)!))
      } else if (onStack.has(neighbor)) {
        // Successor is in stack and hence in the current SCC
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(neighbor)!))
      }
    }

    // If v is a root node, pop the stack and generate an SCC
    if (lowlink.get(v) === index.get(v)) {
      const component: NodeId[] = []
      let w: NodeId | undefined
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      components.push(component)
    }
  }

  for (const id of nodeIds) {
    if (!index.has(id)) {
      strongConnect(id)
    }
  }

  return { components, count: components.length }
}
