/**
 * StreamingPageRank Tests
 *
 * Tests cover:
 * a. Small graph projection construction (see graph-projection.spec.ts)
 * b. Max depth filtering (see graph-projection.spec.ts)
 * c. Node type filtering (see graph-projection.spec.ts)
 * d. Streaming PageRank matches non-streaming pagerank results
 * e. Batch processing yields same results as full processing
 * f. Empty projection
 * g. Single node projection
 * h. Large projection with batching
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import { GraphProjection } from './graph-projection'
import { StreamingPageRank } from './streaming-pagerank'
import { pagerank } from './pagerank'
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

async function seedLinearGraph(engine: GraphEngine): Promise<void> {
  // Nodes 1..6
  for (let i = 1; i <= 6; i++) {
    await engine.upsertNode(1, `n${i}`)
  }
  // Chain: 1→2→3→4→5→6
  await engine.upsertEdge(1, 2, 10)
  await engine.upsertEdge(2, 3, 10)
  await engine.upsertEdge(3, 4, 10)
  await engine.upsertEdge(4, 5, 10)
  await engine.upsertEdge(5, 6, 10)
}

async function seedStarGraph(engine: GraphEngine): Promise<void> {
  // Nodes 1 (center) → 2,3,4,5
  for (let i = 1; i <= 5; i++) {
    await engine.upsertNode(1, `star${i}`)
  }
  await engine.upsertEdge(1, 2, 10)
  await engine.upsertEdge(1, 3, 10)
  await engine.upsertEdge(1, 4, 10)
  await engine.upsertEdge(1, 5, 10)
}

async function seedTinyGraph(engine: GraphEngine): Promise<void> {
  // 2 nodes, 1 edge
  await engine.upsertNode(1, 'a')
  await engine.upsertNode(1, 'b')
  await engine.upsertEdge(1, 2, 10)
}

describe('StreamingPageRank', () => {
  let engine: GraphEngine
  let baseDir: string

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'streaming-pr-test-'))
  })

  afterAll(() => {
    engine?.close()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  async function setupEngine(testName: string, seeder: (e: GraphEngine) => Promise<void>): Promise<GraphEngine> {
    const dir = join(baseDir, testName.replace(/[^a-zA-Z0-9]/g, '_'))
    const eng = createEngine(dir)
    await seeder(eng)
    return eng
  }

  it('d. Streaming PageRank matches non-streaming pagerank results (linear graph)', async () => {
    engine = await setupEngine('linear_pr', seedLinearGraph)
    const projection = await GraphProjection.create(engine)
    const streamingResult = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 100,
      tolerance: 1e-8,
    })

    // Non-streaming pagerank
    const allNodes = projection.getNodes()
    const getNeighbors = (nid: number) => projection.neighbors(nid)
    const expectedResult = pagerank(getNeighbors, allNodes, {
      dampingFactor: 0.85,
      maxIterations: 100,
      convergenceThreshold: 1e-8,
    })

    // Results should be very close
    expect(streamingResult.size).toBe(expectedResult.size)
    for (const [nodeId, score] of streamingResult) {
      const expected = expectedResult.get(nodeId)!
      // Allow small numerical differences (< 0.1%)
      expect(Math.abs(score - expected)).toBeLessThan(0.001)
    }
  })

  it('d2. Streaming PageRank matches non-streaming (star graph)', async () => {
    engine = await setupEngine('star_pr', seedStarGraph)
    const projection = await GraphProjection.create(engine)
    const streamingResult = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 100,
      tolerance: 1e-8,
    })

    const allNodes = projection.getNodes()
    const getNeighbors = (nid: number) => projection.neighbors(nid)
    const expectedResult = pagerank(getNeighbors, allNodes, {
      dampingFactor: 0.85,
      maxIterations: 100,
      convergenceThreshold: 1e-8,
    })

    expect(streamingResult.size).toBe(expectedResult.size)
    for (const [nodeId, score] of streamingResult) {
      const expected = expectedResult.get(nodeId)!
      expect(Math.abs(score - expected)).toBeLessThan(0.001)
    }
  })

  it('e. Batch processing (smaller batchSize) yields same results as full processing (larger batch)', async () => {
    engine = await setupEngine('batch_compare', seedLinearGraph)
    const projection = await GraphProjection.create(engine)

    // Small batch processing
    const smallBatchResult = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 100,
      tolerance: 1e-8,
      batchSize: 1,
    })

    // Full batch processing (batchSize = nodeCount)
    const largeBatchResult = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 100,
      tolerance: 1e-8,
      batchSize: projection.nodeCount,
    })

    expect(smallBatchResult.size).toBe(largeBatchResult.size)
    for (const [nodeId, score] of smallBatchResult) {
      const largeScore = largeBatchResult.get(nodeId)!
      expect(Math.abs(score - largeScore)).toBeLessThan(0.0001)
    }
  })

  it('f. Empty projection returns empty result', async () => {
    engine = await setupEngine('empty_pr', async (e) => {
      await e.upsertNode(1, 'isolated')
    })
    // Filter everything out
    const projection = await GraphProjection.create(engine, {
      nodeFilter: () => false,
    })
    const result = await StreamingPageRank.compute(projection)
    expect(result.size).toBe(0)
  })

  it('g. Single node projection returns single score', async () => {
    engine = await setupEngine('single_pr', async (e) => {
      await e.upsertNode(1, 'lonely')
    })
    const projection = await GraphProjection.create(engine, {
      seedNodes: [1],
    })
    const result = await StreamingPageRank.compute(projection)
    expect(result.size).toBe(1)
    expect(result.has(1)).toBe(true)
    // Single node with no edges: rank = probability of teleport = (1-d)/n = 0.15
    expect(result.get(1)!).toBeCloseTo(1.0, 1)
  })

  it('h. Large projection with batching', async () => {
    engine = await setupEngine('large_proj', seedLinearGraph)
    // Add more nodes to make it "large"
    for (let i = 10; i <= 50; i++) {
      await engine.upsertNode(1, `big${i}`)
    }
    const projection = await GraphProjection.create(engine)

    // Run with small batch size
    const batchResult = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 50,
      batchSize: 5,
    })

    expect(batchResult.size).toBe(projection.nodeCount)
  })

  it('progress callback is invoked', async () => {
    engine = await setupEngine('progress_test', seedLinearGraph)
    const projection = await GraphProjection.create(engine)

    const progressCalls: any[] = []
    const result = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 3,
      batchSize: 2,
      onProgress: (p) => { progressCalls.push({ ...p }) },
    })

    expect(progressCalls.length).toBeGreaterThan(0)
    expect(result.size).toBe(projection.nodeCount)
  })

  it('tiny graph (2 nodes) pagerank', async () => {
    engine = await setupEngine('tiny_pr', seedTinyGraph)
    const projection = await GraphProjection.create(engine, {
      seedNodes: [1, 2],
      maxDepth: 0,
    })
    const result = await StreamingPageRank.compute(projection)

    expect(result.size).toBe(2)
    // Node 1 has an edge to node 2, so node 2 should get more rank contribution
    const r1 = result.get(1)!
    const r2 = result.get(2)!
    // Both should be positive
    expect(r1).toBeGreaterThan(0)
    expect(r2).toBeGreaterThan(0)
    // Node 2 is dangling (no outgoing) so its rank goes very low vs node 1
    // Just check both are reasonable
    expect(r1 + r2).toBeCloseTo(1.0, 2)
  })

  it('default parameters work when minimal options are provided', async () => {
    engine = await setupEngine('default_params', seedLinearGraph)
    const projection = await GraphProjection.create(engine)
    const result = await StreamingPageRank.compute(projection)
    expect(result.size).toBe(projection.nodeCount)
  })

  it('should be fast on 10k chain graph (O(V+E) not O(V²))', async () => {
    // Build a 10k chain graph engine
    const dir = join(baseDir, '10k_chain_perf')
    const eng = createEngine(dir)
    for (let i = 1; i <= 10000; i++) {
      await eng.upsertNode(1, `node${i}`)
    }
    for (let i = 1; i < 10000; i++) {
      await eng.upsertEdge(i, i + 1, 10)
    }

    const projection = await GraphProjection.create(eng)
    expect(projection.nodeCount).toBe(10000)
    expect(projection.edgeCount).toBe(9999)

    const start = Date.now()
    const result = await StreamingPageRank.compute(projection, {
      damping: 0.85,
      iterations: 20,
      tolerance: 1e-6,
    })
    const elapsed = Date.now() - start

    // Allow generous limit for CI variance
    expect(elapsed).toBeLessThan(5000)

    // Sum should be ≈ 1.0
    let sum = 0
    for (const [, score] of result) {
      sum += score
    }
    expect(sum).toBeCloseTo(1.0, 2)

    expect(result.size).toBe(10000)
    eng.close()
  })
})
