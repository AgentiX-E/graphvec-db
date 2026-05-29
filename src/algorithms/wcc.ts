/**
 * Weakly Connected Components (WCC)
 *
 * Reuses graphology-components' connectedComponents function.
 * Builds an in-memory Graph instance, runs the algorithm, returns components.
 */

import Graph from 'graphology'
import { connectedComponents } from 'graphology-components'
import { NodeId } from '../types'

export interface WccResult {
  /** Each component is an array of node IDs */
  components: NodeId[][]
  /** Number of connected components */
  count: number
}

/**
 * Compute weakly connected components.
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

  const graph = new Graph({ multi: false, type: 'mixed' })

  // Add nodes
  for (const id of nodeIds) {
    graph.addNode(String(id))
  }

  // Add edges (undirected for WCC)
  for (const id of nodeIds) {
    const neighbors = getNeighbors(id)
    for (const nid of neighbors) {
      if (graph.hasNode(String(nid)) && !graph.hasEdge(String(id), String(nid))) {
        graph.addUndirectedEdge(String(id), String(nid))
      }
    }
  }

  const rawComponents = connectedComponents(graph)
  const components = rawComponents.map(comp =>
    comp.map(s => Number(s) as NodeId),
  )

  return { components, count: components.length }
}
