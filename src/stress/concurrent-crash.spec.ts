/**
 * concurrent-crash.spec.ts — 并发与异常压力测试
 *
 * 覆盖：
 * - 并发写入 100 节点无 race
 * - 并发 upsertEdge 无 race
 * - 并发读写混合（50 readers + 50 writers）
 * - 大量并发 delete 操作
 * - 边创建时节点不存在的Error处理
 * - 同 id 并发 upsert 与读取
 * - 超大属性值（50KB string）写入
 * - 超大数量 props（100 个 key）的节点
 */
import { test, expect } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import type { NodeProperties } from '../types'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/stress/concurrent-crash')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

// ── Test 1: 并发写入 100 节点 ──
test('CC-01: 并发写入 100 节点无 race', async () => {
  const cfg = makeConfig('concurrent-write-100')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const promises = Array.from({ length: 100 }, (_, i) =>
      engine.upsertNode(i % 5, `cw-${i}`, {
        props: { index: i, payload: 'data-' + i },
      })
    )
    const ids = await Promise.all(promises)
    expect(ids.length).toBe(100)
    expect(new Set(ids).size).toBe(100)

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(100)

    for (const id of ids) {
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 2: 并发 upsertEdge 无 race ──
test('CC-02: 并发 upsertEdge 无 race', async () => {
  const cfg = makeConfig('concurrent-edge')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 先创建中心节点和 50 个目标节点
    const center = await engine.upsertNode(1, 'center', { props: {} })
    const targets = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `target-${i}`, { props: { idx: i } })
      )
    )

    // 并发创建边
    const edgePromises = targets.map((target, i) =>
      engine.upsertEdge(center, target, 10, {
        props: { order: i, ts: Date.now() },
      })
    )
    await Promise.all(edgePromises)

    const n = engine.neighbors(center)
    expect(n.edges.length).toBe(50)
    // 所有 node 都能被 neighbors 查到
    expect(n.nodes.length).toBeGreaterThanOrEqual(50)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 3: 并发读写混合（50 readers + 50 writers） ──
test('CC-03: 50 readers + 50 writers 混合并发', async () => {
  const cfg = makeConfig('read-write-mix')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 先写 50 个基础节点
    const baseIds = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `base-${i}`, { props: { index: i } })
      )
    )

    // 并发 50 个 writer（更新现有节点+写入新节点）和 50 个 reader
    const writers = Array.from({ length: 50 }, (_, i) =>
      i < 25
        ? engine.upsertNode(1, `base-${i}`, {
            props: { index: i, updated: true, ts: Date.now() },
          })
        : engine.upsertNode(1, `new-${i}`, {
            props: { index: i, source: 'writer' },
          })
    )

    const readers = baseIds.map((id) =>
      Promise.resolve().then(() => engine.getNode(id))
    )

    const results = await Promise.all([...writers, ...readers])
    const writerResults = results.slice(0, 50)
    const readerResults = results.slice(50) as (typeof results)

    // 验证所有读操作返回非 null
    for (const r of readerResults) {
      expect(r).not.toBeNull()
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 4: 大量并发 delete 操作 ──
test('CC-04: 大量并发 delete 操作', async () => {
  const cfg = makeConfig('concurrent-delete')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 创建 100 个节点
    const ids = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        engine.upsertNode(1, `del-${i}`, { props: { index: i } })
      )
    )

    // 并发删除 50 个
    const toDelete = ids.filter((_, i) => i % 2 === 0)
    const deletePromises = toDelete.map((id) => engine.deleteNode(id))
    await Promise.all(deletePromises)

    // 验证：被删的不存在，没被删的存在
    for (let i = 0; i < ids.length; i++) {
      const node = engine.getNode(ids[i])
      if (i % 2 === 0) {
        expect(node).toBeNull()
      } else {
        expect(node).not.toBeNull()
      }
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 5: 边创建时节点不存在（Error处理） ──
test('CC-05: 边指向不存在节点的Error处理', async () => {
  const cfg = makeConfig('edge-no-node')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const src = await engine.upsertNode(1, 'src', { props: {} })

    // 尝试用不存在的 dst 创建边 — engine 不应崩溃
    // upsertEdge 本身可能抛出异常或静默忽略
    try {
      await engine.upsertEdge(src, 999999, 10, { props: {} })
    } catch {
      // 允许抛出异常
    }

    // engine 应仍然可用
    const node = await engine.upsertNode(1, 'still-works', { props: {} })
    expect(node).toBeGreaterThan(0)
    expect(engine.getNode(node)).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 6: 同 id 并发 upsert 与读取 ──
test('CC-06: 同 typeId 并发 upsert 读取不崩溃', async () => {
  const cfg = makeConfig('concurrent-same-typeid')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 并发对相同 typeId 但不同 name 的节点做 upsert
    // typeId=1, name 各不相同 → 创建新节点
    const writePromises = Array.from({ length: 50 }, (_, i) =>
      engine.upsertNode(1, `same-type-${i}`, {
        props: { index: i, ts: Date.now() },
      })
    )

    // 边写入的同时去读
    const readPromises = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => engine.getNode(i + 1))
    )

    await Promise.all([...writePromises, ...readPromises])

    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBe(50)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 7: 超大属性值写入 ──
test('CC-07: 50KB 字符串属性写入', async () => {
  const cfg = makeConfig('large-prop')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const largeValue = 'A'.repeat(50 * 1024) // 50KB
    const id = await engine.upsertNode(1, 'large-prop-node', {
      props: { data: largeValue, size: largeValue.length, desc: 'big string' },
    })

    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect((node!.props.data as string).length).toBe(50 * 1024)
    expect(node!.props.size).toBe(50 * 1024)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 8: 超大数量 props（100 个 key）的节点 ──
test('CC-08: 100 个 props 的节点', async () => {
  const cfg = makeConfig('many-props')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const bigProps: NodeProperties = {}
    for (let i = 0; i < 100; i++) {
      bigProps[`key_${i}`] = `value_${i}`
    }

    const id = await engine.upsertNode(1, 'many-props-node', { props: bigProps })
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect(Object.keys(node!.props).length).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(node!.props[`key_${i}`]).toBe(`value_${i}`)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 9: 空 props 节点创建 ──
test('CC-09: 空 props 节点', async () => {
  const cfg = makeConfig('empty-props')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const id = await engine.upsertNode(1, 'no-props')
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('no-props')
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 10: 空对象 props ──
test('CC-10: 空对象 {} props', async () => {
  const cfg = makeConfig('empty-obj-props')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const id = await engine.upsertNode(1, 'empty-obj', { props: {} })
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('empty-obj')
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 11: 节点的 typeName 含特殊字符 ──
test('CC-11: 特殊字符 typeName', async () => {
  const cfg = makeConfig('special-chars')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const specialNames = [
      'hello world',
      'test-123_foo',
      'user@domain.com',
      'a.b.c.d',
      '中文名称',
      '名前_にほんご',
      'emoji_🚀_test',
      'data+value',
      'path/to/node',
      '\t\n\r',
    ]

    for (const name of specialNames) {
      const id = await engine.upsertNode(1, name, {
        props: { originalName: name },
      })
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      // name 字段保留原始传入 name
      expect(node!.props.originalName).toBe(name)
    }

    // scan 所有节点验证个数
    expect(engine.scanAllNodes().length).toBe(specialNames.length)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 12: 长字符串 typeName ──
test('CC-12: 超长 typeName（500 字符）', async () => {
  const cfg = makeConfig('long-name')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const longName = 'n' + 'a'.repeat(499)
    const id = await engine.upsertNode(1, longName, {
      props: { length: longName.length },
    })
    const node = engine.getNode(id)
    expect(node).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 13: neighbors 查询不存在的节点 id ──
test('CC-13: neighbors 查询不存在的节点', async () => {
  const cfg = makeConfig('neighbors-nonexist')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 空引擎查不存在的 id
    const n = engine.neighbors(999999)
    expect(n).toBeDefined()
    expect(n.edges).toEqual([])
    expect(n.nodes).toEqual([])
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 14: 删除节点后重新创建同 id ──
test('CC-14: 删除后重新创建', async () => {
  const cfg = makeConfig('delete-recreate')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    const id = await engine.upsertNode(1, 'original', {
      props: { version: 1 },
    })
    expect(engine.getNode(id)).not.toBeNull()

    const deleted = await engine.deleteNode(id)
    expect(deleted).toBe(true)
    expect(engine.getNode(id)).toBeNull()

    // 重新创建 — upsertNode 用相同的 typeId 和 name
    // Note: 重新 upsert 后可能返回新的 id
    const newId = await engine.upsertNode(1, 'recreated', {
      props: { version: 2 },
    })
    const node = engine.getNode(newId)
    expect(node).not.toBeNull()
    expect(node!.props.version).toBe(2)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 15: 节点 id 为 0 或负数 ──
test('CC-15: typeId 为 0 或负值', async () => {
  const cfg = makeConfig('zero-negative-type')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // typeId=0
    const id0 = await engine.upsertNode(0, 'zero-type', { props: {} })
    expect(id0).toBeGreaterThan(0)
    expect(engine.getNode(id0)).not.toBeNull()

    // typeId 为负数 — 可能报错或允许，但不应崩溃
    try {
      const idNeg = await engine.upsertNode(-1, 'neg-type', { props: {} })
      // 如果成功，验证基本属性
      if (idNeg > 0) {
        expect(engine.getNode(idNeg)).not.toBeNull()
      }
    } catch {
      // 允许抛出异常
    }

    // engine 应仍可用
    const idOk = await engine.upsertNode(1, 'still-ok', { props: {} })
    expect(engine.getNode(idOk)).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 16: deleteNode 不存在的 id ──
test('CC-16: deleteNode 不存在的 id', async () => {
  const cfg = makeConfig('delete-nonexist')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // 删除不存在的节点不应报错
    const result = await engine.deleteNode(999999)
    expect(result).toBe(false)

    // 但 engine 应仍正常使用
    const id = await engine.upsertNode(1, 'survivor', { props: {} })
    expect(engine.getNode(id)).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 17: 非常规类型 name — nullish/falsy ──
test('CC-17: falsy typeName 值', async () => {
  const cfg = makeConfig('falsy-name')
  const engine = new GraphEngine(cfg)
  engine.open()

  try {
    // name=空字符串
    const id1 = await engine.upsertNode(1, '', { props: { note: 'empty' } })
    const node1 = engine.getNode(id1)
    expect(node1).not.toBeNull()

    // name='0'
    const id2 = await engine.upsertNode(1, '0', { props: { note: 'zero-str' } })
    const node2 = engine.getNode(id2)
    expect(node2).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 18: 并发 upsert 5 个 engine ──
test('CC-18: 5 engine 并发写入', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`c5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const results = await Promise.all(
      engines.map((e, idx) =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            e.upsertNode(1, `ce-${idx}-${i}`, { props: { e: idx, i } })
          )
        )
      )
    )
    for (let idx = 0; idx < 5; idx++) {
      expect(results[idx].length).toBe(10)
      expect(engines[idx].scanAllNodes().length).toBe(10)
    }
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 19: 并发 upsert edge 多对多 ──
test('CC-19: 5 engine 并发 upsertEdge', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`ce5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const nodeIds = await Promise.all(
      engines.map(e => Promise.all(
        Array.from({ length: 5 }, (_, i) => e.upsertNode(1, `n-${i}`, { props: { i } }))
      ))
    )
    await Promise.all(
      engines.map((e, ei) =>
        Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            e.upsertEdge(nodeIds[ei][i], nodeIds[ei][i + 1], 10, { props: {} })
          )
        )
      )
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(5)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 20: 并发读写混合 5 engine ──
test('CC-20: 5 engine 并发读写混合', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`rw5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const baseIds = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            e.upsertNode(1, `base-${i}`, { props: { i } })
          )
        )
      )
    )
    await Promise.all(
      engines.map((e, ei) => {
        const writes = Array.from({ length: 5 }, (_, i) =>
          e.upsertNode(1, `rw-${ei}-${i}`, { props: { ei, i } })
        )
        const reads = baseIds[ei].map(id =>
          Promise.resolve().then(() => e.getNode(id))
        )
        return Promise.all([...writes, ...reads])
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(15)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 21: 5 engine 并发 delete+upsert ──
test('CC-21: 5 engine 并发 delete+upsert', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`du5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const ids = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            e.upsertNode(1, `du-${i}`, { props: { i } })
          )
        )
      )
    )
    await Promise.all(
      engines.map((e, ei) => {
        const dels = ids[ei].filter((_, i) => i < 10).map(id => e.deleteNode(id))
        const upserts = Array.from({ length: 10 }, (_, i) =>
          e.upsertNode(1, `new-du-${ei}-${i}`, { props: { ei, i } })
        )
        return Promise.all([...dels, ...upserts])
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(20)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 22: 5 engine 并发 edge+deleteNode ──
test('CC-22: 5 engine 并发 edge+deleteNode', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`ed5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const ids = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            e.upsertNode(1, `nn-${i}`, { props: { i } })
          )
        )
      )
    )
    await Promise.all(
      engines.map((e, ei) => {
        const edges = Array.from({ length: 5 }, (_, i) =>
          e.upsertEdge(ids[ei][i], ids[ei][i + 1], 10, { props: {} })
        )
        const dels = Array.from({ length: 3 }, (_, i) =>
          e.deleteNode(ids[ei][i])
        )
        return Promise.all([...edges, ...dels])
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(7)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 23: 并发 getNode 无 race ──
test('CC-23: 并发 getNode 无 race', async () => {
  const cfg = makeConfig('c-getnode')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `cgn-${i}`, { props: { i } })
      )
    )
    const reads = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => engine.getNode(ids[i]))
    )
    const results = await Promise.all(reads)
    for (const r of results) {
      expect(r).not.toBeNull()
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 24: 并发 neighbors 无 race ──
test('CC-24: 并发 neighbors 无 race', async () => {
  const cfg = makeConfig('c-neighbors')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'center-cn', { props: {} })
    const leaves = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        engine.upsertNode(1, `leaf-cn-${i}`, { props: { i } })
      )
    )
    await Promise.all(
      leaves.map(l => engine.upsertEdge(center, l, 10, { props: {} }))
    )
    const reads = Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => engine.neighbors(center))
    )
    const results = await Promise.all(reads)
    for (const r of results) {
      expect(r.edges.length).toBe(30)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 25: 并发 scanAllNodes 无异常 ──
test('CC-25: 并发 scanAllNodes 无异常', async () => {
  const cfg = makeConfig('c-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `cs-${i}`, { props: { i } })
      )
    )
    const scans = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => engine.scanAllNodes().length)
    )
    const results = await Promise.all(scans)
    for (const len of results) {
      expect(len).toBe(50)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 26: 并发 deleteEdge 无 race ──
test('CC-26: 并发 deleteEdge 无 race', async () => {
  const cfg = makeConfig('c-del-edge')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const src = await engine.upsertNode(1, 'src-cde', { props: {} })
    const dsts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `dst-cde-${i}`, { props: {} })
      )
    )
    await Promise.all(
      dsts.map(d => engine.upsertEdge(src, d, 10, { props: {} }))
    )
    await Promise.all(
      dsts.map(d => engine.deleteEdge(src, d, 10))
    )
    expect(engine.neighbors(src).edges.length).toBe(0)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 27: 并发同 typeId+name upsert 最终一致 ──
test('CC-27: 并发同 typeId+name upsert 最终一致', async () => {
  const cfg = makeConfig('c-same-upsert')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, 'shared-name', { props: { version: i } })
      )
    )
    expect(engine.scanAllNodes().length).toBe(1)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 28: 并发不同 typeId upsert ──
test('CC-28: 并发不同 typeId upsert', async () => {
  const cfg = makeConfig('c-diff-type')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        engine.upsertNode(i, `diff-type-${i}`, { props: { typeId: i } })
      )
    )
    expect(ids.length).toBe(10)
    expect(engine.scanAllNodes().length).toBe(10)
    for (let i = 0; i < 10; i++) {
      const node = engine.getNode(ids[i])
      expect(node).not.toBeNull()
      expect(node!.props.typeId).toBe(i)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 29: 5 engine 并发 neighbors ──
test('CC-29: 5 engine 并发 neighbors', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`cn5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const centers = await Promise.all(
      engines.map(e => e.upsertNode(1, 'center', { props: {} }))
    )
    for (let ei = 0; ei < 5; ei++) {
      const leaves = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          engines[ei].upsertNode(1, `l-${ei}-${i}`, { props: {} })
        )
      )
      await Promise.all(
        leaves.map(l => engines[ei].upsertEdge(centers[ei], l, 10, { props: {} }))
      )
    }
    const results = await Promise.all(
      engines.map((e, ei) =>
        Promise.resolve().then(() => e.neighbors(centers[ei]).edges.length)
      )
    )
    for (const len of results) expect(len).toBe(10)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 30: 5 engine 并发 read+write edge ──
test('CC-30: 5 engine 并发 read+write edge', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`rwe5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const allIds = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            e.upsertNode(1, `rwe-${i}`, { props: { i } })
          )
        )
      )
    )
    await Promise.all(
      engines.map((e, ei) => {
        const edges = Array.from({ length: 4 }, (_, i) =>
          e.upsertEdge(allIds[ei][i], allIds[ei][i + 1], 10, { props: {} })
        )
        const reads = allIds[ei].map(id =>
          Promise.resolve().then(() => e.getNode(id))
        )
        return Promise.all([...edges, ...reads])
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(5)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 31: 并发 getNode + deleteNode 混合 ──
test('CC-31: 并发 getNode + deleteNode 混合', async () => {
  const cfg = makeConfig('get-del-mix')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        engine.upsertNode(1, `gd-${i}`, { props: { i } })
      )
    )
    const half = ids.slice(0, 15)
    const keep = ids.slice(15)
    const ops = [
      ...half.map(id => engine.deleteNode(id)),
      ...keep.map(id => Promise.resolve().then(() => engine.getNode(id))),
    ]
    await Promise.all(ops)
    expect(engine.scanAllNodes().length).toBe(15)
    for (const id of keep) expect(engine.getNode(id)).not.toBeNull()
    for (const id of half) expect(engine.getNode(id)).toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 32: 5 engine delete 后 reopen ──
test('CC-32: 5 engine delete 后 reopen', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`del5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  let allKeepIds: number[][] = []
  let allDelIds: number[][] = []
  try {
    const results = await Promise.all(
      engines.map(async (e) => {
        const ids = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            e.upsertNode(1, `n-${i}`, { props: { i } })
          )
        )
        const delIds = ids.slice(0, 5)
        const keepIds = ids.slice(5)
        await Promise.all(delIds.map(id => e.deleteNode(id)))
        return { keepIds, delIds }
      })
    )
    allKeepIds = results.map(r => r.keepIds)
    allDelIds = results.map(r => r.delIds)
  } finally {
    for (const e of engines) e.close()
  }
  const reEngines = configs.map(c => new GraphEngine(c))
  for (const e of reEngines) e.open()
  try {
    for (let ei = 0; ei < 5; ei++) {
      for (const id of allKeepIds[ei]) expect(reEngines[ei].getNode(id)).not.toBeNull()
      for (const id of allDelIds[ei]) expect(reEngines[ei].getNode(id)).toBeNull()
    }
  } finally {
    for (const e of reEngines) e.close()
  }
}, 60000)

// ── Test 33: 5 engine 并发 upsert 100 节点 ──
test('CC-33: 5 engine 并发 100 节点', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`cu100-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const results = await Promise.all(
      engines.map((e, ei) =>
        Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            e.upsertNode(1, `u-${ei}-${i}`, { props: { ei, i } })
          )
        )
      )
    )
    for (let ei = 0; ei < 5; ei++) {
      expect(results[ei].length).toBe(100)
      expect(engines[ei].scanAllNodes().length).toBe(100)
    }
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 34: 并发 upsertEdge + scanAllNodes ──
test('CC-34: 并发 upsertEdge + scanAllNodes', async () => {
  const cfg = makeConfig('c-edge-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        engine.upsertNode(1, `es-${i}`, { props: { i } })
      )
    )
    const edgeOps = Array.from({ length: 10 }, (_, i) =>
      engine.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
    )
    const scanOps = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => engine.scanAllNodes())
    )
    await Promise.all([...edgeOps, ...scanOps])
    expect(engine.scanAllNodes().length).toBe(30)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 35: 5 engine upsert+delete 混合 ──
test('CC-35: 5 engine upsert+delete 混合', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`udm5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const ids = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 30 }, (_, i) =>
            e.upsertNode(1, `n-${i}`, { props: { i } })
          )
        )
      )
    )
    for (let ei = 0; ei < 5; ei++) {
      const e = engines[ei]
      const half = ids[ei].slice(0, 15)
      const newOps = Array.from({ length: 15 }, (_, i) =>
        e.upsertNode(1, `new-${ei}-${i}`, { props: {} })
      )
      const delOps = half.map(id => e.deleteNode(id))
      await Promise.all([...newOps, ...delOps])
      expect(e.scanAllNodes().length).toBe(30)
    }
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 36: 5 engine 各 50 读写并发 ──
test('CC-36: 5 engine 各 50 读写并发', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`rw50-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const bases = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 25 }, (_, i) =>
            e.upsertNode(1, `b-${i}`, { props: { i } })
          )
        )
      )
    )
    await Promise.all(
      engines.map((e, ei) => {
        const writes = Array.from({ length: 25 }, (_, i) =>
          e.upsertNode(1, `w-${ei}-${i}`, { props: { ei, i } })
        )
        const reads = bases[ei].map(id =>
          Promise.resolve().then(() => e.getNode(id))
        )
        return Promise.all([...writes, ...reads])
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(50)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 37: 并发 upsertNode + neighbors ──
test('CC-37: 并发 upsertNode + neighbors', async () => {
  const cfg = makeConfig('c-upsert-neighbor')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'c-center', { props: {} })
    const leaves = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `cl-${i}`, { props: {} })
      )
    )
    const edgeOps = leaves.map(l =>
      engine.upsertEdge(center, l, 10, { props: {} })
    )
    await Promise.all(edgeOps)
    const nbOps = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => engine.neighbors(center))
    )
    const results = await Promise.all(nbOps)
    for (const r of results) expect(r.edges.length).toBe(20)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 38: 5 engine 各种 typeId upsert ──
test('CC-38: 5 engine 各种 typeId upsert', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`ct5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map((e, ei) =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            e.upsertNode(i, `t-${ei}-${i}`, { props: { typeId: i } })
          )
        )
      )
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(10)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 39: 并发 delete + neighbors ──
test('CC-39: 并发 delete + neighbors', async () => {
  const cfg = makeConfig('c-del-nb')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'cdn-center', { props: {} })
    const leaves = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `cdn-${i}`, { props: {} })
      )
    )
    await Promise.all(
      leaves.map(l => engine.upsertEdge(center, l, 10, { props: {} }))
    )
    const half = leaves.slice(0, 10)
    const ops = [
      ...half.map(id => engine.deleteNode(id)),
      Promise.resolve().then(() => engine.neighbors(center)),
    ]
    await Promise.all(ops)
    expect(engine.neighbors(center).edges.length).toBe(10)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 40: 并发 getNode 不存在节点 ──
test('CC-40: 并发 getNode 不存在节点', async () => {
  const cfg = makeConfig('c-get-nonexist')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ops = Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => engine.getNode(999999))
    )
    const results = await Promise.all(ops)
    for (const r of results) expect(r).toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 41: 并发 deleteNode 已删除节点 ──
test('CC-41: 并发 deleteNode 已删除', async () => {
  const cfg = makeConfig('c-del-deleted')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const id = await engine.upsertNode(1, 'cdd', { props: {} })
    await engine.deleteNode(id)
    const ops = Array.from({ length: 10 }, () => engine.deleteNode(id))
    const results = await Promise.all(ops)
    for (const r of results) expect(r).toBe(false)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 42: 并发 upsert 后 scanAllNodes 一致 ──
test('CC-42: 并发 upsert 后 scanAllNodes 一致', async () => {
  const cfg = makeConfig('c-upsert-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `cus-${i}`, { props: { i } })
      )
    )
    const scans = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => engine.scanAllNodes().length)
    )
    const lengths = await Promise.all(scans)
    for (const len of lengths) expect(len).toBe(50)
    for (const id of ids) expect(engine.getNode(id)).not.toBeNull()
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 43: 5 engine 各种 ops 混合 ──
test('CC-43: 5 engine 各种 ops 混合', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`all5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    for (let ei = 0; ei < 5; ei++) {
      const e = engines[ei]
      const ids = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          e.upsertNode(1, `a-${i}`, { props: { i } })
        )
      )
      await Promise.all([
        e.upsertEdge(ids[0], ids[1], 10, { props: {} }),
        e.upsertEdge(ids[2], ids[3], 10, { props: {} }),
        e.deleteNode(ids[4]),
        Promise.resolve().then(() => e.getNode(ids[0])),
        Promise.resolve().then(() => e.neighbors(ids[0])),
        e.upsertNode(1, 'new-node', { props: {} }),
      ])
    }
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 44: 5 engine 快速并发 upsert ──
test.skip('CC-44: 5 engine 快速并发 upsert', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`burst5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const promises: Promise<number>[] = []
    for (let ei = 0; ei < 5; ei++) {
      for (let i = 0; i < 10; i++) {
        promises.push(engines[ei].upsertNode(1, `b-${ei}-${i}`, { props: { ei, i } }))
      }
    }
    const ids = await Promise.all(promises)
    expect(ids.length).toBe(50)
    expect(new Set(ids).size).toBe(50)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 45: 5 engine deleteNode 不存在 id ──
test('CC-45: 5 engine deleteNode 不存在 id', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`del-ne5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map(e =>
        Promise.all(Array.from({ length: 10 }, () => e.deleteNode(999999)))
      )
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(0)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 46: 5 engine 空引擎 neighbors ──
test('CC-46: 5 engine 空引擎 neighbors', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`empty-nb-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const results = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 5 }, () =>
            Promise.resolve().then(() => e.neighbors(1))
          )
        )
      )
    )
    for (const res of results) {
      for (const r of res) expect(r.edges).toEqual([])
    }
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 47: 5 engine 并发 scanAllNodes ──
test('CC-47: 5 engine 并发 scanAllNodes', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`scan5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map((e, ei) =>
        Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            e.upsertNode(1, `s-${ei}-${i}`, { props: {} })
          )
        )
      )
    )
    const scans = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 5 }, () =>
            Promise.resolve().then(() => e.scanAllNodes().length)
          )
        )
      )
    )
    for (const scan of scans) {
      for (const len of scan) expect(len).toBe(20)
    }
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 48: 并发相同边 upsert ──
test.skip('CC-48: 并发相同边 upsert 不崩溃', async () => {
  const cfg = makeConfig('c-same-edge')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const src = await engine.upsertNode(1, 'src-se', { props: {} })
    const dst = await engine.upsertNode(1, 'dst-se', { props: {} })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertEdge(src, dst, 10, { props: { i } })
      )
    )
    const nb = engine.neighbors(src)
    expect(nb.edges.length).toBe(1)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 49: 5 engine 综合混合 ops ──
test('CC-49: 5 engine 综合混合 ops', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`final-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map(async (e) => {
        const ids = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            e.upsertNode(1, `f-${i}`, { props: { i } })
          )
        )
        await Promise.all([
          e.upsertEdge(ids[0], ids[1], 10, { props: {} }),
          e.upsertEdge(ids[2], ids[3], 10, { props: {} }),
          e.deleteNode(ids[4]),
          Promise.resolve().then(() => e.getNode(ids[0])),
          e.upsertNode(1, 'extra', { props: {} }),
        ])
      })
    )
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 50: 并发 100 getNode + scanAllNodes ──
test('CC-50: 并发 100 getNode + scanAllNodes', async () => {
  const cfg = makeConfig('c-100-get-scan')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        engine.upsertNode(1, `c100-${i}`, { props: { i } })
      )
    )
    const gets = ids.map(id =>
      Promise.resolve().then(() => engine.getNode(id))
    )
    const scans = Array.from({ length: 5 }, () =>
      Promise.resolve().then(() => engine.scanAllNodes().length)
    )
    const results = await Promise.all([...gets, ...scans])
    const getsResult = results.slice(0, 100)
    for (const r of getsResult) expect(r).not.toBeNull()
    const scanResults = results.slice(100) as number[]
    for (const len of scanResults) expect(len).toBe(100)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 51: 5 engine 各 5 节点 5 边 ──
test('CC-51: 5 engine 各 5 节点 5 边', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`s55-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    await Promise.all(
      engines.map(async (e) => {
        const ids = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            e.upsertNode(1, `n-${i}`, { props: { i } })
          )
        )
        await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            e.upsertEdge(ids[i], ids[i + 1], 10, { props: {} })
          )
        )
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(5)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 52: 并发 upsertNode 与 neighbors ──
test('CC-52: 并发 upsertNode + neighbors', async () => {
  const cfg = makeConfig('c-un-neighbors')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'center-un', { props: {} })
    const leaves = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `l-un-${i}`, { props: { i } })
      )
    )
    const writes = leaves.map(l =>
      engine.upsertEdge(center, l, 10, { props: {} })
    )
    const reads = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => engine.neighbors(center))
    )
    const all = await Promise.all([...writes, ...reads])
    const nbResults = all.slice(20) as { edges: { dst: number }[] }[]
    for (const nb of nbResults) expect(nb.edges.length).toBe(20)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 53: 并发 deleteNode + upsertNode 交替 ──
test('CC-53: 并发 deleteNode + upsertNode 交替', async () => {
  const cfg = makeConfig('c-del-upsert-alt')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `d-${i}`, { props: { i } })
      )
    )
    const half = ids.slice(0, 10)
    const dels = half.map(id => engine.deleteNode(id))
    const ups = Array.from({ length: 10 }, (_, i) =>
      engine.upsertNode(1, `u-${i}`, { props: { i } })
    )
    const all = await Promise.all([...dels, ...ups])
    expect(engine.scanAllNodes().length).toBe(20)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 54: 并发 upsertEdge 不同节点对 ──
test('CC-54: 并发不同节点对 upsertEdge', async () => {
  const cfg = makeConfig('c-edge-pairs')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        engine.upsertNode(1, `ep-${i}`, { props: { i } })
      )
    )
    const edges = Array.from({ length: 9 }, (_, i) =>
      engine.upsertEdge(ids[i], ids[i + 1], 10, { props: { seq: i } })
    )
    await Promise.all(edges)
    for (let i = 0; i < 9; i++) {
      const nb = engine.neighbors(ids[i])
      expect(nb.edges.length).toBe(1)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 55: 并发 scanAllNodes 后 getNode ──
test('CC-55: 并发 scanAllNodes 后 getNode', async () => {
  const cfg = makeConfig('c-scan-then-get')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.upsertNode(1, `stg-${i}`, { props: { i } })
      )
    )
    const mixed = await Promise.all([
      ...ids.map(id => Promise.resolve().then(() => engine.getNode(id))),
      ...Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => engine.scanAllNodes().length)
      ),
    ] as const)
    const gets = mixed.slice(0, 50)
    for (const g of gets) expect(g).not.toBeNull()
    const lens = mixed.slice(50) as number[]
    for (const l of lens) expect(l).toBe(50)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 56: 5 engine 并发 edge + scan ──
test('CC-56: 5 engine 并发 edge + scan', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`ces5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const allIds = await Promise.all(
      engines.map(e =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            e.upsertNode(1, `m-${i}`, { props: { i } })
          )
        )
      )
    )
    await Promise.all(
      engines.map((e, ei) => {
        const edges = Array.from({ length: 9 }, (_, i) =>
          e.upsertEdge(allIds[ei][i], allIds[ei][i + 1], 10, { props: {} })
        )
        const scans = Array.from({ length: 3 }, () =>
          Promise.resolve().then(() => e.scanAllNodes().length)
        )
        return Promise.all([...edges, ...scans])
      })
    )
    for (const e of engines) expect(e.scanAllNodes().length).toBe(10)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 57: 并发 neighbors 后 deleteNode ──
test('CC-57: 并发 neighbors 后 deleteNode', async () => {
  const cfg = makeConfig('c-nb-then-del')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const center = await engine.upsertNode(1, 'cnt', { props: {} })
    const leaves = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        engine.upsertNode(1, `lf-${i}`, { props: {} })
      )
    )
    await Promise.all(
      leaves.map(l => engine.upsertEdge(center, l, 10, { props: {} }))
    )
    const nbs = Array.from({ length: 5 }, () =>
      Promise.resolve().then(() => engine.neighbors(center))
    )
    await Promise.all([...nbs, engine.deleteNode(center)])
    // center 被删后 neighbors 应空
    const nb = engine.neighbors(center)
    expect(nb.edges.length).toBe(0)
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 58: 并发 upsertNode 不同 typeId ──
test('CC-58: 并发不同 typeId upsert', async () => {
  const cfg = makeConfig('c-diff-type-upsert')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        engine.upsertNode(i % 3, `dt-${i}`, { props: { tid: i % 3 } })
      )
    )
    expect(ids.length).toBe(10)
    const all = engine.scanAllNodes()
    expect(all.length).toBe(10)
    for (const n of all) {
      expect(n.props.tid).toBe(n.type)
    }
  } finally {
    engine.close()
  }
}, 60000)

// ── Test 59: 5 engine 全部 upsert 后 neighbors ──
test('CC-59: 5 engine upsert 后 neighbors', async () => {
  const configs = Array.from({ length: 5 }, (_, i) => makeConfig(`unn5-e${i}`))
  const engines = configs.map(c => new GraphEngine(c))
  for (const e of engines) e.open()
  try {
    const centers = await Promise.all(
      engines.map(e => e.upsertNode(1, 'c', { props: {} }))
    )
    for (let ei = 0; ei < 5; ei++) {
      const leaves = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          engines[ei].upsertNode(1, `l-${i}`, { props: {} })
        )
      )
      await Promise.all(
        leaves.map(l => engines[ei].upsertEdge(centers[ei], l, 10, { props: {} }))
      )
    }
    const results = await Promise.all(
      engines.map((e, ei) =>
        Promise.resolve().then(() => e.neighbors(centers[ei]))
      )
    )
    for (const r of results) expect(r.edges.length).toBe(8)
  } finally {
    for (const e of engines) e.close()
  }
}, 60000)

// ── Test 60: 最终综合并发验证 ──
test('CC-60: 最终综合并发验证', async () => {
  const cfg = makeConfig('final-concurrent')
  const engine = new GraphEngine(cfg)
  engine.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.upsertNode(1, `fc-${i}`, { props: { i } })
      )
    )
    const ops = [
      ...Array.from({ length: 10 }, (_, i) =>
        engine.upsertEdge(ids[i], ids[(i + 1) % 20], 10, { props: {} })
      ),
      ...ids.map(id => Promise.resolve().then(() => engine.getNode(id))),
      engine.upsertNode(1, 'extra', { props: {} }),
      ...Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => engine.scanAllNodes())
      ),
    ]
    await Promise.all(ops)
    expect(engine.scanAllNodes().length).toBe(21)
  } finally {
    engine.close()
  }
}, 60000)
