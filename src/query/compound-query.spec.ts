/**
 * compound-query.spec.ts — 复合 MATCH+WHERE+CREATE+SET+REMOVE+RETURN 测试
 *
 * 覆盖以下复合子句串行：
 * 1. MATCH + WHERE + RETURN ✅
 * 2. MATCH + CREATE + RETURN ✅
 * 3. MATCH + CREATE + SET + RETURN ✅
 * 4. MATCH + WHERE + CREATE + SET + RETURN (全长) ✅
 * 5. MATCH + WHERE + OPTIONAL MATCH + CREATE + RETURN ✅
 * 6. MATCH + CREATE + REMOVE + RETURN ✅
 * 7. MATCH + SET + REMOVE + RETURN ✅
 * 8. CREATE INDEX / DROP INDEX (≥3 tests) ✅
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ── 1. MATCH + WHERE + RETURN ──────────────────────────

describe('复合 MATCH + WHERE + RETURN', () => {
  it('MATCH (n:Person) WHERE n.age > 25 RETURN n', () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 25 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.returnColumns).toContain('n')

    // 验证 where filter
    const filter = plan.filters[0]
    expect(filter).toBeDefined()
    expect(filter.property).toBe('age')
    expect(filter.operator).toBe('GT')
    expect(filter.value).toBe(25)
  })

  it('MATCH (n:User) WHERE n.name = "Alice" RETURN n.name', () => {
    const plan = parseQuery('MATCH (n:User) WHERE n.name = "Alice" RETURN n.name')
    expect(plan.scanLabel).toBe('User')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.returnColumns).toContain('name')
  })
})

// ── 2. MATCH + CREATE + RETURN ─────────────────────────

describe('复合 MATCH + CREATE + RETURN', () => {
  it('MATCH (n:Person) CREATE (m:Person {name: "Bob"}) RETURN n, m', () => {
    const plan = parseQuery('MATCH (n:Person) CREATE (m:Person {name: "Bob"}) RETURN n, m')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes!.length).toBe(1)
    expect(plan.createNodes![0].label).toBe('Person')
    expect(plan.createNodes![0].props).toBeDefined()
    expect(plan.returnColumns).toContain('n')
    expect(plan.returnColumns).toContain('m')

    // 验证执行 (no-op 不会报错)
    const result = _executeQuery(plan, [{ _label: 'Person', name: 'Alice', age: 30 }])
    expect(result).toBeDefined()
  })

  it('MATCH (n:User) CREATE (n)-[:KNOWS]->(m:User {name: "Bob"}) RETURN n, m', () => {
    const plan = parseQuery('MATCH (n:User) CREATE (n)-[:KNOWS]->(m:User {name: "Bob"}) RETURN n, m')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('User')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes!.length).toBeGreaterThanOrEqual(1)
    expect(plan.createEdges).toBeDefined()
    expect(plan.returnColumns).toContain('n')
    expect(plan.returnColumns).toContain('m')
  })
})

// ── 3. MATCH + CREATE + SET + RETURN ───────────────────

describe('复合 MATCH + CREATE + SET + RETURN', () => {
  it('MATCH (n:Person) CREATE (m:Person {name: "Alice"}) SET m.age = 30 RETURN n, m', () => {
    const plan = parseQuery('MATCH (n:Person) CREATE (m:Person {name: "Alice"}) SET m.age = 30 RETURN n, m')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes![0].label).toBe('Person')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBeGreaterThan(0)
    expect(plan.setClauses![0].property).toBeDefined()
    expect(plan.setClauses![0].value).toBe(30)

    // 验证执行
    const result = _executeQuery(plan, [{ _label: 'Person', name: 'Charlie', age: 25 }])
    expect(result).toBeDefined()
  })

  it('MATCH (n:Person) CREATE (m:Person) SET m.name = "Bob", m.age = 25 RETURN n, m', () => {
    const plan = parseQuery('MATCH (n:Person) CREATE (m:Person) SET m.name = "Bob", m.age = 25 RETURN n, m')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.setClauses!.length).toBeGreaterThanOrEqual(2)
  })
})

// ── 4. MATCH + WHERE + CREATE + SET + RETURN (全长) ───

describe('复合 MATCH + WHERE + CREATE + SET + RETURN (全长)', () => {
  it('MATCH (n:Person) WHERE n.age > 25 CREATE (n)-[:KNOWS]->(m:Person {name: "Alice"}) SET m.age = 30 RETURN n, m', () => {
    const plan = parseQuery(
      'MATCH (n:Person) WHERE n.age > 25 CREATE (n)-[:KNOWS]->(m:Person {name: "Alice"}) SET m.age = 30 RETURN n, m',
    )
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes!.length).toBeGreaterThanOrEqual(1)
    expect(plan.createEdges).toBeDefined()
    expect(plan.createEdges!.length).toBeGreaterThan(0)
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBeGreaterThan(0)
    expect(plan.setClauses![0].value).toBe(30)
    expect(plan.returnColumns).toContain('n')
    expect(plan.returnColumns).toContain('m')
  })

  it('长查询执行不报错', () => {
    const plan = parseQuery(
      'MATCH (n:Person) WHERE n.age > 25 CREATE (n)-[:KNOWS]->(m:Person {name: "Alice"}) SET m.age = 30 RETURN n, m',
    )
    const result = _executeQuery(plan, [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 20 },
    ])
    expect(result).toBeDefined()
  })
})

// ── 5. MATCH + WHERE + OPTIONAL MATCH + CREATE + RETURN ──

describe('MATCH + WHERE + OPTIONAL MATCH + CREATE + RETURN', () => {
  it('MATCH (n:Person) WHERE n.age > 20 OPTIONAL MATCH (n)-[:KNOWS]->(f:Person) CREATE (n)-[:FRIEND]->(f) RETURN n, f', () => {
    const q = 'MATCH (n:Person) WHERE n.age > 20 OPTIONAL MATCH (n)-[:KNOWS]->(f:Person) CREATE (n)-[:FRIEND]->(f) RETURN n, f'
    const plan = parseQuery(q)
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.createNodes).toBeDefined()
    expect(plan.createEdges).toBeDefined()
    expect(plan.returnColumns).toContain('n')
    expect(plan.returnColumns).toContain('f')
  })

  it('解析后的 plan 不报错', () => {
    const q = 'MATCH (n:Person) WHERE n.age > 20 OPTIONAL MATCH (n)-[:KNOWS]->(f:Person) CREATE (n)-[:FRIEND]->(f) RETURN n, f'
    expect(() => parseQuery(q)).not.toThrow()
  })
})

// ── 6. MATCH + CREATE + REMOVE + RETURN ────────────────

describe('复合 MATCH + CREATE + REMOVE + RETURN', () => {
  it('MATCH (n:Person) CREATE (m:Person {name: "OldName"}) REMOVE m.name RETURN n, m', () => {
    const plan = parseQuery('MATCH (n:Person) CREATE (m:Person {name: "OldName"}) REMOVE m.name RETURN n, m')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.createNodes).toBeDefined()
    expect(plan.removeClauses).toBeDefined()
    expect(plan.removeClauses!.length).toBeGreaterThan(0)
    expect(plan.returnColumns).toContain('n')
    expect(plan.returnColumns).toContain('m')

    // 验证不报错
    expect(() => _executeQuery(plan, [{ _label: 'Person', name: 'Test' }])).not.toThrow()
  })
})

// ── 7. MATCH + SET + REMOVE + RETURN ───────────────────

describe('复合 MATCH + SET + REMOVE + RETURN', () => {
  it('MATCH (n:Person) SET n.name = "Updated" REMOVE n.deprecated RETURN n', () => {
    const plan = parseQuery('MATCH (n:Person) SET n.name = "Updated" REMOVE n.deprecated RETURN n')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('Person')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBeGreaterThan(0)
    expect(plan.removeClauses).toBeDefined()
    expect(plan.removeClauses!.length).toBeGreaterThan(0)
    expect(plan.returnColumns).toContain('n')

    // 验证不报错
    expect(() => _executeQuery(plan, [{ _label: 'Person', name: 'Test', deprecated: true }])).not.toThrow()
  })

  it('MATCH (n:User) WHERE n.age > 30 SET n.vip = true REMOVE n.temp RETURN n', () => {
    const plan = parseQuery('MATCH (n:User) WHERE n.age > 30 SET n.vip = true REMOVE n.temp RETURN n')
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBe('User')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.setClauses).toBeDefined()
    expect(plan.removeClauses).toBeDefined()
  })
})

// ── 8. CREATE INDEX / DROP INDEX ──────────────────────

describe('CREATE INDEX — 语法解析', () => {
  it('CREATE INDEX ON :Person(name)', () => {
    const plan = parseQuery('CREATE INDEX ON :Person(name)')
    expect(plan).toBeDefined()
    expect(plan.indexOp).toBe('CREATE')
    expect(plan.indexLabel).toBe('Person')
    expect(plan.indexProperty).toBe('name')
  })

  it('CREATE INDEX ON :User(email)', () => {
    const plan = parseQuery('CREATE INDEX ON :User(email)')
    expect(plan.indexOp).toBe('CREATE')
    expect(plan.indexLabel).toBe('User')
    expect(plan.indexProperty).toBe('email')
  })

  it('CREATE INDEX ON :Product(sku)', () => {
    const plan = parseQuery('CREATE INDEX ON :Product(sku)')
    expect(plan.indexOp).toBe('CREATE')
    expect(plan.indexLabel).toBe('Product')
    expect(plan.indexProperty).toBe('sku')
  })
})

describe('DROP INDEX — 语法解析', () => {
  it('DROP INDEX ON :Person(name)', () => {
    const plan = parseQuery('DROP INDEX ON :Person(name)')
    expect(plan).toBeDefined()
    expect(plan.indexOp).toBe('DROP')
    expect(plan.indexLabel).toBe('Person')
    expect(plan.indexProperty).toBe('name')
  })

  it('DROP INDEX ON :User(email)', () => {
    const plan = parseQuery('DROP INDEX ON :User(email)')
    expect(plan.indexOp).toBe('DROP')
    expect(plan.indexLabel).toBe('User')
    expect(plan.indexProperty).toBe('email')
  })
})

describe('INDEX — 执行不报错（no-op）', () => {
  it('CREATE INDEX 执行不报错', () => {
    const plan = parseQuery('CREATE INDEX ON :Person(name)')
    expect(() => _executeQuery(plan, [])).not.toThrow()
  })

  it('DROP INDEX 执行不报错', () => {
    const plan = parseQuery('DROP INDEX ON :Person(name)')
    expect(() => _executeQuery(plan, [])).not.toThrow()
  })
})

describe('INDEX — 非法语法', () => {
  it('缺少括号抛出错误', () => {
    expect(() => parseQuery('CREATE INDEX ON :Person name')).toThrow()
  })
})
