/**
 * Query Latency Benchmark Suite
 *
 * Measures latency of graph query patterns: path queries, aggregations,
 * and ordered results on large datasets.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-latency-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = createTempDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

/**
 * Build a chain graph using upsertNode (for queryability).
 * Nodes connect via edge type 10.
 */
function buildQueryableChain(engine: GraphEngine, count: number): void {
  for (let i = 0; i < count; i++) {
    engine.upsertNode(1, `chain-${i}`, { props: { seq: i } })
  }
  for (let i = 0; i < count - 1; i++) {
    engine.upsertEdge(i, i + 1, 10, { props: { weight: 1 } })
  }
}

describe('Query Latency Benchmarks', () => {
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR })
    engine.open()

    // Build: chain of 500 nodes
    buildQueryableChain(engine, 500)

    // Add nodes for aggregation queries
    for (let i = 0; i < 2000; i++) {
      engine.upsertNode(2, `agg-node-${i}`, { props: { value: i % 100, group: i < 1000 ? 'A' : 'B' } })
    }

    console.log(`[SETUP] Graph ready: chain(500) + agg data(2000)`)
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ── 1. Shortest path query (2-hop) ──
  it('should measure shortest path latency (2-hop)', { timeout: 60000 }, async () => {
    const warmup = 10
    for (let i = 0; i < warmup; i++) {
      await engine.shortestPath(0, 2)
    }

    const iterations = 100
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      await engine.shortestPath(0, 2)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[PERF] Shortest path (2-hop) latency (${iterations} runs):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)

    const result = await engine.shortestPath(0, 2)
    expect(result).toBeDefined()
  })

  // ── 2. Shortest path query (3-hop) ──
  it('should measure shortest path latency (3-hop)', { timeout: 60000 }, async () => {
    const warmup = 10
    for (let i = 0; i < warmup; i++) {
      await engine.shortestPath(0, 3)
    }

    const iterations = 100
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      await engine.shortestPath(0, 3)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[PERF] Shortest path (3-hop) latency (${iterations} runs):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
  })

  // ── 3. Shortest path query (4-hop) ──
  it('should measure shortest path latency (4-hop)', { timeout: 60000 }, async () => {
    const warmup = 10
    for (let i = 0; i < warmup; i++) {
      await engine.shortestPath(0, 4)
    }

    const iterations = 100
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      await engine.shortestPath(0, 4)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[PERF] Shortest path (4-hop) latency (${iterations} runs):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
  })

  // ── 4. MATCH query (scan) on large graph ──
  it('should measure MATCH scan latency on large graph', { timeout: 60000 }, () => {
    const warmup = 5
    for (let i = 0; i < warmup; i++) {
      engine.query('MATCH (n) RETURN n.name')
    }

    const iterations = 50
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.query('MATCH (n) RETURN n.name')
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[PERF] MATCH scan latency (${iterations} runs on large graph):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)

    const result = engine.query('MATCH (n) RETURN n.name')
    expect(result.length).toBeGreaterThan(0)
  })

  // ── 5. ORDER BY + LIMIT on query results ──
  it('should measure ORDER BY + LIMIT latency on query result', { timeout: 60000 }, () => {
    const warmup = 5
    for (let i = 0; i < warmup; i++) {
      engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 50')
    }

    const iterations = 100
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 50')
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[PERF] MATCH + LIMIT latency (${iterations} runs):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
  })

  // ── 6. BFS traversal latency ──
  it('should measure BFS traversal latency', { timeout: 60000 }, async () => {
    const warmup = 5
    for (let i = 0; i < warmup; i++) {
      await engine.bfs(0)
    }

    const iterations = 50
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      await engine.bfs(0)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[PERF] BFS traversal latency (${iterations} runs from node 0):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)

    const result = await engine.bfs(0)
    expect(result.size).toBeGreaterThan(0)
  })
})
