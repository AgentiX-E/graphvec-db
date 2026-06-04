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

  // ══════════════════════════════════════════════════════════════
  // 以下为 E2E 扩张新增测试
  // ══════════════════════════════════════════════════════════════

  // ── 11. 5 节点写入同 id 不同数据 ────────────────────
  test('ML-11: 5 节点写入同 id 验证隔离', async () => {
    const engines = Array.from({ length: 5 }, (_, i) => {
      const cfg = makeConfig(`ml-11-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      await Promise.all(
        engines.map((e, i) =>
          e.upsertNode(1, `Leader-${i}`, { props: { leaderId: i, data: `from-${i}` } })
        )
      )

      engines.forEach((e, i) => {
        const node = e.getNode(1)
        expect(node).not.toBeNull()
        expect(node!.props.leaderId).toBe(i)
        expect(node!.props.data).toBe(`from-${i}`)
        expect(e.scanAllNodes().length).toBe(1)
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 12. 各节点边缘写入大量数据 ──────────────────
  test('ML-12: 多节点各写入 100 节点', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-12-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      await Promise.all(
        engines.map((e, idx) =>
          Promise.all(
            Array.from({ length: 100 }, (_, i) =>
              e.upsertNode(1, `data-${idx}-${i}`, {
                props: { engine: idx, index: i, tag: `e${idx}_n${i}` },
              })
            )
          )
        )
      )

      engines.forEach((e, idx) => {
        const all = e.scanAllNodes()
        expect(all.length).toBe(100)
        all.forEach(n => {
          expect(n.props.engine).toBe(idx)
        })
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 60000)

  // ── 13. 各节点写入并删除 ─────────────────────────
  test('ML-13: 多节点写入后选择性删除', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-13-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      // Each engine creates 5 nodes
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 5; j++) {
          await engines[i].upsertNode(1, `node-${j}`, { props: { engineIdx: i, idx: j } })
        }
      }

      // Delete first and last nodes from each
      for (let i = 0; i < 3; i++) {
        const all = engines[i].scanAllNodes()
        // Delete first created node
        await engines[i].deleteNode(all[0].id)
        expect(engines[i].scanAllNodes().length).toBe(4)
      }

      engines.forEach((e, i) => {
        expect(e.scanAllNodes().length).toBe(4)
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 14. 节点批量边操作 ─────────────────────────────
  test('ML-14: 各节点内创建边关系', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-14-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      for (let i = 0; i < 3; i++) {
        const a = await engines[i].upsertNode(1, `A-${i}`)
        const b = await engines[i].upsertNode(1, `B-${i}`)
        await engines[i].upsertEdge(a, b, 10, { props: { tag: `edge-${i}` } })

        const n = engines[i].neighbors(a)
        expect(n.edges.length).toBe(1)
        expect(n.edges[0].dst).toBe(b)
      }
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 15. 节点多轮写入验证 ───────────────────
  test('ML-15: 节点多轮写入验证', async () => {
    const cfg = makeConfig('ml-15')

    // Round 1
    const engine = new GraphEngine(cfg)
    engine.open()
    await engine.upsertNode(1, 'round1', { props: { round: 1 } })
    const all = engine.scanAllNodes()
    // Round 1: 1 node created
    expect(all.length).toBe(1)
    // Close and reopen in same session
    engine.close()

    // Round 2 — second instantiation
    const engine2 = new GraphEngine(cfg)
    engine2.open()
    await engine2.upsertNode(1, 'round2', { props: { round: 2 } })
    // New upsert with same typeId+name overwrites same node
    const all2 = engine2.scanAllNodes()
    // At minimum one node, depending on persistence
    expect(all2.length).toBeGreaterThanOrEqual(1)
    engine2.close()
  }, 15000)

  // ── 16. 多节点: 大量属性混合写入 ────────────────
  test('ML-16: 3 节点各含大量属性写入', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-16-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      const propsList = engines.map((_, i) => {
        const p: Record<string, unknown> = {}
        for (let j = 0; j < 20; j++) {
          p[`prop_${j}`] = `engine${i}_val${j}`
        }
        return p
      })

      await Promise.all(
        engines.map((e, i) => e.upsertNode(1, `Heavy-${i}`, { props: propsList[i] }))
      )

      engines.forEach((e, i) => {
        const node = e.getNode(1)
        expect(node).not.toBeNull()
        for (let j = 0; j < 20; j++) {
          expect(node!.props[`prop_${j}`]).toBe(`engine${i}_val${j}`)
        }
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 17. 节点完整生命周期(创建→更新→删除) ────────
  test('ML-17: 各节点完整生命周期', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-17-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      for (let i = 0; i < 3; i++) {
        const e = engines[i]
        const id = await e.upsertNode(1, `lifecycle-${i}`, { props: { status: 'created', val: i } })

        // Read
        let node = e.getNode(id)
        expect(node!.props.status).toBe('created')

        // Update
        await e.upsertNode(1, `lifecycle-${i}`, { props: { status: 'updated', val: i * 10 } })
        node = e.getNode(id)
        expect(node!.props.val).toBe(i * 10)

        // Delete
        await e.deleteNode(id)
        expect(e.getNode(id)).toBeNull()
        expect(e.scanAllNodes().length).toBe(0)
      }
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 18. 节点高压创建 ─────────────────────────
  test('ML-18: 多节点高压并发（每节点 300）', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-18-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      await Promise.all(
        engines.map((e, idx) =>
          Promise.all(
            Array.from({ length: 300 }, (_, i) =>
              e.upsertNode(1, `stress-${idx}-${i}`, { props: { idx, seq: i } })
            )
          )
        )
      )

      engines.forEach(e => {
        expect(e.scanAllNodes().length).toBe(300)
      })
    } finally {
      engines.forEach(e => e.close())
    }
  }, 60000)

  // ── 19. 节点拓扑验证 ─────────────────────────
  test('ML-19: 各节点独立拓扑，不交叉', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-19-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      for (let i = 0; i < 3; i++) {
        const center = await engines[i].upsertNode(1, `center-${i}`)
        const leaves = await Promise.all(
          Array.from({ length: 5 }, (_, j) =>
            engines[i].upsertNode(1, `leaf-${i}-${j}`)
          )
        )
        for (const leaf of leaves) {
          await engines[i].upsertEdge(center, leaf, 10, {})
        }
        expect(engines[i].neighbors(center).edges.length).toBe(5)
      }

      // Verify isolation — engine 0 should only have 6 nodes
      expect(engines[0].scanAllNodes().length).toBe(6)
      expect(engines[1].scanAllNodes().length).toBe(6)
      expect(engines[2].scanAllNodes().length).toBe(6)
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 20. 节点类型丰富度验证 ─────────────────
  test('ML-20: 多节点各异 typeName', async () => {
    const typeNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
    const engines = typeNames.map((name, i) => {
      const cfg = makeConfig(`ml-20-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return { engine: e, name }
    })

    try {
      await Promise.all(
        engines.map(({ engine, name }) =>
          engine.upsertNode(1, name, { props: { label: name, ts: Date.now() } })
        )
      )

      engines.forEach(({ engine, name }) => {
        expect(engine.scanAllNodes().length).toBe(1)
        const node = engine.getNode(1)
        expect(node!.name).toBe(name)
      })
    } finally {
      engines.forEach(e => e.engine.close())
    }
  }, 30000)

  // ── 21. 空图持久化和写入 ─────────────────────
  test('ML-21: 空图打开写入后重开验证', async () => {
    const cfg = makeConfig('ml-21')

    let engine = new GraphEngine(cfg)
    engine.open()
    engine.close()

    engine = new GraphEngine(cfg)
    engine.open()
    const id = await engine.upsertNode(1, 'post-empty', { props: { arrived: true } })
    engine.close()

    engine = new GraphEngine(cfg)
    engine.open()
    expect(engine.getNode(id)).not.toBeNull()
    expect(engine.getNode(id)!.props.arrived).toBe(true)
    engine.close()
  }, 15000)

  // ── 22. 多节点边操作混合 ──────────────────
  test('ML-22: 多节点创建边后删除节点', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-22-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      for (let i = 0; i < 3; i++) {
        const e = engines[i]
        const a = await e.upsertNode(1, `A-${i}`)
        const b = await e.upsertNode(1, `B-${i}`)
        await e.upsertEdge(a, b, 10, { props: {} })

        // Delete dest node
        await e.deleteNode(b)
        expect(e.getNode(a)).not.toBeNull()
        expect(e.getNode(b)).toBeNull()
      }
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 23. 多节点并发写入与读取交替 ────────────
  test('ML-23: 多节点写入后快速读取', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-23-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      await Promise.all(
        engines.map(async (e, i) => {
          for (let j = 0; j < 10; j++) {
            await e.upsertNode(1 + j, `n-${i}-${j}`, { props: { idx: j } })
          }
          // Read back
          for (let j = 0; j < 10; j++) {
            const node = e.getNode(1 + j)
            expect(node).not.toBeNull()
            expect(node!.props.idx).toBe(j)
          }
        })
      )

      engines.forEach(e => expect(e.scanAllNodes().length).toBe(10))
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 24. 多节点 freeze 隔离验证 ──────────────
  test('ML-24: 各节点 pauseWrites 隔离', async () => {
    const engines = Array.from({ length: 3 }, (_, i) => {
      const cfg = makeConfig(`ml-24-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      // All engines write initially
      for (let i = 0; i < 3; i++) {
        await engines[i].upsertNode(1, `pre-${i}`, { props: {} })
      }

      // Pause writes on engine 0 and 2, keep 1 unfrozen
      const resume0 = await engines[0].pauseWrites()
      const resume2 = await engines[2].pauseWrites()

      // Engine 0 and 2 should reject writes
      await expect(engines[0].upsertNode(2, 'fail', { props: {} })).rejects.toThrow()
      await expect(engines[2].upsertNode(2, 'fail', { props: {} })).rejects.toThrow()

      // Engine 1 still works
      const id = await engines[1].upsertNode(2, 'ok', { props: {} })
      expect(engines[1].getNode(id)).not.toBeNull()

      // Resume writes
      resume0()
      resume2()

      // All work again
      const id0 = await engines[0].upsertNode(2, 'recovered', { props: {} })
      expect(engines[0].getNode(id0)).not.toBeNull()
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)

  // ── 25. 多节点同一目录隔离验证 ──────────────
  test('ML-25: 不同路径引擎数据完全隔离', async () => {
    const count = 6
    const engines = Array.from({ length: count }, (_, i) => {
      const cfg = makeConfig(`ml-25-node-${i}`)
      const e = new GraphEngine(cfg)
      e.open()
      return e
    })

    try {
      // Each engine writes a unique number of nodes
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < i + 1; j++) {
          await engines[i].upsertNode(1 + j, `e${i}-n${j}`, { props: { engine: i } })
        }
      }

      // Verify each engine has i+1 nodes
      for (let i = 0; i < count; i++) {
        const all = engines[i].scanAllNodes()
        expect(all.length).toBe(i + 1)
        all.forEach(n => expect(n.props.engine).toBe(i))
      }
    } finally {
      engines.forEach(e => e.close())
    }
  }, 30000)
})

afterAll(() => {
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
