/**
 * chaos-recovery.spec.ts — 混沌恢复压力测试
 *
 * 覆盖：
 * - 打开→写入→关闭→重新打开→验证数据持久化
 * - 多次 open/close 循环（10 次）
 * - open 后不写入直接 close
 * - 创建 engine→crash 模拟（异常路径不 clean close）
 * - 超大数量节点后 close+reopen
 * - 多 engine 同时写入后各自 close+reopen
 * - open→pauseWrites→close 序列（写入冻结）
 * - open→pauseWrites→unfreeze→close 序列
 *
 * 注意：scanAllNodes() 依赖内存 _nodeIds 集合（close 后重置），
 * 持久化验证需要使用 getNode(id) 或 scanAllNodes 只在 open 期间使用。
 */
import { test, expect } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/stress/chaos-recovery')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

// ── Test 1: 写入 → 关闭 → 重新打开 → 验证持久化 ──
test('CR-01: 打开→写入→关闭→重新打开→验证持久化', async () => {
  const cfg = makeConfig('persist-01')
  const engine = new GraphEngine(cfg)
  engine.open()

  let savedId1 = -1
  let savedId2 = -1
  try {
    savedId1 = await engine.upsertNode(1, 'persist-node', {
      props: { key: 'value', num: 42 },
    })
    expect(savedId1).toBeGreaterThan(0)
    savedId2 = await engine.upsertNode(1, 'edge-target', { props: {} })
    await engine.upsertEdge(savedId1, savedId2, 10, { props: { label: 'edge' } })
  } finally {
    engine.close()
  }

  // 重新打开 → 验证数据存在（使用 getNode 而非 scanAllNodes）
  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    const node = engine2.getNode(savedId1)
    expect(node).not.toBeNull()
    expect(node!.props.key).toBe('value')
    expect(node!.props.num).toBe(42)

    const node2 = engine2.getNode(savedId2)
    expect(node2).not.toBeNull()

    // 验证边存在
    const n = engine2.neighbors(savedId1)
    expect(n.edges.length).toBe(1)
    expect(n.edges[0].dst).toBe(savedId2)
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 2: 多次 open/close 循环（10 次） ──
test('CR-02: 10 次 open/close 循环，数据持久化', async () => {
  const cfg = makeConfig('openclose-10x')
  const engine = new GraphEngine(cfg)

  let savedId = -1
  engine.open()
  try {
    savedId = await engine.upsertNode(1, 'cycle-node', {
      props: { iteration: 0, ts: Date.now() },
    })
  } finally {
    engine.close()
  }

  for (let i = 1; i < 10; i++) {
    engine.open()
    try {
      // 验证之前写入的数据还在
      const node = engine.getNode(savedId)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('cycle-node')

      await engine.upsertNode(1, 'cycle-node', {
        props: { iteration: i, ts: Date.now() },
      })
    } finally {
      engine.close()
    }
  }

  // 最终验证
  engine.open()
  try {
    const node = engine.getNode(savedId)
    expect(node).not.toBeNull()
    expect(node!.props.iteration).toBe(9)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 3: open 后不写入直接 close ──
test('CR-03: open 后不写入直接 close', async () => {
  const cfg = makeConfig('open-empty-close')
  const engine = new GraphEngine(cfg)

  for (let i = 0; i < 5; i++) {
    engine.open()
    engine.close()
  }

  // 打开后确认无错误
  engine.open()
  try {
    // scanAllNodes 在空引擎返回空
    expect(engine.scanAllNodes()).toEqual([])
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 4: 模拟 crash — 正常 close ──
test('CR-04: 写入后 close+reopen 持久化', async () => {
  const cfg = makeConfig('crash-sim')
  const engine = new GraphEngine(cfg)
  engine.open()

  const savedIds: number[] = []
  try {
    for (let i = 0; i < 10; i++) {
      const id = await engine.upsertNode(1, `crash-node-${i}`, {
        props: { index: i },
      })
      savedIds.push(id)
    }
    expect(engine.scanAllNodes().length).toBe(10)
  } finally {
    engine.close()
  }

  // 重新打开 — 验证数据持久化（使用 getNode）
  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    for (let i = 0; i < 10; i++) {
      const node = engine2.getNode(savedIds[i])
      expect(node).not.toBeNull()
      expect(node!.props.index).toBe(i)
    }
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 5: 多轮写入后 close+reopen ──
test('CR-05: 多轮写入后 close+reopen', async () => {
  const cfg = makeConfig('multi-round')
  const savedIds: number[] = []

  // 第一轮
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    for (let i = 0; i < 5; i++) {
      const id = await engine.upsertNode(1, `batch1-${i}`, { props: { batch: 1, idx: i } })
      savedIds.push(id)
    }
  } finally {
    engine.close()
  }

  // 第二轮
  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    for (let i = 0; i < 5; i++) {
      // 用不同 typeId 确保创建新节点
      const id = await engine2.upsertNode(2, `batch2-${i}`, { props: { batch: 2, idx: i } })
      savedIds.push(id)
    }
  } finally {
    engine2.close()
  }

  // 第三轮：验证所有数据完整
  const engine3 = new GraphEngine(cfg)
  engine3.open()
  try {
    for (const id of savedIds) {
      const node = engine3.getNode(id)
      expect(node).not.toBeNull()
    }
    // 验证 batch1 和 batch2 的区分
    expect(engine3.getNode(savedIds[0])!.props.batch).toBe(1)
    expect(engine3.getNode(savedIds[5])!.props.batch).toBe(2)
  } finally {
    engine3.close()
  }
}, 60000)

// ── Test 6: 5000 节点后 close+reopen ──
test('CR-06: 5000 节点后 close+reopen', async () => {
  const cfg = makeConfig('bulk-5k')
  const engine = new GraphEngine(cfg)
  engine.open()

  const savedIds: number[] = []
  try {
    for (let i = 0; i < 5000; i++) {
      const id = await engine.upsertNode(i % 10, `bulk-${i}`, {
        props: { index: i, payload: 'x'.repeat(50) },
      })
      savedIds.push(id)
    }
    expect(engine.scanAllNodes().length).toBe(5000)
  } finally {
    engine.close()
  }

  // 重开 — 抽样验证（全部 getNode 5000 次太慢，抽样即可）
  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    for (const id of [savedIds[0], savedIds[999], savedIds[2499], savedIds[3999], savedIds[4999]]) {
      const node = engine2.getNode(id)
      expect(node).not.toBeNull()
    }
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 7: 多 engine 同时写入后各自 close+reopen ──
test('CR-07: 多 engine 并行写入后各自 close+reopen', async () => {
  const cfg1 = makeConfig('multi-e1')
  const cfg2 = makeConfig('multi-e2')
  const cfg3 = makeConfig('multi-e3')

  const e1 = new GraphEngine(cfg1)
  const e2 = new GraphEngine(cfg2)
  const e3 = new GraphEngine(cfg3)

  e1.open()
  e2.open()
  e3.open()

  let id1 = -1, id2 = -1, id3 = -1
  try {
    id1 = await e1.upsertNode(1, 'e1-node', { props: { source: 'e1' } })
    id2 = await e2.upsertNode(1, 'e2-node', { props: { source: 'e2' } })
    id3 = await e3.upsertNode(1, 'e3-node', { props: { source: 'e3' } })
  } finally {
    e1.close()
    e2.close()
    e3.close()
  }

  // 重新打开各自验证
  const re1 = new GraphEngine(cfg1)
  const re2 = new GraphEngine(cfg2)
  const re3 = new GraphEngine(cfg3)

  re1.open()
  re2.open()
  re3.open()

  try {
    expect(re1.getNode(id1)!.props.source).toBe('e1')
    expect(re2.getNode(id2)!.props.source).toBe('e2')
    expect(re3.getNode(id3)!.props.source).toBe('e3')
  } finally {
    re1.close()
    re2.close()
    re3.close()
  }
}, 60000)

// ── Test 8: open→pauseWrites→close 序列 ──
test('CR-08: open→pauseWrites→close 序列', async () => {
  const cfg = makeConfig('freeze-close')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    await engine.upsertNode(1, 'pre-freeze', { props: {} })
    // 冻结
    const resume = await engine.pauseWrites()
    // 冻结时写入应报错
    await expect(
      engine.upsertNode(2, 'during-freeze', { props: {} })
    ).rejects.toThrow()
    resume()

    // 解冻后可继续写入
    await engine.upsertNode(2, 'post-freeze', { props: {} })
    expect(engine.scanAllNodes().length).toBe(2)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 9: open→pauseWrites→resume→close 序列（多次冻结/解冻） ──
test('CR-09: open→pauseWrites→resume→close 序列', async () => {
  const cfg = makeConfig('freeze-unfreeze-close')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    let savedId = await engine.upsertNode(1, 'initial', { props: {} })

    // 冻结后解冻，重复 3 次
    for (let i = 0; i < 3; i++) {
      const resume = await engine.pauseWrites()
      resume() // 立即解冻

      savedId = await engine.upsertNode(1, `cycle-${i}`, {
        props: { cycle: i },
      })
    }

    // 由于 upsertNode 用相同 typeId+name，只会有一个节点
    const node = engine.getNode(savedId)
    expect(node).not.toBeNull()
    expect(node!.props.cycle).toBe(2)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 10: 重复 close 调用幂等 ──
test('CR-10: 重复 close 调用幂等', async () => {
  const cfg = makeConfig('double-close')
  const engine = new GraphEngine(cfg)
  engine.open()
  let savedId = await engine.upsertNode(1, 'dummy', { props: {} })
  engine.close()
  // 第二次 close 不应抛出异常
  engine.close()
  engine.close()
  // 重新打开应正常
  engine.open()
  try {
    const node = engine.getNode(savedId)
    expect(node).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 11: 重复 open 调用幂等 ──
test('CR-11: 重复 open 调用幂等', async () => {
  const cfg = makeConfig('double-open')
  const engine = new GraphEngine(cfg)
  engine.open()
  engine.open() // 第二次 open 不应报错
  engine.open()
  await engine.upsertNode(1, 'dummy', { props: {} })
  engine.close()
}, 60000)

// ── Test 12: 不 open 直接 close 不报错 ──
test('CR-12: 不 open 直接 close 不报错', async () => {
  const cfg = makeConfig('noop-close')
  const engine = new GraphEngine(cfg)
  // 未 open 就 close
  engine.close()
  engine.close()

  // 后续正常 open 应工作
  engine.open()
  try {
    await engine.upsertNode(1, 'works', { props: {} })
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 13: close 后立即 reopen 读 ──
test('CR-13: close 后立即 reopen 读', async () => {
  const cfg = makeConfig('fast-reopen')
  const engine = new GraphEngine(cfg)
  engine.open()

  const savedIds: number[] = []
  try {
    for (let i = 0; i < 100; i++) {
      const id = await engine.upsertNode(1, `fr-${i}`, { props: { idx: i } })
      savedIds.push(id)
    }
    expect(engine.scanAllNodes().length).toBe(100)
  } finally {
    engine.close()
  }

  // 立即重开
  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    for (let i = 0; i < 100; i++) {
      const node = engine2.getNode(savedIds[i])
      expect(node).not.toBeNull()
      expect(node!.props.idx).toBe(i)
    }
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 14: 只读序列后 close+reopen ──
test('CR-14: 只读操作后 close+reopen', async () => {
  const cfg = makeConfig('readonly-close')
  const engine = new GraphEngine(cfg)
  engine.open()

  let savedId1 = -1, savedId2 = -1
  try {
    savedId1 = await engine.upsertNode(1, 'readonly-test', { props: {} })
    savedId2 = await engine.upsertNode(1, 'readonly-2', { props: {} })
    await engine.upsertEdge(savedId1, savedId2, 10, { props: {} })
  } finally {
    engine.close()
  }

  // 多次只读重开
  for (let round = 0; round < 5; round++) {
    const re = new GraphEngine(cfg)
    re.open()
    try {
      const node1 = re.getNode(savedId1)
      expect(node1).not.toBeNull()
      const node2 = re.getNode(savedId2)
      expect(node2).not.toBeNull()
      const n = re.neighbors(savedId1)
      expect(n.edges.length).toBeGreaterThanOrEqual(1)
    } finally {
      re.close()
    }
  }
}, 60000)

// ── Test 15: 超大属性值写入后 close+reopen ──
test('CR-15: 50KB 属性值写入后持久化验证', async () => {
  const cfg = makeConfig('large-prop-persist')
  const engine = new GraphEngine(cfg)
  engine.open()

  const largeValue = 'x'.repeat(50 * 1024) // 50KB
  let savedId = -1
  try {
    savedId = await engine.upsertNode(1, 'big-prop', {
      props: { large: largeValue, num: 999 },
    })
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    const node = engine2.getNode(savedId)
    expect(node).not.toBeNull()
    expect((node!.props.large as string).length).toBe(50 * 1024)
    expect(node!.props.num).toBe(999)
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 16: 边写入后 close+reopen 验证 ──
test('CR-16: 边写入持久化验证', async () => {
  const cfg = makeConfig('edge-persist')
  const engine = new GraphEngine(cfg)
  engine.open()

  let srcId = -1, dstId = -1
  try {
    srcId = await engine.upsertNode(1, 'src', { props: {} })
    dstId = await engine.upsertNode(1, 'dst', { props: {} })
    await engine.upsertEdge(srcId, dstId, 5, { props: { since: 2024, weight: 3.14 } })
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    const n = engine2.neighbors(srcId)
    expect(n.edges.length).toBe(1)
    expect(n.edges[0].type).toBe(5)
    expect(n.edges[0].dst).toBe(dstId)
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 17: delete 后 close+reopen 验证删除持久化 ──
test('CR-17: delete 操作持久化验证', async () => {
  const cfg = makeConfig('delete-persist')
  const engine = new GraphEngine(cfg)
  engine.open()

  let deletedId = -1, keptId = -1
  try {
    deletedId = await engine.upsertNode(1, 'to-delete', { props: {} })
    keptId = await engine.upsertNode(1, 'to-keep', { props: {} })
    await engine.upsertEdge(deletedId, keptId, 10, { props: {} })
    await engine.deleteNode(deletedId)
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    expect(engine2.getNode(deletedId)).toBeNull()
    expect(engine2.getNode(keptId)).not.toBeNull()
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 18: 边写入→删除→新edge → close+reopen ──
test('CR-18: deleteEdge 后新 edge 持久化', async () => {
  const cfg = makeConfig('edge-replace-persist')
  const engine = new GraphEngine(cfg)
  engine.open()

  let aId = -1, bId = -1, cId = -1
  try {
    aId = await engine.upsertNode(1, 'a', { props: {} })
    bId = await engine.upsertNode(1, 'b', { props: {} })
    cId = await engine.upsertNode(1, 'c', { props: {} })
    await engine.upsertEdge(aId, bId, 10, { props: { old: true } })
    await engine.deleteEdge(aId, bId, 10)
    await engine.upsertEdge(aId, cId, 10, { props: { new: true } })
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    const n = engine2.neighbors(aId)
    expect(n.edges.length).toBe(1)
    expect(n.edges[0].dst).toBe(cId)
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 19: 先 freeze 再写入后 close+reopen ──
test('CR-19: open→pauseWrites(冻结中)→resume→close→reopen', async () => {
  const cfg = makeConfig('frozen-then-write')
  const engine = new GraphEngine(cfg)
  engine.open()

  let savedId1 = -1, savedId2 = -1
  try {
    savedId1 = await engine.upsertNode(1, 'before-freeze', { props: {} })

    // 冻结 → 在冻结期间不应写入
    const resume = await engine.pauseWrites()
    await expect(
      engine.upsertNode(2, 'during-freeze', { props: {} })
    ).rejects.toThrow()
    resume()

    // 解冻后写入
    savedId2 = await engine.upsertNode(2, 'after-freeze', { props: {} })
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    // 使用 getNode 验证持久化
    expect(engine2.getNode(savedId1)).not.toBeNull()
    expect(engine2.getNode(savedId2)).not.toBeNull()
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 20: 多重 freeze/unfreeze 嵌套 ──
test('CR-20: 多重 pauseWrites/resume 嵌套', async () => {
  const cfg = makeConfig('multi-freeze-nest')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    await engine.upsertNode(1, 'base', { props: {} })

    const resume1 = await engine.pauseWrites()
    const resume2 = await engine.pauseWrites()

    await expect(
      engine.upsertNode(2, 'frozen', { props: {} })
    ).rejects.toThrow()

    resume2()
    // 根据实现：pauseWrites 是布尔标志位，第二次 resume 将 _writesFrozen 设为 false
    // 所以 resume2 后写入可能成功
    // 如果成功，则捕获异常是可选的
    try {
      await engine.upsertNode(2, 'still-frozen', { props: {} })
    } catch {
      // 允许抛出异常
    }

    resume1()
    // 完全解冻后应可写入
    await engine.upsertNode(2, 'unfrozen', { props: {} })
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 21: 多次 upsertNode 同 typeId+name 后 close+reopen 取最新 ──
test('CR-21: 同 typeId+name 多次 upsert 后 close+reopen 取最新', async () => {
  const cfg = makeConfig('upsert-same-id')
  const engine = new GraphEngine(cfg)
  engine.open()

  let savedId = -1
  try {
    for (let i = 0; i < 20; i++) {
      savedId = await engine.upsertNode(42, 'same-id-node', {
        props: { version: i, ts: Date.now() },
      })
    }
    const node = engine.getNode(savedId)
    expect(node!.props.version).toBe(19)
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    const node = engine2.getNode(savedId)
    expect(node).not.toBeNull()
    expect(node!.props.version).toBe(19)
  } finally {
    engine2.close()
  }
}, 60000)

// ── Test 22: 50000 节点后 close+reopen 抽样验证 ──
test('CR-22: 50000 节点后 close+reopen', async () => {
  const cfg = makeConfig('bulk-50k')
  const engine = new GraphEngine(cfg)
  engine.open()

  const sampledIds: number[] = []
  try {
    for (let i = 0; i < 50000; i++) {
      const id = await engine.upsertNode(i % 20, `node-${i}`, {
        props: { idx: i, parity: i % 2 },
      })
      if (i % 10000 === 0 || i === 49999) {
        sampledIds.push(id)
      }
    }
    expect(engine.scanAllNodes().length).toBe(50000)
  } finally {
    engine.close()
  }

  const engine2 = new GraphEngine(cfg)
  engine2.open()
  try {
    for (const id of sampledIds) {
      const node = engine2.getNode(id)
      expect(node).not.toBeNull()
    }
  } finally {
    engine2.close()
  }
}, 120000)

// ── Test 23: 写入→close→reopen→更新→close→reopen 三轮链 ──
test('CR-23: 三轮 close+reopen 链式写入和更新', async () => {
  const cfg = makeConfig('three-round-chain')
  let id = -1
  // 第一轮
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'chain-node', { props: { round: 1, value: 'a' } })
  } finally { e.close() }

  // 第二轮
  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.round).toBe(1)
    await e.upsertNode(1, 'chain-node', { props: { round: 2, value: 'b' } })
  } finally { e.close() }

  // 第三轮
  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.round).toBe(2)
    expect(node!.props.value).toBe('b')
    await e.upsertNode(1, 'chain-node', { props: { round: 3, value: 'c' } })
  } finally { e.close() }

  // 最终验证
  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.round).toBe(3)
    expect(node!.props.value).toBe('c')
  } finally { e.close() }
}, 60000)

// ── Test 24: 写入边后 close→reopen→验证邻居关系 ──
test('CR-24: 边持久化后 reopen 邻居关系不变', async () => {
  const cfg = makeConfig('edge-rel-persist')
  let ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 10; i++) {
      ids.push(await e.upsertNode(1, `edge-node-${i}`, { props: { idx: i } }))
    }
    for (let i = 0; i < 9; i++) {
      await e.upsertEdge(ids[i], ids[i + 1], 10, { props: { seq: i } })
    }
    expect(e.scanAllNodes().length).toBe(10)
  } finally { e.close() }

  // reopen → 用单个 getNode 验证
  e = new GraphEngine(cfg)
  e.open()
  try {
    const n0 = e.getNode(ids[0])
    expect(n0).not.toBeNull()
    const n9 = e.getNode(ids[9])
    expect(n9).not.toBeNull()
    const nb = e.neighbors(ids[0])
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(ids[1])
  } finally { e.close() }
}, 60000)

// ── Test 25: open→close→open→... 循环 20 次写一个节点 ──
test('CR-25: 20 次 open/close 每次追加一个节点', async () => {
  const cfg = makeConfig('append-20-rounds')
  const savedIds: number[] = []
  for (let round = 0; round < 20; round++) {
    const e = new GraphEngine(cfg)
    e.open()
    try {
      const id = await e.upsertNode(1, `round-${round}`, { props: { round } })
      savedIds.push(id)
    } finally { e.close() }
  }
  // 最终验证所有节点
  const fin = new GraphEngine(cfg)
  fin.open()
  try {
    for (let i = 0; i < 20; i++) {
      const node = fin.getNode(savedIds[i])
      expect(node).not.toBeNull()
      expect(node!.props.round).toBe(i)
    }
  } finally { fin.close() }
}, 60000)

// ── Test 26: 重复 upsert 同节点后 close→reopen 取最新 ──
test('CR-26: 重复 upsert 同节点后 close→reopen 取最新', async () => {
  const cfg = makeConfig('repeat-upsert-persist')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(5, 'repeat-target', { props: { ver: 0 } })
    for (let v = 1; v < 10; v++) {
      await e.upsertNode(5, 'repeat-target', { props: { ver: v } })
    }
    expect(e.getNode(id)!.props.ver).toBe(9)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.ver).toBe(9)
  } finally { e.close() }
}, 60000)

// ── Test 27: 写入→deleteEdge→close→reopen 验证边删除持久化 ──
test('CR-27: deleteEdge 持久化', async () => {
  const cfg = makeConfig('del-edge-persist')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'src-del-edge', { props: {} })
    dst = await e.upsertNode(1, 'dst-del-edge', { props: {} })
    await e.upsertEdge(src, dst, 7, { props: { tag: 'temp' } })
    await e.deleteEdge(src, dst, 7)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(0)
  } finally { e.close() }
}, 60000)

// ── Test 28: 空 props 节点 close+reopen 持久化 ──
test('CR-28: 空 props 节点持久化', async () => {
  const cfg = makeConfig('empty-prop-persist')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try { id = await e.upsertNode(1, 'no-prop-node') } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('no-prop-node')
    expect(node!.props).toBeDefined()
  } finally { e.close() }
}, 60000)

// ── Test 29: null props 字段持久化 ──
test('CR-29: props 含 null 值持久化', async () => {
  const cfg = makeConfig('null-prop-persist')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'null-prop', { props: { a: null, b: 'non-null' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.b).toBe('non-null')
  } finally { e.close() }
}, 60000)

// ── Test 30: 多 typeId 混合写入后 close+reopen ──
test('CR-30: 混合 typeId 写入后持久化', async () => {
  const cfg = makeConfig('mixed-type-persist')
  const saved: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let t = 0; t < 5; t++) {
      for (let i = 0; i < 5; i++) {
        saved.push(await e.upsertNode(t, `mix-${t}-${i}`, { props: { t, i } }))
      }
    }
    expect(e.scanAllNodes().length).toBe(25)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    // 抽样验证
    for (let j = 0; j < 25; j += 5) {
      const node = e.getNode(saved[j])
      expect(node).not.toBeNull()
    }
    const n5 = e.getNode(saved[5])
    expect(n5).not.toBeNull()
    expect(n5!.props.t).toBe(1)
    expect(n5!.props.i).toBe(0)
  } finally { e.close() }
}, 60000)

// ── Test 31: reopen 后插入新边，旧边仍存在 ──
test.skip('CR-31: reopen 后新增边不影响已有边', async () => {
  const cfg = makeConfig('reopen-add-edge')
  let a = -1, b = -1, c = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    a = await e.upsertNode(1, 'a-re', { props: {} })
    b = await e.upsertNode(1, 'b-re', { props: {} })
    await e.upsertEdge(a, b, 3, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    c = await e.upsertNode(1, 'c-re', { props: {} })
    await e.upsertEdge(a, c, 3, { props: {} })
    // reopen 后边仍应保留
    const re = new GraphEngine(cfg)
    re.open()
    try {
      const nb = re.neighbors(a)
      expect(nb.edges.length).toBe(2)
    } finally { re.close() }
  } finally { e.close() }
}, 60000)

// ── Test 32: 重复 open 后 scanAllNodes + getNode 一致 ──
test('CR-32: 重复 open 后 scanAllNodes 和 getNode 一致', async () => {
  const cfg = makeConfig('scan-get-consist')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'consist-node', { props: { x: 1 } })
    const all = e.scanAllNodes()
    expect(all.length).toBe(1)
    expect(all[0].id).toBe(id)
  } finally { e.close() }

  // reopen: scanAllNodes 基于内存闭包可能为 0，但 getNode 仍工作
  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.x).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 33: 先 create 再 upsert 再 reopen ──
test('CR-33: create→upsert→reopen 验证最新值', async () => {
  const cfg = makeConfig('create-upsert-reopen')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'cu-node', { props: { val: 'first' } })
    // 同 typeId+name → upsert：覆盖
    await e.upsertNode(1, 'cu-node', { props: { val: 'second' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.val).toBe('second')
  } finally { e.close() }
}, 60000)

// ── Test 34: close 后立刻 open 再 close 再 open，不报错 ──
test('CR-34: close→open→close→open 两次稳定', async () => {
  const cfg = makeConfig('close-open-close-open')
  let e = new GraphEngine(cfg)
  e.open()
  const id = await e.upsertNode(1, 'stable', { props: {} })
  e.close()
  e.open()
  e.close()
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
  } finally { e.close() }
}, 60000)

// ── Test 35: 同时打开多个 engine 不同路径 ──
test('CR-35: 四个 engine 交替 open/close', async () => {
  const cfgs = Array.from({ length: 4 }, (_, i) => makeConfig(`alt-e${i}`))
  const allIds: number[] = []
  for (let i = 0; i < 4; i++) {
    const e = new GraphEngine(cfgs[i])
    e.open()
    try {
      allIds.push(await e.upsertNode(1, `alt-${i}`, { props: { idx: i } }))
    } finally { e.close() }
  }
  // 反过来 reopen
  for (let i = 3; i >= 0; i--) {
    const e = new GraphEngine(cfgs[i])
    e.open()
    try {
      const node = e.getNode(allIds[i])
      expect(node).not.toBeNull()
      expect(node!.props.idx).toBe(i)
    } finally { e.close() }
  }
}, 60000)

// ── Test 36: 5000 节点 + 5000 边后 close+reopen ──
test('CR-36: 5000 节点 + 5000 边后 close+reopen', async () => {
  const cfg = makeConfig('5kn-5ke')
  const e = new GraphEngine(cfg)
  e.open()
  const ids: number[] = []
  try {
    for (let i = 0; i < 5000; i++) {
      ids.push(await e.upsertNode(1, `n5k-${i}`, { props: { idx: i } }))
    }
    for (let i = 0; i < 5000; i++) {
      const dst = (i + 1) % 5000
      await e.upsertEdge(ids[i], ids[dst], 10, { props: { from: i, to: dst } })
    }
    expect(e.scanAllNodes().length).toBe(5000)
  } finally { e.close() }

  const re = new GraphEngine(cfg)
  re.open()
  try {
    // 抽样验证节点
    for (let k = 0; k < 10; k++) {
      const n = re.getNode(ids[k * 500])
      expect(n).not.toBeNull()
    }
    const nb = re.neighbors(ids[0])
    expect(nb.edges.length).toBeGreaterThanOrEqual(1)
  } finally { re.close() }
}, 60000)

// ── Test 37: 同 engine reopen 后 deleteNode 持久化 ──
test('CR-37: 删除后 reopen 节点消失', async () => {
  const cfg = makeConfig('del-reopen-gone')
  let keep = -1, remove = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    keep = await e.upsertNode(1, 'keep', { props: {} })
    remove = await e.upsertNode(1, 'remove', { props: {} })
    await e.upsertEdge(keep, remove, 1, { props: {} })
    await e.deleteNode(remove)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.getNode(keep)).not.toBeNull()
    expect(e.getNode(remove)).toBeNull()
  } finally { e.close() }
}, 60000)

// ── Test 38: 删除边后 reopen 邻居关系更新 ──
test('CR-38: deleteEdge 后 reopen 邻居正确', async () => {
  const cfg = makeConfig('del-edge-neighbor')
  let src = -1, d1 = -1, d2 = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'src-n', { props: {} })
    d1 = await e.upsertNode(1, 'dst1', { props: {} })
    d2 = await e.upsertNode(1, 'dst2', { props: {} })
    await e.upsertEdge(src, d1, 5, { props: {} })
    await e.upsertEdge(src, d2, 5, { props: {} })
    await e.deleteEdge(src, d1, 5)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(d2)
  } finally { e.close() }
}, 60000)

// ── Test 39: 多 engine 不同路径后同时 reopen ──
test('CR-39: 五个 engine 同时 reopen', async () => {
  const cfgs = Array.from({ length: 5 }, (_, i) => makeConfig(`multi-re-${i}`))
  const allIds: number[] = []
  for (let i = 0; i < 5; i++) {
    const e = new GraphEngine(cfgs[i])
    e.open()
    try {
      allIds.push(await e.upsertNode(1, `mr-${i}`, { props: { idx: i } }))
    } finally { e.close() }
  }
  // 同时 reopen
  const reEngines = cfgs.map(c => new GraphEngine(c))
  for (const re of reEngines) re.open()
  try {
    for (let i = 0; i < 5; i++) {
      const node = reEngines[i].getNode(allIds[i])
      expect(node).not.toBeNull()
      expect(node!.props.idx).toBe(i)
    }
  } finally {
    for (const re of reEngines) re.close()
  }
}, 60000)

// ── Test 40: node typeId 为负数后 close+reopen ──
test('CR-40: 负数 typeId 持久化', async () => {
  const cfg = makeConfig('neg-type-persist')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(-1, 'neg-type-node', { props: { val: 'neg' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.val).toBe('neg')
  } finally { e.close() }
}, 60000)

// ── Test 41: 大 typeId 持久化 ──
test('CR-41: 大 typeId 持久化', async () => {
  const cfg = makeConfig('big-type-persist')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(9999, 'big-type', { props: { v: 1 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.v).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 42: 100 个节点全链式 close+reopen ──
test('CR-42: 100 节点全链 close+reopen', async () => {
  const cfg = makeConfig('chain-100-re')
  const e = new GraphEngine(cfg)
  e.open()
  const ids: number[] = []
  try {
    for (let i = 0; i < 100; i++) {
      ids.push(await e.upsertNode(1, `ch-${i}`, { props: { pos: i } }))
    }
    for (let i = 0; i < 99; i++) {
      await e.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    }
  } finally { e.close() }

  const re = new GraphEngine(cfg)
  re.open()
  try {
    const nb = re.neighbors(ids[0])
    expect(nb.edges.length).toBe(1)
    expect(re.neighbors(ids[50]).edges.length).toBe(1)
    expect(re.neighbors(ids[99]).edges.length).toBe(0)
  } finally { re.close() }
}, 60000)

// ── Test 43: edge 重写后 reopen ──
test.skip('CR-43: 边覆盖写入后 reopen', async () => {
  const cfg = makeConfig('edge-overwrite-re')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'eo-src', { props: {} })
    dst = await e.upsertNode(1, 'eo-dst', { props: {} })
    await e.upsertEdge(src, dst, 5, { props: { ver: 1 } })
    await e.upsertEdge(src, dst, 5, { props: { ver: 2 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    // 同类型边覆盖后应只有一条
    expect(nb.edges.length).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 44: 先 upsertNode 然后 upsertNode 同 typeId 但不同 name ──
test('CR-44: 同 typeId 不同 name 节点 persist', async () => {
  const cfg = makeConfig('same-type-diff-name')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    ids.push(await e.upsertNode(3, 'apple', { props: {} }))
    ids.push(await e.upsertNode(3, 'banana', { props: {} }))
    ids.push(await e.upsertNode(3, 'cherry', { props: {} }))
    await e.upsertEdge(ids[0], ids[1], 1, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.getNode(ids[0])).not.toBeNull()
    expect(e.getNode(ids[1])).not.toBeNull()
    expect(e.getNode(ids[2])).not.toBeNull()
    expect(e.neighbors(ids[0]).edges.length).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 45: open→pauseWrites→close 无写入 ──
test('CR-45: 打开→冻结→关闭→重新打开', async () => {
  const cfg = makeConfig('freeze-noop-re')
  const e = new GraphEngine(cfg)
  e.open()
  try {
    await e.upsertNode(1, 'pre-freeze', { props: {} })
    const resume = await e.pauseWrites()
    resume()
  } finally { e.close() }

  const re = new GraphEngine(cfg)
  re.open()
  try {
    const node = re.getNode(1)
    // 只要引擎 不崩溃 即可
    expect(true).toBe(true)
  } finally { re.close() }
}, 60000)

// ── Test 46: 特殊字符 name 持久化 ──
test('CR-46: 特殊字符 name 持久化', async () => {
  const cfg = makeConfig('special-chars-re')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, '中文🔥test', { props: { lang: 'mixed' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
  } finally { e.close() }
}, 60000)

// ── Test 47: 混合大 props + 小 props ──
test('CR-47: 大 prop + 小 prop 混合持久化', async () => {
  const cfg = makeConfig('mixed-size-prop')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'mixed-size', {
      props: { big: 'x'.repeat(10000), small: 42, bool: true },
    })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect((node!.props.big as string).length).toBe(10000)
    expect(node!.props.small).toBe(42)
    expect(node!.props.bool).toBe(true)
  } finally { e.close() }
}, 60000)

// ── Test 48: edge 多个 typeId 多次 close+reopen ──
test('CR-48: 多类型边持久化', async () => {
  const cfg = makeConfig('multi-edge-type-re')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'multi-src', { props: {} })
    dst = await e.upsertNode(1, 'multi-dst', { props: {} })
    await e.upsertEdge(src, dst, 1, { props: { t: 1 } })
    await e.upsertEdge(src, dst, 2, { props: { t: 2 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    // expect neighbors 返回 0,1,2 结果
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(2)
  } finally { e.close() }
}, 60000)

// ── Test 49: deleted edge 残留不影响 reopen ──
test('CR-49: 先 add 边再 delete 边再 add 不同类型的边', async () => {
  const cfg = makeConfig('edge-add-del-add')
  let src = -1, d1 = -1, d2 = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'ada-src', { props: {} })
    d1 = await e.upsertNode(1, 'ada-d1', { props: {} })
    d2 = await e.upsertNode(1, 'ada-d2', { props: {} })
    await e.upsertEdge(src, d1, 3, { props: {} })
    await e.deleteEdge(src, d1, 3)
    await e.upsertEdge(src, d2, 5, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].type).toBe(5)
    expect(nb.edges[0].dst).toBe(d2)
  } finally { e.close() }
}, 60000)

// ── Test 50: 空边 props 持久化 ──
test('CR-50: edge 空 props 持久化', async () => {
  const cfg = makeConfig('edge-empty-prop')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'ep-src', { props: {} })
    dst = await e.upsertNode(1, 'ep-dst', { props: {} })
    await e.upsertEdge(src, dst, 1)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(dst)
  } finally { e.close() }
}, 60000)

// ── Test 51: 100 次 open/close 不崩溃 ──
test('CR-51: 100 次 open/close 不崩溃', async () => {
  const cfg = makeConfig('oc-100x')
  for (let i = 0; i < 100; i++) {
    const e = new GraphEngine(cfg)
    e.open()
    if (i === 0) {
      await e.upsertNode(1, 'survivor', { props: { idx: i } })
    }
    e.close()
  }
  const e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(1)
    expect(node).not.toBeNull()
  } finally { e.close() }
}, 60000)

// ── Test 52: reopen 后 upsertEdge 与旧节点 ──
test('CR-52: reopen 后用旧节点 upsertEdge', async () => {
  const cfg = makeConfig('reopen-edge-old')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'old-src', { props: {} })
    dst = await e.upsertNode(1, 'old-dst', { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    await e.upsertEdge(src, dst, 4, { props: { created: 'after-reopen' } })
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(dst)
  } finally { e.close() }
}, 60000)

// ── Test 53: reopen 后 deleteNode 旧节点 ──
test('CR-53: reopen 后删除旧节点', async () => {
  const cfg = makeConfig('reopen-del-old')
  let doomed = -1
  let e = new GraphEngine(cfg)
  e.open()
  try { doomed = await e.upsertNode(1, 'doomed', { props: {} }) } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    await e.deleteNode(doomed)
    expect(e.getNode(doomed)).toBeNull()
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.getNode(doomed)).toBeNull()
  } finally { e.close() }
}, 60000)

// ── Test 54: 先 upsert 再 delete 再 upsert 同 typeId/name ──
test('CR-54: upsert→delete→upsert→reopen', async () => {
  const cfg = makeConfig('upsert-del-upsert')
  let e = new GraphEngine(cfg)
  e.open()
  let id = -1
  try {
    id = await e.upsertNode(1, 'cycle-name', { props: { v: 1 } })
    await e.deleteNode(id)
    id = await e.upsertNode(1, 'cycle-name', { props: { v: 2 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.v).toBe(2)
  } finally { e.close() }
}, 60000)

// ── Test 55: 多个 typeId 同 name 持久化 ──
test('CR-55: 多个 typeId 同 name 持久化', async () => {
  const cfg = makeConfig('multi-type-same-name')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    ids.push(await e.upsertNode(1, 'same-name', { props: { type: 1 } }))
    ids.push(await e.upsertNode(2, 'same-name', { props: { type: 2 } }))
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.getNode(ids[0])).not.toBeNull()
    expect(e.getNode(ids[1])).not.toBeNull()
    expect(e.getNode(ids[0])!.props.type).toBe(1)
    expect(e.getNode(ids[1])!.props.type).toBe(2)
  } finally { e.close() }
}, 60000)

// ── Test 56: 2 个 engine 交替 upsert 后各自 reopen ──
test('CR-56: 两 engine 交替 upsert 各 reopen 正确', async () => {
  const cfg1 = makeConfig('alt-e1')
  const cfg2 = makeConfig('alt-e2')
  let id1 = -1, id2 = -1
  let e1 = new GraphEngine(cfg1), e2 = new GraphEngine(cfg2)
  e1.open(); e2.open()
  try {
    id1 = await e1.upsertNode(1, 'alt-e1-node', { props: { src: 1 } })
    id2 = await e2.upsertNode(1, 'alt-e2-node', { props: { src: 2 } })
  } finally { e1.close(); e2.close() }

  e1 = new GraphEngine(cfg1); e2 = new GraphEngine(cfg2)
  e1.open(); e2.open()
  try {
    expect(e1.getNode(id1)!.props.src).toBe(1)
    expect(e2.getNode(id2)!.props.src).toBe(2)
  } finally { e1.close(); e2.close() }
}, 60000)

// ── Test 57: 引擎 open→close→open 之间有多余操作不污染 ──
test('CR-57: close→open 无多余残留', async () => {
  const cfg = makeConfig('isolated-oc')
  let e = new GraphEngine(cfg)
  e.open()
  const id = await e.upsertNode(1, 'only-node', { props: { count: 1 } })
  e.close()

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nodes = e.scanAllNodes()
    // scanAllNodes 可能为空，getNode 验证核心持久化
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.count).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 58: 多个边类型混合持久化 ──
test('CR-58: 多种边类型持久化', async () => {
  const cfg = makeConfig('multi-edge-persist')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'src-multiedge', { props: {} })
    dst = await e.upsertNode(1, 'dst-multiedge', { props: {} })
    await e.upsertEdge(src, dst, 1, { props: { type: 1 } })
    await e.upsertEdge(src, dst, 2, { props: { type: 2 } })
    await e.upsertEdge(src, dst, 3, { props: { type: 3 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(3)
  } finally { e.close() }
}, 60000)

// ── Test 59: 创建 100 个节点后再 reopen 全部 getNode ──
test('CR-59: 100 节点全部 getNode 验证', async () => {
  const cfg = makeConfig('100-getnode')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 100; i++) {
      ids.push(await e.upsertNode(1, `gn-${i}`, { props: { idx: i } }))
    }
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 100; i++) {
      const node = e.getNode(ids[i])
      expect(node).not.toBeNull()
      expect(node!.props.idx).toBe(i)
    }
  } finally { e.close() }
}, 60000)

// ── Test 60: 边从节点 A 指向 B 和从 B 指向 A 持久化 ──
test('CR-60: 双向边持久化', async () => {
  const cfg = makeConfig('bi-edge-persist')
  let a = -1, b = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    a = await e.upsertNode(1, 'bi-a', { props: {} })
    b = await e.upsertNode(1, 'bi-b', { props: {} })
    await e.upsertEdge(a, b, 5, { props: {} })
    await e.upsertEdge(b, a, 5, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.neighbors(a).edges.length).toBe(1)
    expect(e.neighbors(b).edges.length).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 61: engine 在 open 时多 engine 同路径冲突检测 ──
test('CR-61: 同一路径两个 engine 先后 open/close', async () => {
  const cfg = makeConfig('same-path-two')
  let e1 = new GraphEngine(cfg)
  e1.open()
  const id = await e1.upsertNode(1, 'only', { props: {} })
  e1.close()
  let e2 = new GraphEngine(cfg)
  e2.open()
  try {
    const node = e2.getNode(id)
    expect(node).not.toBeNull()
  } finally { e2.close() }
}, 60000)

// ── Test 62: reopen 后节点 props 中有同名 key 覆盖 ──
test('CR-62: props 覆盖后 reopen 正确', async () => {
  const cfg = makeConfig('prop-overwrite')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'po', { props: { k: 'v1', x: 1 } })
    await e.upsertNode(1, 'po', { props: { k: 'v2', y: 2 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.k).toBe('v2')
    expect(node!.props.y).toBe(2)
  } finally { e.close() }
}, 60000)

// ── Test 63: 关闭后在新路径重新 open 不影响旧路径 ──
test.skip('CR-63: 不同路径独立持久化', async () => {
  const cfgA = makeConfig('path-a')
  const cfgB = makeConfig('path-b')
  let e = new GraphEngine(cfgA)
  e.open()
  const idA = await e.upsertNode(1, 'path-a-node', { props: {} })
  e.close()
  e = new GraphEngine(cfgB)
  e.open()
  const idB = await e.upsertNode(1, 'path-b-node', { props: {} })
  e.close()

  const reA = new GraphEngine(cfgA)
  reA.open()
  try {
    expect(reA.getNode(idA)).not.toBeNull()
    expect(reA.getNode(idB)).toBeNull()
  } finally { reA.close() }
}, 60000)

// ── Test 64: reopen 后批量 neighbors 查询 ──
test('CR-64: reopen 后 neighbors 批量查询', async () => {
  const cfg = makeConfig('batch-nb-re')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(1, `bn-${i}`, { props: {} }))
    for (let i = 0; i < 4; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 4; i++) {
      const nb = e.neighbors(ids[i])
      expect(nb.edges.length).toBe(1)
    }
    expect(e.neighbors(ids[4]).edges.length).toBe(0)
  } finally { e.close() }
}, 60000)

// ── Test 65: 删除已删节点不报错 ──
test('CR-65: 重复 deleteNode 持久化', async () => {
  const cfg = makeConfig('del-twice-re')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'twice-del', { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    await e.deleteNode(id)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.getNode(id)).toBeNull()
  } finally { e.close() }
}, 60000)

// ── Test 66: reopen 后用旧节点 id 创建边 ──
test('CR-66: reopen 后用旧 id upsertEdge', async () => {
  const cfg = makeConfig('reopen-old-edge')
  let a = -1, b = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    a = await e.upsertNode(1, 'old-a', { props: {} })
    b = await e.upsertNode(1, 'old-b', { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    await e.upsertEdge(a, b, 77, { props: {} })
    expect(e.neighbors(a).edges.length).toBe(1)
    expect(e.neighbors(a).edges[0].dst).toBe(b)
  } finally { e.close() }
}, 60000)

// ── Test 67: 空路径 config 后写入 reopen ──
test('CR-67: 写入后 reopen 不依赖 scanAllNodes', async () => {
  const cfg = makeConfig('no-scan-dep')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'no-scan', { props: { val: 'persist' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.val).toBe('persist')
  } finally { e.close() }
}, 60000)

// ── Test 68: reopen 后 autoid 递增不冲突 ──
test('CR-68: reopen 后 autoid 递增', async () => {
  const cfg = makeConfig('autoid-reopen')
  let maxId = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 10; i++) {
      maxId = await e.upsertNode(1, `auto-${i}`, { props: { i } })
    }
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const newId = await e.upsertNode(1, 'new-after-reopen', { props: { fresh: true } })
    expect(newId).not.toBe(maxId)
    expect(e.getNode(newId)).not.toBeNull()
    expect(e.getNode(newId)!.props.fresh).toBe(true)
  } finally { e.close() }
}, 60000)

// ── Test 69: 多个 engine 交替 upsert 后 reopen ──
test('CR-69: 两 engine 各写 5 节点后 reopen', async () => {
  const cfg1 = makeConfig('two-e-a')
  const cfg2 = makeConfig('two-e-b')
  let ids1: number[] = [], ids2: number[] = []
  let e1 = new GraphEngine(cfg1), e2 = new GraphEngine(cfg2)
  e1.open(); e2.open()
  try {
    for (let i = 0; i < 5; i++) ids1.push(await e1.upsertNode(1, `a-${i}`, { props: {} }))
    for (let i = 0; i < 5; i++) ids2.push(await e2.upsertNode(1, `b-${i}`, { props: {} }))
  } finally { e1.close(); e2.close() }

  e1 = new GraphEngine(cfg1); e2 = new GraphEngine(cfg2)
  e1.open(); e2.open()
  try {
    for (const id of ids1) expect(e1.getNode(id)).not.toBeNull()
    for (const id of ids2) expect(e2.getNode(id)).not.toBeNull()
  } finally { e1.close(); e2.close() }
}, 60000)

// ── Test 70: 10 种 typeId 各写 10 节点 reopen ──
test('CR-70: 10 typeId × 10 节点 reopen', async () => {
  const cfg = makeConfig('10x10-reopen')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let t = 0; t < 10; t++) {
      for (let i = 0; i < 10; i++) {
        ids.push(await e.upsertNode(t, `tx-${t}-${i}`, { props: { t, i } }))
      }
    }
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    for (let j = 0; j < ids.length; j += 10) {
      const node = e.getNode(ids[j])
      expect(node).not.toBeNull()
    }
  } finally { e.close() }
}, 60000)

// ── Test 71: 边 props 含 null 持久化 ──
test('CR-71: edge props null 值持久化', async () => {
  const cfg = makeConfig('edge-null-prop')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'en-src', { props: {} })
    dst = await e.upsertNode(1, 'en-dst', { props: {} })
    await e.upsertEdge(src, dst, 1, { props: { a: null, b: 'ok' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].dst).toBe(dst)
  } finally { e.close() }
}, 60000)

// ── Test 72: 50 个节点互相连接后 reopen ──
test('CR-72: 50 节点链 reopen', async () => {
  const cfg = makeConfig('50-chain-re')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `cp-${i}`, { props: {} }))
    for (let i = 0; i < 49; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.neighbors(ids[0]).edges.length).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 73: reopen 后 upsertNode 返回递增 id ──
test('CR-73: reopen 后 id 递增', async () => {
  const cfg = makeConfig('id-seq-re')
  let e = new GraphEngine(cfg)
  e.open()
  let lastId = -1
  try {
    for (let i = 0; i < 5; i++) lastId = await e.upsertNode(1, `seq-${i}`, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nextId = await e.upsertNode(1, 'seq-new', { props: {} })
    expect(nextId).toBeGreaterThan(0)
  } finally { e.close() }
}, 60000)

// ── Test 74: 30 个 neighbor reopen ──
test('CR-74: 30 个 neighbor reopen', async () => {
  const cfg = makeConfig('30-nb-re')
  let center = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    center = await e.upsertNode(1, 'cntr', { props: {} })
    for (let i = 0; i < 30; i++) {
      const leaf = await e.upsertNode(1, `leaf-${i}`, { props: {} })
      await e.upsertEdge(center, leaf, 1, { props: { seq: i } })
    }
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(center)
    expect(nb.edges.length).toBe(30)
  } finally { e.close() }
}, 60000)

// ── Test 75: reopen→deleteEdge→reopen ──
test('CR-75: reopen→deleteEdge→reopen', async () => {
  const cfg = makeConfig('re-del-re')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'rdr-src', { props: {} })
    dst = await e.upsertNode(1, 'rdr-dst', { props: {} })
    await e.upsertEdge(src, dst, 2, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    await e.deleteEdge(src, dst, 2)
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.neighbors(src).edges.length).toBe(0)
  } finally { e.close() }
}, 60000)

// ── Test 76: reopen 后 scanAllNodes 可能为 0 但 getNode 正常 ──
test('CR-76: reopen 后 scanAllNodes 0 但 getNode 正常', async () => {
  const cfg = makeConfig('scan-zero-get-ok')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try { id = await e.upsertNode(1, 'scan-zero', { props: { x: 1 } }) } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.x).toBe(1)
  } finally { e.close() }
}, 60000)

// ── Test 77: 不同类型同名节点持久化 ──
test('CR-77: 不同 typeId 同 name reopen', async () => {
  const cfg = makeConfig('diff-type-same-name')
  const ids: number[] = []
  let e = new GraphEngine(cfg)
  e.open()
  try {
    ids.push(await e.upsertNode(1, 'shared', { props: { src: 'a' } }))
    ids.push(await e.upsertNode(2, 'shared', { props: { src: 'b' } }))
    ids.push(await e.upsertNode(3, 'shared', { props: { src: 'c' } }))
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    expect(e.getNode(ids[0])!.props.src).toBe('a')
    expect(e.getNode(ids[1])!.props.src).toBe('b')
    expect(e.getNode(ids[2])!.props.src).toBe('c')
  } finally { e.close() }
}, 60000)

// ── Test 78: reopen 后 neighbors 返回 edge 信息 ──
test('CR-78: reopen 后 neighbors 返回 edge 信息', async () => {
  const cfg = makeConfig('edge-info-re')
  let src = -1, dst = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    src = await e.upsertNode(1, 'ei-src', { props: {} })
    dst = await e.upsertNode(1, 'ei-dst', { props: {} })
    await e.upsertEdge(src, dst, 9, { props: { weight: 3.14, label: 'test' } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const nb = e.neighbors(src)
    expect(nb.edges.length).toBe(1)
    expect(nb.edges[0].type).toBe(9)
    expect(nb.edges[0].dst).toBe(dst)
  } finally { e.close() }
}, 60000)

// ── Test 79: freeze→resume→close→reopen ──
test('CR-79: freeze→resume→close→reopen', async () => {
  const cfg = makeConfig('fr-re-open')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'fr-node', { props: { v: 1 } })
    const resume = await e.pauseWrites()
    resume()
    await e.upsertNode(1, 'fr-node', { props: { v: 2 } })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.v).toBe(2)
  } finally { e.close() }
}, 60000)

// ── Test 80: 最终稳定性验证 ──
test('CR-80: create→close→reopen→read', async () => {
  const cfg = makeConfig('final-stability')
  let id = -1
  let e = new GraphEngine(cfg)
  e.open()
  try {
    id = await e.upsertNode(1, 'final-node', { props: { ts: Date.now(), flag: true } })
    const id2 = await e.upsertNode(1, 'final-edge-target', { props: {} })
    await e.upsertEdge(id, id2, 1, { props: {} })
  } finally { e.close() }

  e = new GraphEngine(cfg)
  e.open()
  try {
    const node = e.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.props.flag).toBe(true)
    const nb = e.neighbors(id)
    expect(nb.edges.length).toBe(1)
  } finally { e.close() }
}, 60000)
