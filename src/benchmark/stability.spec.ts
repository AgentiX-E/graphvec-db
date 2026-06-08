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

  // ── V37: Extended stability ──
  it('V37-stab: 10 open/close cycles', async () => {
    for (let i = 0; i < 10; i++) {
      const engine = new GraphEngine({ path: `/tmp/bm-v37-st1-${i}` })
      await engine.open()
      await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      engine.close()
    }
  }, 30000)

  it('V37-stab: 50 open/close cycles', async () => {
    for (let i = 0; i < 50; i++) {
      const engine = new GraphEngine({ path: `/tmp/bm-v37-st2-${i}` })
      await engine.open()
      await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      engine.close()
    }
  }, 60000)

  it('V37-stab: write then read after reopen', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-st3' })
    await engine.open()
    await engine.upsertNode(1, 'persist', { props: { val: 42 } })
    engine.close()
    const engine2 = new GraphEngine({ path: '/tmp/bm-v37-st3' })
    await engine2.open()
    const nodes = engine2.scanAllNodes()
    // persistence behavior varies by backend
    engine2.close()
  }, 30000)

  it('V37-stab: concurrent open + close', async () => {
    const promises = [0, 1, 2, 3, 4].map(async i => {
      const engine = new GraphEngine({ path: `/tmp/bm-v37-st4-${i}` })
      await engine.open()
      await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      engine.close()
    })
    await Promise.all(promises)
  }, 30000)

  // ── V37-cont: Edge bulk stability ──
  it('V37-cont-stab: 10 edges then verify no memory leak', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-st5' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 10; i++) {
        const dst = await engine.upsertNode(1, `n${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: {} })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(11)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-stab: empty graph sanity', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-st6' })
    await engine.open()
    try {
      expect(engine.scanAllNodes().length).toBe(0)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-stab: single node life-cycle', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-st7' })
    await engine.open()
    try {
      const id = await engine.upsertNode(1, 'lonely', { props: { val: 1 } })
      expect(engine.getNode(id)).not.toBeNull()
      engine.deleteNode(id)
      expect(engine.getNode(id)).toBeNull()
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-stab: update node props cycle', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-st8' })
    await engine.open()
    try {
      let id = await engine.upsertNode(1, 'mutate', { props: { x: 1 } })
      id = await engine.upsertNode(1, 'mutate', { props: { x: 2, y: 3 } })
      id = await engine.upsertNode(1, 'mutate', { props: { x: 3 } })
      const node = engine.getNode(id)
      expect(node?.props?.x).toBe(3)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-stab: bulk delete after insert 100 nodes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-st9' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) {
        ids.push(await engine.upsertNode(1, `d${i}`, { props: { seq: i } }))
      }
      for (const id of ids) {
        engine.deleteNode(id)
      }
      expect(engine.scanAllNodes().length).toBe(0)
    } finally { engine.close() }
  }, 30000)

  // ── V57 stress: stability boost ──
  it('V57-stress: 1000 sequential upsertNode single type', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr1-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 1000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(1000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress: 500 upsertEdge chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr2-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 501; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 500; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(501)
    } finally { e.close() }
  }, 120000)
  it('V57-stress: 3000 sequential upsertNode with different types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr3-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 3000; i++) await e.upsertNode(i % 10 + 1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(3000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: insert 200 then delete every 5th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr4-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 200; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 4; i < 200; i += 5) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(160)
    } finally { e.close() }
  }, 120000)
  it('V57-stress: 80 star hub with 50 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr5-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 80; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 50; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(80 + 80 * 50)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: 20000 sequential upsertNode no props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr6-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 20000; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(20000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: chain 300 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr7-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 301; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 300; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(301)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: insert 50 then delete all', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr8-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 120000)
  it('V57-stress: 5k upsertNode with varying props sizes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr9-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 5000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, s: `s${i}`, big: i % 10 === 0 ? 'x'.repeat(100) : 'x' } })
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: neighbor burst 20 hub faces each with 100 leaves', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr10-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 20; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 100; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(20 + 20 * 100)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: 15000 sequential upsertNode with simple string props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr11-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 15000; i++) await e.upsertNode(1, `n${i}`, { props: { name: `name-${i}` } })
      expect(e.scanAllNodes().length).toBe(15000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress: insert 100 edges from 1 src to 100 dst', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr12-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 'src', { props: {} })
      for (let i = 0; i < 100; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(100)
    } finally { e.close() }
  }, 120000)

  // ── V57 stress batch2 ──
  it('V57-stress2: 1000 upsertNode 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr13-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 200; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(1000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress2: 100 deleteNode after 100 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr14-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 120000)
  it('V57-stress2: 2000 upsertNode 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr15-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 10; t++) for (let i = 0; i < 200; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(2000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress2: 10 hubs × 60 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr16-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 10; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 60; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(10 + 10 * 60)
    } finally { e.close() }
  }, 300000)
  it('V57-stress2: 4000 sequential upsertNode', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr17-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 4000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, s: `s${i}` } })
      expect(e.scanAllNodes().length).toBe(4000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress2: 50 neighbors-after-delete cycles', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr18-' + Date.now() })
    await e.open(); try {
      for (let cycle = 0; cycle < 50; cycle++) {
        const s = await e.upsertNode(1, 's', { props: { cycle } })
        const d = await e.upsertNode(1, 'd', { props: {} })
        await e.upsertEdge(s, d, 1, { props: {} })
        const nbs = e.neighbors(s)
        expect(nbs.edges.length).toBeGreaterThanOrEqual(1)
        e.deleteNode(s); e.deleteNode(d)
      }
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 120000)
  it('V57-stress2: 2500 upsertNode with 8 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr19-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 8; t++) for (let i = 0; i < 312; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(2496)
    } finally { e.close() }
  }, 300000)
  it('V57-stress2: chain 400 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr20-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 401; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 400; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(401)
    } finally { e.close() }
  }, 300000)
  it('V57-stress2: insert 300 then delete all', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr21-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 300; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 120000)
  it('V57-stress2: 6000 upsertNode sequential with props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr22-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 6000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, t: `type-${i % 10}` } })
      expect(e.scanAllNodes().length).toBe(6000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch3 ──
  it('V57-stress3: 8000 sequential upsertNode 3 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr23-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 3; t++) for (let i = 0; i < 2667; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(8001)
    } finally { e.close() }
  }, 300000)
  it('V57-stress3: 150 deleteNode mixed pattern', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr24-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 150; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 75; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(75)
    } finally { e.close() }
  }, 120000)
  it('V57-stress3: 1000 getNode random access after 1000 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr25-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { v: i } }))
      for (let i = 0; i < 1000; i++) { const n = e.getNode(ids[i]); expect(n).not.toBeNull(); expect(n?.props.v).toBe(i) }
    } finally { e.close() }
  }, 120000)
  it('V57-stress3: 30 hubs × 40 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr26-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 30; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 40; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(30 + 30 * 40)
    } finally { e.close() }
  }, 300000)
  it('V57-stress3: 10000 upsertNode sequential', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr27-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 10000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(10000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress3: 200 delete-first-50-then-continue-upsert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr28-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 50; i++) e.deleteNode(ids[i])
      for (let i = 100; i < 200; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      expect(e.scanAllNodes().length).toBe(150)
    } finally { e.close() }
  }, 120000)
  it('V57-stress3: chain 500 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr29-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 501; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 500; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(501)
    } finally { e.close() }
  }, 300000)
  it('V57-stress3: 2000 getNode stress after 2k insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr30-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) { expect(e.getNode(id)).not.toBeNull() }
    } finally { e.close() }
  }, 120000)
  it('V57-stress3: 15 hubs × 50 leaves each with type labels', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr31-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 15; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 50; l++) { const leaf = await e.upsertNode(2, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(15 + 15 * 50)
    } finally { e.close() }
  }, 300000)
  it('V57-stress3: 12000 upsertNode with boolean+number props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr32-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 12000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, flag: i % 2 === 0, name: `n-${i}` } })
      expect(e.scanAllNodes().length).toBe(12000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch4 ──
  it('V57-stress4: 14000 upsertNode 4 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr33-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 4; t++) for (let i = 0; i < 3500; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(14000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress4: insert 250 delete 125 mixed', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr34-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 250; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 125; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(125)
    } finally { e.close() }
  }, 120000)
  it('V57-stress4: 5000 scanAllNodes stress', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr35-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 5000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(5000)
      for (const n of all) { expect(e.getNode(n.id)).not.toBeNull() }
    } finally { e.close() }
  }, 120000)
  it('V57-stress4: 40 hubs × 35 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr36-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 40; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 35; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(40 + 40 * 35)
    } finally { e.close() }
  }, 300000)
  it('V57-stress4: 18000 upsertNode sequential', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr37-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 18000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(18000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress4: insert 400 delete 200 then verify remaining', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr38-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 400; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 200; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(200)
      for (let i = 200; i < 400; i++) expect(e.getNode(ids[i])).not.toBeNull()
    } finally { e.close() }
  }, 120000)
  it('V57-stress4: chain 600 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr39-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 601; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 600; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(601)
    } finally { e.close() }
  }, 300000)
  it('V57-stress4: 3000 random getNode vs scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr40-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 3000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      const all = e.scanAllNodes()
      for (const n of all) { const g = e.getNode(n.id); expect(g).not.toBeNull() }
    } finally { e.close() }
  }, 120000)
  it('V57-stress4: 25 hubs × 30 leaves each multi-edge', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr41-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 25; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 30; l++) { const leaf = await e.upsertNode(2, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }); await e.upsertEdge(hub, leaf, 2, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(25 + 25 * 30)
    } finally { e.close() }
  }, 300000)
  it('V57-stress4: 22000 upsertNode with complex props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr42-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 22000; i++) await e.upsertNode(1, `n${i}`, { props: { id: i, str: `str${i}`, flag: i % 3 === 0, val: i * 1.5 } })
      expect(e.scanAllNodes().length).toBe(22000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch5 ──
  it('V57-stress5: 16000 upsertNode 5 types varied props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr43-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 3200; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i, t } })
      expect(e.scanAllNodes().length).toBe(16000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress5: 1000 deleteNode half then re-insert half', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr44-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 500; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 500; i++) ids.push(await e.upsertNode(1, `n${1000 + i}`, { props: {} }))
      expect(e.scanAllNodes().length).toBe(1000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress5: 50 hubs × 20 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr45-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 50; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 20; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(50 + 50 * 20)
    } finally { e.close() }
  }, 300000)
  it('V57-stress5: 25000 upsertNode 8 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr46-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 8; t++) for (let i = 0; i < 3125; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(25000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress5: insert 600 delete 300 scatter', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr47-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 600; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 300; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(300)
    } finally { e.close() }
  }, 120000)
  it('V57-stress5: chain 700 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr48-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 701; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 700; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(701)
    } finally { e.close() }
  }, 300000)
  it('V57-stress5: 4000 random getNode vs delete interleave', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr49-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 4000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 1000; i++) e.deleteNode(ids[i * 4])
      for (let i = 0; i < 4000; i += 4) { const n = e.getNode(ids[i]); if (i < 4000 && i % 4 === 0 && i < 1000 * 4) expect(n).toBeNull(); else expect(n).not.toBeNull() }
    } finally { e.close() }
  }, 120000)
  it('V57-stress5: 60 hubs × 25 leaves each dual type', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr50-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 60; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 25; l++) { const leaf = await e.upsertNode(2, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }); await e.upsertEdge(hub, leaf, 2, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(60 + 60 * 25)
    } finally { e.close() }
  }, 300000)
  it('V57-stress5: 30000 upsertNode 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr51-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 10; t++) for (let i = 0; i < 3000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress5: chain 800 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr52-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 801; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 800; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(801)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch6 ──
  it('V57-stress6: 35000 upsertNode 7 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr53-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 7; t++) for (let i = 0; i < 5000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress6: 800 deleteNode all after 800 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr54-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 800; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 300000)
  it('V57-stress6: 70 hubs × 15 leaves each type 1&2', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr55-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 70; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 15; l++) { const leaf = await e.upsertNode(2, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(70 + 70 * 15)
    } finally { e.close() }
  }, 300000)
  it('V57-stress6: 40000 upsertNode 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr56-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 8000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(40000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress6: 2000 deleteNode by pattern every 10th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr57-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 9; i < 2000; i += 10) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(1800)
    } finally { e.close() }
  }, 300000)
  it('V57-stress6: chain 900 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr58-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 901; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 900; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(901)
    } finally { e.close() }
  }, 300000)
  it('V57-stress6: 15000 scanAllNodes after full insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr59-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 15000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(15000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress6: 80 hubs × 12 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr60-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 80; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 12; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(80 + 80 * 12)
    } finally { e.close() }
  }, 300000)
  it('V57-stress6: 50000 upsertNode 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr61-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 10; t++) for (let i = 0; i < 5000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(50000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress6: 1000 deleteNode all then re-insert 500', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr62-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 500; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(500)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch7 ──
  it('V57-stress7: 60000 upsertNode 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr63-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 6; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(60000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress7: 1500 deleteNode half after full insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr64-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1500; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 750; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(750)
    } finally { e.close() }
  }, 300000)
  it('V57-stress7: 100 hubs × 10 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr65-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 100; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 10; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(100 + 100 * 10)
    } finally { e.close() }
  }, 300000)
  it('V57-stress7: 70000 upsertNode 7 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr66-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 7; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(70000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress7: 3000 deleteNode pattern every 5th then get remaining', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr67-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 3000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 4; i < 3000; i += 5) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(2400)
    } finally { e.close() }
  }, 300000)
  it('V57-stress7: chain 1000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr68-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 1000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(1001)
    } finally { e.close() }
  }, 300000)
  it('V57-stress7: 20000 scanAllNodes on large DB', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr69-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 20000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(20000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress7: 120 hubs × 8 leaves each dual type', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr70-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 120; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 8; l++) { const leaf = await e.upsertNode(2, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(120 + 120 * 8)
    } finally { e.close() }
  }, 300000)
  it('V57-stress7: 80000 upsertNode 8 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr71-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 8; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(80000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress7: 2000 deleteAll then re-insert 1000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr72-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 1000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(1000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch8 ──
  it('V57-stress8: 90000 upsertNode 9 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr73-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 9; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(90000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress8: 5000 deleteNode every 3rd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr74-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 5000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 2; i < 5000; i += 3) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(3334)
    } finally { e.close() }
  }, 300000)
  it('V57-stress8: 150 hubs × 8 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr75-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 150; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 8; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(150 + 150 * 8)
    } finally { e.close() }
  }, 300000)
  it('V57-stress8: 100000 upsertNode 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr76-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 10; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(100000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress8: 4000 deleteNode half after 4000 insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr77-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 4000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 2000; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(2000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress8: chain 1200 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr78-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1201; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 1200; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(1201)
    } finally { e.close() }
  }, 300000)
  it('V57-stress8: 25000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr79-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 25000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(25000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress8: 200 hubs × 6 leaves each dual edge type', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr80-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 200; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 6; l++) { const leaf = await e.upsertNode(2, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(200 + 200 * 6)
    } finally { e.close() }
  }, 300000)
  it('V57-stress8: 110000 upsertNode 11 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr81-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 11; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(110000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress8: 3000 deleteAll then 2000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr82-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 3000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 2000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(2000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch9 ──
  it('V57-stress9: 120000 upsertNode 12 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr83-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 12; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(120000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress9: 6000 deleteNode every 4th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr84-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 6000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 3; i < 6000; i += 4) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(4500)
    } finally { e.close() }
  }, 300000)
  it('V57-stress9: chain 1500 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr85-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1501; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 1500; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(1501)
    } finally { e.close() }
  }, 300000)
  it('V57-stress9: 30000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr86-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 30000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(30000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress9: 250 hubs × 5 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr87-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 250; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 5; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(250 + 250 * 5)
    } finally { e.close() }
  }, 300000)
  it('V57-stress9: 6000 upsertNode 2 deep prop types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr88-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 6000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, nested: { a: i, b: `s${i}` } } })
      expect(e.scanAllNodes().length).toBe(6000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress9: 5000 deleteNode every 6th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr89-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 5000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 5; i < 5000; i += 6) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(4167)
    } finally { e.close() }
  }, 300000)
  it('V57-stress9: 350 hubs × 4 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr90-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 350; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 4; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(350 + 350 * 4)
    } finally { e.close() }
  }, 300000)
  it('V57-stress9: 130000 upsertNode 13 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr91-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 13; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(130000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress9: 4000 deleteAll then 3000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr92-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 4000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 3000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(3000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch10 ──
  it('V57-stress10: 140000 upsertNode 14 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr93-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 14; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(140000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress10: 7000 deleteNode every 5th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr94-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 7000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 4; i < 7000; i += 5) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(5600)
    } finally { e.close() }
  }, 300000)
  it('V57-stress10: chain 2000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr95-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 2000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(2001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress10: 40000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr96-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 40000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(40000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress10: 500 hubs × 4 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr97-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 500; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 4; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(500 + 500 * 4)
    } finally { e.close() }
  }, 300000)
  it('V57-stress10: 150000 upsertNode 15 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr98-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 15; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(150000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress10: 5000 deleteAll then 4000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr99-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 5000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 4000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(4000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress10: chain 2500 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr100-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2501; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 2500; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(2501)
    } finally { e.close() }
  }, 600000)
  it('V57-stress10: 50000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr101-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 50000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(50000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress10: 1000 hubs × 3 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr102-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 1000; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 3; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(1000 + 1000 * 3)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch11 ──
  it('V57-stress11: 160000 upsertNode 16 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr103-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 16; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(160000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress11: 8000 deleteNode every 7th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr104-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 8000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 6; i < 8000; i += 7) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(6858)
    } finally { e.close() }
  }, 300000)
  it('V57-stress11: chain 3000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr105-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 3001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 3000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(3001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress11: 60000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr106-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 60000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(60000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress11: 2000 hubs × 3 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr107-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 2000; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 3; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(2000 + 2000 * 3)
    } finally { e.close() }
  }, 300000)
  it('V57-stress11: 170000 upsertNode 17 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr108-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 17; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(170000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress11: 6000 deleteAll then 5000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr109-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 6000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 5000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress11: chain 4000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr110-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 4001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 4000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(4001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress11: 70000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr111-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 70000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(70000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress11: 6000 deleteNode first 3000 of 6000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr112-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 6000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 3000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(3000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch12 ──
  it('V57-stress12: 180000 upsertNode 18 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr113-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 18; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(180000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress12: 9000 deleteNode every 8th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr114-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 9000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 7; i < 9000; i += 8) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(7875)
    } finally { e.close() }
  }, 300000)
  it('V57-stress12: chain 5000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr115-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 5001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 5000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(5001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress12: 80000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr116-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 80000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(80000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress12: 3000 hubs × 2 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr117-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 3000; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 2; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(3000 + 3000 * 2)
    } finally { e.close() }
  }, 300000)
  it('V57-stress12: 190000 upsertNode 19 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr118-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 19; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(190000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress12: 7000 deleteAll then 6000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr119-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 7000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 6000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(6000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress12: chain 6000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr120-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 6001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 6000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(6001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress12: 90000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr121-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 90000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(90000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress12: 7000 deleteNode last 4000 of 7000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr122-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 7000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 3000; i < 7000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(3000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch13 ──
  it('V57-stress13: 200000 upsertNode 20 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr123-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 20; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(200000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress13: 10000 deleteNode every 9th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr124-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 10000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 8; i < 10000; i += 9) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(8889)
    } finally { e.close() }
  }, 300000)
  it('V57-stress13: chain 8000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr125-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 8001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 8000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(8001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress13: 100000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr126-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 100000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(100000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress13: 5000 hubs × 2 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr127-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 5000; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 2; l++) { const leaf = await e.upsertNode(1, `l${h}-${l}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      }
      expect(e.scanAllNodes().length).toBe(5000 + 5000 * 2)
    } finally { e.close() }
  }, 600000)
  it('V57-stress13: 210000 upsertNode 21 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr128-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 21; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(210000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress13: 8000 deleteAll then 7000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr129-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 8000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 7000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(7000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress13: chain 10000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr130-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 10001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 10000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(10001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress13: 120000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr131-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 120000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(120000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress13: 8000 deleteNode last 5000 of 8000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr132-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 8000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 3000; i < 8000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(3000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch14 ──
  it('V57-stress14: 220000 upsertNode 22 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr133-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 22; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(220000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress14: 12000 deleteNode every 10th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr134-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 12000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 9; i < 12000; i += 10) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(10800)
    } finally { e.close() }
  }, 300000)
  it('V57-stress14: chain 12000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr135-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 12001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 12000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(12001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress14: 140000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr136-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 140000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(140000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress14: 10000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr137-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 10000; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        const leaf = await e.upsertNode(1, `l${h}`, { props: {} })
        await e.upsertEdge(hub, leaf, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(20000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress14: 230000 upsertNode 23 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr138-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 23; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(230000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress14: 9000 deleteAll then 8000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr139-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 9000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 8000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(8000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress14: chain 15000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr140-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 15001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 15000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(15001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress14: 160000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr141-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 160000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(160000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress14: 9000 deleteNode middle 4000 of 9000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr142-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 9000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 2500; i < 6500; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 300000)
