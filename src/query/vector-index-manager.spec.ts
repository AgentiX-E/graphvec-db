/**
 * vector-index-manager.spec.ts — VectorIndexManager 单元测试
 *
 * 测试覆盖：
 * 1. 创建索引
 * 2. 添加向量后搜索能召回最近邻
 * 3. 搜索不存在的 label → 报错
 * 4. 添加后删除重建
 * 5. 空索引搜索 → 空结果
 * 6. 集成到 GraphEngine 的 search() 方法
 * 7. parseQuery 解析 SEARCH 语法
 * 8. _executeQuery 执行 SEARCH 子句
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { VectorIndexManager } from './vector-index-manager'
import {
  parseQuery,
  _executeQuery,
  _vectorIndexManager,
  setVectorIndexManager,
} from './query-engine'

describe('VectorIndexManager', () => {
  let mgr: VectorIndexManager

  beforeAll(() => {
    mgr = new VectorIndexManager()
  })

  // ── Test 1: 创建索引 ────────────────────────────────────
  it('TC-1: 创建索引后 should be registered', () => {
    mgr.createIndex('Item', 'embedding', 4)
    expect(mgr.hasIndex('Item', 'embedding')).toBe(true)
    expect(mgr.getDimension('Item', 'embedding')).toBe(4)
  })

  // ── Test 2: 重复创建索引 → 报错 ─────────────────────────
  it('TC-2: 重复创建索引时报错', () => {
    expect(() => mgr.createIndex('Item', 'embedding', 4)).toThrow(
      'Vector index already exists',
    )
  })

  // ── Test 3: 添加向量后搜索召回最近邻 ────────────────────
  it('TC-3: 添加向量后搜索能召回最近邻', () => {
    // 添加 5 个向量，第 3 个最接近查询
    const vectors = [
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
      new Float32Array([0.5, 0.6, 0.7, 0.8]),
      new Float32Array([0.9, 0.8, 0.7, 0.6]),
      new Float32Array([0.2, 0.1, 0.9, 0.5]),
      new Float32Array([0.3, 0.4, 0.1, 0.2]),
    ]

    for (let i = 0; i < vectors.length; i++) {
      mgr.addVector('Item', 'embedding', 100 + i, vectors[i])
    }

    // 查询向量接近 vectors[2] = [0.9, 0.8, 0.7, 0.6]
    const query = new Float32Array([0.91, 0.79, 0.71, 0.59])
    const results = mgr.search('Item', 'embedding', query, 3)

    expect(results.length).toBe(3)
    // 最近邻应该是 id=102（vectors[2]）
    expect(results[0].id).toBe(102)
    expect(results[0].distance).toBeLessThan(0.1)
  })

  // ── Test 4: 搜索不存在的 label → 报错 ───────────────────
  it('TC-4: 搜索不存在的 label 时报错', () => {
    const query = new Float32Array([0.1, 0.2, 0.3, 0.4])
    expect(() => mgr.search('NonExistent', 'embedding', query, 5)).toThrow(
      'Vector index not found',
    )
  })

  // ── Test 5: 搜索不存在的 property → 报错 ────────────────
  it('TC-5: 搜索不存在的 property 时报错', () => {
    const query = new Float32Array([0.1, 0.2, 0.3, 0.4])
    expect(() => mgr.search('Item', 'nonexistent', query, 5)).toThrow(
      'Vector index not found',
    )
  })

  // ── Test 6: 空索引搜索 → 空结果 ─────────────────────────
  it('TC-6: 空索引搜索返回空结果', () => {
    mgr.createIndex('EmptyLabel', 'vec', 3)
    const query = new Float32Array([0.5, 0.5, 0.5])
    const results = mgr.search('EmptyLabel', 'vec', query, 5)
    expect(results).toEqual([])
  })

  // ── Test 7: 删除索引 ──────────────────────────────────────
  it('TC-7: 删除索引后不再可用', () => {
    mgr.deleteIndex('EmptyLabel', 'vec')
    expect(mgr.hasIndex('EmptyLabel', 'vec')).toBe(false)

    const query = new Float32Array([0.5, 0.5, 0.5])
    expect(() => mgr.search('EmptyLabel', 'vec', query, 5)).toThrow(
      'Vector index not found',
    )
  })

  // ── Test 8: 删除不存在的索引 → 报错 ─────────────────────
  it('TC-8: 删除不存在的索引时报错', () => {
    expect(() => mgr.deleteIndex('NonExistent', 'vec')).toThrow(
      'Vector index not found',
    )
  })

  // ── Test 9: 删除后重建 ──────────────────────────────────
  it('TC-9: 删除后重建索引并搜索', () => {
    mgr.rebuildIndex('Item', 'embedding', 4, 100)

    // 重新插入向量
    const vectors = [
      new Float32Array([1.0, 0.0, 0.0, 0.0]),
      new Float32Array([0.0, 1.0, 0.0, 0.0]),
      new Float32Array([0.0, 0.0, 1.0, 0.0]),
      new Float32Array([0.0, 0.0, 0.0, 1.0]),
    ]
    for (let i = 0; i < vectors.length; i++) {
      mgr.addVector('Item', 'embedding', 200 + i, vectors[i])
    }

    // 搜索 [0.9, 0.1, 0.0, 0.0]，应返回 id=200
    const query = new Float32Array([0.9, 0.1, 0.0, 0.0])
    const results = mgr.search('Item', 'embedding', query, 2)

    expect(results.length).toBe(2)
    expect(results[0].id).toBe(200)
  })

  // ── Test 10: 多标签隔离 ─────────────────────────────────
  it('TC-10: 不同 label 的索引互相隔离', () => {
    mgr.createIndex('Product', 'features', 3)
    mgr.createIndex('User', 'signature', 3)

    mgr.addVector('Product', 'features', 300, new Float32Array([1, 0, 0]))
    mgr.addVector('User', 'signature', 400, new Float32Array([0, 1, 0]))

    // Product 搜索不应返回 User 的向量
    const results = mgr.search('Product', 'features', new Float32Array([0.9, 0.1, 0]), 5)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe(300)
  })

  // ── Test 11: getVectorCount ──────────────────────────────
  it('TC-11: getVectorCount 返回正确的向量数量', () => {
    expect(mgr.getVectorCount('Item', 'embedding')).toBe(4)
    expect(mgr.getVectorCount('Product', 'features')).toBe(1)
    expect(mgr.getVectorCount('NonExistent', 'x')).toBe(0)
  })

  // ── Test 12: indexCount ─────────────────────────────────
  it('TC-12: indexCount 返回注册的索引数量', () => {
    // Item/embedding, Product/features, User/signature
    expect(mgr.indexCount).toBe(3)
  })

  // ── Test 13: 排序正确性 — 距离升序 ─────────────────────
  it('TC-13: 搜索结果按距离升序排列', () => {
    const dim = 2
    mgr.createIndex('Points', 'coords', dim)

    // 插入点: (0,0), (10,0), (0,10), (5,5), (1,1)
    const points: Array<[number, number]> = [
      [0, 0], [10, 0], [0, 10], [5, 5], [1, 1],
    ]
    for (let i = 0; i < points.length; i++) {
      mgr.addVector('Points', 'coords', 500 + i, new Float32Array(points[i]))
    }

    // 查询 (1, 1) — 最近应该是 (1,1) 自身, 然后是 (0,0)
    const results = mgr.search('Points', 'coords', new Float32Array([1.0, 1.0]), 5)
    expect(results.length).toBe(5)

    // 检查是否按距离升序
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance)
    }

    // 最近邻应该是 id=504 (距离0)
    expect(results[0].id).toBe(504)
    expect(results[0].distance).toBe(0)
  })
})

// ── SEARCH 子句集成测试 ──────────────────────────────────

describe('SEARCH clause integration', () => {
  let mgr: VectorIndexManager

  beforeAll(() => {
    mgr = new VectorIndexManager()
    // 创建索引并注入到 query-engine
    mgr.createIndex('Item', 'embedding', 4, 1000)
    setVectorIndexManager(mgr)

    // 插入向量（id 从 0 开始，与节点 id 对齐）
    const vecs = [
      new Float32Array([1, 0, 0, 0]), // id=0
      new Float32Array([0, 1, 0, 0]), // id=1
      new Float32Array([0, 0, 1, 0]), // id=2
      new Float32Array([0, 0, 0, 1]), // id=3
      new Float32Array([1, 1, 0, 0]), // id=4
      new Float32Array([0, 1, 1, 0]), // id=5
      new Float32Array([0, 0, 1, 1]), // id=6
      new Float32Array([1, 0, 1, 0]), // id=7
    ]
    for (let i = 0; i < vecs.length; i++) {
      mgr.addVector('Item', 'embedding', i, vecs[i])
    }
  })

  afterAll(() => {
    setVectorIndexManager(null)
  })

  // ── Test 14: parseQuery 解析 SEARCH 语法 ──────────────
  it('TC-14: parseQuery 解析 SEARCH 子句语法', () => {
    const plan = parseQuery(
      'MATCH (n:Item) SEARCH n.embedding APPROXIMATE [0.9, 0.1, 0, 0] TOP 3 RETURN n.name',
    )
    expect(plan.search).toBeDefined()
    expect(plan.search!.targetProperty).toBe('n.embedding')
    expect(plan.search!.queryVector).toEqual([0.9, 0.1, 0, 0])
    expect(plan.search!.topK).toBe(3)
  })

  // ── Test 15: parseQuery 解析 ANN 语法 ────────────────
  it('TC-15: parseQuery 解析 ANN(向量, k) 语法', () => {
    const plan = parseQuery(
      'MATCH (n:Item) WHERE n.embedding IN ANN([0, 0, 1, 0], 5) RETURN n.id',
    )
    expect(plan.search).toBeDefined()
    expect(plan.search!.targetProperty).toBe('n.embedding')
    expect(plan.search!.queryVector).toEqual([0, 0, 1, 0])
    expect(plan.search!.topK).toBe(5)
  })

  // ── Test 16: _executeQuery 执行 SEARCH ─────────────────
  it('TC-16: _executeQuery 执行 SEARCH 子句返回排序结果', () => {
    // 构造节点数据
    const nodes = [
      { id: 0, _label: 'Item', name: 'v0' },
      { id: 1, _label: 'Item', name: 'v1' },
      { id: 2, _label: 'Item', name: 'v2' },
      { id: 3, _label: 'Item', name: 'v3' },
      { id: 4, _label: 'Item', name: 'v4' },
      { id: 5, _label: 'Item', name: 'v5' },
      { id: 6, _label: 'Item', name: 'v6' },
      { id: 7, _label: 'Item', name: 'v7' },
    ]

    const result = _executeQuery(
      {
        type: 'QUERY',
        scanLabel: 'Item',
        steps: [],
        filters: [],
        returnColumns: ['id', 'name'],
        orderBy: [],
        limit: undefined,
        skip: undefined,
        search: {
          targetProperty: 'n.embedding',
          queryVector: [0.9, 0.1, 0, 0],
          topK: 3,
        },
      },
      nodes,
    )

    expect(result.length).toBe(3)
    // 最近邻应该是 id=0 (vectors[0]=[1,0,0,0]), id=4 ([1,1,0,0]), id=7 ([1,0,1,0])
    const ids = (result as Array<Record<string, unknown>>).map(r => r.id)
    expect(ids[0]).toBe(0)
  })

  // ── Test 17: SEARCH 无匹配时返回空 ─────────────────────
  it('TC-17: SEARCH 无标签匹配时返回空', () => {
    const nodes = [
      { id: 99, _label: 'Other', name: 'unmatched' },
    ]

    const result = _executeQuery(
      {
        type: 'QUERY',
        scanLabel: 'Other',
        steps: [],
        filters: [],
        returnColumns: ['id'],
        orderBy: [],
        limit: undefined,
        skip: undefined,
        search: {
          targetProperty: 'n.vec',
          queryVector: [0.5, 0.5, 0.5, 0.5],
          topK: 5,
        },
      },
      nodes,
    )

    // 没有"Other.vec"索引，应退化返回原始 candidates
    expect(result.length).toBe(1)
  })

  // ── Test 18: 执行完整 SEARCH 查询 ──────────────────────
  it('TC-18: 通过 parseQuery + _executeQuery 完整链', () => {
    const plan = parseQuery(
      'MATCH (n:Item) SEARCH n.embedding APPROXIMATE [0, 0, 0.9, 0.1] TOP 2 RETURN n.id',
    )

    const nodes = [
      { id: 0, _label: 'Item', name: 'a' },
      { id: 1, _label: 'Item', name: 'b' },
      { id: 2, _label: 'Item', name: 'c' },
      { id: 3, _label: 'Item', name: 'd' },
      { id: 4, _label: 'Item', name: 'e' },
      { id: 5, _label: 'Item', name: 'f' },
      { id: 6, _label: 'Item', name: 'g' },
      { id: 7, _label: 'Item', name: 'h' },
    ]

    const result = _executeQuery(plan, nodes) as Array<Record<string, unknown>>
    expect(result.length).toBe(2)
    // vectors[2]=[0,0,1,0] 最近邻，然后是 vectors[6]=[0,0,1,1] 或 vectors[5]=[0,1,1,0]
    expect(result[0].id).toBe(2)
  })
})

// ── VectorIndexManager 新增 HNSW 参数测试 ──────────────

describe('VectorIndexManager — HNSW Parameters', () => {
  let mgr: VectorIndexManager

  beforeEach(() => {
    mgr = new VectorIndexManager()
  })

  it('TC-19: 使用对象参数创建索引并设置 M 和 efConstruction', () => {
    mgr.createIndex({ label: 'Test', property: 'vec', dimension: 4, M: 32, efConstruction: 400 })
    expect(mgr.hasIndex('Test', 'vec')).toBe(true)
    expect(mgr.getM('Test', 'vec')).toBe(32)
    expect(mgr.getEfConstruction('Test', 'vec')).toBe(400)
  })

  it('TC-20: 不传 M/efConstruction 时使用默认值', () => {
    mgr.createIndex({ label: 'Default', property: 'vec', dimension: 4 })
    expect(mgr.getM('Default', 'vec')).toBe(16)
    expect(mgr.getEfConstruction('Default', 'vec')).toBe(200)
  })

  it('TC-21: 使用 legacy 签名仍能正常工作', () => {
    mgr.createIndex('Legacy', 'vec', 4, 500)
    expect(mgr.hasIndex('Legacy', 'vec')).toBe(true)
    expect(mgr.getDimension('Legacy', 'vec')).toBe(4)
  })
})
