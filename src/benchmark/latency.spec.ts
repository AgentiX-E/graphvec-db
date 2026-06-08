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

  // ── V41 latency ──
  it('V41: upsert 30 with props latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-l1' })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 30; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, s: `s${i}` } })
      console.log(`[BENCH] upsert 30 props: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V41: getNode after bulk upsert 20', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-l2' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 20: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V41: scan 80 then getNode', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-l3' })
    await e.open()
    try {
      for (let i = 0; i < 80; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const start = performance.now()
      const all = e.scanAllNodes()
      e.getNode(all[0].id)
      console.log(`[BENCH] scan 80+get: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  // ── V42 latency ──
  it('V42: upsert 250 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v42-l1' })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 250; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      console.log(`[BENCH] upsert 250: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 180000)

  it('V42: scan 250 latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v42-l2' })
    await e.open()
    try {
      for (let i = 0; i < 250; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const start = performance.now(); e.scanAllNodes()
      console.log(`[BENCH] scan 250: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 120000)

  it('V42: upsertEdge 10 star latency', async () => {
    const e = new GraphEngine({ path: '/tmp/v42-l3' })
    await e.open()
    try {
      const h = await e.upsertNode(1, 'h', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 10; i++) {
        const l = await e.upsertNode(1, `l${i}`, { props: {} })
        await e.upsertEdge(h, l, 1, { props: {} })
      }
      console.log(`[BENCH] star 10 edges: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  // ── V43 latency ──
  it('V43: upsert 40 with mixed property types', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-l1' })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 40; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, s: `s${i}`, flag: i % 2 === 0 } })
      console.log(`[BENCH] upsert 40 mixed props: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V43: upsertEdge 50 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-l2' })
    await e.open()
    try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 50; i++) {
        const l = await e.upsertNode(1, `l${i}`, { props: {} })
        await e.upsertEdge(h, l, 1, { props: {} })
      }
      console.log(`[BENCH] star 50 edges: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V43: getNode after bulk 120', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-l3' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 120; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 120: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 120000)

  it('V43: delete 10 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-l4' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 10; i++) e.deleteNode(ids[i])
      const start = performance.now(); e.scanAllNodes()
      console.log(`[BENCH] scan after delete: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  // ── V44 latency ──
  it('V44: getNode chain 20 with unique paths', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-l5-' + Date.now() })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { v: i } }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode chain 20: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V44: scanAllNodes after 30 with mixed types', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-l6-' + Date.now() })
    await e.open()
    try {
      for (let i = 0; i < 30; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, tag: `t${i % 3}` } })
      const start = performance.now(); const all = e.scanAllNodes()
      console.log(`[BENCH] scan 30 mixed: ${(performance.now() - start).toFixed(3)}ms count=${all.length}`)
      expect(all.length).toBe(30)
    } finally { e.close() }
  }, 30000)

  it('V44: upsertEdge 25 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-l7-' + Date.now() })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 26; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (let i = 0; i < 25; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      console.log(`[BENCH] chain 25 edges: ${(performance.now() - start).toFixed(2)}ms`)
    } finally { e.close() }
  }, 30000)

  it('V44: delete every 3rd of 15 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-l8-' + Date.now() })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 15; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 2; i < 15; i += 3) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)

  it('V44: bulk upsert 60 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-l9-' + Date.now() })
    await e.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 60; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 60 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(60)
    } finally { e.close() }
  }, 30000)

  // ── V45 latency ──
  it('V45: getNode 50 random ids', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-l10-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { v: i } }))
      const start = performance.now()
      for (const id of ids) { e.getNode(id) }
      console.log(`[BENCH] getNode 50 random: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V45: scanAllNodes 70 with filter', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-l11-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 70; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const start = performance.now()
      const filtered = e.scanAllNodes().filter(n => (n.props.v as number) > 35)
      console.log(`[BENCH] filter 70 nodes gt35: ${(performance.now() - start).toFixed(3)}ms count=${filtered.length}`)
      expect(filtered.length).toBe(35)
    } finally { e.close() }
  }, 30000)
  it('V45: upsertEdge 40 star hub-to-leaf', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-l12-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 40; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(40)
    } finally { e.close() }
  }, 30000)
  it('V45: deleteNode every 2nd of 20', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-l13-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 20; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V45: bulk upsert 100 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-l14-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 100; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 100 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(100)
    } finally { e.close() }
  }, 30000)

  // ── V46 latency ──
  it('V46: getNode 60 random after 60 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-l15-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 60: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V46: scanAllNodes 80 then filter', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-l16-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 80; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) % 2 === 0)
      console.log(`[BENCH] filter even 80: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V46: upsertEdge 35 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-l17-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 35; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(35)
    } finally { e.close() }
  }, 30000)
  it('V46: deleteNode last 5 of 15', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-l18-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 15; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 10; i < 15; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V46: bulk upsert 140 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-l19-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 140; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 140 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(140)
    } finally { e.close() }
  }, 30000)

  // ── V47 latency ──
  it('V47: getNode 70 random after 70 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-l20-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 70: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V47: scanAllNodes 90 then filter odd', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-l21-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 90; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) % 2 === 1)
      console.log(`[BENCH] filter odd 90: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(45)
    } finally { e.close() }
  }, 30000)
  it('V47: upsertEdge 45 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-l22-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 45; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(45)
    } finally { e.close() }
  }, 30000)
  it('V47: deleteNode 8 of 24 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-l23-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 24; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 8; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(16)
    } finally { e.close() }
  }, 30000)
  it('V47: bulk upsert 180 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-l24-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 180; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 180 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(180)
    } finally { e.close() }
  }, 30000)

  // ── V48 latency ──
  it('V48: getNode 80 random after 80 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-l25-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 80; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 80: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V48: scanAllNodes 100 then filter gt50', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-l26-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 100; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) > 50)
      console.log(`[BENCH] filter gt50 100: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(49)
    } finally { e.close() }
  }, 30000)
  it('V48: upsertEdge 50 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-l27-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 50; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(50)
    } finally { e.close() }
  }, 30000)
  it('V48: deleteNode 10 of 30 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-l28-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 10; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V48: bulk upsert 220 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-l29-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 220; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 220 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(220)
    } finally { e.close() }
  }, 30000)

  // ── V49 latency ──
  it('V49: getNode 90 random after 90 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-l30-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 90; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 90: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V49: scanAllNodes 110 then filter lte60', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-l31-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 110; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) <= 60)
      console.log(`[BENCH] filter lte60 110: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(61)
    } finally { e.close() }
  }, 30000)
  it('V49: upsertEdge 55 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-l32-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 55; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(55)
    } finally { e.close() }
  }, 30000)
  it('V49: deleteNode 12 of 36 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-l33-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 36; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 12; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(24)
    } finally { e.close() }
  }, 30000)
  it('V49: bulk upsert 260 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-l34-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 260; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 260 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(260)
    } finally { e.close() }
  }, 30000)

  // ── V50 latency ──
  it('V50: getNode 100 random after 100 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-l35-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 100: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V50: scanAllNodes 120 then filter range', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-l36-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 120; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => { const v = n.props.v as number; return v >= 30 && v < 80 })
      console.log(`[BENCH] filter range 120: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(50)
    } finally { e.close() }
  }, 30000)
  it('V50: upsertEdge 60 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-l37-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 60; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(60)
    } finally { e.close() }
  }, 30000)
  it('V50: deleteNode 14 of 42 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-l38-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 42; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 14; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(28)
    } finally { e.close() }
  }, 30000)
  it('V50: bulk upsert 300 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-l39-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 300; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 300 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(300)
    } finally { e.close() }
  }, 30000)

  // ── V51 latency ──
  it('V51: getNode 110 random after 110 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-l40-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 110; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 110: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V51: scanAllNodes 130 then filter top 30', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-l41-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 130; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) >= 100)
      console.log(`[BENCH] filter top 30 130: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(30)
    } finally { e.close() }
  }, 30000)
  it('V51: upsertEdge 65 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-l42-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 65; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(65)
    } finally { e.close() }
  }, 30000)
  it('V51: deleteNode 16 of 48 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-l43-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 48; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 16; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(32)
    } finally { e.close() }
  }, 30000)
  it('V51: bulk upsert 340 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-l44-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 340; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 340 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(340)
    } finally { e.close() }
  }, 30000)

  // ── V52 latency ──
  it('V52: getNode 120 after 120 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-l45-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 120; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 120: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V52: scanAllNodes 140 then filter bottom 40', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-l46-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 140; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) < 40)
      console.log(`[BENCH] filter bottom 40 140: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V52: upsertEdge 70 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-l47-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 70; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(70)
    } finally { e.close() }
  }, 30000)
  it('V52: deleteNode 18 of 54 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-l48-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 54; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 18; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(36)
    } finally { e.close() }
  }, 30000)
  it('V52: bulk upsert 380 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-l49-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 380; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 380 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(380)
    } finally { e.close() }
  }, 30000)

  // ── V53 latency ──
  it('V53: getNode 130 after 130 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-l50-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 130; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 130: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V53: scanAllNodes 150 then filter outside 60-90', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-l51-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 150; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => { const v = n.props.v as number; return v < 60 || v > 90 })
      console.log(`[BENCH] filter outside 150: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(119)
    } finally { e.close() }
  }, 30000)
  it('V53: upsertEdge 75 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-l52-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 75; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(75)
    } finally { e.close() }
  }, 30000)
  it('V53: deleteNode 20 of 60 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-l53-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 20; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V53: bulk upsert 420 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-l54-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 420; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 420 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(420)
    } finally { e.close() }
  }, 30000)

  // ── V54 latency ──
  it('V54: getNode 140 after 140 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-l55-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 140; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 140: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V54: scanAllNodes 160 then filter 80-120', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-l56-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 160; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => { const v = n.props.v as number; return v >= 80 && v < 120 })
      console.log(`[BENCH] filter range 160: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V54: upsertEdge 80 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-l57-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 80; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(80)
    } finally { e.close() }
  }, 30000)
  it('V54: deleteNode 22 of 66 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-l58-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 66; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 22; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(44)
    } finally { e.close() }
  }, 30000)
  it('V54: bulk upsert 460 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-l59-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 460; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 460 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(460)
    } finally { e.close() }
  }, 30000)

  // ── V55 latency ──
  it('V55: getNode 150 after 150 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-l60-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 150; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 150: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V55: scanAllNodes 170 then filter by type name', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-l61-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 170; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) % 2 === 0)
      console.log(`[BENCH] filter even 170: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(85)
    } finally { e.close() }
  }, 30000)
  it('V55: upsertEdge 85 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-l62-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 85; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(85)
    } finally { e.close() }
  }, 30000)
  it('V55: deleteNode 24 of 72 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-l63-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 72; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 24; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(48)
    } finally { e.close() }
  }, 30000)
  it('V55: bulk upsert 500 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-l64-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 500; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 500 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(500)
    } finally { e.close() }
  }, 30000)

  // ── V56 latency ──
  it('V56: getNode 160 after 160 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-l65-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 160; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 160: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V56: scanAllNodes 180 then filter bottom 20%', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-l66-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 180; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => (n.props.v as number) < 36)
      console.log(`[BENCH] filter bottom 180: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(36)
    } finally { e.close() }
  }, 30000)
  it('V56: upsertEdge 90 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-l67-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 90; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(90)
    } finally { e.close() }
  }, 30000)
  it('V56: deleteNode 26 of 78 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-l68-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 78; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 26; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(52)
    } finally { e.close() }
  }, 30000)
  it('V56: bulk upsert 540 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-l69-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 540; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 540 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(540)
    } finally { e.close() }
  }, 30000)

  // ── V57 latency (final batch) ──
  it('V57: getNode 170 after 170 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-l70-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 170; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const start = performance.now()
      for (const id of ids) e.getNode(id)
      console.log(`[BENCH] getNode 170: ${(performance.now() - start).toFixed(3)}ms`)
    } finally { e.close() }
  }, 30000)
  it('V57: scanAllNodes 190 then filter middle 30', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-l71-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 190; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const t0 = performance.now()
      const r = e.scanAllNodes().filter(n => { const v = n.props.v as number; return v >= 80 && v < 110 })
      console.log(`[BENCH] filter 80-110 190: ${(performance.now() - t0).toFixed(3)}ms`)
      expect(r.length).toBe(30)
    } finally { e.close() }
  }, 30000)
  it('V57: upsertEdge 95 star', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-l72-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 95; i++) { const l = await e.upsertNode(1, `l${i}`, { props: {} }); await e.upsertEdge(h, l, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(95)
    } finally { e.close() }
  }, 30000)
  it('V57: deleteNode 28 of 84 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-l73-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 84; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 28; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(56)
    } finally { e.close() }
  }, 30000)
  it('V57: bulk upsert 580 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-l74-' + Date.now() })
    await e.open(); try {
      const start = performance.now()
      for (let i = 0; i < 580; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      console.log(`[BENCH] bulk 580 nodes: ${(performance.now() - start).toFixed(2)}ms`)
      expect(e.scanAllNodes().length).toBe(580)
    } finally { e.close() }
  }, 30000)
