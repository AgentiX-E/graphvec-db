/**
 * multi-leader-e2e.spec.ts — Multi-Leader 完整端到端集成测试
 *
 * 使用真实 GraphEngine 实例（非 mock），模拟多 leader 场景。
 * 每个 test 有独立的临时目录。
 * 覆盖：创建多个独立节点、写入、一致性验证
 */
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/e2e-multi-leader')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, name)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

describe('Multi-Leader E2E — 多 Leader 集成测试', () => {
  // ── 1. 创建两个 leader 节点写入数据 ──────────────────────
  test('ML-01: 创建 2 个独立节点并分别写入', async () => {
    const cfg1 = makeConfig('ml-01-node1')
    const cfg2 = makeConfig('ml-01-node2')
    const node1 = new GraphEngine(cfg1)
    const node2 = new GraphEngine(cfg2)
    node1.open()
    node2.open()

    try {
      // Write to node1
      const id1 = await node1.upsertNode(1, 'leader1-node', {
        props: { source: 'leader1', data: 'hello' },
      })
      expect(id1).toBeGreaterThan(0)
      expect(node1.getNode(id1)!.props.source).toBe('leader1')

      // Write to node2
      const id2 = await node2.upsertNode(1, 'leader2-node', {
        props: { source: 'leader2', data: 'world' },
      })
      expect(id2).toBeGreaterThan(0)
      expect(node2.getNode(id2)!.props.source).toBe('leader2')

      node1.close()
      node2.close()
    } finally {
      node1.close()
      node2.close()
    }
  }, 15000)

  // ── 2. 验证数据一致性 ───────────────────────────
  test('ML-02: 验证写入和读取数据一致性', async () => {
    const cfg = makeConfig('ml-02')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      // Write complex data
      const id = await engine.upsertNode(1, 'complex-node', {
        props: {
          name: 'Test',
          count: 42,
          active: true,
          tags: ['a', 'b', 'c'],
          metadata: { version: 1, owner: 'e2e' },
        },
      })

      // Read back and verify
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.props.name).toBe('Test')
      expect(node!.props.count).toBe(42)
      expect(node!.props.active).toBe(true)

      engine.close()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── 3. 3 节点独立写入 ──────────────────────
  test('ML-03: 3 节点各自独立写入', async () => {
    const cfgs = [0, 1, 2].map(i => makeConfig(`ml-03-node-${i}`))
    const engines = cfgs.map(c => {
      const e = new GraphEngine(c)
      e.open()
      return e
    })

    try {
      // Each node writes its own data
      const values = ['A', 'B', 'C']
      engines.forEach((e, i) => {
        e.upsertNode(1, `data-${values[i]}`, { props: { val: values[i] } })
      })

      // Each node only sees its own data
      engines.forEach(e => expect(e.scanAllNodes().length).toBe(1))
    } finally {
      engines.forEach(e => e.close())
    }
  }, 15000)

  // ── 4. 多节点大批量写入 ─────────────────────────────
  test('ML-04: 多节点同时大批量写入（每节点 200 节点）', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-04-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      await Promise.all(
        engines.map((engine, idx) =>
          Promise.all(
            Array.from({ length: 200 }, (_, i) =>
              engine.upsertNode(1, `engine-${idx}-node-${i}`, {
                props: { engineIdx: idx, nodeIdx: i },
              })
            )
          )
        )
      )

      // Each engine has exactly 200 nodes
      engines.forEach(engine => {
        expect(engine.scanAllNodes().length).toBe(200)
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 60000)

  // ── 5. 节点持久化恢复 ────────────────────────────────
  test('ML-05: 节点关闭后重新打开，数据持久化', async () => {
    const cfg = makeConfig('ml-05')

    // First session
    let engine = new GraphEngine(cfg)
    engine.open()
    const id = await engine.upsertNode(1, 'persistent', {
      props: { shouldSurvive: true },
    })
    engine.close()

    // Second session — reopen same dir
    engine = new GraphEngine(cfg)
    engine.open()
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.shouldSurvive).toBe(true)
    engine.close()
  }, 15000)

  // ── 6. 多节点独立写入后验证 ────────────────────────────
  test('ML-06: 4 节点独立写后验证每个节点完整性', async () => {
    const engines = Array.from({ length: 4 }, (_, i) => {
      const cfg = makeConfig(`ml-06-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      // Each node writes a unique pattern
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 10; j++) {
          await engines[i].upsertNode(1, `n${i}-${j}`, {
            props: { node: i, index: j },
          })
        }
      }

      // Verify each has exactly 10 nodes
      engines.forEach((e, i) => {
        expect(e.scanAllNodes().length).toBe(10)
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 7. 属性更新序列 ────────────────────────────
  test('ML-07: 节点上创建和更新属性序列', async () => {
    const cfg = makeConfig('ml-07')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const id = await engine.upsertNode(1, 'evolving', {
        props: { step: 1, status: 'init' },
      })

      // Update sequence
      await engine.upsertNode(1, 'evolving', {
        props: { step: 2, status: 'processing' },
      })
      await engine.upsertNode(1, 'evolving', {
        props: { step: 3, status: 'completed' },
      })

      const node = engine.getNode(id)
      expect(node!.props.step).toBe(3)
      expect(node!.props.status).toBe('completed')

      engine.close()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── 8. 大量属性 ──────────────────────────
  test('ML-08: 节点大量属性（30 个属性）', async () => {
    const cfg = makeConfig('ml-08')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      const props: Record<string, unknown> = {}
      for (let i = 0; i < 30; i++) {
        props[`prop_${i}`] = `value_${i}`
      }

      const id = await engine.upsertNode(1, 'many-props', { props })
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      for (let i = 0; i < 30; i++) {
        expect(node!.props[`prop_${i}`]).toBe(`value_${i}`)
      }

      engine.close()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── 9. 节点存活检查 ────────────────────────────────
  test('ML-09: 独立节点存活及基本操作', async () => {
    const cfg = makeConfig('ml-09')
    const engine = new GraphEngine(cfg)
    engine.open()

    try {
      // Engine should be operational
      expect(engine.scanAllNodes).toBeDefined()
      expect(engine.upsertNode).toBeDefined()
      expect(engine.getNode).toBeDefined()
      expect(engine.deleteNode).toBeDefined()

      // Basic ops work
      const id = await engine.upsertNode(1, 'healthy', { props: { alive: true } })
      expect(engine.getNode(id)).toBeDefined()

      engine.close()
    } finally {
      engine.close()
    }
  }, 15000)

  // ── 10. 空图持久化 ────────────────────────────
  test('ML-10: 创建空图后重新打开不报错', async () => {
    const cfg = makeConfig('ml-10')

    let engine = new GraphEngine(cfg)
    engine.open()
    engine.close()

    // Reopen — should work
    engine = new GraphEngine(cfg)
    engine.open()
    expect(engine.scanAllNodes().length).toBe(0)
    engine.close()
  }, 15000)
})

afterAll(() => {
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
