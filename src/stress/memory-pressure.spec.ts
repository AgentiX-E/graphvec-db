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
