/**
 * Degree Centrality
 *
 * Measures the number of edges incident upon a node (degree).
 * Normalized: degree / (N - 1) where N is total nodes.
 * Self-implemented, trivial.
 */

import { NodeId } from '../types'

export interface DegreeCentralityOptions {
  /** Whether to normalize by (N - 1). Default: true */
  normalized?: boolean
  /** Direction for directed graphs: 'in' | 'out' | 'all'. Default: 'all' */
  direction?: 'in' | 'out' | 'all'
}

export interface DegreeCentralityResult {
  /** Map from node ID to centrality score */
  scores: Map<NodeId, number>
}

/**
 * Compute degree centrality for all nodes.
 *
 * @param nodeIds - All node IDs
 * @param getNeighbors - Function returning neighbor node IDs (for 'all'/'out')
 * @param getInNeighbors - Optional function returning in-neighbors (for 'in' direction)
 * @param options - Optional parameters
 * @returns DegreeCentralityResult
 */
export function degreeCentrality(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
  getInNeighbors?: (nodeId: NodeId) => NodeId[],
  options?: DegreeCentralityOptions,
): DegreeCentralityResult {
  const normalized = options?.normalized ?? true
  const direction = options?.direction ?? 'all'
  const n = nodeIds.length
  const divisor = normalized && n > 1 ? n - 1 : 1

  const scores = new Map<NodeId, number>()

  for (const id of nodeIds) {
    let degree = 0
    if (direction === 'all' || direction === 'out') {
      degree += getNeighbors(id).length
    }
    if ((direction === 'all' || direction === 'in') && getInNeighbors) {
      degree += getInNeighbors(id).length
    } else if (direction === 'in' && !getInNeighbors) {
      // If no in-neighbor function given for 'in' direction, use getNeighbors as fallback
      degree += getNeighbors(id).length
    }
    scores.set(id, degree / divisor)
  }

  return { scores }
}
