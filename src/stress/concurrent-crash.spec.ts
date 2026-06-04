/**
 * concurrent-crash.spec.ts — 并发与异常压力测试
 *
 * 覆盖：
 * - 并发写入 100 节点无 race
 * - 并发 upsertEdge 无 race
 * - 并发读写混合（50 readers + 50 writers）
 * - 大量并发 delete 操作
 * - 边创建时节点不存在的错误处理
 * - 同 id 并发 upsert 与读取
 * - 超大属性值（50KB string）写入
 * - 超大数量 props（100 个 key）的节点
 */
import { test, expect } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
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

// ── Test 5: 边创建时节点不存在（错误处理） ──
test('CC-05: 边指向不存在节点的错误处理', async () => {
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
    const bigProps: Record<string, unknown> = {}
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
    // 注意：重新 upsert 后可能返回新的 id
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
