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

  // Every neighbor in adjSet is guaranteed to be a member of nodeIds (the
  // adjSet construction filters via `adjSet.has(nid)`), so rank lookups are
  // total — no need for `?? -1` fallbacks here.
  const rankOf = (id: NodeId): number => idRank.get(id)!

  for (const id of nodeIds) {
    const neighbors = adjSet.get(id)!
    // Sort neighbors by rank so the n1 < n2 invariant holds regardless of the
    // order in which getNeighbors returns neighbors. Without this, an unordered
    // neighbor list can miss triangles (the i<j position check would skip valid
    // pairs whose rank order is reversed in the input).
    const nbArray = [...neighbors].sort(
      (a, b) => rankOf(a) - rankOf(b),
    )
    for (let i = 0; i < nbArray.length; i++) {
      const n1 = nbArray[i]
      if (rankOf(n1) <= rankOf(id)) continue
      for (let j = i + 1; j < nbArray.length; j++) {
        const n2 = nbArray[j]
        // nbArray is sorted by rank above, so rankOf(n2) > rankOf(n1) is
        // already guaranteed for all j > i — no redundant rank re-check needed.
        // Check if n1 and n2 are neighbors. n1 is itself a member of adjSet
        // (it came from the neighbor list), so the lookup is total.
        if (adjSet.get(n1)!.has(n2)) {
          triangles.push([id, n1, n2])
        }
      }
    }
  }

  return { count: triangles.length, triangles }
}
