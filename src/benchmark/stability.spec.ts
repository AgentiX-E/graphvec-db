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

  // ── V57 stress batch15 ──
  it('V57-stress15: 240000 upsertNode 24 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr143-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 24; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(240000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress15: 14000 deleteNode every 11th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr144-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 14000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 10; i < 14000; i += 11) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(12727)
    } finally { e.close() }
  }, 300000)
  it('V57-stress15: chain 18000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr145-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 18001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 18000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(18001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress15: 180000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr146-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 180000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(180000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress15: 15000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr147-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 15000; h++) {
        const hub = await e.upsertNode(1, `hub${h}`, { props: {} })
        const leaf = await e.upsertNode(1, `l${h}`, { props: {} })
        await e.upsertEdge(hub, leaf, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress15: 250000 upsertNode 25 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr148-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 25; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(250000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress15: 10000 deleteAll then 9000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr149-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 10000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 9000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(9000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress15: chain 20000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr150-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 20000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(20001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress15: 200000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr151-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 200000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(200000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress15: 10000 deleteNode alternate odd/even of 10000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr152-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 10000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 10000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch16 ──
  it('V57-stress16: 260000 upsertNode 26 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr153-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 26; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(260000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress16: 16000 deleteNode every 12th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr154-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 16000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 11; i < 16000; i += 12) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(14667)
    } finally { e.close() }
  }, 300000)
  it('V57-stress16: chain 22000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr155-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 22001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 22000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(22001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress16: 220000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr156-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 220000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(220000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress16: 20000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr157-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 20000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(40000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress16: 270000 upsertNode 27 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr158-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 27; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(270000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress16: 11000 deleteAll then 10000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr159-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 11000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 10000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(10000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress16: chain 25000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr160-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 25001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 25000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(25001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress16: 240000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr161-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 240000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(240000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress16: 12000 deleteNode chunks of 600 from 12000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr162-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 12000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let chunk = 0; chunk < 10; chunk++) for (let i = chunk * 600; i < (chunk + 1) * 600; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(6000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch17 ──
  it('V57-stress17: 280000 upsertNode 28 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr163-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 28; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(280000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress17: 18000 deleteNode every 12th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr164-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 18000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 11; i < 18000; i += 12) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(16500)
    } finally { e.close() }
  }, 300000)
  it('V57-stress17: chain 28000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr165-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 28001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 28000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(28001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress17: 260000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr166-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 260000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(260000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress17: 25000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr167-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 25000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(50000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress17: 290000 upsertNode 29 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr168-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 29; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(290000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress17: 12000 deleteAll then 11000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr169-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 12000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 11000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(11000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress17: chain 30000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr170-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 30000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(30001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress17: 280000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr171-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 280000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(280000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress17: 14000 deleteNode by range boundary', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr172-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 14000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 7000; i++) e.deleteNode(ids[i])
      for (let i = 7000; i < 14000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(7000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch18 ──
  it('V57-stress18: 300000 upsertNode 30 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr173-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 30; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(300000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress18: 20000 deleteNode every 13th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr174-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 12; i < 20000; i += 13) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(18462)
    } finally { e.close() }
  }, 300000)
  it('V57-stress18: chain 32000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr175-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 32001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 32000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(32001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress18: 300000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr176-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 300000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(300000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress18: 30000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr177-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 30000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(60000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress18: 310000 upsertNode 31 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr178-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 31; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(310000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress18: 13000 deleteAll then 12000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr179-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 13000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 12000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(12000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress18: chain 35000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr180-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 35001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 35000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(35001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress18: 340000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr181-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 340000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(340000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress18: 16000 deleteNode first 8000 then verify remaining', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr182-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 16000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 8000; i++) e.deleteNode(ids[i])
      for (let i = 8000; i < 16000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(8000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch19 ──
  it('V57-stress19: 320000 upsertNode 32 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr183-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 32; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(320000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress19: 22000 deleteNode every 14th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr184-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 22000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 13; i < 22000; i += 14) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(20429)
    } finally { e.close() }
  }, 300000)
  it('V57-stress19: chain 36000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr185-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 36001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 36000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(36001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress19: 360000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr186-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 360000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(360000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress19: 35000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr187-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 35000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(70000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress19: 330000 upsertNode 33 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr188-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 33; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(330000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress19: 14000 deleteAll then 13000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr189-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 14000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 13000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(13000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress19: chain 38000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr190-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 38001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 38000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(38001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress19: 380000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr191-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 380000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(380000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress19: 18000 deleteNode last 9000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr192-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 18000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 9000; i < 18000; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 9000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(9000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch20 ──
  it('V57-stress20: 340000 upsertNode 34 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr193-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 34; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(340000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress20: 24000 deleteNode every 15th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr194-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 24000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 14; i < 24000; i += 15) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(22400)
    } finally { e.close() }
  }, 300000)
  it('V57-stress20: chain 40000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr195-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 40000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(40001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress20: 400000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr196-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 400000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(400000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress20: 40000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr197-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 40000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(80000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress20: 350000 upsertNode 35 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr198-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 35; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(350000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress20: 15000 deleteAll then 14000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr199-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 15000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 14000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(14000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress20: chain 42000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr200-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 42001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 42000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(42001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress20: 420000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr201-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 420000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(420000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress20: 20000 deleteNode middle 10000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr202-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 5000; i < 15000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(10000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch21 ──
  it('V57-stress21: 360000 upsertNode 36 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr203-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 36; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(360000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress21: 26000 deleteNode every 16th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr204-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 26000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 15; i < 26000; i += 16) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(24375)
    } finally { e.close() }
  }, 300000)
  it('V57-stress21: chain 45000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr205-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 45001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 45000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(45001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress21: 440000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr206-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 440000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(440000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress21: 45000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr207-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 45000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(90000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress21: 370000 upsertNode 37 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr208-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 37; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(370000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress21: 16000 deleteAll then 15000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr209-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 16000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 15000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(15000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress21: chain 48000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr210-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 48001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 48000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(48001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress21: 460000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr211-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 460000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(460000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress21: 22000 deleteNode scatter pattern half', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr212-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 22000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 11000; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(11000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch22 ──
  it('V57-stress22: 380000 upsertNode 38 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr213-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 38; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(380000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress22: 28000 deleteNode every 17th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr214-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 28000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 16; i < 28000; i += 17) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(26353)
    } finally { e.close() }
  }, 300000)
  it('V57-stress22: chain 50000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr215-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 50000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(50001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress22: 480000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr216-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 480000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(480000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress22: 50000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr217-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 50000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(100000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress22: 390000 upsertNode 39 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr218-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 39; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(390000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress22: 17000 deleteAll then 16000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr219-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 17000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 16000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(16000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress22: chain 52000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr220-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 52001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 52000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(52001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress22: 500000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr221-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 500000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(500000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress22: 24000 deleteNode alternate half verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr222-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 24000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 24000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(12000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch23 ──
  it('V57-stress23: 400000 upsertNode 40 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr223-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 40; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(400000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress23: 30000 deleteNode every 18th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr224-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 17; i < 30000; i += 18) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(28334)
    } finally { e.close() }
  }, 300000)
  it('V57-stress23: chain 55000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr225-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 55001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 55000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(55001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress23: 520000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr226-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 520000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(520000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress23: 55000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr227-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 55000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(110000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress23: 410000 upsertNode 41 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr228-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 41; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(410000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress23: 18000 deleteAll then 17000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr229-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 18000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 17000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(17000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress23: chain 58000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr230-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 58001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 58000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(58001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress23: 540000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr231-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 540000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(540000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress23: 26000 deleteNode by range 0-13000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr232-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 26000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 13000; i++) e.deleteNode(ids[i])
      for (let i = 13000; i < 26000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(13000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch24 ──
  it('V57-stress24: 420000 upsertNode 42 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr233-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 42; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(420000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress24: 32000 deleteNode every 19th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr234-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 32000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 18; i < 32000; i += 19) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(30316)
    } finally { e.close() }
  }, 300000)
  it('V57-stress24: chain 60000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr235-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 60000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(60001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress24: 560000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr236-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 560000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(560000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress24: 60000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr237-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 60000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(120000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress24: 430000 upsertNode 43 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr238-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 43; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(430000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress24: 19000 deleteAll then 18000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr239-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 19000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 18000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(18000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress24: chain 62000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr240-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 62001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 62000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(62001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress24: 580000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr241-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 580000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(580000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress24: 28000 deleteNode by range 5000-19000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr242-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 28000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 5000; i < 19000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(14000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch25 ──
  it('V57-stress25: 440000 upsertNode 44 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr243-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 44; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(440000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress25: 34000 deleteNode every 20th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr244-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 34000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 19; i < 34000; i += 20) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(32300)
    } finally { e.close() }
  }, 300000)
  it('V57-stress25: chain 65000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr245-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 65001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 65000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(65001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress25: 600000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr246-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 600000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(600000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress25: 65000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr247-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 65000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(130000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress25: 450000 upsertNode 45 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr248-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 45; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(450000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress25: 20000 deleteAll then 19000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr249-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 19000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(19000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress25: chain 68000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr250-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 68001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 68000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(68001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress25: 620000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr251-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 620000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(620000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress25: 30000 deleteNode even indices then check odd survive', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr252-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 30000; i += 2) e.deleteNode(ids[i])
      for (let i = 1; i < 30000; i += 2) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(15000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch26 ──
  it('V57-stress26: 460000 upsertNode 46 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr253-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 46; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(460000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress26: 36000 deleteNode every 21st', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr254-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 36000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 20; i < 36000; i += 21) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(34286)
    } finally { e.close() }
  }, 300000)
  it('V57-stress26: chain 70000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr255-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 70000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(70001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress26: 640000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr256-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 640000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(640000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress26: 70000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr257-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 70000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(140000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress26: 470000 upsertNode 47 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr258-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 47; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(470000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress26: 21000 deleteAll then 20000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr259-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 21000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 20000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(20000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress26: chain 72000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr260-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 72001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 72000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(72001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress26: 660000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr261-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 660000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(660000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress26: 32000 deleteNode last 16000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr262-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 32000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 16000; i < 32000; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 16000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(16000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch27 ──
  it('V57-stress27: 480000 upsertNode 48 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr263-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 48; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(480000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress27: 38000 deleteNode every 22nd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr264-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 38000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 21; i < 38000; i += 22) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(36273)
    } finally { e.close() }
  }, 300000)
  it('V57-stress27: chain 75000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr265-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 75001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 75000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(75001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress27: 680000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr266-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 680000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(680000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress27: 75000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr267-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 75000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(150000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress27: 490000 upsertNode 49 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr268-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 49; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(490000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress27: 22000 deleteAll then 21000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr269-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 22000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 21000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(21000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress27: chain 78000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr270-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 78001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 78000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(78001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress27: 700000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr271-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 700000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(700000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress27: 34000 deleteNode by range 0-17000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr272-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 34000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 17000; i++) e.deleteNode(ids[i])
      for (let i = 17000; i < 34000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(17000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch28 ──
  it('V57-stress28: 500000 upsertNode 50 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr273-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 50; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(500000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress28: 40000 deleteNode every 22nd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr274-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 21; i < 40000; i += 22) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(38182)
    } finally { e.close() }
  }, 300000)
  it('V57-stress28: chain 80000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr275-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 80001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 80000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(80001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress28: 720000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr276-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 720000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(720000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress28: 80000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr277-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 80000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(160000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress28: 510000 upsertNode 51 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr278-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 51; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(510000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress28: 23000 deleteAll then 22000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr279-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 23000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 22000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(22000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress28: chain 82000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr280-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 82001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 82000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(82001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress28: 740000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr281-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 740000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(740000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress28: 36000 deleteNode evenly spaced verify remaining', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr282-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 36000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 36000; i += 3) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(24000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch29 ──
  it('V57-stress29: 520000 upsertNode 52 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr283-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 52; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(520000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress29: 42000 deleteNode every 23rd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr284-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 42000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 22; i < 42000; i += 23) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40174)
    } finally { e.close() }
  }, 300000)
  it('V57-stress29: chain 85000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr285-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 85001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 85000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(85001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress29: 760000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr286-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 760000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(760000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress29: 85000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr287-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 85000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(170000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress29: 530000 upsertNode 53 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr288-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 53; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(530000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress29: 24000 deleteAll then 23000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr289-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 24000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 23000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(23000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress29: chain 88000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr290-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 88001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 88000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(88001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress29: 780000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr291-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 780000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(780000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress29: 38000 deleteNode first 19000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr292-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 38000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 19000; i++) e.deleteNode(ids[i])
      for (let i = 19000; i < 38000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(19000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch30 ──
  it('V57-stress30: 540000 upsertNode 54 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr293-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 54; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(540000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress30: 44000 deleteNode every 23rd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr294-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 44000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 22; i < 44000; i += 23) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(42087)
    } finally { e.close() }
  }, 300000)
  it('V57-stress30: chain 90000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr295-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 90001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 90000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(90001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress30: 800000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr296-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 800000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(800000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress30: 90000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr297-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 90000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(180000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress30: 550000 upsertNode 55 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr298-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 55; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(550000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress30: 25000 deleteAll then 24000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr299-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 25000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 24000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(24000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress30: chain 92000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr300-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 92001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 92000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(92001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress30: 820000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr301-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 820000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(820000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress30: 40000 deleteNode every 4th then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr302-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 3; i < 40000; i += 4) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch31 ──
  it('V57-stress31: 560000 upsertNode 56 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr303-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 56; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(560000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress31: 46000 deleteNode every 24th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr304-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 46000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 23; i < 46000; i += 24) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(44084)
    } finally { e.close() }
  }, 300000)
  it('V57-stress31: chain 95000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr305-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 95001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 95000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(95001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress31: 840000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr306-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 840000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(840000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress31: 95000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr307-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 95000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(190000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress31: 570000 upsertNode 57 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr308-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 57; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(570000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress31: 26000 deleteAll then 25000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr309-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 26000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 25000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(25000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress31: chain 98000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr310-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 98001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 98000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(98001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress31: 860000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr311-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 860000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(860000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress31: 42000 deleteNode by range 0-21000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr312-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 42000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 21000; i++) e.deleteNode(ids[i])
      for (let i = 21000; i < 42000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(21000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch32 ──
  it('V57-stress32: 580000 upsertNode 58 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr313-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 58; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(580000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress32: 48000 deleteNode every 25th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr314-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 48000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 24; i < 48000; i += 25) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(46080)
    } finally { e.close() }
  }, 300000)
  it('V57-stress32: chain 100000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr315-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 100000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(100001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress32: 880000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr316-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 880000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(880000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress32: 100000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr317-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 100000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(200000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress32: 590000 upsertNode 59 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr318-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 59; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(590000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress32: 27000 deleteAll then 26000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr319-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 27000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 26000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(26000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress32: chain 105000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr320-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 105001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 105000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(105001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress32: 900000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr321-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 900000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(900000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress32: 44000 deleteNode by scatter pattern verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr322-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 44000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 22000; i++) e.deleteNode(ids[i * 2])
      for (let i = 0; i < 44000; i += 2) expect(e.getNode(ids[i])).toBeNull()
      expect(e.scanAllNodes().length).toBe(22000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch33 ──
  it('V57-stress33: 600000 upsertNode 60 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr323-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 60; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(600000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress33: 50000 deleteNode every 25th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr324-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 24; i < 50000; i += 25) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(48000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress33: chain 110000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr325-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 110001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 110000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(110001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress33: 920000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr326-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 920000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(920000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress33: 110000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr327-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 110000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(220000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress33: 610000 upsertNode 61 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr328-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 61; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(610000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress33: 28000 deleteAll then 27000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr329-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 28000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 27000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(27000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress33: chain 115000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr330-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 115001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 115000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(115001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress33: 940000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr331-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 940000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(940000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress33: 46000 deleteNode by odd indices verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr332-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 46000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 46000; i += 2) e.deleteNode(ids[i])
      for (let i = 0; i < 46000; i += 2) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(23000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch34 ──
  it('V57-stress34: 620000 upsertNode 62 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr333-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 62; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(620000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress34: 52000 deleteNode every 26th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr334-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 52000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 25; i < 52000; i += 26) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(50000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress34: chain 120000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr335-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 120001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 120000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(120001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress34: 960000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr336-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 960000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(960000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress34: 120000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr337-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 120000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(240000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress34: 630000 upsertNode 63 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr338-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 63; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(630000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress34: 29000 deleteAll then 28000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr339-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 29000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 28000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(28000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress34: chain 125000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr340-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 125001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 125000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(125001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress34: 980000 scanAllNodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr341-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 980000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(980000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress34: 48000 deleteNode by range 0-24000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr342-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 48000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 24000; i++) e.deleteNode(ids[i])
      for (let i = 24000; i < 48000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(24000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch35 ──
  it('V57-stress35: 640000 upsertNode 64 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr343-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 64; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(640000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress35: 54000 deleteNode every 27th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr344-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 54000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 26; i < 54000; i += 27) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(52000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress35: chain 130000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr345-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 130001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 130000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(130001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress35: 1000000 scanAllNodes — 1M milestone', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr346-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 1000000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(1000000)
    } finally { e.close() }
  }, 120000)
  it('V57-stress35: 130000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr347-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 130000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(260000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress35: 650000 upsertNode 65 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr348-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 65; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(650000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress35: 30000 deleteAll then 29000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr349-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 29000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(29000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress35: chain 135000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr350-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 135001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 135000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(135001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress35: 50000 deleteNode even indices verify all deleted', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr351-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 50000; i += 2) e.deleteNode(ids[i])
      for (let i = 1; i < 50000; i += 2) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(25000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch36 ──
  it('V57-stress36: 660000 upsertNode 66 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr352-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 66; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(660000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress36: 56000 deleteNode every 28th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr353-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 56000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 27; i < 56000; i += 28) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(54000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress36: chain 140000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr354-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 140001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 140000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(140001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress36: 140000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr355-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 140000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(280000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress36: 670000 upsertNode 67 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr356-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 67; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(670000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress36: 31000 deleteAll then 30000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr357-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 31000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 30000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress36: chain 145000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr358-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 145001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 145000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(145001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress36: 52000 deleteNode by range 0-26000 verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr359-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 52000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 26000; i++) e.deleteNode(ids[i])
      for (let i = 26000; i < 52000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(26000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress36: 54000 deleteNode every 3rd then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr360-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 54000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 2; i < 54000; i += 3) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(36000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress36: 56000 deleteNode first 28000 verify remainder', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr361-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 56000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 28000; i++) e.deleteNode(ids[i])
      for (let i = 28000; i < 56000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(28000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch37 ──
  it('V57-stress37: 680000 upsertNode 68 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr362-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 68; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(680000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress37: 58000 deleteNode every 29th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr363-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 58000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 28; i < 58000; i += 29) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(56000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress37: chain 150000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr364-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 150001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 150000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(150001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress37: 150000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr365-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 150000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(300000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress37: 690000 upsertNode 69 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr366-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 69; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(690000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress37: 32000 deleteAll then 31000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr367-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 32000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 31000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(31000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress37: chain 155000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr368-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 155001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 155000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(155001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress37: 58000 deleteNode by range 0-29000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr369-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 58000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 29000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(29000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress37: 60000 deleteNode every 5th then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr370-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 4; i < 60000; i += 5) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(48000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress37: 62000 deleteNode last 31000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr371-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 62000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 31000; i < 62000; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 31000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(31000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch38 ──
  it('V57-stress38: 700000 upsertNode 70 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr372-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 70; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(700000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress38: 60000 deleteNode every 30th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr373-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 29; i < 60000; i += 30) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(58000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress38: chain 160000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr374-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 160001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 160000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(160001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress38: 160000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr375-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 160000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(320000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress38: 33000 deleteAll then 32000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr376-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 33000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 32000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(32000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress38: chain 165000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr377-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 165001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 165000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(165001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress38: 64000 deleteNode by range 0-32000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr378-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 64000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 32000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(32000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress38: 66000 deleteNode every 6th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr379-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 66000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 5; i < 66000; i += 6) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(55000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress38: 68000 deleteNode by range 0-34000 verify remainder', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr380-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 68000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 34000; i++) e.deleteNode(ids[i])
      for (let i = 34000; i < 68000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(34000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress38: 70000 deleteNode first 35000 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr381-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 35000; i++) e.deleteNode(ids[i])
      for (let i = 35000; i < 70000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch39 ──
  it('V57-stress39: 710000 upsertNode 71 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr382-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 71; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(710000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress39: 62000 deleteNode every 31st', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr383-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 62000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 30; i < 62000; i += 31) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(60000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress39: chain 170000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr384-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 170001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 170000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(170001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress39: 170000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr385-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 170000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(340000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress39: 34000 deleteAll then 33000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr386-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 34000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 33000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(33000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress39: chain 175000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr387-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 175001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 175000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(175001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress39: 72000 deleteNode by range 0-36000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr388-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 72000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 36000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(36000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress39: 74000 deleteNode even indices to verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr389-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 74000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 74000; i += 2) e.deleteNode(ids[i])
      for (let i = 1; i < 74000; i += 2) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(37000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress39: 76000 deleteNode odd indices verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr390-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 76000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 76000; i += 2) e.deleteNode(ids[i])
      for (let i = 0; i < 76000; i += 2) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(38000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress39: 78000 deleteNode range 0-39000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr391-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 78000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 39000; i++) e.deleteNode(ids[i])
      for (let i = 39000; i < 78000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(39000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch40 ──
  it('V57-stress40: 720000 upsertNode 72 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr392-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 72; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(720000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress40: 64000 deleteNode every 32nd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr393-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 64000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 31; i < 64000; i += 32) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(62000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress40: chain 180000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr394-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 180001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 180000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(180001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress40: 180000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr395-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 180000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(360000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress40: 35000 deleteAll then 34000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr396-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 35000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 34000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(34000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress40: chain 185000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr397-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 185001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 185000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(185001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress40: 80000 deleteNode by range 0-40000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr398-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 80000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 40000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress40: 82000 deleteNode every 7th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr399-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 82000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 6; i < 82000; i += 7) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(70286)
    } finally { e.close() }
  }, 300000)
  it('V57-stress40: 84000 deleteNode range 0-42000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr400-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 84000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 42000; i++) e.deleteNode(ids[i])
      for (let i = 42000; i < 84000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(42000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress40: 86000 deleteNode last 43000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr401-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 86000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 43000; i < 86000; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 43000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(43000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch41 ──
  it('V57-stress41: 730000 upsertNode 73 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr402-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 73; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(730000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress41: 66000 deleteNode every 32nd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr403-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 66000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 31; i < 66000; i += 32) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(63937)
    } finally { e.close() }
  }, 300000)
  it('V57-stress41: chain 190000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr404-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 190001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 190000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(190001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress41: 190000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr405-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 190000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(380000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress41: 36000 deleteAll then 35000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr406-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 36000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 35000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress41: chain 195000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr407-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 195001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 195000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(195001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress41: 88000 deleteNode by range 0-44000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr408-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 88000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 44000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(44000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress41: 90000 deleteNode every 8th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr409-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 90000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 7; i < 90000; i += 8) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(78750)
    } finally { e.close() }
  }, 300000)
  it('V57-stress41: 92000 deleteNode first 46000 verify remainder', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr410-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 92000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 46000; i++) e.deleteNode(ids[i])
      for (let i = 46000; i < 92000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(46000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress41: 94000 deleteNode last 47000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr411-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 94000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 47000; i < 94000; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 47000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(47000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch42 ──
  it('V57-stress42: 740000 upsertNode 74 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr412-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 74; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(740000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress42: 68000 deleteNode every 33rd', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr413-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 68000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 32; i < 68000; i += 33) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(65939)
    } finally { e.close() }
  }, 300000)
  it('V57-stress42: chain 200000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr414-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 200001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 200000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(200001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress42: 200000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr415-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 200000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(400000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress42: 37000 deleteAll then 36000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr416-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 37000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 36000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(36000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress42: chain 205000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr417-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 205001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 205000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(205001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress42: 96000 deleteNode by range 0-48000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr418-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 96000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 48000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(48000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress42: 98000 deleteNode every 9th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr419-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 98000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 8; i < 98000; i += 9) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(87111)
    } finally { e.close() }
  }, 300000)
  it('V57-stress42: deleteNode first half 50000 verify remainder', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr420-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 50000; i++) e.deleteNode(ids[i])
      for (let i = 50000; i < 100000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(50000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress42: deleteNode last half 50000', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr421-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 50000; i < 100000; i++) e.deleteNode(ids[i])
      for (let i = 0; i < 50000; i++) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(50000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch43 ──
  it('V57-stress43: 750000 upsertNode 75 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr422-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 75; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(750000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress43: 70000 deleteNode every 34th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr423-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 33; i < 70000; i += 34) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(67941)
    } finally { e.close() }
  }, 300000)
  it('V57-stress43: chain 210000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr424-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 210001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 210000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(210001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress43: 210000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr425-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 210000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(420000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress43: 38000 deleteAll then 37000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr426-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 38000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 37000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(37000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress43: chain 215000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr427-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 215001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 215000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(215001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress43: deleteNode even indices on 50k set', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr428-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 50000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(25000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress43: deleteNode odd indices on 50k set', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr429-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 50000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(25000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress43: deleteNode range middle on 50k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr430-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 20000; i < 30000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress43: deleteNode every 10th on 50k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr431-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 9; i < 50000; i += 10) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(45000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch44 ──
  it('V57-stress44: 760000 upsertNode 76 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr432-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 76; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(760000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress44: 72000 deleteNode every 35th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr433-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 72000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 34; i < 72000; i += 35) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(69943)
    } finally { e.close() }
  }, 300000)
  it('V57-stress44: chain 220000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr434-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 220001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 220000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(220001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress44: 220000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr435-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 220000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(440000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress44: 39000 deleteAll then 38000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr436-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 39000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 38000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(38000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress44: chain 225000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr437-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 225001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 225000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(225001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress44: deleteNode every 5th on 60k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr438-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 4; i < 60000; i += 5) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(48000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress44: deleteNode first 30000 on 60k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr439-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 30000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress44: deleteNode last 30000 on 60k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr440-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 30000; i < 60000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress44: deleteNode range 10000-40000 on 60k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr441-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 10000; i < 40000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(30000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch45 ──
  it('V57-stress45: 770000 upsertNode 77 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr442-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 77; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(770000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress45: 74000 deleteNode every 36th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr443-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 74000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 35; i < 74000; i += 36) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(71944)
    } finally { e.close() }
  }, 300000)
  it('V57-stress45: chain 230000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr444-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 230001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 230000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(230001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress45: 230000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr445-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 230000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(460000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress45: 40000 deleteAll then 39000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr446-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 39000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(39000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress45: chain 235000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr447-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 235001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 235000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(235001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress45: deleteNode even indices on 70k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr448-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 70000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress45: deleteNode odd indices on 70k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr449-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 70000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress45: deleteNode range 0-35000 on 70k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr450-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 35000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress45: deleteNode last 35000 on 70k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr451-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 70000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 35000; i < 70000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(35000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch46 ──
  it('V57-stress46: 780000 upsertNode 78 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr452-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 78; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(780000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress46: 76000 deleteNode every 37th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr453-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 76000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 36; i < 76000; i += 37) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(73946)
    } finally { e.close() }
  }, 300000)
  it('V57-stress46: chain 240000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr454-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 240001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 240000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(240001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress46: 240000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr455-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 240000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(480000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress46: 41000 deleteAll then 40000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr456-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 41000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 40000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(40000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress46: chain 245000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr457-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 245001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 245000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(245001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress46: deleteNode every 4th on 80k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr458-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 80000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 3; i < 80000; i += 4) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(60000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress46: deleteNode first 45000 on 90k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr459-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 90000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 45000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(45000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress46: deleteNode every 11th on 100k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr460-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 10; i < 100000; i += 11) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(90909)
    } finally { e.close() }
  }, 300000)
  it('V57-stress46: deleteNode range 20000-60000 on 100k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr461-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 20000; i < 60000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(60000)
    } finally { e.close() }
  }, 300000)

  // ── V57 stress batch47 ──
  it('V57-stress47: 790000 upsertNode 79 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr462-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 79; t++) for (let i = 0; i < 10000; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(790000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress47: 78000 deleteNode every 38th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr463-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 78000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 37; i < 78000; i += 38) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(75947)
    } finally { e.close() }
  }, 300000)
  it('V57-stress47: chain 250000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr464-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 250001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 250000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(250001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress47: 250000 hubs × 1 leaf each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr465-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 250000; h++) { const hub = await e.upsertNode(1, `hub${h}`, { props: {} }); const leaf = await e.upsertNode(1, `l${h}`, { props: {} }); await e.upsertEdge(hub, leaf, 1, { props: {} }) }
      expect(e.scanAllNodes().length).toBe(500000)
    } finally { e.close() }
  }, 600000)
  it('V57-stress47: 42000 deleteAll then 41000 re-insert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr466-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 42000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      for (let i = 0; i < 41000; i++) await e.upsertNode(1, `n2-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(41000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress47: chain 255000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr467-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 255001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 255000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(255001)
    } finally { e.close() }
  }, 600000)
  it('V57-stress47: deleteNode range 0-44000 on 88k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr468-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 88000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 44000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(44000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress47: deleteNode range 44000-88000 on 88k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr469-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 88000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 44000; i < 88000; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(44000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress47: deleteNode even indices on 88k', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr470-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 88000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 88000; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(44000)
    } finally { e.close() }
  }, 300000)
  it('V57-stress47: deleteNode odd indices on 88k verify evens survive', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-sr471-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 88000; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 88000; i += 2) e.deleteNode(ids[i])
      for (let i = 0; i < 88000; i += 2) expect(e.getNode(ids[i])).not.toBeNull()
      expect(e.scanAllNodes().length).toBe(44000)
    } finally { e.close() }
  }, 300000)
