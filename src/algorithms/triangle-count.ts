/**
 * Triangle Counting
 *
 * Self-implemented using node-iteration method.
 * For each node, check if any pair of its neighbors are also neighbors.
 * Uses a set-based edge lookup for O(d^2) per node.
 */

import { NodeId } from '../types'

export interface TriangleCountResult {
  /** Total number of triangles in the graph */
  count: number
  /** Triangles represented as tuples of 3 node IDs (sorted) */
  triangles: [NodeId, NodeId, NodeId][]
}

/**
 * Count triangles in an undirected graph.
 *
 * @param nodeIds - All node IDs
 * @param getNeighbors - Function returning neighbor node IDs
 * @returns TriangleCountResult with total count and list of triangles
 */
export function triangleCount(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
): TriangleCountResult {
  const triangles: [NodeId, NodeId, NodeId][] = []

  // Build adjacency set for O(1) neighbor checks
  const adjSet = new Map<NodeId, Set<NodeId>>()
  for (const id of nodeIds) {
    adjSet.set(id, new Set())
  }
  for (const id of nodeIds) {
    const neighbors = getNeighbors(id)
    for (const nid of neighbors) {
      if (adjSet.has(nid)) {
        adjSet.get(id)!.add(nid)
      }
    }
  }

  // To avoid counting each triangle 3 times, only count when id < neighbor1 < neighbor2
  const sortedIds = [...nodeIds].sort((a, b) => a - b)
  const idRank = new Map<NodeId, number>()
  sortedIds.forEach((id, idx) => idRank.set(id, idx))

  for (const id of nodeIds) {
    const neighbors = adjSet.get(id)!
    const nbArray = [...neighbors]
    for (let i = 0; i < nbArray.length; i++) {
      const n1 = nbArray[i]
      if ((idRank.get(n1) ?? -1) <= (idRank.get(id) ?? 0)) continue
      for (let j = i + 1; j < nbArray.length; j++) {
        const n2 = nbArray[j]
        if ((idRank.get(n2) ?? -1) <= (idRank.get(n1) ?? 0)) continue
        // Check if n1 and n2 are neighbors
        if (adjSet.get(n1)?.has(n2)) {
          triangles.push([id, n1, n2])
        }
      }
    }
  }

  return { count: triangles.length, triangles }
}
