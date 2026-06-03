/**
 * aggregate-functions.spec.ts — COLLECT, 数学聚合、路径函数测试
 *
 * 测试目标：
 * - COLLECT 基本聚合
 * - COLLECT DISTINCT
 * - WITH + 聚合组合
 * - COUNT(*) / COUNT(DISTINCT ...)
 * - MIN/MAX/AVG/SUM 基本路径
 * - 空结果聚合返回默认值
 * - 路径函数：length / nodes / relationships / startNode / endNode
 */

import { _executeQuery, _parseAggregate, _parseColumnsWithAggregates, aggregateRecords, executeBuiltinFunction } from './query-engine'

// ═══════════════════════════════════════════════════════════
// 测试数据（with _path metadata for path function tests）
// ═══════════════════════════════════════════════════════════

const testNodes = [
  { id: 1, name: 'Alice', age: 30, city: 'NYC', score: 85 },
  { id: 2, name: 'Bob', age: 25, city: 'SF', score: 92 },
  { id: 3, name: 'Carol', age: 35, city: 'NYC', score: 78 },
  { id: 4, name: 'Dave', age: 28, city: 'LA', score: 95 },
  { id: 5, name: 'Eve', age: 40, city: 'SF', score: 88 },
]

describe('COLLECT 聚合', () => {

  test('COLLECT(n.name) — 收集非 null 列值为数组', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['names'],
      aggregate: { type: 'collect' as const, field: 'name', alias: 'names' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(Array.isArray(result[0].names)).toBe(true)
    expect(result[0].names).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve'])
  })

  test('COLLECT(n.city) — 收集城市名', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['cities'],
      aggregate: { type: 'collect' as const, field: 'city', alias: 'cities' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(Array.isArray(result[0].cities)).toBe(true)
    expect(result[0].cities).toEqual(['NYC', 'SF', 'NYC', 'LA', 'SF'])
  })

  test('COLLECT(DISTINCT n.city) — 去重收集', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['cities'],
      aggregate: { type: 'collect' as const, field: 'city', alias: 'cities', distinct: true },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(Array.isArray(result[0].cities)).toBe(true)
    // Should have 3 unique cities
    const cities = [...result[0].cities].sort()
    expect(cities).toEqual(['LA', 'NYC', 'SF'])
  })

  test('COLLECT — 空结果返回空数组', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [{ property: 'age', operator: 'GT' as const, value: 200 }],
      returnColumns: ['names'],
      aggregate: { type: 'collect' as const, field: 'name', alias: 'names' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(Array.isArray(result[0].names)).toBe(true)
    expect(result[0].names).toEqual([])
  })

  test('WITH + COLLECT 组合 — _parseAggregate handles collect in WITH context', () => {
    const result = _parseAggregate('collect(n.name)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COLLECT')
    expect(result!.field).toBe('n.name')
    expect(result!.alias).toBeNull()
  })
})

describe('COUNT(*) 和 COUNT(DISTINCT ...)', () => {

  test('COUNT(*) — 返回全部行数', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['cnt'],
      aggregate: { type: 'count' as const, field: '*', alias: 'cnt' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(5)
  })

  test('COUNT(DISTINCT n.city) — 去重计数', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['cnt'],
      aggregate: { type: 'count' as const, field: 'DISTINCT city', alias: 'cnt', distinct: true },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(3) // 3 unique cities: NYC, SF, LA
  })
})

describe('MIN/MAX/AVG/SUM 基本路径', () => {

  test('MIN(n.age) — 最小值', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['minAge'],
      aggregate: { type: 'min' as const, field: 'age', alias: 'minAge' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].minAge).toBe(25)
  })

  test('MAX(n.age) — 最大值', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['maxAge'],
      aggregate: { type: 'max' as const, field: 'age', alias: 'maxAge' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].maxAge).toBe(40)
  })

  test('AVG(n.age) — 平均值', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['avgAge'],
      aggregate: { type: 'avg' as const, field: 'age', alias: 'avgAge' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].avgAge).toBeCloseTo(31.6, 1) // (30+25+35+28+40)/5 = 31.6
  })

  test('SUM(n.age) — 求和', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['sumAge'],
      aggregate: { type: 'sum' as const, field: 'age', alias: 'sumAge' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].sumAge).toBe(158) // 30+25+35+28+40 = 158
  })
})

describe('空结果聚合返回默认值', () => {

  test('空结果 COUNT(*) 返回 0', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [{ property: 'age', operator: 'GT' as const, value: 200 }],
      returnColumns: ['cnt'],
      aggregate: { type: 'count' as const, field: '*', alias: 'cnt' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(0)
  })

  test('空结果 SUM 返回 0', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [{ property: 'age', operator: 'GT' as const, value: 200 }],
      returnColumns: ['sumAge'],
      aggregate: { type: 'sum' as const, field: 'age', alias: 'sumAge' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].sumAge).toBe(0)
  })

  test('空结果 AVG 返回 null', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [{ property: 'age', operator: 'GT' as const, value: 200 }],
      returnColumns: ['avgAge'],
      aggregate: { type: 'avg' as const, field: 'age', alias: 'avgAge' },
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(result[0].avgAge).toBeNull()
  })
})

describe('路径函数', () => {

  test('length(path) — 路径长度使用 _pathLength 元数据', () => {
    // Simulate a path with metadata
    const pathNodes = [
      { id: 1, name: 'Alice', _pathLength: 2, _pathEdges: [{}, {}], _pathNodes: [] as any[] },
    ]
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      returnColumns: ['path'],
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, pathNodes as any)
    // The built-in length function should read _pathLength from the path object
    // This is tested via executeBuiltinFunction, not _executeQuery
    // _executeQuery returns the raw node, so we need to evaluate length differently
    expect(result.length).toBe(1)
    expect(result[0].path._pathLength).toBe(2)
  })

  test('length([node1, node2, node3]) — 数组路径长度 = n-1', () => {
    const path = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' },
    ]
    const result = executeBuiltinFunction('length', [path])
    expect(result).toBe(2) // 3 nodes → 2 edges
  })

  test('length(null) — null 返回 0', () => {
    expect(executeBuiltinFunction('length', [null])).toBe(0)
  })

  test('nodes(path) — 返回路径中所有节点', () => {
    const path = { _pathNodes: [{ id: 1 }, { id: 2 }], _pathEdges: [{}] }
    const result = executeBuiltinFunction('nodes', [path])
    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('relationships(path) — 返回路径中所有边', () => {
    const edge = { _relType: 'KNOWS' }
    const path = { _pathNodes: [{ id: 1 }, { id: 2 }], _pathEdges: [edge] }
    const result = executeBuiltinFunction('relationships', [path])
    expect(result).toEqual([edge])
  })

  test('rels(path) — relationships 的别名', () => {
    const edge = { _relType: 'KNOWS' }
    const path = { _pathNodes: [{ id: 1 }, { id: 2 }], _pathEdges: [edge] }
    const result = executeBuiltinFunction('rels', [path])
    expect(result).toEqual([edge])
  })

  test('startNode(rel) — 边的起点', () => {
    const srcNode = { id: 1, name: 'Alice' }
    const rel = { _startNode: srcNode }
    const result = executeBuiltinFunction('startNode', [rel])
    expect(result).toEqual(srcNode)
  })

  test('endNode(rel) — 边的终点', () => {
    const dstNode = { id: 2, name: 'Bob' }
    const rel = { _endNode: dstNode }
    const result = executeBuiltinFunction('endNode', [rel])
    expect(result).toEqual(dstNode)
  })

  test('endNode(rel) with _dst fallback', () => {
    const dstNode = { id: 2 }
    const rel = { _dst: dstNode }
    const result = executeBuiltinFunction('endNode', [rel])
    expect(result).toEqual(dstNode)
  })

  test('startNode(rel) with _src fallback', () => {
    const srcNode = { id: 1 }
    const rel = { _src: srcNode }
    const result = executeBuiltinFunction('startNode', [rel])
    expect(result).toEqual(srcNode)
  })

  test('relationships on path without _pathEdges returns empty array', () => {
    const path = { _pathNodes: [{ id: 1 }] }
    const result = executeBuiltinFunction('relationships', [path])
    expect(result).toEqual([])
  })
})

describe('_parseAggregate 解析函数', () => {

  test('解析 COLLECT(n.name)', () => {
    const result = _parseAggregate('collect(n.name)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COLLECT')
    expect(result!.field).toBe('n.name')
    expect(result!.distinct).toBe(false)
  })

  test('解析 COLLECT(DISTINCT n.city)', () => {
    const result = _parseAggregate('collect(DISTINCT n.city)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COLLECT')
    expect(result!.field).toBe('n.city') // field excludes DISTINCT prefix
    expect(result!.distinct).toBe(true)
  })

  test('解析 COUNT(*)', () => {
    const result = _parseAggregate('count(*)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COUNT')
    expect(result!.field).toBe('*')
  })

  test('解析 COUNT(DISTINCT n.city)', () => {
    const result = _parseAggregate('count(DISTINCT n.city)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COUNT')
    expect(result!.field).toBe('n.city') // field excludes DISTINCT prefix
    expect(result!.distinct).toBe(true)
  })

  test('非聚合表达式返回 null', () => {
    expect(_parseAggregate('n.name')).toBeNull()
    expect(_parseAggregate('42')).toBeNull()
  })
})

describe('WITH + 聚合组合', () => {

  test('WITH n.age, COUNT(*) AS cnt — WITH 聚合', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      with: {
        columns: [
          { expression: 'age', alias: null },
        ],
        aggregate: { type: 'count' as const, field: '*', alias: 'cnt' },
        filters: [],
        orderBy: [],
        limit: undefined,
        skip: undefined,
      },
      returnColumns: ['cnt'],
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    // WITH n.age, COUNT(*) AS cnt — age is a GROUP BY key
    // Each different age is a separate group
    expect(result.length).toBe(5) // 5 different ages
    expect(result[0].cnt).toBe(1) // each group has 1 person
  })

  test('WITH COLLECT(n.name) AS names — pure collect, no group-by', () => {
    const plan = {
      scanLabel: null,
      steps: [],
      filters: [],
      with: {
        columns: [], // no group-by columns
        aggregate: { type: 'collect' as const, field: 'name', alias: 'names' },
        filters: [],
        orderBy: [],
        limit: undefined,
        skip: undefined,
      },
      returnColumns: ['names'],
      orderBy: [],
      limit: undefined,
      skip: undefined,
    }
    const result = _executeQuery(plan, testNodes as any)
    expect(result.length).toBe(1)
    expect(Array.isArray(result[0].names)).toBe(true)
    expect(result[0].names).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve'])
  })
})

describe('aggregateRecords 测试', () => {
  test('aggregateRecords with COLLECT', () => {
    const records = [
      { name: 'Alice', city: 'NYC' },
      { name: 'Bob', city: 'SF' },
      { name: 'Carol', city: 'NYC' },
    ]
    const result = aggregateRecords('collect', 'name', records)
    expect(result.get('name')).toEqual(['Alice', 'Bob', 'Carol'])
  })

  test('aggregateRecords with collect removing nulls', () => {
    const records = [
      { name: 'Alice', city: 'NYC' },
      { name: null, city: 'SF' },
      { name: 'Carol', city: null },
    ]
    const result = aggregateRecords('collect', 'name', records)
    expect(result.get('name')).toEqual(['Alice', 'Carol'])
  })
})
