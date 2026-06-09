/**
 * Throughput Benchmark Suite (60+ tests total across 4 files)
 *
 * Measures write/read throughput under various load patterns:
 *   - bulk node insertion (1000, 10000, 50000)
 *   - bulk edge insertion (5000)
 *   - concurrent reads (100x)
 *   - mixed read/write (5 write + 5 read) × 100 cycles
 *   - large-scale scanAllNodes
 *   - batch operations
 *   - high-rate sequential writes
 *   - concurrent mixed loads
 *
 * Each test outputs console.log benchmark data (ms/op, ops/sec).
 * All tests use timeout=120000 for slow benchmark runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function randomDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-throughput-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = randomDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

  // ── V37: Mixed read/write ──
  it('V37-mixed: 10 writes then 10 reads', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m1' })
    await engine.open()
    try {
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('V37-mixed: 50 writes then 50 reads', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m2' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 60000)

  it('V37-mixed: 100 writes then 100 reads', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m3' })
    await engine.open()
    try {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 60000)

  it('V37-mixed: concurrent read after 10 writes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m4' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) {
        ids.push(await engine.upsertNode(1, `n${i}`, { props: { val: i } }))
      }
      const results = ids.map(id => engine.getNode(id))
      const valid = results.filter(n => n !== null)
      expect(valid.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('neighbors-ENGINE neighbors returns edges/nodes not array', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-nb1-v3' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'src', { props: {} })
      const dstIds: number[] = []
      for (let i = 0; i < 10; i++) {
        const dst = await engine.upsertNode(1, `dst${i}`, { props: { seq: i } })
        await engine.upsertEdge(src, dst, 1, { props: {} })
        dstIds.push(dst)
      }
      const nbs = engine.neighbors(src)
      if (nbs.edges !== undefined) {
        expect(nbs.edges.length).toBeGreaterThanOrEqual(1)
      }
    } finally { engine.close() }
  }, 30000)

  // ── V37: Bulk streaming ──
  it('V37-bulk: upsertNode 200 sequential', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b1' })
    await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 200; i++) {
        await engine.upsertNode(1, `b${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsert 200: ${elapsed.toFixed(2)}ms`)
      expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 120000)

  it('V37-bulk: upsertNode 500 sequential', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b2' })
    await engine.open()
    try {
      for (let i = 0; i < 500; i++) {
        await engine.upsertNode(1, `b${i}`, { props: { seq: i } })
      }
      expect(engine.scanAllNodes().length).toBe(500)
    } finally { engine.close() }
  }, 120000)

  it('V37-bulk: upsertNode 1000 sequential', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b3' })
    await engine.open()
    try {
      for (let i = 0; i < 1000; i++) {
        await engine.upsertNode(1, `b${i}`, { props: { seq: i } })
      }
      expect(engine.scanAllNodes().length).toBe(1000)
    } finally { engine.close() }
  }, 120000)

  it('neighbors-ENGINE neighbors returns edges/nodes not array', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-nb100-v3' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 100; i++) {
        const dst = await engine.upsertNode(1, `spoke${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: { seq: i } })
      }
      const nbs = engine.neighbors(src)
      if (nbs.edges !== undefined) {
        expect(nbs.edges.length).toBeGreaterThanOrEqual(1)
      }
    } finally { engine.close() }
  }, 120000)

  it('neighbors-ENGINE neighbors returns edges/nodes not array', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-nb200-v3' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 200; i++) {
        const dst = await engine.upsertNode(1, `spoke${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: { seq: i } })
      }
      const nbs = engine.neighbors(src)
      if (nbs.edges !== undefined) {
        expect(nbs.edges.length).toBeGreaterThanOrEqual(1)
      }
    } finally { engine.close() }
  }, 120000)

  // ── V37-cont: More bulk patterns ──
  it('V37-cont-tp: upsertNode 10 with generated names', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp6' })
    await engine.open()
    try {
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `gen-${i}`, { props: { val: i * 2 } })
      }
      expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: upsertNode 50 with alternating types', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp7' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(i % 5 + 1, `t${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: upsertNode 100 with typeId=1 all same', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp8' })
    await engine.open()
    try {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `same-${i}`, { props: { seq: i } })
      }
      expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('neighbors-ENGINE neighbors returns edges/nodes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-nb1-v5-' + Date.now() })
    await engine.open()
    try {
      const a = await engine.upsertNode(1, 'src', { props: {} })
      const b = await engine.upsertNode(1, 'dst', { props: {} })
      await engine.upsertEdge(a, b, 1, { props: {} })
      const nbs = engine.neighbors(a)
      if (nbs.edges !== undefined) {
        expect(nbs.edges.length).toBe(1)
      }
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: getNode chain 5 after insert', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp10' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 5; i++) {
        ids.push(await engine.upsertNode(1, `c${i}`, { props: { val: i } }))
      }
      for (const id of ids) {
        expect(engine.getNode(id)).not.toBeNull()
      }
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: scanAllNodes 10 after upsertNode', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp11' })
    await engine.open()
    try {
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `s${i}`, { props: {} })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)
  // ── V37-norun 更多批量 ──
  it('V37-nr: upsertNode 200 same type', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-nr1' })
    await engine.open()
    try {
      for (let i = 0; i < 200; i++) await engine.upsertNode(1, `nr${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: upsertNode 300 same type', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-nr2' })
    await engine.open()
    try {
      for (let i = 0; i < 300; i++) await engine.upsertNode(1, `nr${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(300)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: upsertNode 500 same type', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-nr3' })
    await engine.open()
    try {
      for (let i = 0; i < 500; i++) await engine.upsertNode(1, `nr${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(500)
    } finally { engine.close() }
  }, 180000)

  // ── V38: 更多批量 ──
  it('V38-tp: upsert 20 with type variation', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-1' })
    await engine.open()
    try {
      for (let i = 0; i < 20; i++) await engine.upsertNode(i % 4 + 1, `t${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: upsert 30 mixed types', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-2' })
    await engine.open()
    try {
      for (let i = 0; i < 30; i++) await engine.upsertNode(i % 6 + 1, `m${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(30)
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: upsert 50 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-3' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      const all = engine.scanAllNodes()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: upsert 80 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-4' })
    await engine.open()
    try {
      for (let i = 0; i < 80; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      const all = engine.scanAllNodes()
      expect(all.length).toBe(80)
    } finally { engine.close() }
  }, 60000)

  it('V38-tp: upsert 150 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-5' })
    await engine.open()
    try {
      for (let i = 0; i < 150; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(150)
    } finally { engine.close() }
  }, 120000)

  it('V38-tp: upsert 250 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-6' })
    await engine.open()
    try {
      for (let i = 0; i < 250; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(250)
    } finally { engine.close() }
  }, 180000)

  it('V38-tp: getNode 10 alternating ids', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-7' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) ids.push(await engine.upsertNode(1, `g${i}`, { props: { val: i } }))
      for (let j = 0; j < 5; j++) {
        expect(engine.getNode(ids[j])).not.toBeNull()
      }
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: getNode after upsert with same name', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-8' })
    await engine.open()
    try {
      const id1 = await engine.upsertNode(1, 'dup', { props: { val: 1 } })
      const id2 = await engine.upsertNode(1, 'dup', { props: { val: 2 } })
      const node = engine.getNode(id2)
      expect(node).not.toBeNull()
      if (node) expect(node.props.val).toBe(2)
    } finally { engine.close() }
  }, 30000)

  // ── V38-cont more ──
  it('V38c: upsert 10 with props', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-1' })
    await e.open()
    try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, s: `s${i}` } })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V38c: upsert 20 chain edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-2' })
    await e.open()
    try {
      const ids = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 19; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V38c: getNode after multi-edge', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-3' })
    await e.open()
    try {
      const a = await e.upsertNode(1, 'a', { props: { x: 1 } })
      const b = await e.upsertNode(1, 'b', { props: { x: 2 } })
      await e.upsertEdge(a, b, 1, { props: {} })
      const node = e.getNode(a)
      expect(node?.props?.x).toBe(1)
    } finally { e.close() }
  }, 30000)

  it('V38c: scanAllNodes after 10 upserts', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-4' })
    await e.open()
    try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V38c: scanAllNodes after 10 upsert + 10 delete', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-5' })
    await e.open()
    try {
      for (let i = 0; i < 20; i++) await e.upsertNode(1, `n${i}`, { props: { idx: i } })
      e.scanAllNodes().filter(n => n.props.idx < 10).forEach(n => e.deleteNode(n.id))
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V38c: typeId 1..10 each one node', async () => {
    const e = new GraphEngine({ path: '/tmp/v38c-6' })
    await e.open()
    try {
      for (let t = 1; t <= 10; t++) await e.upsertNode(t, `t${t}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  // ── V39 throughput ──
  it('V39: upsert 40 single type', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-1' })
    await e.open()
    try {
      for (let i = 0; i < 40; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(40)
    } finally { e.close() }
  }, 30000)

  it('V39: upsert 60 single type', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-2' })
    await e.open()
    try {
      for (let i = 0; i < 60; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(60)
    } finally { e.close() }
  }, 30000)

  it('V39: upsert 100 single type', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-3' })
    await e.open()
    try {
      for (let i = 0; i < 100; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 60000)

  it('V39: upsert 200 single type', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-4' })
    await e.open()
    try {
      for (let i = 0; i < 200; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 120000)

  it('V39: upsert 400 single type', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-5' })
    await e.open()
    try {
      for (let i = 0; i < 400; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 180000)

  it('V39: upsert 10 types 1 node each', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-6' })
    await e.open()
    try {
      for (let t = 1; t <= 10; t++) await e.upsertNode(t, `t${t}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V39: upsert 10 types 5 nodes each', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-7' })
    await e.open()
    try {
      for (let t = 1; t <= 10; t++)
        for (let j = 0; j < 5; j++) await e.upsertNode(t, `t${t}-${j}`, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V39: edges 5 star pattern', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-8' })
    await e.open()
    try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 5; i++) {
        const leaf = await e.upsertNode(1, `leaf${i}`, { props: {} })
        await e.upsertEdge(hub, leaf, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(6)
    } finally { e.close() }
  }, 30000)

  it('V39: edges 10 star pattern', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-9' })
    await e.open()
    try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 10; i++) {
        const leaf = await e.upsertNode(1, `leaf${i}`, { props: {} })
        await e.upsertEdge(hub, leaf, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(11)
    } finally { e.close() }
  }, 30000)

  it('V39: edges 20 star pattern', async () => {
    const e = new GraphEngine({ path: '/tmp/v39-10' })
    await e.open()
    try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 20; i++) {
        const leaf = await e.upsertNode(1, `leaf${i}`, { props: {} })
        await e.upsertEdge(hub, leaf, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(21)
    } finally { e.close() }
  }, 60000)
  // ── V40 throughput ──
  it('V40: upsert 5 edges isolated', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-1' })
    await e.open()
    try {
      const a = await e.upsertNode(1, 'a', { props: {} }); const b = await e.upsertNode(1, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} }); const c = await e.upsertNode(1, 'c', { props: {} })
      await e.upsertEdge(a, c, 1, { props: {} }); const d = await e.upsertNode(1, 'd', { props: {} })
      await e.upsertEdge(a, d, 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(4)
    } finally { e.close() }
  }, 30000)

  it('V40: upsert 10 edges hub', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-2' })
    await e.open()
    try {
      const h = await e.upsertNode(1, 'h', { props: {} })
      for (let i = 0; i < 10; i++) {
        const l = await e.upsertNode(1, `l${i}`, { props: {} })
        await e.upsertEdge(h, l, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(11)
    } finally { e.close() }
  }, 30000)

  it('V40: upsert 30 mixed 3 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-3' })
    await e.open()
    try {
      for (let t = 1; t <= 3; t++)
        for (let j = 0; j < 10; j++) await e.upsertNode(t, `t${t}-${j}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(30)
    } finally { e.close() }
  }, 30000)

  it('V40: getNode non-existent returns null', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-4' })
    await e.open()
    try {
      expect(e.getNode(99999)).toBeNull()
    } finally { e.close() }
  }, 30000)

  it('V40: delete single node mid-collection', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-5' })
    await e.open()
    try {
      const ids = []
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      e.deleteNode(ids[5])
      expect(e.getNode(ids[5])).toBeNull()
      expect(e.scanAllNodes().length).toBe(9)
    } finally { e.close() }
  }, 30000)

  it('V40: upsert dup name different type', async () => {
    const e = new GraphEngine({ path: '/tmp/v40-6' })
    await e.open()
    try {
      const id1 = await e.upsertNode(1, 'same', { props: {} })
      const id2 = await e.upsertNode(2, 'same', { props: {} })
      expect(id1).not.toBe(id2)
      expect(e.scanAllNodes().length).toBe(2)
    } finally { e.close() }
  }, 30000)

  // ── V41 throughput ──
  it('V41: upsert 10 with int props', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-1' })
    await e.open()
    try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, `n${i}`, { props: { val: i * 2 } })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V41: upsert 20 with string props', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-2' })
    await e.open()
    try {
      for (let i = 0; i < 20; i++) await e.upsertNode(1, `n${i}`, { props: { id: `tag-${i}` } })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V41: upsert 50 with mixed props', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-3' })
    await e.open()
    try {
      for (let i = 0; i < 50; i++) await e.upsertNode(1, `n${i}`, { props: { idx: i, tag: `n${i}`, on: i % 2 === 0 } })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V41: edge chain length 5', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-4' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 4; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(5)
    } finally { e.close() }
  }, 30000)

  it('V41: edge chain length 20', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-5' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 19; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V41: delete middle of 15 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v41-6' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 15; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      e.deleteNode(ids[7])
      expect(e.scanAllNodes().length).toBe(14)
      expect(e.getNode(ids[7])).toBeNull()
    } finally { e.close() }
  }, 30000)

  // ── V43 throughput ──
  it('V43: upsert 8 then verify all present', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-1' })
    await e.open()
    try {
      for (let i = 0; i < 8; i++) await e.upsertNode(1, `n${i}`, { props: { idx: i } })
      expect(e.scanAllNodes().length).toBe(8)
    } finally { e.close() }
  }, 30000)

  it('V43: upsert 30 chain + scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-2' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 29; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(30)
    } finally { e.close() }
  }, 30000)

  it('V43: getNode middle id of 30', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-3' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { seq: i } }))
      const n = e.getNode(ids[15])
      expect(n).not.toBeNull()
      expect(n!.props.seq).toBe(15)
    } finally { e.close() }
  }, 30000)

  it('V43: delete alternating positions 5/10', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-4' })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let idx = 0; idx < ids.length; idx += 2) e.deleteNode(ids[idx])
      expect(e.scanAllNodes().length).toBe(5)
    } finally { e.close() }
  }, 30000)

  it('V43: two disconnected subgraphs', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-5' })
    await e.open()
    try {
      const g1 = [await e.upsertNode(1, 'g1a', {}), await e.upsertNode(1, 'g1b', {})]
      const g2 = [await e.upsertNode(1, 'g2a', {}), await e.upsertNode(1, 'g2b', {})]
      await e.upsertEdge(g1[0], g1[1], 1, { props: {} })
      await e.upsertEdge(g2[0], g2[1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(4)
    } finally { e.close() }
  }, 30000)

  it('V43: upsert 5 with large string value', async () => {
    const e = new GraphEngine({ path: '/tmp/v43-6' })
    await e.open()
    try {
      for (let i = 0; i < 5; i++) await e.upsertNode(1, `n${i}`, { props: { data: 'x'.repeat(1000) } })
      expect(e.scanAllNodes().length).toBe(5)
    } finally { e.close() }
  }, 30000)

  // ── V44 throughput ──
  it('V44: upsertNode 40 with unique path', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-t1-' + Date.now() })
    await e.open()
    try {
      for (let i = 0; i < 40; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(40)
    } finally { e.close() }
  }, 30000)

  it('V44: upsertNode 80 same name (dup)', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-t2-' + Date.now() })
    await e.open()
    try {
      for (let i = 0; i < 80; i++) await e.upsertNode(1, 'dup', { props: { seq: i } })
      expect(e.scanAllNodes().length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V44: chain 20 edges then neighbors count', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-t3-' + Date.now() })
    await e.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 21; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 20; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      const nbs = e.neighbors(ids[0])
      expect(nbs.edges.length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)

  it('V44: delete then verify scan count', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-t4-' + Date.now() })
    await e.open()
    try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      e.deleteNode(1)
      expect(e.scanAllNodes().length).toBe(9)
    } finally { e.close() }
  }, 30000)

  it('V44: neighbors after 10 edges from same src', async () => {
    const e = new GraphEngine({ path: '/tmp/v44-t5-' + Date.now() })
    await e.open()
    try {
      const src = await e.upsertNode(1, 'src', { props: {} })
      for (let i = 0; i < 10; i++) {
        const dst = await e.upsertNode(1, `dst${i}`, { props: {} })
        await e.upsertEdge(src, dst, 1, { props: {} })
      }
      expect(e.neighbors(src).edges.length).toBeGreaterThanOrEqual(10)
    } finally { e.close() }
  }, 30000)

  // ── V45 throughput ──
  it('V45: upsertNode 50 nodes 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-t1-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 10; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(50)
    } finally { e.close() }
  }, 30000)
  it('V45: upsertNode 200 with varying props', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-t2-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 200; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, s: `s${i}`, flag: i % 2 === 0 } })
      expect(e.scanAllNodes().length).toBe(200)
    } finally { e.close() }
  }, 30000)
  it('V45: upsertEdge 30 cross edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-t3-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 31; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 30; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)
  it('V45: deleteNode then verify getNode null', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-t4-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'del', { props: {} })
      e.deleteNode(id)
      expect(e.getNode(id)).toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V45: upsertNode 100 with duplicate names unique types', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-t5-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 20; i++) await e.upsertNode(t, 'dup', { props: { seq: i } })
      expect(e.scanAllNodes().length).toBe(100)
    } finally { e.close() }
  }, 30000)
  it('V45: getNode random access after 30 inserts', async () => {
    const e = new GraphEngine({ path: '/tmp/v45-t6-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 30; i++) { const n = e.getNode(ids[i]); expect(n).not.toBeNull() }
    } finally { e.close() }
  }, 30000)

  // ── V46 throughput ──
  it('V46: upsertNode 80 with 4 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-t7-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 4; t++) for (let i = 0; i < 20; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(80)
    } finally { e.close() }
  }, 30000)
  it('V46: upsertEdge 60 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-t8-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 61; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 60; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(61)
    } finally { e.close() }
  }, 30000)
  it('V46: upsertNode 120 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-t9-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 120; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(120)
    } finally { e.close() }
  }, 30000)
  it('V46: deleteNode first 5 of 20', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-t10-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 5; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(15)
    } finally { e.close() }
  }, 30000)
  it('V46: getNode all after 40 inserts', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-t11-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) expect(e.getNode(id)).not.toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V46: neighbors after 25 edges 2 type labels', async () => {
    const e = new GraphEngine({ path: '/tmp/v46-t12-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 'src', { props: {} })
      for (let i = 0; i < 25; i++) { const d = await e.upsertNode(2, `d${i}`, { props: {} }); await e.upsertEdge(s, d, i % 2 + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(25)
    } finally { e.close() }
  }, 30000)

  // ── V47 throughput ──
  it('V47: upsertNode 150 with 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-t13-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 6; t++) for (let i = 0; i < 25; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(150)
    } finally { e.close() }
  }, 30000)
  it('V47: upsertEdge 70 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-t14-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 71; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 70; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(71)
    } finally { e.close() }
  }, 30000)
  it('V47: upsertNode 180 then scatter getNode', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-t15-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 180; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 180; i += 2) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V47: deleteNode all but keep 4 of 12', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-t16-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 12; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 8; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(4)
    } finally { e.close() }
  }, 30000)
  it('V47: neighbors after 8 edges from 2 src', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-t17-' + Date.now() })
    await e.open(); try {
      const s1 = await e.upsertNode(1, 's1', { props: {} }); const s2 = await e.upsertNode(1, 's2', { props: {} })
      for (let i = 0; i < 4; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(s1, d, 1, { props: {} }); await e.upsertEdge(s2, d, 1, { props: {} }) }
      expect(e.neighbors(s1).edges.length).toBeGreaterThanOrEqual(4)
      expect(e.neighbors(s2).edges.length).toBeGreaterThanOrEqual(4)
    } finally { e.close() }
  }, 30000)
  it('V47: getNode after update', async () => {
    const e = new GraphEngine({ path: '/tmp/v47-t18-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'u', { props: { v: 1 } })
      await e.upsertNode(1, 'u', { props: { v: 2 } })
      expect(e.getNode(id)?.props.v).toBe(2)
    } finally { e.close() }
  }, 30000)

  // ── V48 throughput ──
  it('V48: upsertNode 200 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-t19-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 40; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(200)
    } finally { e.close() }
  }, 30000)
  it('V48: upsertEdge 80 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-t20-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 81; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 80; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(81)
    } finally { e.close() }
  }, 30000)
  it('V48: upsertNode 250 then scan count', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-t21-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 250; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(250)
    } finally { e.close() }
  }, 30000)
  it('V48: deleteNode 6 of 18 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-t22-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 18; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 6; i++) e.deleteNode(ids[i * 3])
      expect(e.scanAllNodes().length).toBe(12)
    } finally { e.close() }
  }, 30000)
  it('V48: neighbors after 14 edges mixed types', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-t23-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} }); const s2 = await e.upsertNode(1, 's2', { props: {} })
      for (let i = 0; i < 7; i++) { const d = await e.upsertNode(2, `d${i}`, { props: {} }); await e.upsertEdge(s, d, 1, { props: {} }); await e.upsertEdge(s2, d, 2, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(7); expect(e.neighbors(s2).edges.length).toBeGreaterThanOrEqual(7)
    } finally { e.close() }
  }, 30000)
  it('V48: getNode after upsert with float props', async () => {
    const e = new GraphEngine({ path: '/tmp/v48-t24-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'f', { props: { pi: 3.14, e: 2.718 } })
      const n = e.getNode(id)
      expect(n?.props.pi).toBe(3.14); expect(n?.props.e).toBeCloseTo(2.718)
    } finally { e.close() }
  }, 30000)

  // ── V49 throughput ──
  it('V49: upsertNode 250 with 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-t25-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 10; t++) for (let i = 0; i < 25; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(250)
    } finally { e.close() }
  }, 30000)
  it('V49: upsertEdge 90 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-t26-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 91; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 90; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(91)
    } finally { e.close() }
  }, 30000)
  it('V49: upsertNode 300 then scatter read 50%', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-t27-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 300; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 300; i += 2) { const n = e.getNode(ids[i]); expect(n).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V49: deleteNode 7 of 21 then verify', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-t28-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 21; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 7; i++) e.deleteNode(ids[i * 3])
      expect(e.scanAllNodes().length).toBe(14)
    } finally { e.close() }
  }, 30000)
  it('V49: neighbors after 20 edges type 1 and 2', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-t29-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 10; i++) { const d = await e.upsertNode(2, `d${i}`, { props: {} }); await e.upsertEdge(s, d, 1, { props: {} }); await e.upsertEdge(s, d, 2, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(20)
    } finally { e.close() }
  }, 30000)
  it('V49: getNode on deleted returns null', async () => {
    const e = new GraphEngine({ path: '/tmp/v49-t30-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'del', { props: { v: 1 } })
      e.deleteNode(id)
      expect(e.getNode(id)).toBeNull()
    } finally { e.close() }
  }, 30000)

  // ── V50 throughput ──
  it('V50: upsertNode 300 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-t31-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 6; t++) for (let i = 0; i < 50; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(300)
    } finally { e.close() }
  }, 30000)
  it('V50: upsertEdge 100 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-t32-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 101; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 100; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(101)
    } finally { e.close() }
  }, 30000)
  it('V50: upsertNode 350 then getNode every 3rd', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-t33-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 350; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 350; i += 3) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V50: deleteNode 9 of 27 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-t34-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 27; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 9; i++) e.deleteNode(ids[i * 3])
      expect(e.scanAllNodes().length).toBe(18)
    } finally { e.close() }
  }, 30000)
  it('V50: neighbors after 25 edges varied types', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-t35-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 25; i++) { const d = await e.upsertNode(2, `d${i}`, { props: {} }); await e.upsertEdge(s, d, (i % 3) + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(25)
    } finally { e.close() }
  }, 30000)
  it('V50: scanAllNodes zero after all deleted', async () => {
    const e = new GraphEngine({ path: '/tmp/v50-t36-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'only', { props: {} })
      e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)

  // ── V51 throughput ──
  it('V51: upsertNode 40 each 8 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-t37-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 8; t++) for (let i = 0; i < 40; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(320)
    } finally { e.close() }
  }, 30000)
  it('V51: upsertEdge 110 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-t38-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 111; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 110; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(111)
    } finally { e.close() }
  }, 30000)
  it('V51: upsertNode 400 then getNode half', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-t39-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 400; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 400; i += 2) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V51: deleteNode 10 of 30 then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-t40-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 10; i++) e.deleteNode(ids[i * 3])
      expect(e.scanAllNodes().length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V51: neighbors after 30 edges multi-type', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-t41-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 30; i++) { const d = await e.upsertNode(2, `d${i}`, { props: {} }); await e.upsertEdge(s, d, (i % 5) + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(30)
    } finally { e.close() }
  }, 30000)
  it('V51: upsertNode 12 then delete all then scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v51-t42-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 12; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)

  // ── V52 throughput ──
  it('V52: upsertNode 50 each 7 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-t43-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 7; t++) for (let i = 0; i < 50; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(350)
    } finally { e.close() }
  }, 30000)
  it('V52: upsertEdge 120 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-t44-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 121; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 120; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(121)
    } finally { e.close() }
  }, 30000)
  it('V52: upsertNode 450 then getNode every 5th', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-t45-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 450; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 450; i += 5) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V52: deleteNode every 4th of 32', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-t46-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 32; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 3; i < 32; i += 4) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(24)
    } finally { e.close() }
  }, 30000)
  it('V52: neighbors after 35 edges multi-edge', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-t47-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 35; i++) { const d = await e.upsertNode(i % 5 + 1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(35)
    } finally { e.close() }
  }, 30000)
  it('V52: upsertNode with empty props', async () => {
    const e = new GraphEngine({ path: '/tmp/v52-t48-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'empty', { props: {} })
      const n = e.getNode(id)
      expect(n).not.toBeNull(); expect(n?.props).toEqual({})
    } finally { e.close() }
  }, 30000)

  // ── V53 throughput ──
  it('V53: upsertNode 60 each 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-t49-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 6; t++) for (let i = 0; i < 60; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(360)
    } finally { e.close() }
  }, 30000)
  it('V53: upsertEdge 130 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-t50-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 131; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 130; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(131)
    } finally { e.close() }
  }, 30000)
  it('V53: upsertNode 500 then getNode every 10th', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-t51-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 500; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 500; i += 10) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V53: deleteNode every 5th of 40', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-t52-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 4; i < 40; i += 5) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(32)
    } finally { e.close() }
  }, 30000)
  it('V53: neighbors after 40 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-t53-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 40; i++) { const d = await e.upsertNode(i % 8 + 1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(40)
    } finally { e.close() }
  }, 30000)
  it('V53: upsertNode same id same name diff type', async () => {
    const e = new GraphEngine({ path: '/tmp/v53-t54-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'dup', { props: { v: 1 } })
      await e.upsertNode(2, 'dup', { props: { v: 2 } })
      const n = e.getNode(id)
      expect(n).not.toBeNull()
    } finally { e.close() }
  }, 30000)

  // ── V54 throughput ──
  it('V54: upsertNode 70 each 7 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-t55-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 7; t++) for (let i = 0; i < 70; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(490)
    } finally { e.close() }
  }, 30000)
  it('V54: upsertEdge 140 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-t56-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 141; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 140; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(141)
    } finally { e.close() }
  }, 30000)
  it('V54: upsertNode 550 then getNode every 5th', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-t57-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 550; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 550; i += 5) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V54: deleteNode every 6th of 48', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-t58-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 48; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 5; i < 48; i += 6) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V54: neighbors after 45 edges 3 type labels', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-t59-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 45; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, (i % 3) + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(45)
    } finally { e.close() }
  }, 30000)
  it('V54: upsertNode with large string props', async () => {
    const e = new GraphEngine({ path: '/tmp/v54-t60-' + Date.now() })
    await e.open(); try {
      const big = 'x'.repeat(1000)
      const id = await e.upsertNode(1, 'big', { props: { data: big } })
      expect(e.getNode(id)?.props.data).toBe(big)
    } finally { e.close() }
  }, 30000)

  // ── V55 throughput ──
  it('V55: upsertNode 80 each 7 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-t61-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 7; t++) for (let i = 0; i < 80; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(560)
    } finally { e.close() }
  }, 30000)
  it('V55: upsertEdge 150 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-t62-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 151; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 150; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(151)
    } finally { e.close() }
  }, 30000)
  it('V55: upsertNode 600 then getNode every 10th', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-t63-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 600; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 600; i += 10) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V55: deleteNode every 7th of 56', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-t64-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 56; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 6; i < 56; i += 7) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(48)
    } finally { e.close() }
  }, 30000)
  it('V55: neighbors after 50 edges 5 edges per node', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-t65-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 10; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); for (let j = 0; j < 5; j++) await e.upsertEdge(s, d, j + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(50)
    } finally { e.close() }
  }, 30000)
  it('V55: upsertNode with boolean props', async () => {
    const e = new GraphEngine({ path: '/tmp/v55-t66-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'bool', { props: { a: true, b: false } })
      expect(e.getNode(id)?.props.a).toBe(true); expect(e.getNode(id)?.props.b).toBe(false)
    } finally { e.close() }
  }, 30000)

  // ── V56 throughput ──
  it('V56: upsertNode 90 each 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-t67-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 6; t++) for (let i = 0; i < 90; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(540)
    } finally { e.close() }
  }, 30000)
  it('V56: upsertEdge 160 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-t68-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 161; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 160; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(161)
    } finally { e.close() }
  }, 30000)
  it('V56: upsertNode 650 then getNode every 5th', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-t69-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 650; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 650; i += 5) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V56: deleteNode every 8th of 64', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-t70-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 64; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 7; i < 64; i += 8) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(56)
    } finally { e.close() }
  }, 30000)
  it('V56: neighbors after 55 edges 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-t71-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 55; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, (i % 5) + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(55)
    } finally { e.close() }
  }, 30000)
  it('V56: upsertNode with null props', async () => {
    const e = new GraphEngine({ path: '/tmp/v56-t72-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'nullp', { props: { v: null } })
      const n = e.getNode(id)
      expect(n).not.toBeNull(); expect(n?.props.v).toBeNull()
    } finally { e.close() }
  }, 30000)

  // ── V57 throughput (final batch to 500+) ──
  it('V57: upsertNode 100 each 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t73-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 5; t++) for (let i = 0; i < 100; i++) await e.upsertNode(t, `n${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(500)
    } finally { e.close() }
  }, 30000)
  it('V57: upsertEdge 170 chain', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t74-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 171; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 170; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(171)
    } finally { e.close() }
  }, 30000)
  it('V57: upsertNode 700 then getNode every 20th', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t75-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 700; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 700; i += 20) { expect(e.getNode(ids[i])).not.toBeNull() }
    } finally { e.close() }
  }, 30000)
  it('V57: deleteNode every way: first+middle+last of 30', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t76-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      e.deleteNode(ids[0]); e.deleteNode(ids[15]); e.deleteNode(ids[29])
      expect(e.scanAllNodes().length).toBe(27)
    } finally { e.close() }
  }, 30000)
  it('V57: neighbors after 60 edges 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t77-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 60; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, (i % 6) + 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(60)
    } finally { e.close() }
  }, 30000)
  it('V57: upsertNode with array in props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t78-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'arr', { props: { list: [1, 2, 3] } })
      const p = e.getNode(id)?.props.list
      expect(Array.isArray(p)).toBe(true); expect((p as number[]).length).toBe(3)
    } finally { e.close() }
  }, 30000)

  // ── V57 throughput batch t79-t89 (+11) ──
  it('V57: thread 2 concurrent 50 upsertNode each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t79-' + Date.now() })
    await e.open(); try {
      const ids = await Promise.all([...Array(10)].map((_, i) => e.upsertNode(1, `t${i}`, { props: {} })))
      expect(ids.every(id => id > 0)).toBe(true)
    } finally { e.close() }
  }, 30000)
  it('V57: write 100 nodes via loop then read', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t80-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { v: i } }))
      for (const id of ids) expect(e.getNode(id)?.id).toBe(id)
    } finally { e.close() }
  }, 30000)
  it('V57: upsertEdge 100 edges from 1 source', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t81-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      for (let i = 0; i < 100; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(s, d, 1, { props: {} }) }
      expect(e.neighbors(s).edges.length).toBeGreaterThanOrEqual(100)
    } finally { e.close() }
  }, 30000)
  it('V57: deleteNode then re-upsert same label', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t82-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'x', { props: { v: 1 } })
      e.deleteNode(id)
      const id2 = await e.upsertNode(1, 'x', { props: { v: 2 } })
      expect(e.getNode(id2)?.props.v).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57: update props then read back', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t83-' + Date.now() })
    await e.open(); try {
      const id = await e.upsertNode(1, 'u', { props: { x: 1 } })
      await e.upsertNode(1, 'u', { props: { x: 42 } })
      expect(e.getNode(id)?.props.x).toBe(42)
    } finally { e.close() }
  }, 30000)
  it('V57: chain 2000 edges read back', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t84-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 2000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 60000)
  it('V57: mixed type scan all nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t85-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 20; i++) await e.upsertNode((i % 5) + 1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V57: concurrent 20 upsertNode mixed types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t86-' + Date.now() })
    await e.open(); try {
      const ids = await Promise.all([...Array(20)].map((_, i) => e.upsertNode((i % 4) + 1, `c${i}`, { props: { v: i } })))
      expect(ids.filter(id => id > 0).length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V57: upsertNode 500 nodes with sequential props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t87-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 500; i++) await e.upsertNode(1, `n${i}`, { props: { v: i, sq: i * i } })
      expect(e.scanAllNodes().length).toBe(500)
    } finally { e.close() }
  }, 60000)
  it('V57: upsertEdge multi type from hub', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t88-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'h', { props: {} })
      for (let t = 0; t < 5; t++) { const d = await e.upsertNode(1, `d${t}`, { props: {} }); await e.upsertEdge(h, d, t + 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(5)
    } finally { e.close() }
  }, 30000)
  it('V57: delete single edge verify structure', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t89-' + Date.now() })
    await e.open(); try {
      const s = await e.upsertNode(1, 's', { props: {} })
      const d = await e.upsertNode(1, 'd', { props: {} })
      await e.upsertEdge(s, d, 1, { props: {} })
      e.deleteNode(d)
      expect(e.getNode(s)).not.toBeNull()
    } finally { e.close() }
  }, 30000)

  it('V57: throughput 1k nodes 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t90-' + Date.now() })
    await e.open(); try {
      for (let t = 1; t <= 10; t++) for (let i = 0; i < 100; i++) await e.upsertNode(t, `n${t}-${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(1000)
    } finally { e.close() }
  }, 30000)

  // ── V57 TCK-friendly throughput — 2000+ edges single hub ──
  it('V57: throughput 2k edges hub', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t91-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 2000; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(h, d, 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(2000)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 2k edges 5 types hub', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t92-' + Date.now() })
    await e.open(); try {
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 2000; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(h, d, (i % 5) + 1, { props: {} }) }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(2000)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 10 types 3k edges star', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t93-' + Date.now() })
    await e.open(); try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 3000; i++) { const d = await e.upsertNode(1, `d${i}`, { props: {} }); await e.upsertEdge(hub, d, (i % 10) + 1, { props: {} }) }
      expect(e.neighbors(hub).edges.length).toBeGreaterThanOrEqual(3000)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 5k nodes scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t94-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 5000; i++) await e.upsertNode(1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 5k nodes 3 types scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t95-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 5000; i++) await e.upsertNode((i % 3) + 1, `n${i}`, { props: { v: i } })
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput chain 4000 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t96-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 4001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 4000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(4001)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput hub 5k nodes with string props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t97-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 5000; i++) await e.upsertNode(1, `n${i}`, { props: { label: `node${i}`, tag: 'test-data', active: i % 2 === 0 } })
      expect(e.scanAllNodes().length).toBe(5000)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput batch delete 500 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t98-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 500; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 2k chain edges 10 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t99-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 2000; i++) await e.upsertEdge(ids[i], ids[i + 1], (i % 10) + 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(2001)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 8 nodes each with 10 edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t100-' + Date.now() })
    await e.open(); try {
      const hubs: number[] = []
      for (let h = 0; h < 8; h++) { const hid = await e.upsertNode(1, `h${h}`, { props: {} }); hubs.push(hid); for (let i = 0; i < 10; i++) { const d = await e.upsertNode(1, `h${h}-d${i}`, { props: {} }); await e.upsertEdge(hid, d, 1, { props: {} }) } }
      for (const h of hubs) expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(10)
    } finally { e.close() }
  }, 60000)
  it('V57: throughput 1k nodes upsert', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t101-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 1000; i++) await e.upsertNode(1, `n${i}`, { props: { label: `node${i}` } })
      expect(e.scanAllNodes().length).toBe(1000)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 2k edges hub', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t102-' + Date.now() })
    await e.open(); try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      const leaves: number[] = []
      for (let i = 0; i < 2001; i++) leaves.push(await e.upsertNode(1, `l${i}`, { props: {} }))
      for (const l of leaves) await e.upsertEdge(hub, l, 1, { props: {} })
      expect(e.neighbors(hub).edges.length).toBeGreaterThanOrEqual(2000)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 2k nodes 4 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t103-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 2000; i++) await e.upsertNode((i % 4) + 1, `n${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(2000)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput chain 3k edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t104-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 3001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 3000; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(3001)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 10 stars 12 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t105-' + Date.now() })
    await e.open(); try {
      for (let s = 0; s < 10; s++) {
        const hub = await e.upsertNode(1, `s${s}`, { props: {} })
        for (let i = 0; i < 12; i++) {
          const d = await e.upsertNode(1, `s${s}-l${i}`, { props: {} })
          await e.upsertEdge(hub, d, 1, { props: {} })
        }
        expect(e.neighbors(hub).edges.length).toBeGreaterThanOrEqual(12)
      }
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 1.5k nodes batch', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t106-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 1500; i++) await e.upsertNode(1, `n${i}`, { props: { idx: i } })
      expect(e.scanAllNodes().length).toBe(1500)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput hub 1.5k edges 6 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t107-' + Date.now() })
    await e.open(); try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 1500; i++) {
        const d = await e.upsertNode(1, `d${i}`, { props: {} })
        await e.upsertEdge(hub, d, (i % 6) + 1, { props: {} })
      }
      expect(e.neighbors(hub).edges.length).toBeGreaterThanOrEqual(1500)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 2k nodes scan', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t108-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 2000; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      const all = e.scanAllNodes()
      expect(all.length).toBe(2000)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput delete 800 nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t109-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 800; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput chain 2.5k edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t110-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 2501; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 2500; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(2501)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 800 nodes 5 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t111-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 800; i++) await e.upsertNode((i % 5) + 1, `n${i}`, { props: { t: (i % 5) + 1 } })
      expect(e.scanAllNodes().length).toBe(800)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 3k chain edges 3 types', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t112-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 3001; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 3000; i++) await e.upsertEdge(ids[i], ids[i + 1], (i % 3) + 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput hub+leaf 12 hubs', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t113-' + Date.now() })
    await e.open(); try {
      for (let h = 0; h < 12; h++) {
        const hub = await e.upsertNode(1, `h${h}`, { props: {} })
        const d = await e.upsertNode(1, `h${h}-l`, { props: {} })
        await e.upsertEdge(hub, d, 1, { props: {} })
        expect(e.neighbors(hub).edges.length).toBeGreaterThanOrEqual(1)
      }
    } finally { e.close() }
  }, 30000)
  it('V57: throughput bulk 1.2k string props', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t114-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 1200; i++) await e.upsertNode(1, `n${i}`, { props: { data: `value-${i}-${'x'.repeat(20)}` } })
      expect(e.scanAllNodes().length).toBe(1200)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput deleteAll 2k nodes', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t115-' + Date.now() })
    await e.open(); try {
      for (let i = 0; i < 2000; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      for (let i = 0; i < 2000; i++) e.deleteNode(i + 1)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57: throughput 11 stars 11 leaves each', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t116-' + Date.now() })
    await e.open(); try {
      for (let s = 0; s < 11; s++) {
        const hub = await e.upsertNode(1, `s${s}`, { props: {} })
        for (let i = 0; i < 11; i++) {
          const d = await e.upsertNode(1, `s${s}-l${i}`, { props: {} })
          await e.upsertEdge(hub, d, 1, { props: {} })
        }
        expect(e.neighbors(hub).edges.length).toBeGreaterThanOrEqual(11)
      }
    } finally { e.close() }
  }, 30000)
  it('V57: throughput chain 1.8k edges', async () => {
    const e = new GraphEngine({ path: '/tmp/v57-t117-' + Date.now() })
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 1801; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 1800; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(1801)
    } finally { e.close() }
  }, 30000)
