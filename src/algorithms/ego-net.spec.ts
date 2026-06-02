import { describe, test, expect } from 'vitest'
import { egoNet, EgoNetOptions } from './ego-net'
import { NodeId } from '../types'

describe('egoNet - Ego Network', () => {
  // ── 测试图 ──
  //   0 ─── 1 ─── 2 ─── 3
  //         │
  //         4
  const neighbors: Record<number, NodeId[]> = {
    0: [1],
    1: [0, 2, 4],
    2: [1, 3],
    3: [2],
    4: [1],
  }
  function getNeighbors(nid: NodeId): NodeId[] {
    return neighbors[nid] ?? []
  }

  const weightedNeighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
    0: [{ nodeId: 1, weight: 1 }],
    1: [{ nodeId: 0, weight: 1 }, { nodeId: 2, weight: 2 }, { nodeId: 4, weight: 3 }],
    2: [{ nodeId: 1, weight: 2 }, { nodeId: 3, weight: 4 }],
    3: [{ nodeId: 2, weight: 4 }],
    4: [{ nodeId: 1, weight: 3 }],
  }
  function getWeightedNeighbors(nid: NodeId) {
    return weightedNeighbors[nid] ?? []
  }

  test('depth 1 from node 1 includes nodes {0,1,2,4}', () => {
    const result = egoNet(getNeighbors, undefined, 1, { depth: 1 })
    expect(result.nodes).toEqual(new Set([0, 1, 2, 4]))
  })

  test('depth 3 from node 0 includes all 5 nodes', () => {
    const result = egoNet(getNeighbors, undefined, 0, { depth: 3 })
    expect(result.nodes).toEqual(new Set([0, 1, 2, 3, 4]))
    expect(result.actualDepth).toBe(3)
  })

  test('depth 0 returns only ego node', () => {
    const result = egoNet(getNeighbors, undefined, 1, { depth: 0 })
    expect(result.nodes).toEqual(new Set([1]))
    expect(result.edges).toHaveLength(0)
  })

  test('depth 1 from node 3 returns {2,3}', () => {
    const result = egoNet(getNeighbors, undefined, 3, { depth: 1 })
    expect(result.nodes).toEqual(new Set([2, 3]))
  })

  test('edges are included correctly', () => {
    const result = egoNet(getNeighbors, undefined, 0, { depth: 1 })
    // neighbors of 0: [1] → subgraph nodes {0,1}, edge {0,1}
    expect(result.nodes).toEqual(new Set([0, 1]))
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toEqual({ src: 0, dst: 1, weight: undefined })
  })

  test('edges include weights when weighted function is provided', () => {
    const result = egoNet(getNeighbors, getWeightedNeighbors, 0, { depth: 1 })
    expect(result.nodes).toEqual(new Set([0, 1]))
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].weight).toBe(1)
  })

  test('excludeEgo works', () => {
    const result = egoNet(getNeighbors, undefined, 1, { depth: 1, includeEgo: false })
    expect(result.nodes).toEqual(new Set([0, 2, 4]))
    expect(result.nodes.has(1)).toBe(false)
  })

  test('includeEdges=false returns no edges', () => {
    const result = egoNet(getNeighbors, undefined, 1, { depth: 1, includeEdges: false })
    expect(result.nodes).toEqual(new Set([0, 1, 2, 4]))
    expect(result.edges).toHaveLength(0)
  })

  test('depth > 0 from isolated node returns just that node', () => {
    const result = egoNet(() => [], undefined, 99, { depth: 3 })
    expect(result.nodes).toEqual(new Set([99]))
    expect(result.edges).toHaveLength(0)
  })

  test('negative depth returns empty', () => {
    const result = egoNet(getNeighbors, undefined, 1, { depth: -1 })
    expect(result.nodes.size).toBe(0)
    expect(result.edges).toHaveLength(0)
  })

  test('large depth does not overshoot', () => {
    const result = egoNet(getNeighbors, undefined, 0, { depth: 100 })
    const allNodes = new Set(Object.keys(neighbors).map(Number))
    expect(result.nodes).toEqual(allNodes)
    expect(result.actualDepth).toBeLessThanOrEqual(100)
  })

  test('directed mode only follows out-edges', () => {
    // In our undirected graph, node 3 only connects to 2
    // In directed mode starting from 3, only 3→2 matters
    const directedNeighbors: Record<number, NodeId[]> = {
      0: [],
      1: [0],
      2: [1, 3],
      3: [2],
      4: [],
    }
    const result = egoNet(
      (nid) => directedNeighbors[nid] ?? [],
      undefined,
      2,
      { depth: 1, directed: true },
    )
    // From 2, following out-edges: {2, 1, 3} (but undirected would also get 0 and 4 via 1)
    expect(result.nodes.has(2)).toBe(true)
    expect(result.nodes.has(1)).toBe(true)
    expect(result.nodes.has(3)).toBe(true)
  })
})
