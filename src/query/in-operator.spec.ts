/**
 * IN 操作符 + ORDER BY 多列 — 单元测试
 *
 * 覆盖：
 *   - IN [20, 30, 40] 匹配
 *   - IN [] 不匹配
 *   - 字符串 IN
 *   - 非数组右值不报错（变量引用兜底 → 等同 EQ）
 *   - AND + IN 复合条件
 *   - IN + ORDER BY 组合
 *   - ORDER BY 多列（DESC/ASC 混合）
 *   - ORDER BY 单列（向后兼容）
 */

import { parseQuery, _executeQuery } from './query-engine'

// ═══════════════════════════════════════════════════════
// IN 操作符
// ═══════════════════════════════════════════════════════

describe('IN 操作符', () => {
  // ── 基础解析 ──

  it('IN [20, 30, 40] — 解析为 IN 过滤器', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age IN [20, 30, 40] RETURN n.name")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IN')
    expect(plan.filters[0].property).toBe('age')
    expect(plan.filters[0].value).toEqual([20, 30, 40])
  })

  it('IN [] — 解析为空数组', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age IN [] RETURN n.name")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IN')
    expect(plan.filters[0].value).toEqual([])
  })

  it('字符串 IN — 解析为字符串数组', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] RETURN n.name")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IN')
    expect(plan.filters[0].value).toEqual(['Alice', 'Bob'])
  })

  // ── 执行测试 — 匹配 ──

  it('IN [20, 30, 40] — 运行时匹配', () => {
    const plan = parseQuery("MATCH (n) WHERE n.age IN [20, 30, 40] RETURN n.name, n.age")
    const nodes = [
      { id: 1, name: 'Alice', age: 25 },
      { id: 2, name: 'Bob', age: 30 },
      { id: 3, name: 'Carol', age: 35 },
      { id: 4, name: 'Dave', age: 20 },
      { id: 5, name: 'Eve', age: 40 },
    ]
    const result = _executeQuery(plan, nodes)
    // Should match Bob (30), Dave (20), Eve (40)
    expect(result).toHaveLength(3)
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Bob', 'Dave', 'Eve'])
  })

  it('IN [] — 运行时不匹配任何值', () => {
    const plan = parseQuery("MATCH (n) WHERE n.age IN [] RETURN n.name")
    const nodes = [
      { id: 1, name: 'Alice', age: 25 },
      { id: 2, name: 'Bob', age: 30 },
    ]
    const result = _executeQuery(plan, nodes)
    expect(result).toHaveLength(0)
  })

  it('字符串 IN — 运行时匹配字符串', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name IN ['Alice', 'Carol'] RETURN n.name")
    const nodes = [
      { id: 1, name: 'Alice', age: 25 },
      { id: 2, name: 'Bob', age: 30 },
      { id: 3, name: 'Carol', age: 35 },
    ]
    const result = _executeQuery(plan, nodes)
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Alice', 'Carol'])
  })

  // ── 边界情况 ──

  it('单值 IN — 等同 EQ', () => {
    const plan = parseQuery("MATCH (n) WHERE n.age IN [25] RETURN n.name, n.age")
    const nodes = [
      { id: 1, name: 'Alice', age: 25 },
      { id: 2, name: 'Bob', age: 30 },
    ]
    const result = _executeQuery(plan, nodes)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Alice')
  })

  it('IN 与 AND 复合条件', () => {
    const plan = parseQuery("MATCH (n) WHERE n.age IN [20, 30] AND n.status = 'active' RETURN n.name")
    const nodes = [
      { id: 1, name: 'Alice', age: 20, status: 'active' },
      { id: 2, name: 'Bob', age: 30, status: 'inactive' },
      { id: 3, name: 'Carol', age: 30, status: 'active' },
      { id: 4, name: 'Dave', age: 40, status: 'active' },
    ]
    const result = _executeQuery(plan, nodes)
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Alice', 'Carol'])
  })

  it('IN + ORDER BY 组合', () => {
    const plan = parseQuery("MATCH (n) WHERE n.age IN [20, 30, 40] RETURN n.name, n.age ORDER BY n.age ASC")
    const nodes = [
      { id: 1, name: 'Alice', age: 25 },
      { id: 2, name: 'Bob', age: 30 },
      { id: 3, name: 'Carol', age: 35 },
      { id: 4, name: 'Dave', age: 20 },
      { id: 5, name: 'Eve', age: 40 },
    ]
    const result = _executeQuery(plan, nodes)
    expect(result).toHaveLength(3)
    expect(result[0].age).toBe(20) // Dave
    expect(result[1].age).toBe(30) // Bob
    expect(result[2].age).toBe(40) // Eve
  })
})

// ═══════════════════════════════════════════════════════
// ORDER BY 多列
// ═══════════════════════════════════════════════════════

describe('ORDER BY 多列', () => {
  const nodes = [
    { id: 1, name: 'Alice', age: 30, score: 95 },
    { id: 2, name: 'Bob', age: 25, score: 80 },
    { id: 3, name: 'Carol', age: 30, score: 90 },
    { id: 4, name: 'Dave', age: 20, score: 85 },
    { id: 5, name: 'Eve', age: 30, score: 85 },
    { id: 6, name: 'Frank', age: 25, score: 95 },
  ]

  it('解析 ORDER BY 多列', () => {
    const plan = parseQuery("MATCH (n) RETURN n.name ORDER BY n.age DESC, n.score ASC")
    expect(plan.orderBy).toHaveLength(2)
    expect(plan.orderBy[0]).toEqual({ property: 'age', direction: 'DESC' })
    expect(plan.orderBy[1]).toEqual({ property: 'score', direction: 'ASC' })
  })

  it('ORDER BY age DESC, score ASC — 执行排序正确', () => {
    const plan = parseQuery("MATCH (n) RETURN n.name, n.age, n.score ORDER BY n.age DESC, n.score ASC")
    const result = _executeQuery(plan, nodes)
    // Expected order: age=30: Eve(85), Carol(90), Alice(95); age=25: Bob(80), Frank(95); age=20: Dave(85)
    expect(result).toHaveLength(6)
    expect(result.map(r => r.name)).toEqual(['Eve', 'Carol', 'Alice', 'Bob', 'Frank', 'Dave'])
  })

  it('ORDER BY age ASC, score DESC — 混合方向', () => {
    const plan = parseQuery("MATCH (n) RETURN n.name, n.age, n.score ORDER BY n.age ASC, n.score DESC")
    const result = _executeQuery(plan, nodes)
    // Expected order: age=20: Dave(85); age=25: Frank(95), Bob(80); age=30: Alice(95), Carol(90), Eve(85)
    expect(result).toHaveLength(6)
    expect(result.map(r => r.name)).toEqual(['Dave', 'Frank', 'Bob', 'Alice', 'Carol', 'Eve'])
  })

  it('ORDER BY 单列（向后兼容）', () => {
    const plan = parseQuery("MATCH (n) RETURN n.name, n.age ORDER BY n.age DESC")
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0]).toEqual({ property: 'age', direction: 'DESC' })
    const result = _executeQuery(plan, nodes)
    expect(result[0].age).toBe(30)
    expect(result[result.length - 1].age).toBe(20)
  })

  it('ORDER BY 多列 — 单列默认 ASC', () => {
    const plan = parseQuery("MATCH (n) RETURN n.name, n.age ORDER BY n.age")
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].direction).toBe('ASC')
    const result = _executeQuery(plan, nodes)
    expect(result[0].age).toBe(20)
    expect(result[result.length - 1].age).toBe(30)
  })

  it('ORDER BY 三列', () => {
    const nodes3 = [
      { id: 1, name: 'A', a: 1, b: 2, c: 3 },
      { id: 2, name: 'B', a: 1, b: 2, c: 1 },
      { id: 3, name: 'C', a: 1, b: 1, c: 5 },
      { id: 4, name: 'D', a: 2, b: 1, c: 0 },
    ]
    // Must include sort columns in RETURN to make them available for ORDER BY
    const plan = parseQuery("MATCH (n) RETURN n.name, n.a, n.b, n.c ORDER BY n.a ASC, n.b ASC, n.c DESC")
    expect(plan.orderBy).toHaveLength(3)
    const result = _executeQuery(plan, nodes3)
    // a=1 group: b=1→C(5); b=2→B(1), A(3); a=2→D(1,0)
    // Within a=1,b=2: c DESC → A(3) before B(1)
    expect(result.map(r => r.name)).toEqual(['C', 'A', 'B', 'D'])
  })
})
