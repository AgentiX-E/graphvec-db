/**
 * Latency Benchmark Suite (15+ tests)
 *
 * Measures single-operation latency:
 *   - upsertNode / upsertEdge / getNode / neighbors / deleteNode
 *   - Each takes median of 100 runs for stable measurement
 *   - All tests timeout=120000
 *
 * Each test outputs console.log with median/p95/p99 latency data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { makeEngine } from '../test-utils/make-engine'

function randomDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-latency-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

function medianSorted(arr: number[]): number {
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
}

function percentileSorted(arr: number[], p: number): number {
  const idx = Math.floor(arr.length * (p / 100))
  return arr[Math.min(idx, arr.length - 1)]
}

const TEST_DIR = randomDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

describe('Latency Benchmarks', () => {

  // ── Setup ──
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR, denseVector: { dimension: 384 } })
    engine.open()

    // Seed some initial nodes for neighbor/edge tests
    for (let i = 0; i < 200; i++) {
      engine.upsertNode(1, `lat-seed-${i}`, { props: { seq: i, tag: 'latency' } })
    }
    const allNodes = engine.scanAllNodes()
    for (let i = 0; i < allNodes.length - 1; i++) {
      engine.upsertEdge(allNodes[i].id, allNodes[i + 1].id, 10, { props: { weight: 1 } })
    }

    console.log(`[SETUP] Latency bench graph: ${engine.scanAllNodes().length} nodes`)
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ════════════════════════════════════════════════════════════════
  // 1.  upsertNode latency (100 runs, median)
  // ════════════════════════════════════════════════════════════════

  it('should measure upsertNode latency (100 runs)', async () => {
    const runs = 100
    const timings: number[] = []

    // Warmup
    for (let i = 0; i < 10; i++) {
      await engine.upsertNode(100, `lat-up-warm-${i}`, { props: { seq: i } })
    }

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      await engine.upsertNode(101, `lat-up-${i}`, { props: { seq: i, payload: 'x'.repeat(64) } })
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)
    const p99 = percentileSorted(timings, 99)
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length

    console.log(`[BENCH][latency] upsertNode (${runs} runs)`)
    console.log(`  Avg:   ${avg.toFixed(3)} ms`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
    console.log(`  P99:   ${p99.toFixed(3)} ms`)
    console.log(`  Min:   ${timings[0].toFixed(3)} ms`)
    console.log(`  Max:   ${timings[timings.length - 1].toFixed(3)} ms`)
  }, 120000)

  it('should measure upsertNode latency with large payload (100 runs)', async () => {
    const runs = 100
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      await engine.upsertNode(102, `lat-up-big-${i}`, {
        props: { seq: i, title: 'Large Payload Test', tags: ['a', 'b', 'c', 'd', 'e'], weight: Math.random(), description: 'x'.repeat(256) },
      })
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] upsertNode (large payload, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure upsertNode latency with denseVector (100 runs)', async () => {
    const runs = 100
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const vec = Array.from({ length: 384 }, () => Math.random() - 0.5)
      const t0 = performance.now()
      await engine.upsertNode(103, `lat-up-vec-${i}`, { props: { seq: i }, vector: new Float32Array(vec) })
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] upsertNode (denseVector 384d, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 2.  upsertEdge latency
  // ════════════════════════════════════════════════════════════════

  it('should measure upsertEdge latency (100 runs)', async () => {
    const allNodes = engine.scanAllNodes()
    const runs = Math.min(100, allNodes.length - 1)
    const timings: number[] = []

    // Warmup
    for (let i = 0; i < 5; i++) {
      await engine.upsertEdge(allNodes[i % (allNodes.length - 1)].id, allNodes[(i + 1) % allNodes.length].id, 50, { props: { weight: 1 } })
    }

    for (let i = 0; i < runs; i++) {
      const src = allNodes[i % (allNodes.length - 1)]
      const dst = allNodes[(i + 2) % allNodes.length]
      const t0 = performance.now()
      await engine.upsertEdge(src.id, dst.id, 50, { props: { weight: Math.random() } })
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length

    console.log(`[BENCH][latency] upsertEdge (${runs} runs)`)
    console.log(`  Avg:   ${avg.toFixed(3)} ms`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure upsertEdge latency with props (100 runs)', async () => {
    const allNodes = engine.scanAllNodes()
    const runs = Math.min(100, allNodes.length - 2)
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const src = allNodes[i % (allNodes.length - 2)]
      const dst = allNodes[(i + 3) % allNodes.length]
      const t0 = performance.now()
      await engine.upsertEdge(src.id, dst.id, 51, {
        props: { weight: Math.random(), timestamp: Date.now(), label: `edge-${i}`, tags: ['test', 'latency'] },
      })
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] upsertEdge (with props, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 3.  getNode (scanAllNodes equivalent) latency
  // ════════════════════════════════════════════════════════════════

  it('should measure getNode (scanAllNodes) latency (100 runs)', () => {
    const runs = 100
    const timings: number[] = []

    // Warmup
    for (let i = 0; i < 5; i++) {
      engine.scanAllNodes()
    }

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const nodes = engine.scanAllNodes()
      timings.push(performance.now() - t0)
      expect(nodes.length).toBeGreaterThan(0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length
    const opsPerSec = 1000 / avg

    console.log(`[BENCH][latency] scanAllNodes (${runs} runs)`)
    console.log(`  Avg:   ${avg.toFixed(3)} ms`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
    console.log(`  Ops/sec: ${opsPerSec.toFixed(0)}`)
  }, 120000)

  it('should measure getNode (MATCH query) latency (100 runs)', () => {
    const runs = 100
    const timings: number[] = []

    // Warmup
    for (let i = 0; i < 5; i++) {
      engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 1')
    }

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const result = engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 1')
      timings.push(performance.now() - t0)
      expect(result.length).toBeGreaterThan(0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] MATCH query (LIMIT 1, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure getNode (MATCH WHERE) latency (100 runs)', () => {
    const runs = 100
    const timings: number[] = []

    // Warmup
    for (let i = 0; i < 5; i++) {
      engine.query('MATCH (n) WHERE n.tag = "latency" RETURN n.name LIMIT 1')
    }

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      engine.query('MATCH (n) WHERE n.tag = "latency" RETURN n.name LIMIT 1')
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] MATCH WHERE query (${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 4.  neighbors latency
  // ════════════════════════════════════════════════════════════════

  it('should measure batchNeighbors latency (100 runs)', () => {
    const allNodes = engine.scanAllNodes()
    const runs = Math.min(100, allNodes.length)

    const timings: number[] = []

    // Warmup
    for (let i = 0; i < 5; i++) {
      engine.batchNeighbors([allNodes[i].id])
    }

    for (let i = 0; i < runs; i++) {
      const node = allNodes[i % allNodes.length]
      const t0 = performance.now()
      const result = engine.batchNeighbors([node.id])
      timings.push(performance.now() - t0)
      expect(result.size).toBeGreaterThan(0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length
    const opsPerSec = 1000 / avg

    console.log(`[BENCH][latency] batchNeighbors (${runs} runs)`)
    console.log(`  Avg:   ${avg.toFixed(3)} ms`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
    console.log(`  Ops/sec: ${opsPerSec.toFixed(0)}`)
  }, 120000)

  it('should measure batchNeighbors latency with maxDepth=2 (50 runs)', () => {
    const allNodes = engine.scanAllNodes()
    const runs = Math.min(50, allNodes.length)
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const node = allNodes[i % allNodes.length]
      const t0 = performance.now()
      const result = engine.batchNeighbors([node.id], { maxDepth: 2 })
      timings.push(performance.now() - t0)
      expect(result.size).toBeGreaterThan(0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] batchNeighbors (depth=2, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure batchNeighbors latency with edgeTypeFilter (50 runs)', () => {
    const allNodes = engine.scanAllNodes()
    const runs = Math.min(50, allNodes.length)
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const node = allNodes[i % allNodes.length]
      const t0 = performance.now()
      const result = engine.batchNeighbors([node.id], { maxDepth: 1, edgeTypeFilter: [10] })
      timings.push(performance.now() - t0)
      expect(result.size).toBeGreaterThan(0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] batchNeighbors (filter type=10, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 5.  deleteNode latency
  // ════════════════════════════════════════════════════════════════

  it('should measure deleteNode latency (50 runs)', async () => {
    // Pre-create nodes to delete
    const ids: number[] = []
    for (let i = 0; i < 60; i++) {
      const id = await engine.upsertNode(200, `lat-del-${i}`, { props: { seq: i } })
      ids.push(id)
    }

    const runs = 50
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const deleted = await engine.deleteNode(ids[i])
      timings.push(performance.now() - t0)
      expect(deleted).toBe(true)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length

    console.log(`[BENCH][latency] deleteNode (${runs} runs)`)
    console.log(`  Avg:   ${avg.toFixed(3)} ms`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure deleteNode (with cascade) latency (50 runs)', async () => {
    // Pre-create nodes with edges
    const ids: number[] = []
    for (let i = 0; i < 60; i++) {
      const id = await engine.upsertNode(201, `lat-del-cas-${i}`, { props: { seq: i } })
      ids.push(id)
    }
    for (let i = 0; i < ids.length - 1; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 60, { props: { weight: 1 } })
    }

    const runs = 50
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const deleted = await engine.deleteNode(ids[i], false, true)
      timings.push(performance.now() - t0)
      expect(deleted).toBe(true)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] deleteNode (cascade, ${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 6.  deleteEdge latency
  // ════════════════════════════════════════════════════════════════

  it('should measure deleteEdge latency (50 runs)', async () => {
    const allNodes = engine.scanAllNodes()
    const runs = Math.min(50, allNodes.length - 1)
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const src = allNodes[i]
      const dst = allNodes[(i + 1) % allNodes.length]
      // Ensure edge exists
      await engine.upsertEdge(src.id, dst.id, 70, { props: { weight: 1 } })
      const t0 = performance.now()
      const deleted = await engine.deleteEdge(src.id, dst.id, 70)
      timings.push(performance.now() - t0)
      expect(deleted).toBe(true)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] deleteEdge (${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 7.  batchUpsertNodes latency
  // ════════════════════════════════════════════════════════════════

  it('should measure batchUpsertNodes latency (50 batches of 10)', () => {
    const batches = 50
    const batchSize = 10
    const timings: number[] = []

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        inputs.push({
          typeId: 300,
          name: `lat-batch-${b}-${i}`,
          opts: { props: { seq: b * batchSize + i } },
        })
      }
      const t0 = performance.now()
      engine.batchUpsertNodes(inputs)
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length

    console.log(`[BENCH][latency] batchUpsertNodes (${batches} batches of ${batchSize})`)
    console.log(`  Avg batch:   ${avg.toFixed(3)} ms`)
    console.log(`  Median batch: ${median.toFixed(3)} ms`)
    console.log(`  P95 batch:   ${p95.toFixed(3)} ms`)
    console.log(`  Per-op equiv: ${(avg / batchSize).toFixed(3)} ms/op`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 8.  Query latency (various patterns)
  // ════════════════════════════════════════════════════════════════

  it('should measure MATCH query latency with LIMIT (100 runs)', () => {
    const runs = 100
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 10')
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] MATCH LIMIT 10 (${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure MATCH query latency with WHERE (100 runs)', () => {
    const runs = 100
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      engine.query('MATCH (n) WHERE n.seq >= 0 RETURN n.name, n.seq LIMIT 10')
      timings.push(performance.now() - t0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] MATCH WHERE (${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

  it('should measure full scan MATCH latency (100 runs)', () => {
    const runs = 100
    const timings: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const result = engine.query('MATCH (n) RETURN n.name')
      timings.push(performance.now() - t0)
      expect(result.length).toBeGreaterThan(0)
    }

    timings.sort((a, b) => a - b)
    const median = medianSorted(timings)
    const p95 = percentileSorted(timings, 95)

    console.log(`[BENCH][latency] MATCH full scan (${runs} runs)`)
    console.log(`  Median: ${median.toFixed(3)} ms`)
    console.log(`  P95:   ${p95.toFixed(3)} ms`)
  }, 120000)

    it('should measure upsertNode single latency (10 runs)', async () => {
      const engine = makeEngine('bench-lt1')
      try {
        const timings: number[] = []
        for (let r = 0; r < 10; r++) {
          const t0 = performance.now()
          await engine.upsertNode(1, `lt-${r}`, { props: { seq: r } })
          timings.push(performance.now() - t0)
        }
        timings.sort((a, b) => a - b)
        const median = timings[4]
        console.log(`[BENCH][latency] upsertNode single (10 runs): min=${timings[0].toFixed(3)} median=${median.toFixed(3)} max=${timings[9].toFixed(3)} ms`)
        expect(median).toBeGreaterThan(0)
      } finally { engine.close() }
    }, 30000)
    it('should measure upsertEdge single latency (10 runs)', async () => {
      const engine = makeEngine('bench-lt2')
      try {
        const src = await engine.upsertNode(1, 'lt-src', { props: {} })
        const dst = await engine.upsertNode(1, 'lt-dst', { props: {} })
        const timings: number[] = []
        for (let r = 0; r < 10; r++) {
          const t0 = performance.now()
          await engine.upsertEdge(src, dst, r % 2, { props: {} })
          timings.push(performance.now() - t0)
        }
        timings.sort((a, b) => a - b)
        console.log(`[BENCH][latency] upsertEdge single: median=${timings[4].toFixed(3)} ms`)
        expect(timings[4]).toBeGreaterThan(0)
      } finally { engine.close() }
    }, 30000)
    it('should measure getNode single latency (20 runs)', async () => {
      const engine = makeEngine('bench-lt3')
      try {
        const id = await engine.upsertNode(1, 'lt-get', { props: { val: 42 } })
        const timings: number[] = []
        for (let r = 0; r < 20; r++) {
          const t0 = performance.now()
          engine.getNode(id)
          timings.push(performance.now() - t0)
        }
        timings.sort((a, b) => a - b)
        console.log(`[BENCH][latency] getNode single (20 runs): min=${timings[0].toFixed(3)} median=${timings[9].toFixed(3)} max=${timings[19].toFixed(3)} ms`)
        expect(timings[0]).toBeGreaterThanOrEqual(0)
      } finally { engine.close() }
    }, 30000)
    it('should measure scanAllNodes latency at different sizes', async () => {
      const engine = makeEngine('bench-lt4')
      try {
        for (let i = 0; i < 10; i++) await engine.upsertNode(1, `lt-scan-${i}`, { props: {} })
        let t0 = performance.now()
        let r1 = engine.scanAllNodes().length
        let t1 = performance.now() - t0
        for (let i = 10; i < 60; i++) await engine.upsertNode(1, `lt-scan-${i}`, { props: {} })
        t0 = performance.now()
        let r2 = engine.scanAllNodes().length
        let t2 = performance.now() - t0
        console.log(`[BENCH][latency] scanAllNodes: 10nodes=${t1.toFixed(3)}ms count=${r1}, 60nodes=${t2.toFixed(3)}ms count=${r2}`)
        expect(r1).toBe(10)
        expect(r2).toBe(60)
      } finally { engine.close() }
    }, 30000)
    it('should measure neighbors latency at 20 edges', async () => {
      const engine = makeEngine('bench-lt5')
      try {
        const src = await engine.upsertNode(1, 'lt-nb-src', { props: {} })
        for (let i = 0; i < 20; i++) {
          const dst = await engine.upsertNode(1, `lt-nb-${i}`, { props: {} })
          await engine.upsertEdge(src, dst, 1, { props: {} })
        }
        const timings: number[] = []
        for (let r = 0; r < 5; r++) {
          const t0 = performance.now()
          engine.neighbors(src)
          timings.push(performance.now() - t0)
        }
        timings.sort((a, b) => a - b)
        console.log(`[BENCH][latency] neighbors (20 edges, 5 runs): median=${timings[2].toFixed(3)} ms`)
        expect(timings[0]).toBeGreaterThanOrEqual(0)
      } finally { engine.close() }
    }, 30000)

})
  // ── V37: More latency patterns ──
  it('V37-lat: edge upsert latency (1 edge)', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-l1' })
    await engine.open()
    try {
      const a = await engine.upsertNode(1, 'a', { props: {} })
      const b = await engine.upsertNode(1, 'b', { props: {} })
      const start = performance.now()
      await engine.upsertEdge(a, b, 1, { props: {} })
      const elapsed = performance.now() - start
      console.log(`[BENCH] edgeUpsert 1: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 30000)

  it('V37-lat: edge upsert latency (10 edges)', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-l2' })
    await engine.open()
    try {
      const a = await engine.upsertNode(1, 'a', { props: {} })
      const times: number[] = []
      for (let i = 0; i < 10; i++) {
        const b = await engine.upsertNode(1, `b${i}`, { props: {} })
        const start = performance.now()
        await engine.upsertEdge(a, b, 1, { props: {} })
        times.push(performance.now() - start)
      }
      const avg = times.reduce((s, t) => s + t, 0) / times.length
      const p99 = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.99)]
      console.log(`[BENCH] edgeUpsert 10: avg=${avg.toFixed(3)}ms p99=${p99.toFixed(3)}ms`)
    } finally { engine.close() }
  }, 30000)

  it('V37-lat: getNode with props (100 nodes)', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-l3' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) {
        ids.push(await engine.upsertNode(1, `n${i}`, { props: { seq: i, name: `user${i}`, active: true } }))
      }
      const start = performance.now()
      for (const id of ids) {
        engine.getNode(id)
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] getNode 100 (with props): ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 30000)

  it('V37-lat: scanAllNodes with large props (50 nodes)', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-l4' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i, desc: 'x'.repeat(100) } })
      }
      const start = performance.now()
      const all = engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scanAllNodes 50 (large props): ${elapsed.toFixed(2)}ms count=${all.length}`)
      expect(all.length).toBe(50)
    } finally { engine.close() }
  }, 30000)

  it('V37-lat: scanAllNodes with large props (200 nodes)', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-l5' })
    await engine.open()
    try {
      for (let i = 0; i < 200; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i, desc: 'x'.repeat(100) } })
      }
      const start = performance.now()
      const all = engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scanAllNodes 200 (large props): ${elapsed.toFixed(2)}ms count=${all.length}`)
      expect(all.length).toBe(200)
    } finally { engine.close() }
  }, 30000)
  // ── V37-norun 更多延迟 ──
  it('V37-nr: upsertNode latency 200 nodes measure sum', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lt1' })
    await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 200; i++) await engine.upsertNode(1, `lt${i}`, { props: { seq: i } })
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsert 200 latency sum: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: upsertNode latency 500 nodes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lt2' })
    await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 500; i++) await engine.upsertNode(1, `lt${i}`, { props: { seq: i } })
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsert 500 latency sum: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 180000)

  it('V37-nr: scanAllNodes latency 200', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lt3' })
    await engine.open()
    try {
      for (let i = 0; i < 200; i++) await engine.upsertNode(1, `lt${i}`, { props: { seq: i } })
      const start = performance.now()
      engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scanAllNodes 200: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: scanAllNodes latency 500', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lt4' })
    await engine.open()
    try {
      for (let i = 0; i < 500; i++) await engine.upsertNode(1, `lt${i}`, { props: { seq: i } })
      const start = performance.now()
      engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scanAllNodes 500: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 120000)

  // ── V38: 更多延迟 ──
  it('V38-lat: upsertNode 80 measure sum', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-lat-1' })
    await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 80; i++) await engine.upsertNode(1, `l${i}`, { props: { seq: i } })
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsert 80: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 30000)

  it('V38-lat: upsertNode 150 measure sum', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-lat-2' })
    await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 150; i++) await engine.upsertNode(1, `l${i}`, { props: { seq: i } })
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsert 150: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 60000)

  it('V38-lat: scanAllNodes 80 measure', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-lat-3' })
    await engine.open()
    try {
      for (let i = 0; i < 80; i++) await engine.upsertNode(1, `l${i}`, { props: { seq: i } })
      const start = performance.now()
      engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scan 80: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 30000)

  it('V38-lat: scanAllNodes 150 measure', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-lat-4' })
    await engine.open()
    try {
      for (let i = 0; i < 150; i++) await engine.upsertNode(1, `l${i}`, { props: { seq: i } })
      const start = performance.now()
      engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scan 150: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 60000)

  it('V38-lat: upsertEdge 20 measure', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-lat-5' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'hub', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 20; i++) {
        const dst = await engine.upsertNode(1, `d${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: {} })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsertEdge 20: ${elapsed.toFixed(2)}ms`)
    } finally { engine.close() }
  }, 30000)

  // ── V38-cont more ──
  it('V38c: getNode after upsert measure', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-l1' })
    await e.open()
    try {
      const id = await e.upsertNode(1, 't', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 10; i++) e.getNode(id)
      const elapsed = performance.now() - start
      console.log(`[BENCH] getNode 10x: ${elapsed.toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V38c: scan then getNode cycle', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-l2' })
    await e.open()
    try {
      const ids = []
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { v: i } }))
      const start = performance.now()
      for (let i = 0; i < 10; i++) { e.scanAllNodes(); e.getNode(ids[0]) }
      const elapsed = performance.now() - start
      console.log(`[BENCH] scan+get cycle 10x: ${elapsed.toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V38c: upsertEdge single latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-l3' })
    await e.open()
    try {
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(1, 'b', { props: {} })
      const start = performance.now()
      await e.upsertEdge(a, b, 1, { props: {} })
      console.log(`[BENCH] single edge: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  // ── V39 latency ──
  it('V39: upsert 40 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-l1' })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 40; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      console.log(`[BENCH] upsert 40: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V39: upsert 100 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-l2' })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 100; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      console.log(`[BENCH] upsert 100: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 60000)

  it('V39: scan 40 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-l3' })
    await e.open()
    try {
      for (let i = 0; i < 40; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const start = performance.now()
      e.scanAllNodes()
      console.log(`[BENCH] scan 40: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V39: scan 100 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-l4' })
    await e.open()
    try {
      for (let i = 0; i < 100; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const start = performance.now()
      e.scanAllNodes()
      console.log(`[BENCH] scan 100: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 60000)

  it('V39: scan 200 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-l5' })
    await e.open()
    try {
      for (let i = 0; i < 200; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const start = performance.now()
      e.scanAllNodes()
      console.log(`[BENCH] scan 200: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 120000)
  // ── V40 latency ──
  it('V40: upsertNode 60 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-l1' })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 60; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      console.log(`[BENCH] upsert 60: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V40: scan 60 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-l2' })
    await e.open()
    try {
      for (let i = 0; i < 60; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const start = performance.now(); e.scanAllNodes()
      console.log(`[BENCH] scan 60: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V40: upsertEdge 5 + scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-l3' })
    await e.open()
    try {
      const h = await e.upsertNode(1, 'h', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 5; i++) {
        const l = await e.upsertNode(1, `l${i}`, { props: {} })
        await e.upsertEdge(h, l, 1, { props: {} })
      }
      console.log(`[BENCH] 5 edges + 5 nodes: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V40: deleteNode then getNode', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-l4' })
    await e.open()
    try {
      const id = await e.upsertNode(1, 'del', { props: {} })
      e.deleteNode(id)
      const start = performance.now()
      e.getNode(id)
      console.log(`[BENCH] getNode after delete: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
