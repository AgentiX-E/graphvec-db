/**
 * Closeness Centrality
 *
 * Measures how close a node is to all other nodes in the graph.
 * For each node, BFS is used to compute distances to all reachable nodes.
 * Score = (reachableCount) / (sum of distances to reachable nodes)
 *
 * Reference: https://en.wikipedia.org/wiki/Centrality#Closeness_centrality
 *
 * Time Complexity: O(V * (V + E))
 * Space Complexity: O(V)
 */

import { NodeId } from '../types'

export interface ClosenessOptions {
  /** Whether to normalize by reachable count. Default: true */
  normalize?: boolean
}

/**
 * Compute closeness centrality for all nodes.
 *
 * @param getNeighbors - Function returning neighbor node IDs
 * @param allNodes - All node IDs in the graph
 * @param options - Optional parameters
 * @returns Map from node ID to closeness centrality score
 */
export function closeness(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  options?: ClosenessOptions,
): Map<NodeId, number> {
  const normalize = options?.normalize ?? true
  const scores = new Map<NodeId, number>()

  // Use index lookup for faster neighbor iteration
  const nodeSet = new Set(allNodes)
  const n = allNodes.length

  for (const start of allNodes) {
    // BFS from start to all other nodes
    const distances = new Map<NodeId, number>()
    const queue: NodeId[] = []
    distances.set(start, 0)
    queue.push(start)

    let head = 0
    while (head < queue.length) {
      const current = queue[head++]
      const curDist = distances.get(current)!

      for (const neighbor of getNeighbors(current)) {
        if (!nodeSet.has(neighbor)) continue
        if (!distances.has(neighbor)) {
          distances.set(neighbor, curDist + 1)
          queue.push(neighbor)
        }
      }
    }

    // Sum distances of reachable nodes (excluding self)
    let sumDist = 0
    let reachableCount = 0
    for (const [nodeId, dist] of distances) {
      if (nodeId === start) continue
      sumDist += dist
      reachableCount++
    }

    if (reachableCount === 0) {
      scores.set(start, 0)
    } else if (normalize) {
      // Normalized closeness: (reachableCount) / (sum of distances)
      // This gives a value in [0, 1]
      scores.set(start, reachableCount / sumDist)
    } else {
      // Raw closeness: 1 / (sum of distances)
      // This gives a value in (0, 1]
      scores.set(start, 1 / sumDist)
    }
  }

  return scores
}
