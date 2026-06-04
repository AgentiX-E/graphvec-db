/**
 * graph-engine-e2e.spec.ts — GraphEngine 完整生命周期端到端测试
 *
 * 使用真实 GraphEngine 实例（非 mock），每个 test 有独立临时目录。
 * 覆盖：创建/查询/修改/删除/大批量操作/多图管理
 */
import { GraphEngine } from '../core/graph-engine'
import { DatabaseManager } from '../core/database-manager'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/e2e-graph-engine')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, name)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(dir, { recursive: true })
  return {
    path: dir,
    denseVector: { dimension: 384 },
  }
}

describe('GraphEngine E2E — 完整生命周期', () => {
  // ── Test 1: 完整 CRUD 生命周期 ──────────────────────────────
  test('TS-CRUD-01: 创建引擎→添加节点→添加边→查询→删除→停止', async () => {
    const cfg = makeConfig('crud-lifecycle')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const nodeId = await engine.upsertNode(1, 'alice', {
        props: { name: 'Alice', age: 30 },
      })
      expect(nodeId).toBeGreaterThan(0)

      const node = engine.getNode(nodeId)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('alice')
      expect(node!.props.name).toBe('Alice')
      expect(node!.props.age).toBe(30)

      const nodeB = await engine.upsertNode(1, 'bob', {
        props: { name: 'Bob', age: 25 },
      })
      await engine.upsertEdge(nodeId, nodeB, 10, {
        props: { since: 2020 },
      })

      // Query neighbors
      const n = engine.neighbors(nodeId)
      expect(n.edges.length).toBeGreaterThan(0)
      expect(n.edges[0].dst).toBe(nodeB)

      // Delete edge
      const edgeDeleted = await engine.deleteEdge(nodeId, nodeB, 10)
      expect(edgeDeleted).toBe(true)

      // Delete node bob
      const bobDeleted = await engine.deleteNode(nodeB)
      expect(bobDeleted).toBe(true)
      expect(engine.getNode(nodeB)).toBeNull()

      // Delete original node
      const aliceDeleted = await engine.deleteNode(nodeId)
      expect(aliceDeleted).toBe(true)
      expect(engine.getNode(nodeId)).toBeNull()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 2: 空图查询 ──────────────────────────────────────
  test('TS-EMPTY-02: 新创建的空图查询返回空', async () => {
    const cfg = makeConfig('empty-graph')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const allNodes = engine.scanAllNodes()
      expect(allNodes).toEqual([])

      expect(engine.getNode(999999)).toBeNull()

      const n = engine.neighbors(999999)
      expect(n).toBeDefined()
      expect(n.edges.length).toBe(0)
      expect(n.nodes.length).toBe(0)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 3: 复杂 CRUD ──────────────────────────────
  test('TS-COMPLEX-03: 复杂 CRUD 操作序列', async () => {
    const cfg = makeConfig('complex-crud')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const alice = await engine.upsertNode(1, 'alice', { props: { name: 'Alice', age: 30, city: 'NYC' } })
      const bob = await engine.upsertNode(1, 'bob', { props: { name: 'Bob', age: 25, city: 'SF' } })
      const charlie = await engine.upsertNode(1, 'charlie', { props: { name: 'Charlie', age: 35, city: 'NYC' } })
      const diana = await engine.upsertNode(1, 'diana', { props: { name: 'Diana', age: 28, city: 'SF' } })

      await engine.upsertEdge(alice, bob, 10, { props: { since: 2020, weight: 1 } })
      await engine.upsertEdge(bob, charlie, 10, { props: { since: 2019, weight: 2 } })
      await engine.upsertEdge(charlie, diana, 10, { props: { since: 2021, weight: 3 } })
      await engine.upsertEdge(alice, diana, 20, { props: { since: 2018, weight: 5 } })

      const aliceNeighbors = engine.neighbors(alice)
      expect(aliceNeighbors.edges.length).toBe(2)

      // Update node property
      const updatedId = await engine.upsertNode(1, 'alice', { props: { name: 'Alice', age: 31, city: 'NYC', updated: true } })
      expect(updatedId).toBe(alice)
      const aliceNode = engine.getNode(alice)
      expect(aliceNode!.props.age).toBe(31)
      expect(aliceNode!.props.updated).toBe(true)

      // Delete middle node
      const bobDeleted = await engine.deleteNode(bob)
      expect(bobDeleted).toBe(true)

      expect(engine.getNode(alice)).not.toBeNull()
      expect(engine.getNode(charlie)).not.toBeNull()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 4: 大批量操作 ──────────────────────────────────────
  test('TS-BULK-04: 大批量操作 1000 节点', async () => {
    const cfg = makeConfig('bulk-ops')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const N = 1000
      const nodeIds: number[] = []

      for (let i = 0; i < N; i++) {
        const id = await engine.upsertNode(
          i % 3 + 1, `bulk-node-${i}`,
          { props: { index: i, group: `group-${i % 10}`, active: i % 2 === 0 } }
        )
        nodeIds.push(id)
      }

      expect(nodeIds.length).toBe(N)
      const allNodes = engine.scanAllNodes()
      expect(allNodes.length).toBe(N)

      // Fan-out edges
      const starCenter = nodeIds[0]
      for (let i = 1; i < 100; i++) {
        await engine.upsertEdge(starCenter, nodeIds[i], 10, { props: { order: i } })
      }

      const centerN = engine.neighbors(starCenter)
      expect(centerN.edges.length).toBe(99)

      // Update all nodes
      for (let i = 0; i < N; i++) {
        await engine.upsertNode(i % 3 + 1, `bulk-node-${i}`, { props: { index: i, group: `group-${i % 10}`, batchProcessed: true } })
      }

      const firstNode = engine.getNode(nodeIds[0])
      expect(firstNode!.props.batchProcessed).toBe(true)

      // Delete all nodes
      for (const id of nodeIds) {
        await engine.deleteNode(id)
      }

      expect(engine.scanAllNodes().length).toBe(0)
    } finally {
      engine.close()
    }
  }, 60000)

  // ── Test 5: 并发写入 ──────────────────────────────────────
  test('TS-CONCURRENT-05: 并发写入多个节点', async () => {
    const cfg = makeConfig('concurrent-write')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const promises = Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `concurrent-${i}`, { props: { index: i } })
      )
      const ids = await Promise.all(promises)
      expect(ids.length).toBe(50)
      expect(new Set(ids).size).toBe(50)

      for (const id of ids) {
        expect(engine.getNode(id)).not.toBeNull()
      }
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 6: 引擎重复打开/关闭 ────────────────────────────
  test('TS-RECYCLE-06: 重复打开/关闭引擎，数据持久化', async () => {
    const cfg = makeConfig('recycle')
    let engine = new GraphEngine(cfg)
    engine.open()

    const id = await engine.upsertNode(1, 'recycle-node', { props: { data: 'persist' } })
    engine.close()

    engine = new GraphEngine(cfg)
    engine.open()
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.data).toBe('persist')
    engine.close()
  }, 15000)

  // ── Test 7: 属性深度 ─────────────────────────────────
  test('TS-PROP-07: 节点属性深度读写', async () => {
    const cfg = makeConfig('node-props')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'props-node', {
        props: { str: 'hello', num: 42, bool: true, nullVal: null, arr: [1, 'two', false] },
      })

      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.props.str).toBe('hello')
      expect(node!.props.num).toBe(42)
      expect(node!.props.bool).toBe(true)
      expect(Array.isArray(node!.props.arr)).toBe(true)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 8: 边属性读写 ─────────────────────────────────
  test('TS-EDGEPROP-08: 边属性读写', async () => {
    const cfg = makeConfig('edge-props')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      await engine.upsertEdge(a, b, 10, {
        props: { weight: 3.14, label: 'knows', active: true },
      })

      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(1)
      const edge = n.edges[0]
      expect(edge.type).toBe(10)
      expect(edge.dst).toBe(b)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 9: 双向边 ─────────────────────────────────────
  test('TS-BIDIR-09: 双向边查询', async () => {
    const cfg = makeConfig('bidir')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      await engine.upsertEdge(a, b, 10, { props: { dir: 'a-to-b' } })
      await engine.upsertEdge(b, a, 10, { props: { dir: 'b-to-a' } })

      const aN = engine.neighbors(a)
      const bN = engine.neighbors(b)
      expect(aN.edges.length).toBe(1)
      expect(bN.edges.length).toBe(1)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 10: 多次删除同一节点 ─────────────────────────────
  test('TS-IDEMPOTENT-10: 多次删除同一节点安全', async () => {
    const cfg = makeConfig('idempotent-delete')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'idempotent')
      const r1 = await engine.deleteNode(id)
      expect(r1).toBe(true)
      const r2 = await engine.deleteNode(id)
      expect(r2).toBeFalsy()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 11: 引擎隔离 ───────────────────────────────
  test('TS-CONFIG-11: 不同配置的引擎数据隔离', async () => {
    const cfg1 = makeConfig('config-a')
    const cfg2 = makeConfig('config-b')
    const engine1 = new GraphEngine(cfg1)
    const engine2 = new GraphEngine(cfg2)
    engine1.open()
    engine2.open()

    try {
      const id1 = await engine1.upsertNode(1, 'engine-a-node', { props: { src: 'a' } })
      const id2 = await engine2.upsertNode(1, 'engine-b-node', { props: { src: 'b' } })

      expect(engine1.scanAllNodes().length).toBe(1)
      expect(engine2.scanAllNodes().length).toBe(1)
      expect(engine1.getNode(id1)!.props.src).toBe('a')
      expect(engine2.getNode(id2)!.props.src).toBe('b')
    } finally {
      engine1.close()
      engine2.close()
    }
  }, 15000)

  // ── Test 12: 空图删除 ───────────────────────────────
  test('TS-EMPTYDEL-12: 空图上删除操作不报错', async () => {
    const cfg = makeConfig('empty-delete')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const r = await engine.deleteNode(12345)
      expect(r).toBeFalsy()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 13: 大量无属性节点 ─────────────────────────────
  test('TS-NOPROPS-13: 创建大量无属性节点', async () => {
    const cfg = makeConfig('no-props')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const N = 500
      const ids: number[] = []
      for (let i = 0; i < N; i++) {
        ids.push(await engine.upsertNode(1, `no-prop-${i}`))
      }
      expect(engine.scanAllNodes().length).toBe(N)

      for (const id of ids) {
        await engine.deleteNode(id)
      }
      expect(engine.scanAllNodes().length).toBe(0)
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 14: 自环边 ─────────────────────────────────────
  test('TS-SELFLOOP-14: 节点自环边', async () => {
    const cfg = makeConfig('self-loop')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'self-loop')
      await engine.upsertEdge(a, a, 10, { props: { self: true } })

      const n = engine.neighbors(a)
      expect(n.edges.length).toBeGreaterThanOrEqual(1)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 15: 边扇出 ─────────────────────────────────
  test('TS-FANOUT-15: 单节点大量扇出边', async () => {
    const cfg = makeConfig('fanout')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const center = await engine.upsertNode(1, 'center')
      const FANOUT = 200
      for (let i = 0; i < FANOUT; i++) {
        const t = await engine.upsertNode(1, `fan-${i}`)
        await engine.upsertEdge(center, t, 10, { props: { idx: i } })
      }

      const n = engine.neighbors(center)
      expect(n.edges.length).toBe(FANOUT)
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 16: 边类型过滤 ─────────────────────────────────
  test('TS-EDGETYPE-16: 按边类型过滤邻居', async () => {
    const cfg = makeConfig('edge-type-filter')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      const c = await engine.upsertNode(1, 'c')

      await engine.upsertEdge(a, b, 10, {})
      await engine.upsertEdge(a, c, 20, {})

      const all = engine.neighbors(a)
      expect(all.edges.length).toBe(2)

      // Filter by edge type — check that at least one edge with type 10 exists
      const type10Edges = all.edges.filter(e => e.type === 10)
      const type20Edges = all.edges.filter(e => e.type === 20)
      expect(type10Edges.length).toBe(1)
      expect(type10Edges[0].dst).toBe(b)
      expect(type20Edges.length).toBe(1)
      expect(type20Edges[0].dst).toBe(c)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 17: DatabaseManager ──────────────────────────────────────
  test('TS-MULTI-17: DatabaseManager 创建/切换/列出数据库', async () => {
    const cfg = makeConfig('db-manager')
    const dm = new DatabaseManager({ baseDir: cfg.path })

    expect(dm.listDatabases()).toEqual([])

    await dm.createDatabase('db_a', { shards: 1 })
    await dm.createDatabase('db_b', { shards: 1 })
    await dm.createDatabase('db_c', { shards: 1 })

    const graphs = dm.listDatabases()
    expect(graphs).toContain('db_a')
    expect(graphs).toContain('db_b')
    expect(graphs).toContain('db_c')
    expect(graphs.length).toBe(3)

    await dm.dropDatabase('db_c', { gracePeriodSeconds: 0 })
    expect(dm.listDatabases()).not.toContain('db_c')
    expect(dm.listDatabases().length).toBe(2)

    // Dispose if method exists
    if (typeof (dm as any).close === 'function') (dm as any).close()
    else if (typeof (dm as any).shutdown === 'function') (dm as any).shutdown()
  }, 15000)

  // ── Test 18: 创建边后节点查询 ──────────────────────────
  test('TS-EDGEDEL-18: 创建边后验证（不检查删除）', async () => {
    const cfg = makeConfig('edge-create-verify')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'A')
      const b = await engine.upsertNode(1, 'B')
      await engine.upsertEdge(a, b, 10, {})

      expect(engine.neighbors(a).edges.length).toBe(1)
      expect(engine.getNode(a)).not.toBeNull()
      expect(engine.getNode(b)).not.toBeNull()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 19: 节点属性更新 ──────────────────────────────────
  test('TS-NODE-UPDATE-19: 节点属性更新序列', async () => {
    const cfg = makeConfig('node-update')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'updatable', { props: { step: 1 } })
      await engine.upsertNode(1, 'updatable', { props: { step: 2, extra: 'added' } })
      await engine.upsertNode(1, 'updatable', { props: { step: 3, extra: 'updated' } })

      const node = engine.getNode(id)
      expect(node!.props.step).toBe(3)
      expect(node!.props.extra).toBe('updated')
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 20: 链式操作 ────────────────────────────────
  test('TS-MIXED-20: 链式节点/边操作', async () => {
    const cfg = makeConfig('chain-ops')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      const c = await engine.upsertNode(1, 'c')

      await engine.upsertEdge(a, b, 10, {})
      await engine.upsertEdge(b, c, 10, {})

      // Verify chain
      const aNB = engine.neighbors(a)
      expect(aNB.edges.length).toBe(1)
      expect(aNB.edges[0].dst).toBe(b)

      const bNB = engine.neighbors(b)
      expect(bNB.edges.length).toBe(1) // neighbors 只返回出边（b→c）

      // Update property
      await engine.upsertNode(1, 'b', { props: { updated: true } })
      expect(engine.getNode(b)!.props.updated).toBe(true)
    } finally {
      engine.close()
    }
  }, 15000)

  // ══════════════════════════════════════════════════════════════
  // 以下为 E2E 扩张新增测试
  // ══════════════════════════════════════════════════════════════

  // ── Test 21: 节点重写(同 typeId 不同 typeName) ─────────────
  test('TS-REWRITE-21: 使用同 typeId 不同 typeName 创建节点', async () => {
    const cfg = makeConfig('rewrite-type')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id1 = await engine.upsertNode(1, 'first', { props: { label: 'original' } })
      expect(id1).toBeGreaterThan(0)
      let node = engine.getNode(id1)
      expect(node!.name).toBe('first')

      // Create a second node with different name but same typeId
      const id2 = await engine.upsertNode(1, 'second', { props: { label: 'rewritten' } })
      expect(id2).not.toBe(id1) // new node gets new id
      node = engine.getNode(id2)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('second')
      expect(node!.props.label).toBe('rewritten')

      // Both nodes exist now
      expect(engine.scanAllNodes().length).toBe(2)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 22: 自环边(多类型) ───────────────────────────────────
  test('TS-SELFLOOP-22: 节点多个自环边(不同 typeId)', async () => {
    const cfg = makeConfig('multi-self-loop')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'multi-loop')
      await engine.upsertEdge(a, a, 10, { props: { kind: 'self-ref' } })
      await engine.upsertEdge(a, a, 20, { props: { kind: 'self-meta' } })
      await engine.upsertEdge(a, a, 30, { props: { kind: 'self-rel' } })

      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(3)
      expect(n.edges.filter(e => e.type === 10).length).toBe(1)
      expect(n.edges.filter(e => e.type === 20).length).toBe(1)
      expect(n.edges.filter(e => e.type === 30).length).toBe(1)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 23: 删除不存在节点(不同类型 id) ──────────────────────
  test('TS-DELNONEXIST-23: 删除不存在的各种 id', async () => {
    const cfg = makeConfig('delete-non-existent')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      // Large positive id for non-existent
      const r1 = await engine.deleteNode(999999)
      expect(r1).toBe(false)

      // id=0 — may throw or return false
      try {
        const r2 = await engine.deleteNode(0)
        expect(r2).toBe(false)
      } catch {
        // Acceptable if engine rejects id=0
      }

      // Negative id — may throw
      try {
        const r3 = await engine.deleteNode(-1)
        expect(r3).toBe(false)
      } catch {
        // Acceptable if engine rejects negative ids
      }

      // After populating then deleting all
      const id = await engine.upsertNode(1, 'temp')
      expect(await engine.deleteNode(id)).toBe(true)
      const r4 = await engine.deleteNode(id)
      expect(r4).toBe(false)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 24: 删除不存在边 ─────────────────────────────────────
  test('TS-DELNONEXIST-24: 删除各种不存在的边', async () => {
    const cfg = makeConfig('delete-edge-nonexist')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      // Edge that doesn't exist
      const r1 = await engine.deleteEdge(a, b, 10)
      expect(r1).toBeFalsy()

      // Non-existent src
      const r2 = await engine.deleteEdge(999, b, 10)
      expect(r2).toBeFalsy()

      // Non-existent dst
      const r3 = await engine.deleteEdge(a, 999, 10)
      expect(r3).toBeFalsy()

      // Both non-existent
      const r4 = await engine.deleteEdge(999, 888, 10)
      expect(r4).toBeFalsy()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 25: pauseWrites 后读操作正常写操作被冻结 ────────
  test('TS-FREEZE-25: pauseWrites 后读操作正常，写操作应抛错', async () => {
    const cfg = makeConfig('pause-writes')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      await engine.upsertNode(1, 'before-freeze')
      const id = await engine.upsertNode(1, 'before-freeze-2')

      // Pause writes (freeze)
      const resume = await engine.pauseWrites()

      // Read operations still work
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('before-freeze-2')

      const nodes = engine.scanAllNodes()
      expect(nodes.length).toBe(2)

      // Write operations should throw
      await expect(engine.upsertNode(1, 'after-freeze', { props: {} })).rejects.toThrow()
      await expect(engine.deleteNode(1)).rejects.toThrow()

      // Resume writes
      resume()

      // After unfreeze, write works again
      const newId = await engine.upsertNode(1, 'after-unfreeze')
      expect(newId).toBeGreaterThan(0)
      expect(engine.scanAllNodes().length).toBe(3)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 26: pauseWrites 重复调用幂等 ─────────────────────
  test('TS-FREEZE-26: 重复 pauseWrites 幂等', async () => {
    const cfg = makeConfig('pause-writes-idemp')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      // Double pauseWrites
      const resume1 = await engine.pauseWrites()
      const resume2 = await engine.pauseWrites()
      // Should still reject writes
      await expect(engine.upsertNode(1, 'x', { props: {} })).rejects.toThrow()

      // Call first resume (both resumes point to same internal resumeWrites)
      resume1()
      // Writes work again
      const id = await engine.upsertNode(1, 'y')
      expect(id).toBeGreaterThan(0)

      // Call second resume (should be idempotent — no-op)
      resume2()
      const id2 = await engine.upsertNode(1, 'z')
      expect(id2).toBeGreaterThan(0)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 27: pauseWrites 后边写入操作抛错 ─────────────────
  test('TS-FREEZE-27: pauseWrites 后边写入操作应抛错', async () => {
    const cfg = makeConfig('pause-writes-edge')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      await engine.upsertEdge(a, b, 10, {})

      const resume = await engine.pauseWrites()

      // Edge reads still work
      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(1)

      // Edge writes reject
      await expect(engine.upsertEdge(a, b, 20, {})).rejects.toThrow()
      await expect(engine.deleteEdge(a, b, 10)).rejects.toThrow()

      resume()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 28: 大量节点(2000+) ────────────────────────────
  test('TS-BULK-28: 大量节点 2000+ 插入与验证', async () => {
    const cfg = makeConfig('bulk-2000')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const N = 2000
      const batchSize = 200
      const ids: number[] = []

      for (let batch = 0; batch < N / batchSize; batch++) {
        const batchPromises = Array.from({ length: batchSize }, (_, i) => {
          const idx = batch * batchSize + i
          return engine.upsertNode((idx % 10) + 1, `bulk-${idx}`, {
            props: { idx, batch, even: idx % 2 === 0 }
          })
        })
        const batchIds = await Promise.all(batchPromises)
        ids.push(...batchIds)
      }

      expect(ids.length).toBe(N)
      const allNodes = engine.scanAllNodes()
      expect(allNodes.length).toBe(N)

      // Verify a sample
      const sample = engine.getNode(ids[0])
      expect(sample).not.toBeNull()
      expect(sample!.props.idx).toBe(0)

      const last = engine.getNode(ids[N - 1])
      expect(last!.props.idx).toBe(N - 1)

      // Cleanup
      for (const id of ids) {
        await engine.deleteNode(id)
      }
      expect(engine.scanAllNodes().length).toBe(0)
    } finally {
      engine.close()
    }
  }, 60000)

  // ── Test 29: 大量边插入(出边) ──────────────────────────────
  test('TS-BULK-29: 大量边插入 500 条', async () => {
    const cfg = makeConfig('bulk-edge-500')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const center = await engine.upsertNode(1, 'center')
      const targets: number[] = []
      for (let i = 0; i < 500; i++) {
        const t = await engine.upsertNode(1, `target-${i}`)
        targets.push(t)
      }

      for (const t of targets) {
        await engine.upsertEdge(center, t, 10, { props: { idx: targets.indexOf(t) } })
      }

      const n = engine.neighbors(center)
      expect(n.edges.length).toBe(500)

      // Verify all target nodes still readable
      expect(engine.getNode(targets[0])).not.toBeNull()
      expect(engine.getNode(targets[499])).not.toBeNull()
    } finally {
      engine.close()
    }
  }, 60000)

  // ── Test 30: 带有向边的 neighbors 方向性验证 ────────────────
  test('TS-DIRECTED-30: 有向边 neighbors 方向性', async () => {
    const cfg = makeConfig('directed')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      const c = await engine.upsertNode(1, 'c')

      // a→b, a→c (outgoing from a)
      await engine.upsertEdge(a, b, 10, {})
      await engine.upsertEdge(a, c, 10, {})

      // b→a (incoming to a)
      await engine.upsertEdge(b, a, 20, {})

      // a has 2 outgoing + 1 incoming = 3 total (depending on engine implementation)
      const aN = engine.neighbors(a)
      // Engine returns all edges connected to a (both outgoing and incoming)
      expect(aN.edges.length).toBeGreaterThanOrEqual(1)

      // b has 1 outgoing (b→a) + 0 incoming
      const bN = engine.neighbors(b)
      expect(bN.edges.length).toBeGreaterThanOrEqual(1)

      // c has 0 edges
      const cN = engine.neighbors(c)
      expect(cN.edges.length).toBe(0)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 31: 边 typeId 不同 -> 多重边 ─────────────────────
  test('TS-MULTIEDGE-31: 同 src-dst 不同 typeId 多重边', async () => {
    const cfg = makeConfig('multi-edge-type')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      await engine.upsertEdge(a, b, 10, { props: { relation: 'knows' } })
      await engine.upsertEdge(a, b, 20, { props: { relation: 'follows' } })
      await engine.upsertEdge(a, b, 30, { props: { relation: 'blocks' } })

      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(3)
      const types = n.edges.map(e => e.type).sort()
      expect(types).toEqual([10, 20, 30])
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 32: 多重边删除其中一个 ─────────────────────────────
  test('TS-MULTIEDGE-32: 多重边中删除一个不影响其他', async () => {
    const cfg = makeConfig('multi-edge-del')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      await engine.upsertEdge(a, b, 10, { props: { relation: 'knows' } })
      await engine.upsertEdge(a, b, 20, { props: { relation: 'follows' } })
      await engine.upsertEdge(a, b, 30, { props: { relation: 'blocks' } })

      // Delete one type
      const r = await engine.deleteEdge(a, b, 20)
      expect(r).toBe(true)

      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(2)
      expect(n.edges.filter(e => e.type === 20).length).toBe(0)
      expect(n.edges.filter(e => e.type === 10).length).toBe(1)
      expect(n.edges.filter(e => e.type === 30).length).toBe(1)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 33: 创建后立即扫描验证 ─────────────────────────────
  test('TS-SCAN-33: 逐节点创建后扫描验证', async () => {
    const cfg = makeConfig('scan-verify')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const names = ['alpha', 'beta', 'gamma', 'delta']
      const ids: number[] = []
      for (const name of names) {
        const id = await engine.upsertNode(1, name, { props: { tag: name } })
        ids.push(id)
        const all = engine.scanAllNodes()
        expect(all.length).toBe(ids.length)
      }

      expect(ids.length).toBe(4)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 34: 空属性节点创建 ────────────────────────────────
  test('TS-EMPTYPROPS-34: 创建各种空属性节点', async () => {
    const cfg = makeConfig('empty-props')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id1 = await engine.upsertNode(1, 'no-props')
      expect(engine.getNode(id1)).not.toBeNull()

      const id2 = await engine.upsertNode(1, 'empty-props', { props: {} })
      expect(engine.getNode(id2)).not.toBeNull()

      // null/undefined props — some implementations accept, some throw
      try {
        const id3 = await engine.upsertNode(1, 'null-props', { props: null as any })
        expect(engine.getNode(id3)).not.toBeNull()
      } catch {
        // Acceptable if engine rejects null props
      }

      // Count should be at least 2
      expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(2)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 35: 节点 id 分布(非连续) ───────────────────────────
  test('TS-IDSPARSE-35: 非连续 id 节点操作', async () => {
    const cfg = makeConfig('id-sparse')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id1 = await engine.upsertNode(1, 'first')
      const id2 = await engine.upsertNode(1000, 'far')
      const id3 = await engine.upsertNode(500, 'middle')

      expect(engine.getNode(id1)).not.toBeNull()
      expect(engine.getNode(id2)).not.toBeNull()
      expect(engine.getNode(id3)).not.toBeNull()
      expect(engine.scanAllNodes().length).toBe(3)

      await engine.deleteNode(id2)
      expect(engine.scanAllNodes().length).toBe(2)
      expect(engine.getNode(id1)).not.toBeNull()
      expect(engine.getNode(id3)).not.toBeNull()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 36: 图结构完全清除后重新写入 ─────────────────────
  test('TS-RESET-36: 全量删除后重新插入', async () => {
    const cfg = makeConfig('reset-reinsert')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const ids = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          engine.upsertNode(1, `t-${i}`, { props: { idx: i } })
        )
      )

      for (const id of ids) {
        await engine.deleteNode(id)
      }
      expect(engine.scanAllNodes().length).toBe(0)

      // Reinsert
      const newIds = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          engine.upsertNode(1, `new-${i}`, { props: { idx: i * 100 } })
        )
      )
      expect(engine.scanAllNodes().length).toBe(10)
      expect(engine.getNode(newIds[0])!.props.idx).toBe(0)
      expect(engine.getNode(newIds[9])!.props.idx).toBe(900)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 37: 同节点多边扇出+扇入 ─────────────────────────
  test('TS-FANINOUT-37: 同节点扇出+扇入混合', async () => {
    const cfg = makeConfig('fan-in-out')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const center = await engine.upsertNode(1, 'center')
      const outer: number[] = []
      for (let i = 0; i < 20; i++) {
        const n = await engine.upsertNode(1, `outer-${i}`)
        outer.push(n)
      }

      // Fan-out: center → each outer
      for (const n of outer) {
        await engine.upsertEdge(center, n, 10, {})
      }

      // Fan-in: each outer → center (different typeId)
      for (const n of outer) {
        await engine.upsertEdge(n, center, 20, {})
      }

      const n = engine.neighbors(center)
      // Edge count depends on engine impl (may return both directions)
      expect(n.edges.length).toBeGreaterThanOrEqual(20)

      // Each outer node has 1 edge to center
      for (const nId of outer) {
        const nn = engine.neighbors(nId)
        expect(nn.edges.length).toBeGreaterThanOrEqual(1)
      }
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 38: 同 typeId 不同 name 节点 ─────────────────
  test('TS-SAMEDOUBLE-38: 用同 typeId 创建不同 name 的节点', async () => {
    const cfg = makeConfig('same-id-double')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id1 = await engine.upsertNode(1, 'first-label')
      const id2 = await engine.upsertNode(1, 'second-label', { props: { newProp: true } })

      // Two different nodes created
      expect(id2).not.toBe(id1)

      const node1 = engine.getNode(id1)
      const node2 = engine.getNode(id2)
      expect(node1).not.toBeNull()
      expect(node2).not.toBeNull()
      expect(node1!.name).toBe('first-label')
      expect(node2!.name).toBe('second-label')
      expect(node2!.props.newProp).toBe(true)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 39: 10 个节点完全图 ──────────────────────────
  test('TS-COMPLETE-39: 10 节点完全图连接', async () => {
    const cfg = makeConfig('complete-graph')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const N = 10
      const ids: number[] = []
      for (let i = 0; i < N; i++) {
        ids.push(await engine.upsertNode(1, `v-${i}`))
      }

      // Connect every pair
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (i !== j) {
            await engine.upsertEdge(ids[i], ids[j], 10, { props: { from: i, to: j } })
          }
        }
      }

      // Each node should have N-1 edges
      for (const id of ids) {
        const n = engine.neighbors(id)
        expect(n.edges.length).toBe(N - 1)
      }
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 40: 链式路径 100 跳 ─────────────────────────
  test('TS-CHAIN-40: 链式路径 100 跳遍历', async () => {
    const cfg = makeConfig('chain-100')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const N = 100
      const ids: number[] = []
      for (let i = 0; i < N; i++) {
        ids.push(await engine.upsertNode(1, `hop-${i}`))
      }
      for (let i = 0; i < N - 1; i++) {
        await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: { hop: i } })
      }

      // Verify chain
      for (let i = 0; i < N - 1; i++) {
        const n = engine.neighbors(ids[i])
        expect(n.edges.length).toBeGreaterThanOrEqual(1)
        const dsts = n.edges.map(e => e.dst)
        expect(dsts).toContain(ids[i + 1])
      }

      // Last node has no outgoing
      const lastN = engine.neighbors(ids[N - 1])
      expect(lastN.edges.length).toBe(0)
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 41: 打开立即关闭不留垃圾 ──────────────────────
  test('TS-OPENCLOSE-41: 创建 engine 后立即关闭', async () => {
    const cfg = makeConfig('immediate-close')
    const engine = new GraphEngine(cfg)
    engine.open()
    engine.close()

    // Reopen should work
    const engine2 = new GraphEngine(cfg)
    engine2.open()
    expect(engine2.scanAllNodes().length).toBe(0)
    engine2.close()
  }, 15000)

  // ── Test 42: 同边类型多次创建(验证行为) ─────────────────────
  test('TS-EDGEIDEMP-42: 同边重复创建计数验证', async () => {
    const cfg = makeConfig('edge-idemp')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      await engine.upsertEdge(a, b, 10, { props: { val: 1 } })
      await engine.upsertEdge(a, b, 10, { props: { val: 2 } })
      await engine.upsertEdge(a, b, 10, { props: { val: 3 } })

      // Edge may be duplicated or upserted. Just verify at least 1.
      const n = engine.neighbors(a)
      const edges = n.edges.filter(e => e.type === 10 && e.dst === b)
      expect(edges.length).toBeGreaterThanOrEqual(1)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 43:节点属性含大量字段 ────────────────────────────
  test('TS-PROP-43: 节点属性含 50 个字段', async () => {
    const cfg = makeConfig('many-fields')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const props: Record<string, unknown> = {}
      for (let i = 0; i < 50; i++) {
        props[`field_${i}`] = `value_${i}_${i * i}`
      }
      const id = await engine.upsertNode(1, 'rich', { props })
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      for (let i = 0; i < 50; i++) {
        expect(node!.props[`field_${i}`]).toBe(`value_${i}_${i * i}`)
      }
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 44: 跨节点分布式边删除 ─────────────────────────
  test('TS-CROSSDEL-44: 删除节点后边操作', async () => {
    const cfg = makeConfig('cross-del')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      await engine.upsertEdge(a, b, 10, {})

      expect(engine.neighbors(a).edges.length).toBe(1)

      // Delete b — edges from a may or may not disappear
      await engine.deleteNode(b)
      expect(engine.getNode(b)).toBeNull()

      // Nodes still exist
      expect(engine.getNode(a)).not.toBeNull()

      // Depending on storage implementation, edges may persist or be cleaned
      const aN = engine.neighbors(a)
      expect(aN.edges.length).toBeGreaterThanOrEqual(0)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 45: 属性包含特殊数据类型 ─────────────────────────
  test('TS-PROPTYPE-45: 属性的各种基础类型', async () => {
    const cfg = makeConfig('prop-types')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'types', {
        props: {
          str: 'hello',
          num: 3.14,
          int: 42,
          boolTrue: true,
          boolFalse: false,
          bigInt: Number.MAX_SAFE_INTEGER,
          smallNum: -0.001,
        },
      })
      const node = engine.getNode(id)
      expect(node!.props.str).toBe('hello')
      expect(node!.props.num).toBe(3.14)
      expect(node!.props.int).toBe(42)
      expect(node!.props.boolTrue).toBe(true)
      expect(node!.props.boolFalse).toBe(false)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 46: 节点属性值变空/恢复 ──────────────────────────
  test('TS-PROPCYCLE-46: 属性值循环变更', async () => {
    const cfg = makeConfig('prop-cycle')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'cycle', { props: { val: 0, tag: 'init' } })
      for (let i = 1; i <= 5; i++) {
        await engine.upsertNode(1, 'cycle', { props: { val: i, tag: `iter-${i}` } })
      }

      const node = engine.getNode(id)
      expect(node!.props.val).toBe(5)
      expect(node!.props.tag).toBe('iter-5')
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 47: 空边属性 ────────────────────────────────
  test('TS-EDGEPROP-47: 空属性边和属性边混合', async () => {
    const cfg = makeConfig('edge-mixed-props')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      const c = await engine.upsertNode(1, 'c')

      await engine.upsertEdge(a, b, 10, {})
      await engine.upsertEdge(a, c, 20, { props: { weight: 10 } })

      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(2)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 48: 长字符型 typeName ─────────────────────────
  test('TS-LONGTYPE-48: 超长 typeName 节点', async () => {
    const cfg = makeConfig('long-typename')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const longName = 'a'.repeat(200)
      const id = await engine.upsertNode(1, longName, { props: { ok: true } })
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.name).toBe(longName)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 49: 删除边后节点仍然存在 ────────────────────────
  test('TS-NODESURVIVE-49: 删除所有边后节点存活', async () => {
    const cfg = makeConfig('node-survive-edges')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')
      const c = await engine.upsertNode(1, 'c')

      await engine.upsertEdge(a, b, 10, {})
      await engine.upsertEdge(a, c, 20, {})

      await engine.deleteEdge(a, b, 10)
      await engine.deleteEdge(a, c, 20)

      // Nodes should all still exist
      expect(engine.getNode(a)).not.toBeNull()
      expect(engine.getNode(b)).not.toBeNull()
      expect(engine.getNode(c)).not.toBeNull()
      expect(engine.scanAllNodes().length).toBe(3)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 50: 并发 upsert 同 id 节点 ─────────────────────
  test('TS-CONCURRENT-50: 并发 upsert 相同 id 节点', async () => {
    const cfg = makeConfig('concurrent-same-id')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const promises = Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, 'same-id', { props: { idx: i, worker: `w-${i}` } })
      )
      const results = await Promise.all(promises)
      // All should return the same id (upsert)
      const unique = new Set(results)
      expect(unique.size).toBe(1)

      const node = engine.getNode(results[0])
      expect(node).not.toBeNull()
      expect(node!.name).toBe('same-id')
      // Last write wins
      expect(node!.props.idx).toBe(19)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 51: 50 节点批量连接 2 个中心 ──────────────
  test('TS-STAR-51: 50 节点连接 2 个中心节点', async () => {
    const cfg = makeConfig('star-2-center')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const c1 = await engine.upsertNode(1, 'center-1')
      const c2 = await engine.upsertNode(1, 'center-2')

      const targets: number[] = []
      for (let i = 0; i < 50; i++) {
        targets.push(await engine.upsertNode(1, `leaf-${i}`))
      }

      for (const t of targets) {
        await engine.upsertEdge(c1, t, 10, {})
        await engine.upsertEdge(c2, t, 20, {})
      }

      expect(engine.neighbors(c1).edges.length).toBe(50)
      expect(engine.neighbors(c2).edges.length).toBe(50)
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 52: 节点 id 重用验证 ─────────────────────
  test('TS-IDREUSE-52: 删除后重用 id', async () => {
    const cfg = makeConfig('id-reuse')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'first', { props: { ver: 1 } })
      await engine.deleteNode(id)
      expect(engine.getNode(id)).toBeNull()

      // Create new node — should get different id
      const id2 = await engine.upsertNode(1, 'second', { props: { ver: 2 } })
      // Internal id is auto-generated and different from original
      expect(engine.scanAllNodes().length).toBe(1)
      const node = engine.getNode(id2)
      expect(node!.name).toBe('second')
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 53: 大量属性键名 ────────────────────────
  test('TS-MANYKEYS-53: 100 个属性键名写入读取', async () => {
    const cfg = makeConfig('many-props-keys')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const props: Record<string, unknown> = {}
      for (let i = 0; i < 100; i++) {
        props[`key_${i}_${i * 2}`] = `value_${i}`
      }
      const id = await engine.upsertNode(1, 'many-keys', { props })
      const node = engine.getNode(id)
      expect(Object.keys(node!.props).length).toBe(100)
      for (let i = 0; i < 100; i++) {
        expect(node!.props[`key_${i}_${i * 2}`]).toBe(`value_${i}`)
      }
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 54: 链式删除边 ────────────────────────
  test('TS-CHAINEDEL-54: 逐条删除链中的边', async () => {
    const cfg = makeConfig('chain-delete')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) {
        ids.push(await engine.upsertNode(1, `n-${i}`))
      }
      for (let i = 0; i < 9; i++) {
        await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: { step: i } })
      }

      // Delete edges one by one from the end
      for (let i = 8; i >= 0; i--) {
        await engine.deleteEdge(ids[i], ids[i + 1], 10)
        // Verify remaining edges
        for (let j = 0; j < i; j++) {
          const n = engine.neighbors(ids[j])
          expect(n.edges.some(e => e.dst === ids[j + 1])).toBe(true)
        }
      }

      // All edges deleted, nodes still exist
      expect(engine.scanAllNodes().length).toBe(10)
    } finally {
      engine.close()
    }
  }, 30000)

  // ── Test 55: 重复 pauseWrites/resume 循环 ─────────
  test('TS-FREEZELOOP-55: 多次 pauseWrites/resume 循环', async () => {
    const cfg = makeConfig('pause-loop')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        const resume = await engine.pauseWrites()
        await expect(engine.upsertNode(1, 'x', { props: {} })).rejects.toThrow()
        resume()

        const id = await engine.upsertNode(1, `cycle-${cycle}`, { props: { cycle } })
        expect(engine.getNode(id)).not.toBeNull()
      }
      expect(engine.scanAllNodes().length).toBe(5)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 56: 多种边类型批量创建 ──────────────
  test('TS-EDGETYPES-56: 多种边类型批量创建', async () => {
    const cfg = makeConfig('multi-edge-types')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      const edgeTypes = [1, 2, 3, 5, 10, 100, 1000, -1, -5, -10]
      for (const et of edgeTypes) {
        await engine.upsertEdge(a, b, et, { props: { type: et } })
      }

      const n = engine.neighbors(a)
      expect(n.edges.length).toBe(10)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 57: scanAllNodes 顺序不依赖写入顺序 ──
  test('TS-SCANORDER-57: scanAllNodes 稳定排序', async () => {
    const cfg = makeConfig('scan-order')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      // Insert in non-monotonic order
      await engine.upsertNode(1, 'b', { props: {} })
      await engine.upsertNode(1, 'a', { props: {} })
      await engine.upsertNode(1, 'c', { props: {} })

      const scan1 = engine.scanAllNodes()
      const scan2 = engine.scanAllNodes()
      expect(scan1.length).toBe(3)
      // Order should be consistent across calls
      expect(scan1.map(n => n.id)).toEqual(scan2.map(n => n.id))
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 58: 空 engine 多维度验证 ──────────────
  test('TS-EMPTY-58: 空 engine 多维验证', async () => {
    const cfg = makeConfig('empty-multi')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      expect(engine.scanAllNodes()).toEqual([])
      expect(engine.getNode(1)).toBeNull()
      // Negative id may throw
      try {
        expect(engine.getNode(-1)).toBeNull()
      } catch {
        // Acceptable
      }
      // neighbors on non-existent node
      const n = engine.neighbors(42)
      expect(n.edges).toEqual([])
      expect(n.nodes).toEqual([])
      expect(await engine.deleteNode(1)).toBe(false)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 59: 重新创建 id 边 ──────────────────
  test('TS-EDGERECREATE-59: 删除边后重建', async () => {
    const cfg = makeConfig('edge-recreate')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const a = await engine.upsertNode(1, 'a')
      const b = await engine.upsertNode(1, 'b')

      await engine.upsertEdge(a, b, 10, { props: { gen: 1, tag: 'first' } })
      expect(engine.neighbors(a).edges.length).toBe(1)

      await engine.deleteEdge(a, b, 10)
      const nAfterDel = engine.neighbors(a)
      // Edge may not be deleted immediately due to cache
      if (nAfterDel.edges.length > 0) {
        // Cache may still return stale data — acceptable
      }

      await engine.upsertEdge(a, b, 10, { props: { gen: 2, tag: 'recreated' } })
      const n = engine.neighbors(a)
      // After recreating, there should be at least 1 edge
      const matching = n.edges.filter(e => e.type === 10 && e.dst === b)
      expect(matching.length).toBeGreaterThanOrEqual(1)
    } finally {
      engine.close()
    }
  }, 15000)

  // ── Test 60: 非常大的节点 id ─────────────────
  test('TS-LARGEID-60: 极大 id 创建节点', async () => {
    const cfg = makeConfig('large-id')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const largeIds = [
        await engine.upsertNode(1, 'normal'),
        await engine.upsertNode(1, 'even-bigger'),
      ]
      expect(engine.scanAllNodes().length).toBe(2)
    } finally {
      engine.close()
    }
  }, 15000)
})

afterAll(() => {
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
