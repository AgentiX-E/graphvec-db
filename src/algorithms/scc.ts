/**
 * Strongly Connected Components (SCC)
 *
 * Reuses graphology-components' stronglyConnectedComponents function.
 * Builds an in-memory Graph instance, runs the algorithm, returns components.
 * SCC considers edge direction, so only directed edges are added.
 */

import Graph from 'graphology'
import { stronglyConnectedComponents } from 'graphology-components'
import { NodeId } from '../types'

export interface SccResult {
  /** Each component is an array of node IDs */
  components: NodeId[][]
  /** Number of strongly connected components */
  count: number
}

/**
 * Compute strongly connected components.
 *
 * @param nodeIds - All node IDs in the graph
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

  const graph = new Graph({ multi: false, type: 'directed' })

  // Add nodes
  for (const id of nodeIds) {
    graph.addNode(String(id))
  }

  // Add directed edges
  for (const id of nodeIds) {
    const neighbors = getNeighbors(id)
    for (const nid of neighbors) {
      if (graph.hasNode(String(nid)) && !graph.hasEdge(String(id), String(nid))) {
        graph.addDirectedEdge(String(id), String(nid))
      }
    }
  }

  const rawComponents = stronglyConnectedComponents(graph)
  const components = rawComponents.map(comp =>
    comp.map(s => Number(s) as NodeId),
  )

  return { components, count: components.length }
}
