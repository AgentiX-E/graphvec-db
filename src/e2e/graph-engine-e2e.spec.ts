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
})

afterAll(() => {
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
