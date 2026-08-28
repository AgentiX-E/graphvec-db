/**
 * C-06: GROUP BY + HAVING — 测试
 *
 * 验证分组聚合 + HAVING 后聚合过滤
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

describe('C-06: GROUP BY', () => {
  // TC1: 基本分组聚合
  it('GROUP BY with count(*)', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy).toContain('name')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
  })

  // TC2: GROUP BY with count(prop)
  it('GROUP BY with count(prop)', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy).toContain('name')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
    expect(plan.aggregate!.field).toBe('n.age')
  })

  // TC3: 多字段 GROUP BY
  it('multi-field GROUP BY', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, n.city, count(*) GROUP BY n.name, n.city')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy).toHaveLength(2)
    expect(plan.groupBy).toContain('name')
    expect(plan.groupBy).toContain('city')
  })

  // TC4: GROUP BY + ORDER BY
  it('GROUP BY with ORDER BY', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name ORDER BY count(n.age)')
    expect(plan.groupBy).toContain('name')
    expect(plan.orderBy).toHaveLength(1)
  })

  // TC5: HAVING 过滤（parsing）
  it('HAVING clause parsing', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name HAVING count(n.age) > 1')
    expect(plan.having).toBeDefined()
    expect(plan.having).toHaveLength(1)
    expect(plan.having![0].operator).toBe('GT')
    expect(plan.having![0].value).toBe(1)
  })

  // TC6: _executeQuery with GROUP BY + HAVING
  it('_executeQuery GROUP BY with HAVING filter', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name HAVING count(n.age) > 1')
    const data: Array<Record<string, unknown>> = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Alice', age: 35 },
      { _label: 'Person', name: 'Bob', age: 20 },
      { _label: 'Person', name: 'Charlie', age: 40 },
      { _label: 'Person', name: 'Charlie', age: 50 },
      { _label: 'Person', name: 'Charlie', age: 60 },
    ]

    const results = await _executeQuery(plan, data) as Array<Record<string, unknown>>

    // Alice: 2 rows → count=2, Charlie: 3 rows → count=3, Bob: 1 row → count=1 (filtered out by HAVING > 1)
    expect(results.length).toBe(2)

    // Results may be in any order (no ORDER BY on aggregate)
    const names = results.map(r => r['name'])
    expect(names).toContain('Alice')
    expect(names).toContain('Charlie')
    expect(names).not.toContain('Bob')
  })

  // TC7: 空结果
  it('HAVING filter with no matches', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.name) GROUP BY n.name HAVING count(n.name) > 999')
    const data: Array<Record<string, unknown>> = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]

    const results = await _executeQuery(plan, data) as Array<Record<string, unknown>>
    expect(results.length).toBe(0)
  })

  // TC8: 无 GROUP BY 但有 aggregate
  it('aggregate without GROUP BY', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN count(*)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
    expect(plan.groupBy).toBeUndefined()
  })
})

describe('C-06b: Implicit GROUP BY (aggregate + non-aggregate column)', () => {
  // A RETURN clause mixing an aggregate call with plain columns implicitly groups
  // by the plain columns — e.g. `RETURN n.name, sum(n.num)` groups by n.name.

  it('implicitly groups by a single non-aggregate column (sum)', () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, sum(n.num)')
    expect(plan.aggregate?.function).toBe('sum')
    expect(plan.groupBy).toEqual(['name'])
  })

  it('implicitly groups by multiple non-aggregate columns (count)', () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, n.city, count(*)')
    expect(plan.aggregate?.function).toBe('count')
    expect(plan.groupBy).toEqual(['name', 'city'])
  })

  it('does not set groupBy for a pure aggregate (no non-aggregate column)', () => {
    const plan = parseQuery('MATCH (n) RETURN sum(n.num)')
    expect(plan.aggregate?.function).toBe('sum')
    expect(plan.groupBy).toBeUndefined()
  })

  it('sums only non-null values within each group', async () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, sum(n.num)')
    const data: Array<Record<string, unknown>> = [
      { _label: 'X', name: 'a', num: 33 },
      { _label: 'X', name: 'a' },               // null num — must be skipped
      { _label: 'X', name: 'a', num: 42 },
      { _label: 'X', name: 'b', num: 10 },
    ]
    const results = await _executeQuery(plan, data) as Array<Record<string, unknown>>
    // Two groups: a → 33+42=75, b → 10
    expect(results).toHaveLength(2)
    const byName = new Map(results.map(r => [r['name'], r['sum(n.num)']]))
    expect(byName.get('a')).toBe(75)
    expect(byName.get('b')).toBe(10)
  })

  it('counts non-null values per group (count(prop))', async () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, count(n.num)')
    const data: Array<Record<string, unknown>> = [
      { _label: 'X', name: 'a', num: 1 },
      { _label: 'X', name: 'a' },
      { _label: 'X', name: 'a', num: 2 },
      { _label: 'X', name: 'b', num: 9 },
    ]
    const results = await _executeQuery(plan, data) as Array<Record<string, unknown>>
    const byName = new Map(results.map(r => [r['name'], r['count(n.num)']]))
    expect(byName.get('a')).toBe(2)   // two non-null num
    expect(byName.get('b')).toBe(1)
  })

  it('averages per group (avg)', async () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, avg(n.num)')
    const data: Array<Record<string, unknown>> = [
      { _label: 'X', name: 'a', num: 10 },
      { _label: 'X', name: 'a', num: 20 },
    ]
    const results = await _executeQuery(plan, data) as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    expect(results[0]['avg(n.num)']).toBe(15)
  })

  it('keeps explicit GROUP BY unchanged (does not re-harvest)', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name')
    expect(plan.groupBy).toEqual(['name'])
  })
})
