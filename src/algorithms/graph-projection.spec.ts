/**
 * GraphProjection Tests
 *
 * Tests cover:
 * a. Small graph projection construction
 * b. Max depth filtering (2 hops only)
 * c. Node type filtering
 * d. Streaming PageRank matches non-streaming pagerank results (cross-test, in streaming-pagerank.spec.ts)
 * e. Batch processing yields same results as full processing (see streaming-pagerank.spec.ts)
 * f. Empty projection
 * g. Single node projection
 * h. Large projection with batching
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import { GraphProjection, type ProjectionOptions } from './graph-projection'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

function createEngine(path: string): GraphEngine {
  const engine = new GraphEngine({
    path,
    cacheSize: 100,
  })
  engine.open()
  return engine
}

async function seedGraph(engine: GraphEngine): Promise<void> {
  // Nodes: 1..10
  for (let i = 1; i <= 10; i++) {
    const typeId = i <= 5 ? 1 : 2
    await engine.upsertNode(typeId, `node${i}`, {
      props: { label: `n${i}`, type: typeId === 1 ? 'A' : 'B' },
    })
  }

  // Edges: simple chain 1-2-3-4-5, plus star from 6 to 7,8,9,10
  await engine.upsertEdge(1, 2, 10)
  await engine.upsertEdge(2, 3, 10)
  await engine.upsertEdge(3, 4, 10)
  await engine.upsertEdge(4, 5, 10)
  await engine.upsertEdge(6, 7, 10)
  await engine.upsertEdge(6, 8, 10)
  await engine.upsertEdge(6, 9, 10)
  await engine.upsertEdge(6, 10, 10)

  // Cross edges connecting the two groups
  await engine.upsertEdge(5, 6, 10)
}

describe('GraphProjection', () => {
  let engine: GraphEngine
  let baseDir: string

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'graph-proj-test-'))
  })

  afterAll(() => {
    engine?.close()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // Helper to create fresh engine per test
  async function setupEngine(testName: string): Promise<GraphEngine> {
    const dir = join(baseDir, testName.replace(/[^a-zA-Z0-9]/g, '_'))
    const eng = createEngine(dir)
    await seedGraph(eng)
    return eng
  }

  it('a. Small graph projection construction', async () => {
    engine = await setupEngine('small_graph')
    const proj = await GraphProjection.create(engine)

    // Expect to find all 10 nodes
    expect(proj.nodeCount).toBeGreaterThanOrEqual(10)
    expect(proj.edgeCount).toBeGreaterThanOrEqual(9)
    expect(proj.projectionNodeIds.length).toBe(proj.nodeCount)
    expect(proj.nodeIndex.size).toBe(proj.nodeCount)

    // CSR structure integrity
    expect(proj.nodeOffsets.length).toBe(proj.nodeCount + 1)
    expect(proj.nodeOffsets[proj.nodeCount]).toBe(proj.edgeCount)
    expect(proj.edges.length).toBe(proj.edgeCount)

    // stats
    expect(proj.stats.constructionTimeMs).toBeGreaterThanOrEqual(0)
    expect(proj.stats.estimatedMemoryBytes).toBeGreaterThan(0)

    // neighbors O(1)
    const n1Id = 1
    const n1Nb = proj.neighbors(n1Id)
    expect(n1Nb).toContain(2)
  })

  it('b. Max depth filtering (2 hops only)', async () => {
    engine = await setupEngine('max_depth')
    // From node 1 with maxDepth=2: reachable = 1, 2, 3
    const proj = await GraphProjection.create(engine, {
      seedNodes: [1],
      maxDepth: 2,
    })

    // Nodes: 1 (depth 0), 2 (depth 1), 3 (depth 2) — 3 nodes
    expect(proj.nodeCount).toBe(3)
    expect(proj.nodeIndex.has(1)).toBe(true)
    expect(proj.nodeIndex.has(2)).toBe(true)
    expect(proj.nodeIndex.has(3)).toBe(true)
    // Should NOT include node 4 (depth 3)
    expect(proj.nodeIndex.has(4)).toBe(false)
  })

  it('c. Node type filtering', async () => {
    engine = await setupEngine('node_type_filter')
    // Only type=1 nodes (nodes 1-5)
    const proj = await GraphProjection.create(engine, {
      nodeFilter: (node) => node.type === 1,
    })

    expect(proj.nodeCount).toBe(5)
    for (let i = 1; i <= 5; i++) {
      expect(proj.nodeIndex.has(i)).toBe(true)
    }
    for (let i = 6; i <= 10; i++) {
      expect(proj.nodeIndex.has(i)).toBe(false)
    }
  })

  it('f. Empty projection', async () => {
    engine = await setupEngine('empty_proj')
    // Filter that matches nothing
    const proj = await GraphProjection.create(engine, {
      nodeFilter: () => false,
    })

    expect(proj.nodeCount).toBe(0)
    expect(proj.edgeCount).toBe(0)
    expect(proj.getNodes()).toEqual([])

    const result = await proj.streamBatches(100).next()
    expect(result.done).toBe(true)
  })

  it('g. Single node projection', async () => {
    engine = await setupEngine('single_node')
    const proj = await GraphProjection.create(engine, {
      seedNodes: [3],
      maxDepth: 0,
    })

    expect(proj.nodeCount).toBe(1)
    expect(proj.nodeIndex.has(3)).toBe(true)
    expect(proj.getNodes()).toEqual([3])

    // Single node, no edges within projection (node 3 has edge to 4, but 4 not in proj)
    const nbs = proj.neighbors(3)
    expect(nbs).toEqual([])
    expect(proj.edgeCount).toBe(0) // no edges within the projection
  })

  it('h. Large projection with batching', async () => {
    engine = await setupEngine('large_proj_batch')
    // Connect the initial graph to the extended nodes
    await engine.upsertEdge(10, 11, 10)
    // Add many more nodes to test batching
    for (let i = 11; i <= 110; i++) {
      await engine.upsertNode(1, `node${i}`)
      if (i > 11) {
        await engine.upsertEdge(i - 1, i, 10)
      }
    }

    // Create projection with all nodes as seeds
    const proj = await GraphProjection.create(engine, {
      seedNodes: Array.from({length: 110}, (_, i) => i + 1),
      maxDepth: 1,
    })

    expect(proj.nodeCount).toBe(110)

    const batchSize = 20
    let batchCount = 0
    let totalYielded = 0

    for await (const batch of proj.streamBatches(batchSize)) {
      batchCount++
      // Each batch is a number[] of node IDs
      totalYielded += batch.length
    }

    expect(totalYielded).toBe(proj.nodeCount)
    expect(batchCount).toBe(Math.ceil(proj.nodeCount / batchSize))
  })

  it('neighbors O(1) access returns correct edges', async () => {
    engine = await setupEngine('neighbors_o1')
    // The graph has edges: 1→2, 2→3, 3→4, 4→5
    // So node 3's outgoing neighbors = [4], node 1's outgoing neighbors = [2]
    const proj = await GraphProjection.create(engine, {
      seedNodes: [1, 2, 3, 4, 5],
      maxDepth: 0, // Only the seed nodes themselves, no BFS expansion
    })

    // Node 1 has outgoing edge to 2
    const nb1 = proj.neighbors(1)
    expect(nb1).toContain(2)
    // Node 3 has outgoing edge to 4 (NOT to 2 — edge direction is 2→3)
    const nb3 = proj.neighbors(3)
    expect(nb3).toContain(4)
    expect(nb3).not.toContain(2)
    // Node 2 has outgoing edge to 3
    const nb2 = proj.neighbors(2)
    expect(nb2).toContain(3)
  })

  it('edge filter excludes specific edges', async () => {
    engine = await setupEngine('edge_filter_test')
    // Filter out edges to node 5
    const proj = await GraphProjection.create(engine, {
      seedNodes: [1, 2, 3, 4, 5],
      maxDepth: 2,
      edgeFilter: (edge) => edge.dst !== 5,
    })

    // Node 4 has edge to 5, which should be filtered out
    const nb4 = proj.neighbors(4)
    if (proj.nodeIndex.has(4) && proj.nodeIndex.has(5)) {
      expect(nb4).not.toContain(5)
    }
  })

  it('streamBatches yields correct batches', async () => {
    engine = await setupEngine('stream_batches_correct')
    const proj = await GraphProjection.create(engine, {
      seedNodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      maxDepth: 1, // Include one-hop neighbors
    })

    console.log('DEBUG streamBatches: proj.nodeCount =', proj.nodeCount)
    console.log('DEBUG streamBatches: proj.projectionNodeIds =', proj.projectionNodeIds)
    console.log('DEBUG streamBatches: proj.nodeIndex keys =', Array.from(proj.nodeIndex.keys()))

    const batchSize = 3
    const yieldedNodes: number[] = []

    for await (const batch of proj.streamBatches(batchSize)) {
      // batch is a number[] of node IDs
      yieldedNodes.push(...batch)
    }

    // All projection nodes should be yielded
    expect(yieldedNodes.length).toBe(proj.nodeCount)
    expect(yieldedNodes.sort((a, b) => a - b))
      .toEqual(proj.getNodes().sort((a, b) => a - b))
  })

  it('stats reflect correct metrics', async () => {
    engine = await setupEngine('stats_test')
    const proj = await GraphProjection.create(engine, {
      seedNodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      maxDepth: 1,
    })

    expect(proj.stats.nodeCount).toBe(proj.nodeCount)
    expect(proj.stats.edgeCount).toBe(proj.edgeCount)
    expect(proj.stats.constructionTimeMs).toBeGreaterThanOrEqual(0)
    // Memory estimate should be positive
    expect(proj.stats.estimatedMemoryBytes).toBeGreaterThan(0)
  })
})
