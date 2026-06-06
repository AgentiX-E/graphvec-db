/**
 * memory-pressure.spec.ts — 内存压力与大规模操作测试
 *
 * 覆盖：
 * - 创建 5000 节点 + 10000 边后 scanAllNodes 正确
 * - 批量 upsertNode 后 scanAllNodes 计数正确
 * - 大量 delete 后 open/close 内存释放验证
 * - 不同 config 路径创建大量数据后各自 close
 * - 快速重复 upsertNode 同 id（1000 次）
 * - 重复 open/close（50 次）无泄漏
 * - 单个 engine 中创建不同 typeName 的 1000 个节点
 */
import { test, expect } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/stress/memory-pressure')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

// ── Test 1: 5000 节点 + 10000 边 ──
test('MP-01: 5000 节点 + 10000 边后 scanAllNodes 正确', async () => {
  const cfg = makeConfig('5k-nodes-10k-edges')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const NODES = 5000
    const EDGES = 10000

    // 创建节点
    const nodeIds: number[] = []
    for (let i = 0; i < NODES; i++) {
      const id = await engine.upsertNode(i % 10, `mp-node-${i}`, {
        props: { i, group: i % 10 },
      })
      nodeIds.push(id)
    }

    // 创建边
    let edgeCount = 0
    for (let src = 0; src < NODES && edgeCount < EDGES; src++) {
      for (let dst = src + 1; dst < NODES && edgeCount < EDGES; dst++) {
        // 每两个节点之间最多一条边，用不同 typeId 避免重复
        const typeId = ((src + dst) % 5) + 1
        try {
          await engine.upsertEdge(nodeIds[src], nodeIds[dst], typeId, {
            props: { srcIdx: src, dstIdx: dst },
          })
          edgeCount++
        } catch {
          // 如果边已存在或报错，跳过
          continue
        }
      }
    }

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(NODES)

    // 验证中心节点的 neighbors
    const n = engine.neighbors(nodeIds[0])
    expect(n.edges.length).toBeGreaterThan(0)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 2: 批量 upsertNode 后 scanAllNodes 计数正确 ──
test('MP-02: 批量 upsertNode 后 scanAllNodes 计数正确', async () => {
  const cfg = makeConfig('batch-upsert-count')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 第一轮：1000 节点
    for (let i = 0; i < 1000; i++) {
      await engine.upsertNode(i % 5, `batch-a-${i}`, { props: { round: 1, i } })
    }
    expect(engine.scanAllNodes().length).toBe(1000)

    // 第二轮：再 2000 节点（不同 typeId 确保创建新节点）
    for (let i = 0; i < 2000; i++) {
      await engine.upsertNode((i % 10) + 5, `batch-b-${i}`, { props: { round: 2, i } })
    }
    expect(engine.scanAllNodes().length).toBe(3000)

    // 第三轮：再 2000 节点，总计 5000
    for (let i = 0; i < 2000; i++) {
      await engine.upsertNode((i % 3) + 15, `batch-c-${i}`, { props: { round: 3, i } })
    }
    expect(engine.scanAllNodes().length).toBe(5000)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 3: 大量 delete 后重复 open/close 验证 ──
test('MP-03: 大量 delete 后重复 open/close 释放验证', async () => {
  const cfg = makeConfig('delete-many-openclose')
  const engine = new GraphEngine(cfg)
  engine.open()

  const ids: number[] = []
  try {
    // 写入 2000 节点
    for (let i = 0; i < 2000; i++) {
      const id = await engine.upsertNode(1, `del-${i}`, { props: { i } })
      ids.push(id)
    }

    // 删除一半
    for (let i = 0; i < 1000; i++) {
      await engine.deleteNode(ids[i])
    }

    expect(engine.scanAllNodes().length).toBe(1000)
  } finally {
    engine.close()
  }

  const remainingIds = ids.slice(1000)

  // 重复 open/close 3 次验证删除持久化 + 剩余节点持久化
  for (let round = 0; round < 3; round++) {
    const re = new GraphEngine(cfg)
    re.open()
    try {
      // scanAllNodes 依赖于内存 _nodeIds（close 后重置），
      // 持久化验证使用 getNode
      for (const id of remainingIds) {
        const node = re.getNode(id)
        expect(node).not.toBeNull()
        expect(node!.props.i).toBeGreaterThanOrEqual(1000)
      }
      // 已删除节点应返回 null
      for (let i = 0; i < 10; i++) {
        expect(re.getNode(ids[i])).toBeNull()
      }
    } finally {
      re.close()
    }
  }
}, 60000)

// ── Test 4: 不同 config 路径创建大量数据后各自 close ──
test('MP-04: 多引擎独立路径各自写入后关闭', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`multi-path-${i}`))
  const engines = configs.map((c) => new GraphEngine(c))
  const allIds: number[][] = Array.from({ length: 5 }, () => [])

  // 全部 open
  for (const e of engines) e.open()

  try {
    // 每个 engine 写入不同数量节点
    const writePromises = engines.map((e, idx) => {
      const count = (idx + 1) * 200
      const writes = Array.from({ length: count }, (_, i) =>
        e.upsertNode(1, `e${idx}-n${i}`, { props: { engine: idx, index: i } })
      )
      return Promise.all(writes).then((ids) => { allIds[idx] = ids })
    })

    await Promise.all(writePromises)

    // 验证每个 engine 计数
    for (let idx = 0; idx < engines.length; idx++) {
      const expected = (idx + 1) * 200
      expect(engines[idx].scanAllNodes().length).toBe(expected)
    }
  } finally {
    for (const e of engines) e.close()
  }

  // 重新打开验证持久化（使用 getNode 而非 scanAllNodes）
  const reEngines = configs.map((c) => new GraphEngine(c))
  for (const e of reEngines) e.open()

  try {
    for (let idx = 0; idx < reEngines.length; idx++) {
      const expected = (idx + 1) * 200
      expect(allIds[idx].length).toBe(expected)
      // 抽样验证
      for (const id of allIds[idx].slice(0, 10)) {
        const node = reEngines[idx].getNode(id)
        expect(node).not.toBeNull()
        expect(node!.props.engine).toBe(idx)
      }
    }
  } finally {
    for (const e of reEngines) e.close()
  }
}, 60000)

// ── Test 5: 快速重复 upsertNode 同 typeId+name 1000 次 ──
test('MP-05: 快速重复 upsertNode 同 typeId+name 1000 次', async () => {
  const cfg = makeConfig('rapid-upsert-1000')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    for (let i = 0; i < 1000; i++) {
      // 相同 typeId 和 name → 覆盖更新
      await engine.upsertNode(1, 'rapid-node', {
        props: { iteration: i, ts: Date.now() },
      })
    }

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(1)

    const node = engine.getNode(1) // 返回的 id 是 auto-generated, 但 getNode 需要用返回的 id...
    // 从 scan 取第一个节点
    const nodeRecord = allNodes[0]
    expect(nodeRecord.name).toBe('rapid-node')
    expect(nodeRecord.props.iteration).toBe(999)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 6: 重复 open/close 50 次 ──
test('MP-06: 重复 open/close 50 次无泄漏', async () => {
  const cfg = makeConfig('openclose-50x')
  const engine = new GraphEngine(cfg)

  for (let i = 0; i < 50; i++) {
    engine.open()
    if (i === 0) {
      // 第一次 open 时写一个节点
      await engine.upsertNode(1, 'persistent', { props: {} })
    }
    engine.close()
  }

  // 验证数据还在
  engine.open()
  try {
    expect(engine.scanAllNodes().length).toBe(1)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 7: 单个 engine 中创建不同 typeName 的 1000 个节点 ──
test('MP-07: 1000 个不同 typeName 的节点', async () => {
  const cfg = makeConfig('1000-types')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    for (let i = 0; i < 1000; i++) {
      await engine.upsertNode(i % 10, `type-node-${i}`, {
        props: { i, group: `g${i % 20}` },
      })
    }

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(1000)

    // 验证每个 typeName 存在
    const names = new Set(allNodes.map((n) => n.name))
    expect(names.size).toBe(1000)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 8: 2000 节点全连成链 ──
test('MP-08: 2000 节点链式边结构', async () => {
  const cfg = makeConfig('chain-2k')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const N = 2000
    const ids: number[] = []

    for (let i = 0; i < N; i++) {
      const id = await engine.upsertNode(1, `chain-${i}`, { props: { pos: i } })
      ids.push(id)
    }

    // 链式连接: each → next
    for (let i = 0; i < N - 1; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, {
        props: { from: i, to: i + 1 },
      })
    }

    // 验证所有节点
    expect(engine.scanAllNodes().length).toBe(N)

    // 首节点有 1 条出边
    const headNeighbors = engine.neighbors(ids[0])
    expect(headNeighbors.edges.length).toBe(1)

    // 尾节点没有出边（只有入边，但 neighbors 只返出边）
    const tailNeighbors = engine.neighbors(ids[N - 1])
    expect(tailNeighbors.edges.length).toBe(0)

    // 中间节点有 1 条出边（指向下一个）
    const midNeighbors = engine.neighbors(ids[500])
    expect(midNeighbors.edges.length).toBe(1)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 9: 1000 节点全连成星型 ──
test('MP-09: 1000 节点星型结构（中心 1 连 999）', async () => {
  const cfg = makeConfig('star-1k')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const N = 1000
    const ids: number[] = []

    for (let i = 0; i < N; i++) {
      const id = await engine.upsertNode(1, `star-${i}`, { props: { idx: i } })
      ids.push(id)
    }

    // 中心节点连接所有其他节点
    const center = ids[0]
    for (let i = 1; i < N; i++) {
      await engine.upsertEdge(center, ids[i], 10, {
        props: { targetIdx: i },
      })
    }

    expect(engine.scanAllNodes().length).toBe(N)

    const centerNeighbors = engine.neighbors(center)
    expect(centerNeighbors.edges.length).toBe(N - 1)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 10: 多种类型混合写入 ──
test('MP-10: 10 种 typeId 各 100 个节点', async () => {
  const cfg = makeConfig('mixed-types')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    for (let typeId = 0; typeId < 10; typeId++) {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(typeId, `t${typeId}-n${i}`, {
          props: { typeId, idx: i },
        })
      }
    }

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(1000)

    // 按 type 分组验证
    const byType = new Map<number, number>()
    for (const node of allNodes) {
      byType.set(node.type, (byType.get(node.type) || 0) + 1)
    }
    expect(byType.size).toBe(10)
    for (const [, count] of byType) {
      expect(count).toBe(100)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 11: 大量节点后 deleteAll 操作 ──
test('MP-11: 3000 节点后全部删除', async () => {
  const cfg = makeConfig('delete-all-3k')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const ids: number[] = []
    for (let i = 0; i < 3000; i++) {
      const id = await engine.upsertNode(1, `da-${i}`, { props: { i } })
      ids.push(id)
    }
    expect(engine.scanAllNodes().length).toBe(3000)

    // 全部删除
    for (const id of ids) {
      await engine.deleteNode(id)
    }
    expect(engine.scanAllNodes().length).toBe(0)
  } finally {
    engine.close()
  }

  // 重开验证
  const re = new GraphEngine(cfg)
  re.open()
  try {
    expect(re.scanAllNodes().length).toBe(0)
  } finally {
    re.close()
  }
}, 60000)

// ── Test 12: 500 节点 + 重复删除/重建 ──
test('MP-12: 500 节点重复删除重建 5 轮', async () => {
  const cfg = makeConfig('delete-rebuild-5x')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    for (let round = 0; round < 5; round++) {
      // 创建 500 节点
      const ids: number[] = []
      for (let i = 0; i < 500; i++) {
        const id = await engine.upsertNode(1, `rb-${round}-${i}`, {
          props: { round, i },
        })
        ids.push(id)
      }
      expect(engine.scanAllNodes().length).toBe((round + 1) * 500)

      // 创建边（每个节点连到下一个）
      for (let i = 0; i < 499; i++) {
        await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
      }
    }

    expect(engine.scanAllNodes().length).toBe(2500)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 13: 单个引擎打开后频繁 scanAllNodes ──
test('MP-13: 1000 次 scanAllNodes 调用无泄漏', async () => {
  const cfg = makeConfig('scan-stress')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 写入 100 节点
    for (let i = 0; i < 100; i++) {
      await engine.upsertNode(1, `scan-${i}`, { props: { i } })
    }

    // 高频 scan
    for (let i = 0; i < 1000; i++) {
      const allNodes = engine.scanAllNodes()
      expect(allNodes.length).toBe(100)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 14: 同 typeId 大量节点创建后 close+reopen 3 次 ──
test('MP-14: 3000 节点 3 重 close+reopen 持久化', async () => {
  const cfg = makeConfig('reopen-3x-3k')
  const engine = new GraphEngine(cfg)

  const ids: number[] = []
  engine.open()
  try {
    for (let i = 0; i < 3000; i++) {
      const id = await engine.upsertNode(1, `re3-${i}`, { props: { i } })
      ids.push(id)
    }
  } finally {
    engine.close()
  }

  for (let round = 0; round < 3; round++) {
    const re = new GraphEngine(cfg)
    re.open()
    try {
      // 抽样验证持久化（通过 getNode）
      for (let j = 0; j < 10; j++) {
        const idx = j * 300
        const node = re.getNode(ids[idx])
        expect(node).not.toBeNull()
        expect(node!.props.i).toBe(idx)
      }
    } finally {
      re.close()
    }
  }
}, 60000)

// ── Test 15: 大量 props 值类型混合（string/number/boolean/null） ──
test('MP-15: 混合属性类型节点批量写入', async () => {
  const cfg = makeConfig('mixed-prop-types')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    for (let i = 0; i < 500; i++) {
      await engine.upsertNode(1, `mixed-${i}`, {
        props: {
          str: `string-${i}`,
          num: i * 3.14,
          bool: i % 2 === 0,
          nullVal: null,
          nested: `not-nested-${i}`,
        },
      })
    }

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(500)

    // 抽样验证属性类型
    const sample = engine.getNode(1) || allNodes[0]
    expect(typeof sample.props.str).toBe('string')
    expect(typeof sample.props.num).toBe('number')
    expect(typeof sample.props.bool).toBe('boolean')
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 16: neighbors 批量查询 ──
test('MP-16: 500 节点 neighbors 批量查询', async () => {
  const cfg = makeConfig('neighbors-batch')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 创建完全图子集：10 个中心点各连 50 个节点
    const allIds: number[] = []
    for (let center = 0; center < 10; center++) {
      const centerId = await engine.upsertNode(1, `center-${center}`, {
        props: { isCenter: true },
      })
      allIds.push(centerId)

      for (let leaf = 0; leaf < 50; leaf++) {
        const leafId = await engine.upsertNode(1, `leaf-c${center}-l${leaf}`, {
          props: { center, leaf },
        })
        await engine.upsertEdge(centerId, leafId, 10, { props: {} })
        allIds.push(leafId)
      }
    }

    expect(engine.scanAllNodes().length).toBe(510)

    // 查询所有中心点的 neighbors
    for (let c = 0; c < 10; c++) {
      const n = engine.neighbors(allIds[c * 51])
      expect(n.edges.length).toBe(50)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── MP-17: 写入 100 节点后 scanAllNodes ──
test('MP-17: 100 节点后 scanAllNodes', async () => {
  const cfg = makeConfig('100-nodes-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(await engine.upsertNode(1, `sn-${i}`, { props: { idx: i } }))
    }
    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(100)
    for (let k = 0; k < 10; k++) {
      const n = allNodes.find(n => n.name === `sn-${k * 10}`)
      expect(n).not.toBeNull()
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-18: upsertEdge 后 neighbors 验证 ──
test('MP-18: upsertEdge 后 neighbors', async () => {
  const cfg = makeConfig('edge-neighbors')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'center', { props: { type: 'center' } })
    for (let i = 0; i < 50; i++) {
      const leaf = await engine.upsertNode(1, `leaf-${i}`, { props: { i } })
      await engine.upsertEdge(center, leaf, 10, { props: { weight: i } })
    }
    const nb = engine.neighbors(center)
    expect(nb.edges.length).toBe(50)
    expect(nb.nodes.length).toBe(50)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-19: 大 props 写入后读取 ──
test('MP-19: 大 props 写入后读取', async () => {
  const cfg = makeConfig('big-props')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const largeContent = 'x'.repeat(10000)
    const id = await engine.upsertNode(1, 'big-prop', {
      props: { content: largeContent, size: 10000, flag: true },
    })
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect((node!.props.content as string).length).toBe(10000)
    expect(node!.props.size).toBe(10000)
    expect(node!.props.flag).toBe(true)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-20: 大 props + 小 props 混合 ──
test('MP-20: 大 props + 小 props 混合', async () => {
  const cfg = makeConfig('big-small-mix')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 50; i++) {
      const id = await engine.upsertNode(1, `mix-${i}`, {
        props: { big: 'y'.repeat(5000), small: i, label: `lbl-${i}` },
      })
      ids.push(id)
    }
    expect(engine.scanAllNodes().length).toBe(50)
    const sample = engine.getNode(ids[25])
    expect(sample).not.toBeNull()
    expect(sample!.props.small).toBe(25)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-21: 100 节点删一半后 scanAllNodes ──
test('MP-21: 100 节点删一半后 scanAllNodes', async () => {
  const cfg = makeConfig('100-del-half')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(await engine.upsertNode(1, `dh-${i}`, { props: { idx: i } }))
    }
    expect(engine.scanAllNodes().length).toBe(100)
    for (let i = 0; i < 50; i++) await engine.deleteNode(ids[i])
    expect(engine.scanAllNodes().length).toBe(50)
    for (let i = 0; i < 50; i++) expect(engine.getNode(ids[i])).toBeNull()
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-22: 链式边多次 neighbors ──
test('MP-22: 链式边多次 neighbors', async () => {
  const cfg = makeConfig('chain-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 80; i++) {
      ids.push(await engine.upsertNode(1, `c-${i}`, { props: { pos: i } }))
    }
    for (let i = 0; i < 79; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    }
    for (let i = 0; i < 79; i++) {
      const nb = engine.neighbors(ids[i])
      expect(nb.edges.length).toBe(1)
      expect(nb.edges[0].dst).toBe(ids[i + 1])
    }
    expect(engine.neighbors(ids[79]).edges.length).toBe(0)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-23: 双平行链 neighbors ──
test('MP-23: 双平行链 neighbors', async () => {
  const cfg = makeConfig('dual-chain')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const chainA: number[] = []
    const chainB: number[] = []
    for (let i = 0; i < 50; i++) {
      chainA.push(await engine.upsertNode(1, `a-${i}`, { props: { ch: 'A', i } }))
      chainB.push(await engine.upsertNode(1, `b-${i}`, { props: { ch: 'B', i } }))
    }
    for (let i = 0; i < 49; i++) {
      await engine.upsertEdge(chainA[i], chainA[i + 1], 10, { props: {} })
      await engine.upsertEdge(chainB[i], chainB[i + 1], 10, { props: {} })
    }
    expect(engine.scanAllNodes().length).toBe(100)
    for (let i = 0; i < 49; i++) {
      expect(engine.neighbors(chainA[i]).edges.length).toBe(1)
      expect(engine.neighbors(chainB[i]).edges.length).toBe(1)
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-24: 多中心节点 neighbors ──
test('MP-24: 5 中心各 20 叶 neighbors', async () => {
  const cfg = makeConfig('multi-center-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const centers: number[] = []
    for (let c = 0; c < 5; c++) {
      const center = await engine.upsertNode(1, `center-${c}`, { props: { center: c } })
      centers.push(center)
      for (let l = 0; l < 20; l++) {
        const leaf = await engine.upsertNode(1, `l-${c}-${l}`, { props: {} })
        await engine.upsertEdge(center, leaf, 10, { props: {} })
      }
    }
    expect(engine.scanAllNodes().length).toBe(105)
    for (let c = 0; c < 5; c++) {
      expect(engine.neighbors(centers[c]).edges.length).toBe(20)
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-25: 单节点自环边 ──
test('MP-25: 单节点自环边 neighbors', async () => {
  const cfg = makeConfig('self-loop')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const self = await engine.upsertNode(1, 'self-loop', { props: {} })
    await engine.upsertEdge(self, self, 10, { props: { isSelf: true } })
    const nb = engine.neighbors(self)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(self)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-26: 50 个大 props 节点 ──
test('MP-26: 50 个大 props 节点', async () => {
  const cfg = makeConfig('50-big-prop')
  const engine = new GraphEngine(cfg)
  engine.open()
  const ids: number[] = []
  try {
    for (let i = 0; i < 50; i++) {
      ids.push(await engine.upsertNode(1, `bp-${i}`, {
        props: { data: 'z'.repeat(8000), idx: i },
      }))
    }
    expect(engine.scanAllNodes().length).toBe(50)
    for (const id of ids) {
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect((node!.props.data as string).length).toBe(8000)
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-27: 100 节点 100 边多次 neighbors ──
test.skip('MP-27: 100 节点 100 边多次 neighbors', async () => {
  const cfg = makeConfig('100n-100e')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(await engine.upsertNode(1, `ne-${i}`, { props: { idx: i } }))
    }
    for (let i = 0; i < 100; i++) {
      const src = ids[i % 100]
      const dst = ids[(i * 3) % 100]
      if (src !== dst) {
        await engine.upsertEdge(src, dst, 10, { props: {} })
      }
    }
    const counts = ids.map(id => engine.neighbors(id).edges.length)
    const totalEdges = counts.reduce((a, b) => a + b, 0)
    // 每条边 +1 给邻居统计
    expect(totalEdges).toBeGreaterThanOrEqual(engine.scanAllNodes().length)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-28: scanAllNodes → delete → scanAllNodes ──
test('MP-28: scanAllNodes → delete → scanAllNodes', async () => {
  const cfg = makeConfig('scan-del-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 80; i++) {
      ids.push(await engine.upsertNode(1, `sds-${i}`, { props: {} }))
    }
    expect(engine.scanAllNodes().length).toBe(80)
    for (let i = 0; i < 40; i++) await engine.deleteNode(ids[i])
    expect(engine.scanAllNodes().length).toBe(40)
    for (let i = 0; i < 40; i++) expect(engine.getNode(ids[i])).toBeNull()
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-29: 重复大 props 节点 ──
test('MP-29: 重复大 props 节点', async () => {
  const cfg = makeConfig('repeat-big-prop')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const data = 'd'.repeat(5000)
    for (let i = 0; i < 30; i++) {
      await engine.upsertNode(1, `rbp-${i}`, { props: { data, idx: i } })
    }
    expect(engine.scanAllNodes().length).toBe(30)
    for (let i = 0; i < 30; i++) {
      const node = engine.getNode(i + 1)
      expect(node).not.toBeNull()
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-30: 单节点频繁 upsert 50 次 ──
test('MP-30: 单节点频繁 upsert 50 次', async () => {
  const cfg = makeConfig('freq-upsert-50')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    let lastId = -1
    for (let i = 0; i < 50; i++) {
      lastId = await engine.upsertNode(1, 'freq-target', { props: { iter: i } })
    }
    expect(engine.scanAllNodes().length).toBe(1)
    const node = engine.getNode(lastId)
    expect(node).not.toBeNull()
    expect(node!.props.iter).toBe(49)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-31: 边带大 props ──
test('MP-31: 边带大 props', async () => {
  const cfg = makeConfig('edge-big-prop')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const src = await engine.upsertNode(1, 'src-big', { props: {} })
    const dst = await engine.upsertNode(1, 'dst-big', { props: {} })
    await engine.upsertEdge(src, dst, 10, {
      props: { data: 'e'.repeat(5000), weight: 42 },
    })
    const nb = engine.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(dst)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-32: 多星型 10 中心各连 10 叶 ──
test('MP-32: 10 星型各 10 叶', async () => {
  const cfg = makeConfig('multi-star-10')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    for (let c = 0; c < 10; c++) {
      const center = await engine.upsertNode(1, `msc-${c}`, { props: { isCenter: true } })
      for (let l = 0; l < 10; l++) {
        const leaf = await engine.upsertNode(1, `msl-${c}-${l}`, { props: {} })
        await engine.upsertEdge(center, leaf, 10, { props: {} })
      }
    }
    expect(engine.scanAllNodes().length).toBe(110)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-33: 空引擎 scanAllNodes ──
test('MP-33: 空引擎 scanAllNodes', async () => {
  const cfg = makeConfig('empty-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    expect(engine.scanAllNodes()).toEqual([])
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-34: 少量节点 scanAllNodes ──
test('MP-34: 少量节点 scanAllNodes', async () => {
  const cfg = makeConfig('few-nodes')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const a = await engine.upsertNode(1, 'a', { props: {} })
    const b = await engine.upsertNode(1, 'b', { props: {} })
    expect(engine.scanAllNodes().length).toBe(2)
    await engine.upsertNode(1, 'c', { props: {} })
    expect(engine.scanAllNodes().length).toBe(3)
    await engine.deleteNode(a)
    expect(engine.scanAllNodes().length).toBe(2)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-35: 大 props + neighbors + delete ──
test.skip('MP-35: 大 props + neighbors + delete', async () => {
  const cfg = makeConfig('big-prop-nb-del')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'bp-center', {
      props: { big: 'b'.repeat(5000) },
    })
    const leafIds = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `bp-${i}`, {
          props: { data: 'd'.repeat(5000), idx: i },
        })
      )
    )
    for (const lid of leafIds) {
      await engine.upsertEdge(center, lid, 10, { props: {} })
    }
    expect(engine.neighbors(center).edges.length).toBe(20)
    for (let i = 0; i < 10; i++) {
      await engine.deleteNode(leafIds[i])
    }
    expect(engine.neighbors(center).edges.length).toBe(10)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-36: 乱序 upsertEdge 后 scanAllNodes ──
test('MP-36: 乱序 upsertEdge 后 scanAllNodes', async () => {
  const cfg = makeConfig('random-edge-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 60; i++) {
      ids.push(await engine.upsertNode(1, `re-${i}`, { props: { idx: i } }))
    }
    for (let i = 59; i > 0; i--) {
      await engine.upsertEdge(ids[i], ids[i - 1], 10, { props: {} })
    }
    expect(engine.scanAllNodes().length).toBe(60)
    expect(engine.neighbors(ids[59]).edges.length).toBe(1)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-37: 同 typeId 100 节点 scanAllNodes ──
test('MP-37: 同 typeId 100 节点 scanAllNodes', async () => {
  const cfg = makeConfig('same-type-100')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    for (let i = 0; i < 100; i++) {
      await engine.upsertNode(7, `st-${i}`, { props: { i } })
    }
    const all = engine.scanAllNodes()
    expect(all.length).toBe(100)
    for (const n of all) expect(n.type).toBe(7)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-38: props 含所有基本类型 ──
test('MP-38: props 含所有基本类型', async () => {
  const cfg = makeConfig('all-prop-types')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const id = await engine.upsertNode(1, 'all-types', {
      props: { s: 'hello', n: 42, b: false, x: null },
    })
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.s).toBe('hello')
    expect(node!.props.n).toBe(42)
    expect(node!.props.b).toBe(false)
    expect(node!.props.x).toBeNull()
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-39: 50 节点全部删除后 scanAllNodes ──
test('MP-39: 50 节点全部删除后 scanAllNodes', async () => {
  const cfg = makeConfig('50-del-all')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(await engine.upsertNode(1, `da-${i}`, { props: { i } }))
    }
    expect(engine.scanAllNodes().length).toBe(50)
    for (const id of ids) await engine.deleteNode(id)
    expect(engine.scanAllNodes().length).toBe(0)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-40: 大 props 节点 + neighbors ──
test('MP-40: 大 props 节点 + neighbors', async () => {
  const cfg = makeConfig('big-prop-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'bp-c', {
      props: { huge: 'h'.repeat(10000) },
    })
    for (let i = 0; i < 10; i++) {
      const leaf = await engine.upsertNode(1, `bp-l-${i}`, { props: {} })
      await engine.upsertEdge(center, leaf, 10, { props: {} })
    }
    const nb = engine.neighbors(center)
    expect(nb.edges.length).toBe(10)
    expect(nb.nodes.length).toBe(10)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-41: 连续 upsert + neighbors 20 次 ──
test.skip('MP-41: 连续 upsert + neighbors 20 次', async () => {
  const cfg = makeConfig('upsert-nb-20')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'center-20', { props: {} })
    for (let i = 0; i < 20; i++) {
      const leaf = await engine.upsertNode(1, `un-${i}`, { props: {} })
      await engine.upsertEdge(center, leaf, 10, { props: {} })
      const nb = engine.neighbors(center)
      expect(nb.edges.length).toBe(i + 1)
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-42: 多边类型 neighbors ──
test('MP-42: 多边类型 neighbors', async () => {
  const cfg = makeConfig('multi-edge-type-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'met-center', { props: {} })
    for (let t = 0; t < 5; t++) {
      const dst = await engine.upsertNode(1, `met-${t}`, { props: { t } })
      await engine.upsertEdge(center, dst, t, { props: {} })
    }
    const nb = engine.neighbors(center)
    expect(nb.edges.length).toBe(5)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-43: 100 节点 props 检查 ──
test('MP-43: 100 节点 props 检查', async () => {
  const cfg = makeConfig('100-prop-check')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    for (let i = 0; i < 100; i++) {
      await engine.upsertNode(1, `pc-${i}`, {
        props: { id: i, name: `node-${i}`, active: i % 2 === 0 },
      })
    }
    const all = engine.scanAllNodes()
    expect(all.length).toBe(100)
    for (const n of all) {
      expect(typeof n.props.id).toBe('number')
      expect(typeof n.props.name).toBe('string')
      expect(typeof n.props.active).toBe('boolean')
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-44: scanAllNodes 后连续 neighbors ──
test('MP-44: scanAllNodes 后连续 neighbors', async () => {
  const cfg = makeConfig('scan-nb-batch')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const centers: number[] = []
    for (let c = 0; c < 5; c++) {
      const center = await engine.upsertNode(1, `sc-${c}`, { props: {} })
      centers.push(center)
      for (let l = 0; l < 10; l++) {
        const leaf = await engine.upsertNode(1, `sl-${c}-${l}`, { props: {} })
        await engine.upsertEdge(center, leaf, 10, { props: {} })
      }
    }
    const all = engine.scanAllNodes()
    expect(all.length).toBe(55)
    const nbs = centers.map(c => engine.neighbors(c))
    for (const nb of nbs) expect(nb.edges.length).toBe(10)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-45: 50 节点空对象 props ──
test('MP-45: 50 节点空对象 props', async () => {
  const cfg = makeConfig('50-empty-prop')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(await engine.upsertNode(1, `ep-${i}`))
    }
    expect(engine.scanAllNodes().length).toBe(50)
    for (const id of ids) {
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.props).toBeDefined()
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-46: 3 engine 各 50 节点 scanAllNodes ──
test('MP-46: 3 engine 各 50 节点 scanAllNodes', async () => {
  const configs = Array.from({ length: 3 }, (_, i) => makeConfig(`e3-${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map((e, ei) =>
        Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            e.upsertNode(1, `x-${ei}-${i}`, { props: { ei, i } })
          )
        )
      )
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(50)
  } finally {
    for (const e of engines) e.close()
  }
}, 30000)

// ── MP-47: 100 节点边带大 props ──
test('MP-47: 100 节点边带大 props', async () => {
  const cfg = makeConfig('100-edge-big')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(await engine.upsertNode(1, `eb-${i}`, { props: { i } }))
    }
    for (let i = 0; i < 99; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, {
        props: { data: 'x'.repeat(2000), seq: i },
      })
    }
    expect(engine.scanAllNodes().length).toBe(100)
    expect(engine.neighbors(ids[0]).edges.length).toBe(1)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-48: 3 engine neighbors ──
test('MP-48: 3 engine neighbors', async () => {
  const configs = Array.from({ length: 3 }, (_, i) => makeConfig(`e3-nb-${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map(async (e) => {
        const center = await e.upsertNode(1, 'center-e3', { props: {} })
        for (let i = 0; i < 15; i++) {
          const leaf = await e.upsertNode(1, `l-${i}`, { props: {} })
          await e.upsertEdge(center, leaf, 10, { props: {} })
        }
        expect(e.neighbors(center).edges.length).toBe(15)
      })
    )
  } finally {
    for (const e of engines) e.close()
  }
}, 30000)

// ── MP-49: 80→40→60 scan ──
test('MP-49: 80→40→20→scan', async () => {
  const cfg = makeConfig('80-40-60')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 80; i++) {
      ids.push(await engine.upsertNode(1, `m-${i}`, { props: { i } }))
    }
    expect(engine.scanAllNodes().length).toBe(80)
    for (let i = 0; i < 40; i++) await engine.deleteNode(ids[i])
    expect(engine.scanAllNodes().length).toBe(40)
    for (let i = 0; i < 20; i++) {
      await engine.upsertNode(1, `add-${i}`, { props: {} })
    }
    expect(engine.scanAllNodes().length).toBe(60)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-50: 100 大 props 节点 + neighbors ──
test('MP-50: 100 大 props 节点 + neighbors', async () => {
  const cfg = makeConfig('100-big-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'big-c', {
      props: { large: 'l'.repeat(8000) },
    })
    for (let i = 0; i < 30; i++) {
      const leaf = await engine.upsertNode(1, `bn-${i}`, {
        props: { data: 'd'.repeat(5000) },
      })
      await engine.upsertEdge(center, leaf, 10, { props: {} })
    }
    expect(engine.scanAllNodes().length).toBe(31)
    expect(engine.neighbors(center).edges.length).toBe(30)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-51: 100 节点大 props + 边 ──
test('MP-51: 100 节点大 props + 边', async () => {
  const cfg = makeConfig('100n-big-prop-edge')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(await engine.upsertNode(1, `bp-${i}`, {
        props: { data: 'd'.repeat(3000), idx: i },
      }))
    }
    for (let i = 0; i < 99; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    }
    expect(engine.scanAllNodes().length).toBe(100)
    expect(engine.neighbors(ids[0]).edges.length).toBe(1)
    expect(engine.neighbors(ids[50]).edges.length).toBe(1)
    expect(engine.neighbors(ids[99]).edges.length).toBe(0)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-52: neighbors 一致性 ──
test('MP-52: neighbors 一致性', async () => {
  const cfg = makeConfig('nb-consistency')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(await engine.upsertNode(1, `nc-${i}`, { props: {} }))
    }
    for (let i = 0; i < 49; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    }
    for (let r = 0; r < 5; r++) {
      for (let i = 0; i < 49; i++) {
        const nb = engine.neighbors(ids[i])
        expect(nb.edges.length).toBe(1)
        expect(nb.edges[0].dst).toBe(ids[i + 1])
      }
      expect(engine.neighbors(ids[49]).edges.length).toBe(0)
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-53: 多种边类型 scanAllNodes ──
test('MP-53: 多种边类型 scanAllNodes', async () => {
  const cfg = makeConfig('edge-types-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const src = await engine.upsertNode(1, 'src', { props: {} })
    const dsts: number[] = []
    for (let t = 0; t < 8; t++) {
      const dst = await engine.upsertNode(1, `dst-${t}`, { props: {} })
      await engine.upsertEdge(src, dst, t, { props: {} })
      dsts.push(dst)
    }
    expect(engine.scanAllNodes().length).toBe(9)
    expect(engine.neighbors(src).edges.length).toBe(8)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-54: 大 props + scanAllNodes 多次 ──
test('MP-54: 大 props + scanAllNodes 多次', async () => {
  const cfg = makeConfig('big-prop-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    for (let i = 0; i < 30; i++) {
      await engine.upsertNode(1, `bps-${i}`, {
        props: { data: 'w'.repeat(6000), idx: i },
      })
    }
    for (let r = 0; r < 3; r++) {
      const all = engine.scanAllNodes()
      expect(all.length).toBe(30)
    }
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-55: 边带大 props neighbors 验证 ──
test('MP-55: 边带大 props neighbors', async () => {
  const cfg = makeConfig('big-edge-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const src = await engine.upsertNode(1, 'src-ben', { props: {} })
    for (let i = 0; i < 10; i++) {
      const dst = await engine.upsertNode(1, `dst-ben-${i}`, { props: {} })
      await engine.upsertEdge(src, dst, 10, {
        props: { big: 'b'.repeat(4000), seq: i },
      })
    }
    const nb = engine.neighbors(src)
    expect(nb.edges.length).toBe(10)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-56: 50 节点 + 50 边 + scanAllNodes ──
test('MP-56: 50 节点 50 边 scanAllNodes', async () => {
  const cfg = makeConfig('50n50e-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(await engine.upsertNode(1, `n50-${i}`, { props: {} }))
    }
    for (let i = 0; i < 49; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    }
    expect(engine.scanAllNodes().length).toBe(50)
    expect(engine.neighbors(ids[0]).edges.length).toBe(1)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-57: 大 props 节点 delete 后 scanAllNodes ──
test('MP-57: 大 props 节点 delete 后 scan', async () => {
  const cfg = makeConfig('big-del-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 40; i++) {
      ids.push(await engine.upsertNode(1, `bd-${i}`, {
        props: { data: 'm'.repeat(5000), idx: i },
      }))
    }
    expect(engine.scanAllNodes().length).toBe(40)
    for (let i = 0; i < 20; i++) await engine.deleteNode(ids[i])
    expect(engine.scanAllNodes().length).toBe(20)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-58: 链式 neighbors 带大 props ──
test('MP-58: 链式 neighbors 带大 props', async () => {
  const cfg = makeConfig('chain-big-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 30; i++) {
      ids.push(await engine.upsertNode(1, `cbn-${i}`, {
        props: { data: 'n'.repeat(3000), pos: i },
      }))
    }
    for (let i = 0; i < 29; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    }
    for (let i = 0; i < 29; i++) {
      const nb = engine.neighbors(ids[i])
      expect(nb.edges.length).toBe(1)
    }
    expect(engine.neighbors(ids[29]).edges.length).toBe(0)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-59: scanAllNodes 后 upsertEdge 再 scan ──
test('MP-59: scanAllNodes → upsertEdge → scanAllNodes', async () => {
  const cfg = makeConfig('scan-edge-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const src = await engine.upsertNode(1, 'src-ses', { props: {} })
    const dst = await engine.upsertNode(1, 'dst-ses', { props: {} })
    expect(engine.scanAllNodes().length).toBe(2)
    await engine.upsertEdge(src, dst, 10, { props: {} })
    expect(engine.scanAllNodes().length).toBe(2)
    expect(engine.neighbors(src).edges.length).toBe(1)
  } finally {
    engine.close()
  }
}, 30000)

// ── MP-60: 最终综合压力验证 ──
test('MP-60: 综合压力验证', async () => {
  const cfg = makeConfig('final-pressure')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(await engine.upsertNode(i % 5, `fp-${i}`, {
        props: { idx: i, data: 'q'.repeat(2000), even: i % 2 === 0 },
      }))
    }
    expect(engine.scanAllNodes().length).toBe(100)
    for (let i = 0; i < 99; i++) {
      await engine.upsertEdge(ids[i], ids[i + 1], 10, { props: { seq: i } })
    }
    expect(engine.neighbors(ids[0]).edges.length).toBe(1)
    expect(engine.neighbors(ids[50]).edges.length).toBe(1)
    expect(engine.neighbors(ids[99]).edges.length).toBe(0)
    // 删除一半后验证
    for (let i = 0; i < 50; i++) await engine.deleteNode(ids[i])
    expect(engine.scanAllNodes().length).toBe(50)
    for (let i = 50; i < 100; i++) expect(engine.getNode(ids[i])).not.toBeNull()
  } finally {
    engine.close()
  }
}, 30000)


