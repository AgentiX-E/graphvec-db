/**
 * Stability Benchmark Suite (10+ tests)
 *
 * Measures engine stability under sustained load:
 *   - Continuous writes for 1 minute
 *   - Mixed read/write for 30 seconds
 *   - Large numbers of small transactions
 *   - Performance consistency over time
 *
 * Each test outputs console.log with ms/op, ops/sec, and stability metrics.
 * All tests timeout=120000.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function randomDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-stability-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = randomDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

// Helper: compute stats from timing array
function summarizeTimings(label: string, timings: number[], labelExtra?: string): void {
  timings.sort((a, b) => a - b)
  const n = timings.length
  const total = timings.reduce((a, b) => a + b, 0)
  const avg = total / n
  const median = n % 2 === 0 ? (timings[n / 2 - 1] + timings[n / 2]) / 2 : timings[Math.floor(n / 2)]
  const p95 = timings[Math.floor(n * 0.95)]
  const p99 = timings[Math.floor(n * 0.99)]
  const min = timings[0]
  const max = timings[n - 1]
  const opsPerSec = 1000 / avg

  const extra = labelExtra ? ` (${labelExtra})` : ''
  console.log(`[BENCH][stability] ${label}${extra}`)
  console.log(`  Samples: ${n}`)
  console.log(`  Total:   ${total.toFixed(1)} ms`)
  console.log(`  Avg:     ${avg.toFixed(3)} ms/op`)
  console.log(`  Median:  ${median.toFixed(3)} ms/op`)
  console.log(`  P95:     ${p95.toFixed(3)} ms`)
  console.log(`  P99:     ${p99.toFixed(3)} ms`)
  console.log(`  Min:     ${min.toFixed(3)} ms`)
  console.log(`  Max:     ${max.toFixed(3)} ms`)
  console.log(`  Range:   ${(max - min).toFixed(3)} ms`)
  console.log(`  Ops/sec: ${opsPerSec.toFixed(0)}`)

  // Jitter metric: coefficient of variation
  const variance = timings.reduce((sum, t) => sum + (t - avg) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  const cv = (stddev / avg) * 100
  console.log(`  StdDev:  ${stddev.toFixed(3)} ms (CV: ${cv.toFixed(1)}%)`)
}

describe('Stability Benchmarks', () => {

  // ── Setup ──
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR, denseVector: { dimension: 384 } })
    engine.open()

    // Seed initial data
    for (let i = 0; i < 500; i++) {
      engine.upsertNode(1, `st-seed-${i}`, { props: { seq: i } })
    }
    const allNodes = engine.scanAllNodes()
    for (let i = 0; i < allNodes.length - 1; i++) {
      engine.upsertEdge(allNodes[i].id, allNodes[i + 1].id, 10, { props: { weight: 1 } })
    }
    console.log(`[SETUP] Stability bench seed: ${engine.scanAllNodes().length} nodes`)
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ════════════════════════════════════════════════════════════════
  // 1.  Continuous write stability (2000 ops)
  // ════════════════════════════════════════════════════════════════

  it('should maintain stable write performance over 2000 sequential upsertNodes', async () => {
    const count = 2000
    const timings: number[] = []

    for (let i = 0; i < count; i++) {
      const t0 = performance.now()
      await engine.upsertNode(1000, `st-cw-${i}`, { props: { seq: i, payload: 'x'.repeat(64) } })
      timings.push(performance.now() - t0)
    }

    summarizeTimings('2000 sequential writes', timings)
  }, 120000)

  it('should maintain stable write performance over 5000 sequential upsertNodes', async () => {
    const count = 5000
    const timings: number[] = []

    for (let i = 0; i < count; i++) {
      const t0 = performance.now()
      await engine.upsertNode(1001, `st-cw2-${i}`, { props: { seq: i } })
      timings.push(performance.now() - t0)
    }

    summarizeTimings('5000 sequential writes', timings)
  }, 120000)

  it('should maintain stable burst write performance (concurrent batches)', async () => {
    const batches = 20
    const batchSize = 100
    const timings: number[] = []

    for (let b = 0; b < batches; b++) {
      const t0 = performance.now()
      const promises = Array.from({ length: batchSize }, (_, i) => {
        return engine.upsertNode(1002, `st-burst-${b}-${i}`, { props: { seq: b * batchSize + i } })
      })
      await Promise.all(promises)
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${batches} concurrent bursts (${batchSize} each)`, timings,
      `batch=${batchSize}, bursts=${batches}`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 2.  Mixed read/write stability (30-second equivalent)
  // ════════════════════════════════════════════════════════════════

  it('should maintain stable mixed r/w performance (500 iterations)', async () => {
    const iterations = 500
    const timings: number[] = []
    let nodeIdx = 100000000

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()

      // Rotate between write, read, and neighbor operations
      if (i % 4 === 0) {
        // Write node + edge
        const id = await engine.upsertNode(2000, `st-mix-${i}`, { props: { seq: nodeIdx++ } })
        const allNodes = engine.scanAllNodes()
        if (allNodes.length > 1) {
          await engine.upsertEdge(id, allNodes[0].id, 20, { props: { weight: 0.5 } })
        }
      } else if (i % 4 === 1) {
        // Query
        engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 10')
      } else if (i % 4 === 2) {
        // Neighbors
        engine.batchNeighbors([0])
      } else {
        // Full scan + filter
        const allNodes = engine.scanAllNodes()
        allNodes.filter((n: any) => n.props?.seq !== undefined)
      }

      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} mixed r/w ops (rotating)`, timings)
  }, 120000)

  it('should maintain stable mixed r/w with query focus (1000 iterations)', async () => {
    const iterations = 1000
    const timings: number[] = []

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()

      if (i % 10 === 0) {
        // Every 10th op is a write
        await engine.upsertNode(2001, `st-mq-${i}`, { props: { seq: i } })
      } else if (i % 3 === 0) {
        engine.query('MATCH (n) WHERE n.seq > 0 RETURN n.name, n.seq LIMIT 5')
      } else if (i % 3 === 1) {
        engine.query('MATCH (n) RETURN n.name LIMIT 10')
      } else {
        engine.batchNeighbors([i % 500])
      }

      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} mixed r/w (query-heavy)`, timings)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 3.  Many small transactions
  // ════════════════════════════════════════════════════════════════

  it('should handle many small transactions (500 single-node upsertNode calls)', async () => {
    const count = 500
    const timings: number[] = []

    for (let i = 0; i < count; i++) {
      const t0 = performance.now()
      await engine.upsertNode(3000, `st-txn-${i}`, { props: { seq: i, label: 'tiny-txn' } })
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${count} tiny upsertNode transactions`, timings)
  }, 120000)

  it('should handle many small edge transactions (500 single-edge upsertEdge)', async () => {
    const allNodes = engine.scanAllNodes()
    const count = Math.min(500, allNodes.length - 1)
    const timings: number[] = []

    for (let i = 0; i < count; i++) {
      const src = allNodes[i % (allNodes.length - 1)]
      const dst = allNodes[(i + 3) % allNodes.length]
      const t0 = performance.now()
      await engine.upsertEdge(src.id, dst.id, 30, { props: { weight: Math.random() } })
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${count} tiny upsertEdge transactions`, timings)
  }, 120000)

  it('should handle many small query transactions (500 MATCH LIMIT 1 queries)', () => {
    const count = 500
    const timings: number[] = []

    for (let i = 0; i < count; i++) {
      const t0 = performance.now()
      engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 1')
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${count} tiny MATCH queries (LIMIT 1)`, timings)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 4.  Performance consistency (latency jitter)
  // ════════════════════════════════════════════════════════════════

  it('should show consistent latency across 1000 fast operations', () => {
    const iterations = 1000
    const timings: number[] = []

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()

      // Fast rotating mix
      if (i % 5 === 0) {
        engine.query('MATCH (n) RETURN n.name LIMIT 5')
      } else if (i % 5 === 1) {
        engine.query('MATCH (n) WHERE n.seq >= 0 RETURN n.name LIMIT 3')
      } else if (i % 5 === 2) {
        engine.batchNeighbors([i % 500])
      } else {
        engine.scanAllNodes()
      }

      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} fast ops (latency consistency)`, timings)
  }, 120000)

  it('should show consistent latency across 2000 fast ops (write + read mix)', async () => {
    const iterations = 2000
    const timings: number[] = []

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()

      if (i % 20 === 0) {
        // Write every 20th op
        await engine.upsertNode(4000, `st-cons-${i}`, { props: { seq: i } })
      } else if (i % 4 === 0) {
        engine.query('MATCH (n) RETURN n.name LIMIT 10')
      } else if (i % 4 === 1) {
        engine.query('MATCH (n) WHERE n.seq > 0 RETURN n.name LIMIT 5')
      } else if (i % 4 === 2) {
        engine.batchNeighbors([i % 500])
      } else {
        engine.scanAllNodes()
      }

      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} fast ops (write+read consistency)`, timings)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 5.  Warm cache vs cold cache stability
  // ════════════════════════════════════════════════════════════════

  it('should show stable performance with warm cache (100 repeat queries)', () => {
    const iterations = 100
    const timings: number[] = []

    // Warm the cache
    for (let i = 0; i < 10; i++) {
      engine.query('MATCH (n) WHERE n.seq >= 0 RETURN n.name, n.seq LIMIT 20')
    }

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      engine.query('MATCH (n) WHERE n.seq >= 0 RETURN n.name, n.seq LIMIT 20')
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} warm-cache queries`, timings, 'pattern: MATCH WHERE LIMIT')
  }, 120000)

  it('should show stable neighbor lookups with warm cache (100 calls)', () => {
    const iterations = 100
    const timings: number[] = []

    // Warm the neighbor cache
    for (let i = 0; i < 10; i++) {
      engine.batchNeighbors([i % 500], { maxDepth: 1 })
    }

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      engine.batchNeighbors([i % 500], { maxDepth: 1 })
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} warm-cache neighbors`, timings, 'maxDepth=1')
  }, 120000)

  it('should show stable performance under rotating query patterns (500 calls)', () => {
    const iterations = 500
    const timings: number[] = []

    const patterns = [
      () => engine.query('MATCH (n) RETURN n.name LIMIT 5'),
      () => engine.query('MATCH (n) WHERE n.seq >= 0 RETURN n.name, n.seq LIMIT 10'),
      () => engine.batchNeighbors([0]),
      () => { engine.scanAllNodes(); return; },
    ]

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      patterns[i % patterns.length]()
      timings.push(performance.now() - t0)
    }

    summarizeTimings(`${iterations} rotating query patterns`, timings, '4 patterns')
  }, 120000)
})
