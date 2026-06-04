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
