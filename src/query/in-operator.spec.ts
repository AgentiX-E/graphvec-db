/**
 * IN operator + multi-column ORDER BY — unit tests.
 *
 * Coverage:
 *   - IN [20, 30, 40] matching
 *   - IN [] (empty list) never matches
 *   - string IN
 *   - single-element IN (equivalent to EQ)
 *   - AND + IN compound predicates
 *   - IN + ORDER BY combination
 *   - ORDER BY multiple columns (mixed DESC/ASC)
 *   - ORDER BY single column (backward compatible)
 */

import { parseQuery, _executeQuery } from './query-engine'

// ═══════════════════════════════════════════════════════
// IN operator
// ═══════════════════════════════════════════════════════

describe('IN 操作符', () => {
  // ── Parsing ──

  it('IN [20, 30, 40] — parsed as an IN filter', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age IN [20, 30, 40] RETURN n.name")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IN')
    expect(plan.filters[0].property).toBe('age')
    expect(plan.filters[0].value).toEqual([20, 30, 40])
  })

  it('IN [] — parsed as an empty list', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age IN [] RETURN n.name")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IN')
    expect(plan.filters[0].value).toEqual([])
  })

  it('字符串 IN — parsed as a string array', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] RETURN n.name")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IN')
    expect(plan.filters[0].value).toEqual(['Alice', 'Bob'])
  })

  // ── Execution — matching ──

  it('IN [20, 30, 40] — runtime matching', async () => {
    const query = "MATCH (n:Person) WHERE n.age IN [20, 30, 40] RETURN n.name, n.age"
    const plan = parseQuery(query)
    const nodes = [
      { _label: 'Person', id: 1, name: 'Alice', age: 25 },
      { _label: 'Person', id: 2, name: 'Bob', age: 30 },
      { _label: 'Person', id: 3, name: 'Carol', age: 35 },
      { _label: 'Person', id: 4, name: 'Dave', age: 20 },
      { _label: 'Person', id: 5, name: 'Eve', age: 40 },
    ]
    const result = await _executeQuery(plan, nodes, query) as any[]
    // Should match Bob (30), Dave (20), Eve (40)
    expect(result).toHaveLength(3)
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Bob', 'Dave', 'Eve'])
  })

  it('IN [] — runtime never matches', async () => {
    const query = "MATCH (n:Person) WHERE n.age IN [] RETURN n.name"
    const plan = parseQuery(query)
    const nodes = [
      { _label: 'Person', id: 1, name: 'Alice', age: 25 },
      { _label: 'Person', id: 2, name: 'Bob', age: 30 },
    ]
    const result = await _executeQuery(plan, nodes, query) as any[]
    expect(result).toHaveLength(0)
  })

  it('字符串 IN — runtime string matching', async () => {
    const query = "MATCH (n:Person) WHERE n.name IN ['Alice', 'Carol'] RETURN n.name"
    const plan = parseQuery(query)
    const nodes = [
      { _label: 'Person', id: 1, name: 'Alice', age: 25 },
      { _label: 'Person', id: 2, name: 'Bob', age: 30 },
      { _label: 'Person', id: 3, name: 'Carol', age: 35 },
    ]
    const result = await _executeQuery(plan, nodes, query) as any[]
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Alice', 'Carol'])
  })

  // ── Edge cases ──

  it('单值 IN — equivalent to EQ', async () => {
    const query = "MATCH (n:Person) WHERE n.age IN [25] RETURN n.name, n.age"
    const plan = parseQuery(query)
    const nodes = [
      { _label: 'Person', id: 1, name: 'Alice', age: 25 },
      { _label: 'Person', id: 2, name: 'Bob', age: 30 },
    ]
    const result = await _executeQuery(plan, nodes, query) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Alice')
  })

  it('IN 与 AND 复合条件', async () => {
    const query = "MATCH (n:Person) WHERE n.age IN [20, 30] AND n.status = 'active' RETURN n.name"
    const plan = parseQuery(query)
    const nodes = [
      { _label: 'Person', id: 1, name: 'Alice', age: 20, status: 'active' },
      { _label: 'Person', id: 2, name: 'Bob', age: 30, status: 'inactive' },
      { _label: 'Person', id: 3, name: 'Carol', age: 30, status: 'active' },
      { _label: 'Person', id: 4, name: 'Dave', age: 40, status: 'active' },
    ]
    const result = await _executeQuery(plan, nodes, query) as any[]
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Alice', 'Carol'])
  })

  it('IN + ORDER BY 组合', async () => {
    const query = "MATCH (n:Person) WHERE n.age IN [20, 30, 40] RETURN n.name, n.age ORDER BY n.age ASC"
    const plan = parseQuery(query)
    const nodes = [
      { _label: 'Person', id: 1, name: 'Alice', age: 25 },
      { _label: 'Person', id: 2, name: 'Bob', age: 30 },
      { _label: 'Person', id: 3, name: 'Carol', age: 35 },
      { _label: 'Person', id: 4, name: 'Dave', age: 20 },
      { _label: 'Person', id: 5, name: 'Eve', age: 40 },
    ]
    const result = await _executeQuery(plan, nodes, query) as any[]
    expect(result).toHaveLength(3)
    expect(result[0].age).toBe(20) // Dave
    expect(result[1].age).toBe(30) // Bob
    expect(result[2].age).toBe(40) // Eve
  })
})

// ═══════════════════════════════════════════════════════
// ORDER BY multiple columns
// ═══════════════════════════════════════════════════════

describe('ORDER BY 多列', () => {
  const nodes = [
    { _label: 'Person', id: 1, name: 'Alice', age: 30, score: 95 },
    { _label: 'Person', id: 2, name: 'Bob', age: 25, score: 80 },
    { _label: 'Person', id: 3, name: 'Carol', age: 30, score: 90 },
    { _label: 'Person', id: 4, name: 'Dave', age: 20, score: 85 },
    { _label: 'Person', id: 5, name: 'Eve', age: 30, score: 85 },
    { _label: 'Person', id: 6, name: 'Frank', age: 25, score: 95 },
  ]

  it('解析 ORDER BY 多列', () => {
    const plan = parseQuery("MATCH (n) RETURN n.name ORDER BY n.age DESC, n.score ASC")
    expect(plan.orderBy).toHaveLength(2)
    expect(plan.orderBy[0].property).toBe('age')
    expect(plan.orderBy[0].direction).toBe('DESC')
    expect(plan.orderBy[1].property).toBe('score')
    expect(plan.orderBy[1].direction).toBe('ASC')
  })

  it('ORDER BY age DESC, score ASC — correct execution order', async () => {
    const query = "MATCH (n:Person) RETURN n.name, n.age, n.score ORDER BY n.age DESC, n.score ASC"
    const plan = parseQuery(query)
    const result = await _executeQuery(plan, nodes, query) as any[]
    // Expected order: age=30: Eve(85), Carol(90), Alice(95); age=25: Bob(80), Frank(95); age=20: Dave(85)
    expect(result).toHaveLength(6)
    expect(result.map(r => r.name)).toEqual(['Eve', 'Carol', 'Alice', 'Bob', 'Frank', 'Dave'])
  })

  it('ORDER BY age ASC, score DESC — mixed directions', async () => {
    const query = "MATCH (n:Person) RETURN n.name, n.age, n.score ORDER BY n.age ASC, n.score DESC"
    const plan = parseQuery(query)
    const result = await _executeQuery(plan, nodes, query) as any[]
    // Expected order: age=20: Dave(85); age=25: Frank(95), Bob(80); age=30: Alice(95), Carol(90), Eve(85)
    expect(result).toHaveLength(6)
    expect(result.map(r => r.name)).toEqual(['Dave', 'Frank', 'Bob', 'Alice', 'Carol', 'Eve'])
  })

  it('ORDER BY 单列（向后兼容）', async () => {
    const query = "MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC"
    const plan = parseQuery(query)
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('age')
    expect(plan.orderBy[0].direction).toBe('DESC')
    const result = await _executeQuery(plan, nodes, query) as any[]
    expect(result[0].age).toBe(30)
    expect(result[result.length - 1].age).toBe(20)
  })

  it('ORDER BY 多列 — single column defaults to ASC', async () => {
    const query = "MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age"
    const plan = parseQuery(query)
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].direction).toBe('ASC')
    const result = await _executeQuery(plan, nodes, query) as any[]
    expect(result[0].age).toBe(20)
    expect(result[result.length - 1].age).toBe(30)
  })

  it('ORDER BY 三列', async () => {
    const nodes3 = [
      { _label: 'Person', id: 1, name: 'A', a: 1, b: 2, c: 3 },
      { _label: 'Person', id: 2, name: 'B', a: 1, b: 2, c: 1 },
      { _label: 'Person', id: 3, name: 'C', a: 1, b: 1, c: 5 },
      { _label: 'Person', id: 4, name: 'D', a: 2, b: 1, c: 0 },
    ]
    // Must include sort columns in RETURN to make them available for ORDER BY
    const query = "MATCH (n:Person) RETURN n.name, n.a, n.b, n.c ORDER BY n.a ASC, n.b ASC, n.c DESC"
    const plan = parseQuery(query)
    expect(plan.orderBy).toHaveLength(3)
    const result = await _executeQuery(plan, nodes3, query) as any[]
    // a=1 group: b=1→C(5); b=2→B(1), A(3); a=2→D(1,0)
    // Within a=1,b=2: c DESC → A(3) before B(1)
    expect(result.map(r => r.name)).toEqual(['C', 'A', 'B', 'D'])
  })
})
