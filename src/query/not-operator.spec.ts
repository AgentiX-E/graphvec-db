/**
 * NOT operator tests.
 *
 * Coverage:
 *   - WHERE NOT n.name = 'Alice' — negated EQ
 *   - WHERE NOT (n.age > 30) — negated paren expression
 *   - WHERE NOT n.name STARTS WITH 'A' — negated string predicate
 *   - NOT with AND
 *   - NOT with IN
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ═══════════════════════════════════════════════════════
// NOT parsing
// ═══════════════════════════════════════════════════════

describe('NOT 解析', () => {
  it('WHERE NOT: 解析 NOT n.name = "Alice" → negated EQ filter', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE NOT n.name = 'Alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const nameFilter = plan.filters.find(f => f.property === 'name')
    expect(nameFilter).toBeDefined()
    expect(nameFilter!.negated).toBe(true)
    expect(nameFilter!.operator).toBe('EQ')
    expect(nameFilter!.value).toBe('Alice')
  })

  it('WHERE NOT: 解析 NOT (n.age > 30) → negated GT filter', () => {
    const plan = parseQuery('MATCH (n:Person) WHERE NOT (n.age > 30) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const ageFilter = plan.filters.find(f => f.property === 'age')
    expect(ageFilter).toBeDefined()
    expect(ageFilter!.negated).toBe(true)
    expect(ageFilter!.operator).toBe('GT')
    expect(ageFilter!.value).toBe(30)
  })

  it('NOT 不干扰普通 WHERE 条件（无 NOT 标记）', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age > 25 RETURN n")
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const ageFilter = plan.filters.find(f => f.property === 'age')
    expect(ageFilter).toBeDefined()
    expect(ageFilter!.negated).toBeUndefined()
    expect(ageFilter!.operator).toBe('GT')
    expect(ageFilter!.value).toBe(25)
  })

  it('WHERE NOT: 解析 NOT n.name STARTS WITH "A" → negated STRING_PREDICATE', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE NOT n.name STARTS WITH 'A' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const nameFilter = plan.filters.find(f => f.property === 'name')
    expect(nameFilter).toBeDefined()
    expect(nameFilter!.negated).toBe(true)
    expect(nameFilter!.operator).toBe('STARTS_WITH')
    expect(nameFilter!.value).toBe('A')
  })
})

// ═══════════════════════════════════════════════════════
// NOT execution
// ═══════════════════════════════════════════════════════

describe('NOT 执行 — _executeQuery 集成', () => {
  it('WHERE NOT n.name = "Charlie": 排除匹配节点', async () => {
    const query = "MATCH (n:Person) WHERE NOT n.name = 'Charlie' RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 25 },
      { _label: 'Person', name: 'Charlie', age: 35 },
    ]
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(result).toHaveLength(2)
    const names = result.map((r: any) => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Bob'])
  })

  it('WHERE NOT (n.age > 30): 保留年龄 ≤ 30 的节点', async () => {
    const query = 'MATCH (n:Person) WHERE NOT (n.age > 30) RETURN n'
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 25 },
      { _label: 'Person', name: 'Charlie', age: 35 },
    ]
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(result).toHaveLength(2)
    const names = result.map((r: any) => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Bob'])
  })

  it('WHERE NOT n.name STARTS WITH "A": 排除以A开头的名字', async () => {
    const query = "MATCH (n:Person) WHERE NOT n.name STARTS WITH 'A' RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 25 },
      { _label: 'Person', name: 'Anna', age: 28 },
      { _label: 'Person', name: 'Charlie', age: 35 },
    ]
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(result).toHaveLength(2)
    const names = result.map((r: any) => r.n.name).sort()
    expect(names).toEqual(['Bob', 'Charlie'])
  })

  it('NOT 与 AND 组合: WHERE NOT n.name = "Alice" AND n.age > 25', async () => {
    const query = "MATCH (n:Person) WHERE NOT n.name = 'Alice' AND n.age > 25 RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 25 },
      { _label: 'Person', name: 'Charlie', age: 35 },
    ]
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].n.name).toBe('Charlie')
  })

  it('NOT 与 IN 组合: WHERE NOT n.name IN ["Alice", "Bob"]', async () => {
    const query = "MATCH (n:Person) WHERE NOT n.name IN ['Alice', 'Bob'] RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 25 },
      { _label: 'Person', name: 'Charlie', age: 35 },
    ]
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].n.name).toBe('Charlie')
  })
})
