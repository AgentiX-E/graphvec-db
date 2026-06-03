/**
 * CALL 子查询单元测试
 *
 * 测试 CALL { subquery } 的解析与执行。
 */

import { parseQuery, _executeQuery } from './query-engine'

// ── 测试用图数据 ──────────────────────────────────────────

var testGraph = [
  { _id: 'p1', _label: 'Person', name: 'Alice', age: 30 },
  { _id: 'p2', _label: 'Person', name: 'Bob', age: 25 },
  { _id: 'p3', _label: 'Person', name: 'Charlie', age: 35 },
  { _id: 'p4', _label: 'Pet', name: 'Whiskers', type: 'cat' },
  { _id: 'p5', _label: 'Pet', name: 'Buddy', type: 'dog' },
]

// ── 1. 解析 CALL 子查询 ───────────────────────────────────

describe('CALL 子查询 — 解析', function() {
  it('解析 CALL 子查询 — parseQuery 正确识别 CALL 子句', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name')
    expect(plan.type).toBe('CALL')
    expect(plan.callQuery).toBeDefined()
    if (plan.callQuery) {
      expect(plan.callQuery.type).toBe('QUERY')
      expect(plan.callQuery.scanLabel).toBe('Person')
      expect(plan.callQuery.returnColumns).toContain('name')
    }
    expect(plan.returnColumns).toContain('name')
  })
})

// ── 2. CALL + RETURN 外层 ─────────────────────────────────

describe('CALL 子查询 — 执行', function() {
  it('CALL + RETURN 外层 — 子查询结果被外层 RETURN 引用', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name')
    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(3)
    var names = result.map(function(r) { return r.name }).sort()
    expect(names).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('CALL 变量作用域隔离 — 内层临时变量不泄漏', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name')
    var result = _executeQuery(plan, testGraph)
    for (var i = 0; i < result.length; i++) {
      expect(result[i].n).toBeUndefined()
    }
    expect(result.length).toBe(3)
  })

  it('CALL 多层嵌套 — CALL 内部 MATCH + RETURN 完整执行', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name')
    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(3)
    var names = result.map(function(r) { return r.name }).sort()
    expect(names).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('CALL 标签过滤 — 子查询仅返回指定标签节点', function() {
    var plan = parseQuery('CALL { MATCH (n:Pet) RETURN n.name AS name } RETURN name')
    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(2)
    var names = result.map(function(r) { return r.name }).sort()
    expect(names).toEqual(['Buddy', 'Whiskers'])
  })

  it('CALL 空结果 — 子查询没有匹配的标签', function() {
    var plan = parseQuery('CALL { MATCH (n:Robot) RETURN n.name AS name } RETURN name')
    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(0)
  })

  it('CALL 重复执行 — 多次执行结果一致（无副作用残留）', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name')
    var result1 = _executeQuery(plan, testGraph)
    var result2 = _executeQuery(plan, testGraph)
    expect(result1.length).toBe(result2.length)
    for (var i = 0; i < result1.length; i++) {
      expect(result1[i].name).toBe(result2[i].name)
    }
  })

  it('无 RETURN 的 CALL — CALL 仅做数据操作', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name }')
    expect(plan.type).toBe('CALL')
    expect(plan.callQuery).toBeDefined()
    expect(plan.returnColumns.length).toBe(0)
  })

  it('CALL + ORDER BY / LIMIT — 外层排序和限制', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name ORDER BY name ASC LIMIT 2')
    expect(plan.type).toBe('CALL')
    expect(plan.orderBy.length).toBe(1)
    expect(plan.orderBy[0].direction).toBe('ASC')
    expect(plan.limit).toBe(2)

    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(2)
    expect(result[0].name).toBe('Alice')
    expect(result[1].name).toBe('Bob')
  })

  it('CALL 仅子查询 + RETURN 属性', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name')
    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(3)
    var names = result.map(function(r) { return r.name }).sort()
    expect(names).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('CALL 子查询结果包含多列', function() {
    var plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name AS name, n.age AS age } RETURN name, age')
    expect(plan.returnColumns).toContain('name')
    expect(plan.returnColumns).toContain('age')
    var result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(3)
    var names = result.map(function(r) { return r.name }).sort()
    expect(names).toEqual(['Alice', 'Bob', 'Charlie'])
  })
})
