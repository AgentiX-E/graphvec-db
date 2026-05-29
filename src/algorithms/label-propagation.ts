/**
 * Label Propagation Algorithm (LPA)
 *
 * Community detection algorithm. Each node starts with a unique label.
 * Iteratively, each node adopts the most frequent label among its neighbors.
 * Converges when no label changes occur.
 *
 * Self-implemented, ~80 lines.
 */

import { NodeId } from '../types'

export interface LabelPropagationOptions {
  /** Maximum iterations (default: 100) */
  maxIterations?: number
}

export interface LabelPropagationResult {
  /** Map from node ID to community label */
  labels: Map<NodeId, number>
  /** Number of communities found */
  communityCount: number
  /** Iterations performed */
  iterations: number
  /** Whether the algorithm converged */
  converged: boolean
}

/**
 * Run Label Propagation community detection.
 *
 * @param nodeIds - All node IDs
 * @param getNeighbors - Function returning neighbor node IDs
 * @param options - Optional parameters
 * @returns LabelPropagationResult
 */
export function labelPropagation(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
  options?: LabelPropagationOptions,
): LabelPropagationResult {
  const maxIter = options?.maxIterations ?? 100
  if (nodeIds.length === 0) {
    return { labels: new Map(), communityCount: 0, iterations: 0, converged: true }
  }

  // Initialize: each node gets its own ID as label
  const labels = new Map<NodeId, number>()
  for (const id of nodeIds) {
    labels.set(id, id)
  }

  // Pre-compute neighbor lists (exclude self-loops)
  const neighborLists = new Map<NodeId, NodeId[]>()
  for (const id of nodeIds) {
    neighborLists.set(id, getNeighbors(id).filter(n => n !== id))
  }

  let converged = false
  let iter = 0

  for (iter = 0; iter < maxIter; iter++) {
    converged = true

    for (const id of nodeIds) {
      const neighbors = neighborLists.get(id) ?? []
      if (neighbors.length === 0) continue

      // Count label frequencies among neighbors
      const freq = new Map<number, number>()
      for (const nid of neighbors) {
        const lbl = labels.get(nid)!
        freq.set(lbl, (freq.get(lbl) ?? 0) + 1)
      }

      // Find the most frequent label (break ties by picking smallest)
      let bestLabel: number = labels.get(id)!
      let bestCount = freq.get(bestLabel) ?? 0
      for (const [lbl, count] of freq) {
        if (count > bestCount || (count === bestCount && lbl < bestLabel)) {
          bestLabel = lbl
          bestCount = count
        }
      }

      if (labels.get(id) !== bestLabel) {
        labels.set(id, bestLabel)
        converged = false
      }
    }

    if (converged) break
  }

  // Count unique communities
  const uniqueCommunities = new Set(labels.values())

  return {
    labels,
    communityCount: uniqueCommunities.size,
    iterations: iter + 1,
    converged,
  }
}
