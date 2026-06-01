// ============================================================
// query-engine.spec.ts — Variable-Length Path Query Engine Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  findVarlenPaths,
  findPaths,
  parseVarlenSpec,
  parseVarlenEdgeLabel,
  extractEndpoints,
  flattenPaths,
  VarlenRange,
} from './query-engine'
import { NodeRecord, EdgeRecord } from '../types'

// ──────────────────────────────────────────
// Mock ShardManager
// ──────────────────────────────────────────

/**
 * Creates a chain graph: 1 → 2 → 3 → 4 → 5
 * Edges: (1→2), (2→3), (3→4), (4→5)
 */
function createChainGraph(): Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }> {
  const graph = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()

  graph.set(1, {
    nodes: [
      { id: 2, type: 1, name: 'node2', props: {} },
    ],
    edges: [
      { src: 1, dst: 2, type: 10, props: {} },
    ],
  })

  graph.set(2, {
    nodes: [
      { id: 3, type: 1, name: 'node3', props: {} },
    ],
    edges: [
      { src: 2, dst: 3, type: 10, props: {} },
    ],
  })

  graph.set(3, {
    nodes: [
      { id: 4, type: 1, name: 'node4', props: {} },
    ],
    edges: [
      { src: 3, dst: 4, type: 10, props: {} },
    ],
  })

  graph.set(4, {
    nodes: [
      { id: 5, type: 1, name: 'node5', props: {} },
    ],
    edges: [
      { src: 4, dst: 5, type: 10, props: {} },
    ],
  })

  graph.set(5, {
    nodes: [],
    edges: [],
  })

  return graph
}

/**
 * Creates a star/fan-out graph: 1 → 2, 1 → 3, 1 → 4, 2 → 5, 3 → 5, 4 → 5
 */
function createStarGraph(): Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }> {
  const graph = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()

  graph.set(1, {
    nodes: [
      { id: 2, type: 1, name: 'node2', props: {} },
      { id: 3, type: 1, name: 'node3', props: {} },
      { id: 4, type: 1, name: 'node4', props: {} },
    ],
    edges: [
      { src: 1, dst: 2, type: 10, props: {} },
      { src: 1, dst: 3, type: 10, props: {} },
      { src: 1, dst: 4, type: 10, props: {} },
    ],
  })

  graph.set(2, {
    nodes: [
      { id: 5, type: 1, name: 'node5', props: {} },
    ],
    edges: [
      { src: 2, dst: 5, type: 10, props: {} },
    ],
  })

  graph.set(3, {
    nodes: [
      { id: 5, type: 1, name: 'node5', props: {} },
    ],
    edges: [
      { src: 3, dst: 5, type: 10, props: {} },
    ],
  })

  graph.set(4, {
    nodes: [
      { id: 5, type: 1, name: 'node5', props: {} },
    ],
    edges: [
      { src: 4, dst: 5, type: 10, props: {} },
    ],
  })

  graph.set(5, { nodes: [], edges: [] })

  return graph
}

/**
 * Creates a graph with a cycle: 1 → 2 → 3 → 1
 */
function createCyclicGraph(): Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }> {
  const graph = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()

  graph.set(1, {
    nodes: [{ id: 2, type: 1, name: 'node2', props: {} }],
    edges: [{ src: 1, dst: 2, type: 10, props: {} }],
  })

  graph.set(2, {
    nodes: [{ id: 3, type: 1, name: 'node3', props: {} }],
    edges: [{ src: 2, dst: 3, type: 10, props: {} }],
  })

  graph.set(3, {
    nodes: [{ id: 1, type: 1, name: 'node1', props: {} }],
    edges: [{ src: 3, dst: 1, type: 10, props: {} }],
  })

  return graph
}

/**
 * Creates a simple two-node graph: 1 → 2 (single edge)
 */
function createSimpleGraph(): Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }> {
  const graph = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()

  graph.set(1, {
    nodes: [{ id: 2, type: 1, name: 'node2', props: {} }],
    edges: [{ src: 1, dst: 2, type: 10, props: {} }],
  })

  graph.set(2, { nodes: [], edges: [] })

  return graph
}

/**
 * Creates an isolated node graph: only node 1, no edges
 */
function createIsolatedGraph(): Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }> {
  const graph = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()

  graph.set(1, { nodes: [], edges: [] })

  return graph
}

// Build a mock ShardManager from a predefined adjacency graph
function buildMockManager(
  adjacency: Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>,
) {
  return {
    neighbors: async (
      id: number,
      opts?: { maxDepth?: number; edgeTypeFilter?: number[] },
    ): Promise<{ nodes: NodeRecord[]; edges: EdgeRecord[] }> => {
      const entry = adjacency.get(id)
      if (!entry) return { nodes: [], edges: [] }

      let edges = entry.edges

      // Apply edge type filter if specified
      if (opts?.edgeTypeFilter && opts.edgeTypeFilter.length > 0) {
        edges = edges.filter(e => opts.edgeTypeFilter!.includes(e.type))
      }

      // Filter nodes to only those reachable via the filtered edges
      const reachableIds = new Set(edges.map(e => e.dst))
      const nodes = entry.nodes.filter(n => reachableIds.has(n.id))

      return { nodes, edges }
    },
  } as any
}

// ──────────────────────────────────────────
// parseVarlenSpec Tests
// ──────────────────────────────────────────

describe('parseVarlenSpec', () => {
  it('parses empty string as min=1 default max', () => {
    const result = parseVarlenSpec('')
    expect(result.min).toBe(1)
    expect(result.max).toBe(5) // DEFAULT_UNBOUNDED_MAX_DEPTH
  })

  it('parses *N as exact N', () => {
    const result = parseVarlenSpec('3')
    expect(result.min).toBe(3)
    expect(result.max).toBe(3)
  })

  it('parses *N..M as range', () => {
    const result = parseVarlenSpec('1..3')
    expect(result.min).toBe(1)
    expect(result.max).toBe(3)
  })

  it('parses *0..5 as range starting from 0', () => {
    const result = parseVarlenSpec('0..5')
    expect(result.min).toBe(0)
    expect(result.max).toBe(5)
  })

  it('parses *N.. as unbounded max', () => {
    const result = parseVarlenSpec('1..')
    expect(result.min).toBe(1)
    expect(result.max).toBeGreaterThanOrEqual(50) // ABSOLUTE_MAX_DEPTH
  })

  it('parses *..M as min=1, max=M', () => {
    const result = parseVarlenSpec('..3')
    expect(result.min).toBe(1)
    expect(result.max).toBe(3)
  })

  it('caps max to ABSOLUTE_MAX_DEPTH', () => {
    const result = parseVarlenSpec('1..999')
    expect(result.min).toBe(1)
    expect(result.max).toBeLessThanOrEqual(50)
  })
})

// ──────────────────────────────────────────
// parseVarlenEdgeLabel Tests
// ──────────────────────────────────────────

describe('parseVarlenEdgeLabel', () => {
  it('returns null range for plain label', () => {
    const result = parseVarlenEdgeLabel('KNOWS')
    expect(result.label).toBe('KNOWS')
    expect(result.range).toBeNull()
  })

  it('parses KNOWS*1..3', () => {
    const result = parseVarlenEdgeLabel('KNOWS*1..3')
    expect(result.label).toBe('KNOWS')
    expect(result.range).toEqual({ min: 1, max: 3 })
  })

  it('parses KNOWS* (unbounded)', () => {
    const result = parseVarlenEdgeLabel('KNOWS*')
    expect(result.label).toBe('KNOWS')
    expect(result.range!.min).toBe(1)
    expect(result.range!.max).toBe(5)
  })

  it('parses KNOWS*2 (exact)', () => {
    const result = parseVarlenEdgeLabel('KNOWS*2')
    expect(result.label).toBe('KNOWS')
    expect(result.range).toEqual({ min: 2, max: 2 })
  })

  it('handles null label', () => {
    const result = parseVarlenEdgeLabel(null)
    expect(result.label).toBeNull()
    expect(result.range).toBeNull()
  })

  it('handles * only (no label prefix)', () => {
    const result = parseVarlenEdgeLabel('*')
    expect(result.label).toBeNull()
    expect(result.range!.min).toBe(1)
    expect(result.range!.max).toBe(5)
  })
})

// ──────────────────────────────────────────
// findVarlenPaths — Chain Graph Tests
// ──────────────────────────────────────────

describe('findVarlenPaths — chain graph', () => {
  let mockManager: any

  beforeEach(() => {
    mockManager = buildMockManager(createChainGraph())
  })

  it('a. finds paths with *1..3 on chain', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: 3 },
    })

    // From 1: can reach 2 (1 edge), 3 (2 edges), 4 (3 edges)
    // But BFS means we find 2 first, then 3, then 4
    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(2)
    expect(endpoints).toContain(3)
    expect(endpoints).toContain(4)
    expect(endpoints).not.toContain(5) // 5 is 4 edges away
  })

  it('b. finds paths with * (unbounded, capped to 5) on chain', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: null },
    })

    // Should reach all nodes 2-5 since chain is only 4 edges
    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(2)
    expect(endpoints).toContain(3)
    expect(endpoints).toContain(4)
    expect(endpoints).toContain(5)
  })

  it('c. returns path arrays in correct order', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: 3 },
    })

    // First path should be [1, 2] (BFS, single hop)
    expect(paths.length).toBeGreaterThanOrEqual(1)
    const shortestPath = paths.find(p => p.length === 2)
    expect(shortestPath).toBeDefined()
    expect(shortestPath![0]).toBe(1)
    expect(shortestPath![1]).toBe(2)

    // Should have [1, 2, 3] as well
    const twoHopPath = paths.find(p => p.length === 3)
    expect(twoHopPath).toBeDefined()
    expect(twoHopPath![0]).toBe(1)
    expect(twoHopPath![1]).toBe(2)
    expect(twoHopPath![2]).toBe(3)
  })

  it('d. no results when path too short (below min length)', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 10, max: 15 },
    })

    // Chain only has 4 edges, so no paths of length 10+
    expect(paths.length).toBe(0)
  })

  it('e. no results on disconnected graph', async () => {
    const isolatedManager = buildMockManager(createIsolatedGraph())

    const paths = await findVarlenPaths(isolatedManager, {
      source: 1,
      range: { min: 1, max: 3 },
    })

    expect(paths.length).toBe(0)
  })

  it('f. returns source node only for *0', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 0, max: 0 },
    })

    expect(paths.length).toBe(1)
    expect(paths[0]).toEqual([1])
  })

  it('g. handles *0..2 correctly (includes zero-length path)', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 0, max: 2 },
    })

    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(1) // *0 includes source
    expect(endpoints).toContain(2) // 1 hop
    expect(endpoints).toContain(3) // 2 hops
    expect(endpoints).not.toContain(4) // 3 hops, beyond max=2
  })
})

// ──────────────────────────────────────────
// findVarlenPaths — Star Graph Tests
// ──────────────────────────────────────────

describe('findVarlenPaths — star graph (multiple paths)', () => {
  let mockManager: any

  beforeEach(() => {
    mockManager = buildMockManager(createStarGraph())
  })

  it('finds all paths from 1 with *1..2', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: 2 },
    })

    // With *1..2 from node 1:
    // 1-hop: [1,2], [1,3], [1,4]
    // 2-hop: [1,2,5], [1,3,5], [1,4,5]
    expect(paths.length).toBe(6)

    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(2)
    expect(endpoints).toContain(3)
    expect(endpoints).toContain(4)
    expect(endpoints).toContain(5)
  })

  it('finds distinct paths from 1 to 5 via *2', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 2, max: 2 },
    })

    // Exactly 2 hops from 1: all paths to 5
    // [1,2,5], [1,3,5], [1,4,5]
    expect(paths.length).toBe(3)
    for (const p of paths) {
      expect(p.length).toBe(3) // start + 2 hops = 3 nodes
      expect(p[0]).toBe(1)
      expect(p[2]).toBe(5)
    }
  })
})

// ──────────────────────────────────────────
// findVarlenPaths — Cycle Tests
// ──────────────────────────────────────────

describe('findVarlenPaths — cycle prevention', () => {
  let mockManager: any

  beforeEach(() => {
    mockManager = buildMockManager(createCyclicGraph())
  })

  it('prevents cycles, finds only acyclic paths', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: 10 },
    })

    // From 1: 1→2 (1 edge), 1→2→3 (2 edges)
    // 1→2→3→1 would be a cycle and should be prevented
    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(2)
    expect(endpoints).toContain(3)
    expect(endpoints).not.toContain(1) // cycle back to 1 should be prevented
  })

  it('path count is reasonable with cycle prevention', async () => {
    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: 5 },
    })

    // With *1..5 from 1: [1,2], [1,2,3] (cycles prevented)
    expect(paths.length).toBe(2)
  })
})

// ──────────────────────────────────────────
// findVarlenPaths — Edge Filter Tests
// ──────────────────────────────────────────

describe('findVarlenPaths — edge type filters', () => {
  it('respects edge type filter', async () => {
    // Build a graph with two edge types
    const adj = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()
    adj.set(1, {
      nodes: [
        { id: 2, type: 1, name: 'node2', props: {} },
        { id: 3, type: 1, name: 'node3', props: {} },
      ],
      edges: [
        { src: 1, dst: 2, type: 10, props: {} },
        { src: 1, dst: 3, type: 20, props: {} },
      ],
    })
    adj.set(2, { nodes: [], edges: [] })
    adj.set(3, { nodes: [], edges: [] })

    const manager = buildMockManager(adj)

    // Only follow type 10 edges
    const paths = await findVarlenPaths(manager, {
      source: 1,
      range: { min: 1, max: 3 },
      edgeTypeFilter: [10],
    })

    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(2)
    expect(endpoints).not.toContain(3) // Node 3 is reached via type 20
  })
})

// ──────────────────────────────────────────
// extractEndpoints & flattenPaths Tests
// ──────────────────────────────────────────

describe('extractEndpoints and flattenPaths', () => {
  it('extractEndpoints returns unique last nodes', () => {
    const paths: Array<number[]> = [[1, 2], [1, 2, 3], [1, 4]]
    const endpoints = extractEndpoints(paths)
    expect(endpoints.sort()).toEqual([2, 3, 4])
  })

  it('flattenPaths returns all unique nodes', () => {
    const paths: Array<number[]> = [[1, 2], [1, 2, 3], [1, 4]]
    const nodes = flattenPaths(paths)
    expect(nodes.sort()).toEqual([1, 2, 3, 4])
  })
})

// ──────────────────────────────────────────
// findPaths Convenience Wrapper
// ──────────────────────────────────────────

describe('findPaths — convenience wrapper', () => {
  let mockManager: any

  beforeEach(() => {
    mockManager = buildMockManager(createChainGraph())
  })

  it('works with default arguments', async () => {
    const paths = await findPaths(mockManager, 1)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths[0][0]).toBe(1)
  })

  it('accepts explicit min/max', async () => {
    const paths = await findPaths(mockManager, 1, 2, 3)
    const endpoints = extractEndpoints(paths)
    expect(endpoints).toContain(3) // 2 hops
    expect(endpoints).toContain(4) // 3 hops
    expect(endpoints).not.toContain(2) // 1 hop is below min=2
  })
})

// ──────────────────────────────────────────
// Safety: Max Depth Limit
// ──────────────────────────────────────────

describe('safety — max depth limit', () => {
  it('does not hang on large depth value', async () => {
    // Build a simple chain of 3 nodes
    const adj = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()
    adj.set(1, {
      nodes: [{ id: 2, type: 1, name: 'node2', props: {} }],
      edges: [{ src: 1, dst: 2, type: 10, props: {} }],
    })
    adj.set(2, {
      nodes: [{ id: 3, type: 1, name: 'node3', props: {} }],
      edges: [{ src: 2, dst: 3, type: 10, props: {} }],
    })
    adj.set(3, { nodes: [], edges: [] })

    const manager = buildMockManager(adj)

    // Even with range 1..100000, should cap at ABSOLUTE_MAX_DEPTH
    const paths = await findVarlenPaths(manager, {
      source: 1,
      range: { min: 1, max: 100000 },
    })

    // Should still get results (chain is only 2 edges)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.length).toBeLessThanOrEqual(100)
  })
})

// ──────────────────────────────────────────
// Error Handling
// ──────────────────────────────────────────

describe('error handling', () => {
  it('handles empty graph gracefully', async () => {
    const adj = new Map<number, { nodes: NodeRecord[]; edges: EdgeRecord[] }>()
    const manager = buildMockManager(adj)

    const paths = await findVarlenPaths(manager, {
      source: 1,
      range: { min: 1, max: 3 },
    })

    expect(paths).toEqual([])
  })

  it('handles manager.neighbors throwing', async () => {
    const failingManager = {
      neighbors: async () => {
        throw new Error('mock error')
      },
    }

    const paths = await findVarlenPaths(failingManager, {
      source: 1,
      range: { min: 1, max: 3 },
    })

    expect(paths).toEqual([])
  })

  it('handles limit parameter', async () => {
    const mockManager = buildMockManager(createChainGraph())

    const paths = await findVarlenPaths(mockManager, {
      source: 1,
      range: { min: 1, max: 10 },
      limit: 2,
    })

    expect(paths.length).toBeLessThanOrEqual(2)
  })
})
