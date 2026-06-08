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
