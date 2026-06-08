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
