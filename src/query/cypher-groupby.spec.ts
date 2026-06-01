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
  it('_executeQuery GROUP BY with HAVING filter', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name HAVING count(n.age) > 1')
    const data: Array<Record<string, unknown>> = [
      { name: 'Alice', type: 'Person', props: { age: 30 } },
      { name: 'Alice', type: 'Person', props: { age: 35 } },
      { name: 'Bob', type: 'Person', props: { age: 20 } },
      { name: 'Charlie', type: 'Person', props: { age: 40 } },
      { name: 'Charlie', type: 'Person', props: { age: 50 } },
      { name: 'Charlie', type: 'Person', props: { age: 60 } },
    ]

    const results = _executeQuery(plan, data)

    // Alice: 2 rows → count=2, Charlie: 3 rows → count=3, Bob: 1 row → count=1 (filtered out by HAVING > 1)
    expect(results.length).toBe(2)

    // Results may be in any order (no ORDER BY on aggregate)
    const names = results.map(r => r['name'])
    expect(names).toContain('Alice')
    expect(names).toContain('Charlie')
    expect(names).not.toContain('Bob')
  })

  // TC7: 空结果
  it('HAVING filter with no matches', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.name) GROUP BY n.name HAVING count(n.name) > 999')
    const data: Array<Record<string, unknown>> = [
      { name: 'Alice', type: 'Person' },
      { name: 'Bob', type: 'Person' },
    ]

    const results = _executeQuery(plan, data)
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
