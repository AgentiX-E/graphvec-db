// ============================================================
// procedure-registry.spec.ts — Cypher Procedure Registry Tests
// ============================================================

import { ProcedureRegistry, globalRegistry, toAsyncIterable } from './procedure-registry'
import { parseQuery, _executeQuery } from './query-engine'

// ── 测试用图数据 ──────────────────────────────────────────

const testGraph = [
  { _id: 'p1', _label: 'Person', name: 'Alice', age: 30 },
  { _id: 'p2', _label: 'Person', name: 'Bob', age: 25 },
  { _id: 'p3', _label: 'Pet', name: 'Whiskers', type: 'cat' },
  { _id: 'p4', _label: 'Pet', name: 'Buddy', type: 'dog' },
]

// ── 1. Registry 基础 API ──────────────────────────────────

describe('ProcedureRegistry', function() {
  it('register — 注册和获取过程', function() {
    const registry = new ProcedureRegistry()
    const proc = {
      name: 'my.test',
      signature: 'my.test() :: (x :: INTEGER?)',
      execute() { return [] },
    }
    registry.register(proc)

    expect(registry.has('my.test')).toBe(true)
    expect(registry.has('MY.TEST')).toBe(true) // case insensitive
    expect(registry.get('my.test')).toBe(proc)
    expect(registry.get('my.test')).toBeDefined()
  })

  it('get — 不存在的返回 undefined', function() {
    const registry = new ProcedureRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
    expect(registry.has('nonexistent')).toBe(false)
  })

  it('list — 列出所有已注册过程', function() {
    const registry = new ProcedureRegistry()
    registry.register({
      name: 'a.proc',
      signature: 'a.proc() :: (x :: ANY?)',
      execute() { return [] },
    })
    registry.register({
      name: 'b.proc',
      signature: 'b.proc() :: (y :: ANY?)',
      execute() { return [] },
    })
    const list = registry.list()
    expect(list.length).toBe(2)
    expect(list.map(p => p.name).sort()).toEqual(['a.proc', 'b.proc'])
  })
})

// ── 2. 内置过程 — 全局注册 ────────────────────────────────

describe('内置 Procedure — globalRegistry', function() {
  it('globalRegistry 包含所有 8+ 个内置过程', function() {
    const list = globalRegistry.list()
    const names = list.map(p => p.name)

    expect(names).toContain('db.labels')
    expect(names).toContain('db.relationshipTypes')
    expect(names).toContain('db.propertyKeys')
    expect(names).toContain('db.schema.nodeTypeProperties')
    expect(names).toContain('db.schema.visualization')
    expect(names).toContain('dbms.listConfig')
    expect(names).toContain('db.stats.retrieve')
    expect(names).toContain('db.index.fulltext.queryNodes')
    expect(names).toContain('db.index.fulltext.queryRelationshipIndexes')

    // 至少 9 个
    expect(list.length).toBeGreaterThanOrEqual(9)
  })
})

// ── 3. 解析和执行 ──────────────────────────────────────────

describe('CALL procedure — 解析与执行', function() {
  it('解析 CALL db.labels()', function() {
    const plan = parseQuery('CALL db.labels()')
    expect(plan.type).toBe('CALL_PROCEDURE')
    expect(plan.callProcedure).toBeDefined()
    if (plan.callProcedure) {
      expect(plan.callProcedure.name).toBe('db.labels')
      expect(plan.callProcedure.args).toEqual([])
    }
  })

  it('解析 CALL db.labels() YIELD label', function() {
    const plan = parseQuery('CALL db.labels() YIELD label')
    expect(plan.type).toBe('CALL_PROCEDURE')
    expect(plan.callProcedure).toBeDefined()
    if (plan.callProcedure) {
      expect(plan.callProcedure.yieldItems).toBeDefined()
      expect(plan.callProcedure.yieldItems!.length).toBe(1)
      expect(plan.callProcedure.yieldItems![0].name).toBe('label')
    }
  })

  it('解析 CALL db.index.fulltext.queryNodes()', function() {
    const plan = parseQuery('CALL db.index.fulltext.queryNodes("idx", "term") YIELD node, score')
    expect(plan.type).toBe('CALL_PROCEDURE')
    if (plan.callProcedure) {
      expect(plan.callProcedure.name).toBe('db.index.fulltext.queryNodes')
      expect(plan.callProcedure.args).toEqual(['idx', 'term'])
      expect(plan.callProcedure.yieldItems!.map((y: { name: string }) => y.name)).toEqual(['node', 'score'])
    }
  })

  it('执行 CALL db.labels() — 返回 label 列表', function() {
    const result = _executeQuery(
      parseQuery('CALL db.labels()'),
      testGraph,
    ) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(2)
    const labels = result.map((r: { label: string }) => r.label).sort()
    expect(labels).toContain('Person')
    expect(labels).toContain('Pet')
  })

  it('执行 CALL db.labels() YIELD label — 返回 label 列', function() {
    const result = _executeQuery(
      parseQuery('CALL db.labels() YIELD label'),
      testGraph,
    ) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(2)
    // 只应该有 label 字段
    for (const row of result) {
      expect(Object.keys(row)).toEqual(['label'])
    }
  })

  it('YIELD 过滤不存在的列 — 报错', function() {
    expect(() => {
      _executeQuery(
        parseQuery('CALL db.labels() YIELD nonExistentColumn'),
        testGraph,
      )
    }).toThrow(/Invalid YIELD field/)
  })

  it('调用不存在的 procedure — 报错', function() {
    expect(() => {
      _executeQuery(
        parseQuery('CALL some.nonexistent.procedure()'),
        testGraph,
      )
    }).toThrow(/Unknown procedure/)
  })
})

// ── 4. 高级 YIELD 测试 ────────────────────────────────────

describe('CALL procedure — YIELD 高级场景', function() {
  it('YIELD label AS lbl — 别名', function() {
    const result = _executeQuery(
      parseQuery('CALL db.labels() YIELD label AS lbl'),
      testGraph,
    ) as any[]
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const row of result) {
      expect(Object.keys(row)).toEqual(['lbl'])
      expect(typeof row.lbl).toBe('string')
    }
  })
})

// ── 5. 更多内置过程 ──────────────────────────────────────

describe('其他内置 Procedure', function() {
  it('db.stats.retrieve() — 返回统计信息', function() {
    const result = _executeQuery(
      parseQuery('CALL db.stats.retrieve()'),
      testGraph,
    ) as any[]
    expect(result.length).toBe(1)
    expect(result[0].section).toBe('graph')
    expect(result[0].stat).toBeDefined()
    expect(result[0].stat.nodeCount).toBe(4)
  })

  it('db.schema.visualization() — 返回拓扑信息', function() {
    const result = _executeQuery(
      parseQuery('CALL db.schema.visualization()'),
      testGraph,
    ) as any[]
    expect(result.length).toBe(1)
    expect(typeof result[0].nodes).toBe('number')
    expect(typeof result[0].edges).toBe('number')
    expect(result[0].degreeDistribution).toBeDefined()
  })

  it('dbms.listConfig() — 返回配置信息', function() {
    const result = _executeQuery(
      parseQuery('CALL dbms.listConfig()'),
      testGraph,
    ) as any[]
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].name).toBeDefined()
    expect(result[0].description).toBeDefined()
    expect(result[0].value).toBeDefined()
  })

  it('db.index.fulltext.queryNodes() — 空结果', function() {
    const result = _executeQuery(
      parseQuery('CALL db.index.fulltext.queryNodes("idx", "term")'),
      testGraph,
    ) as any[]
    expect(result).toEqual([])
  })
})
