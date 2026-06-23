/**
 * tck-TCK___COMPLEX_复杂组合查询.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — COMPLEX 复杂组合查询', () => {

  it('[TCK-COMPLEX-01] ORDER BY ASC', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name ASC')
    expect(plan.orderBy[0].direction).toBe('ASC')
    const data = [{ _label: 'Person', name: 'Charlie' }, { _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].name).toBe('Alice')
  })

  it('[TCK-COMPLEX-02] ORDER BY DESC', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name DESC')
    expect(plan.orderBy[0].direction).toBe('DESC')
  })

  it('[TCK-COMPLEX-03] ORDER BY 多字段', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC, n.name ASC')
    expect(plan.orderBy.length).toBe(2)
    expect(plan.orderBy[0].direction).toBe('DESC')
    expect(plan.orderBy[1].direction).toBe('ASC')
  })

  it('[TCK-COMPLEX-04] LIMIT 单独', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name LIMIT 5')
    expect(plan.limit).toBe(5)
  })

  it('[TCK-COMPLEX-05] SKIP 单独', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name SKIP 2')
    expect(plan.skip).toBe(2)
    const data = [
      { _label: 'Person', name: 'A' },
      { _label: 'Person', name: 'B' },
      { _label: 'Person', name: 'C' },
    ]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result[0].name).toBe('C')
  })

  it('[TCK-COMPLEX-06] SKIP + LIMIT 组合', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name SKIP 1 LIMIT 3')
    expect(plan.skip).toBe(1)
    expect(plan.limit).toBe(3)
  })

  it('[TCK-COMPLEX-07] ORDER BY + LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name DESC LIMIT 2')
    expect(plan.orderBy.length).toBe(1)
    expect(plan.limit).toBe(2)
  })

  it('[TCK-COMPLEX-08] ORDER BY + SKIP + LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name SKIP 1 LIMIT 2')
    expect(plan.orderBy.length).toBe(1)
    expect(plan.skip).toBe(1)
    expect(plan.limit).toBe(2)
  })

  it('[TCK-COMPLEX-09] 多 MATCH + WHERE', async () => {
    const plan = parseQuery('MATCH (a:Person), (b:Company) WHERE a.age > 25 RETURN a, b')
    expect(plan).toBeDefined()
    const data = [{ _label: 'Person', age: 30 }, { _label: 'Company' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-COMPLEX-10] MATCH + WHERE + RETURN + ORDER BY', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 RETURN n.name ORDER BY n.name')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.orderBy.length).toBe(1)
  })

  it('[TCK-COMPLEX-11] MATCH + WHERE + RETURN + ORDER BY + LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.status = "active" RETURN n.name ORDER BY n.name LIMIT 10')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.orderBy.length).toBe(1)
    expect(plan.limit).toBe(10)
  })

  it('[TCK-COMPLEX-12] WITH + WHERE + RETURN', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n WHERE n.age > 18 RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-COMPLEX-13] WITH + ORDER BY + LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n ORDER BY n.name SKIP 1 LIMIT 2 RETURN n')
    expect(plan.with).toBeDefined()
    expect(plan.with!.orderBy.length).toBeGreaterThan(0)
  })

  it('[TCK-COMPLEX-14] WITH + 聚合 + WHERE', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.age AS age, count(*) AS cnt WHERE cnt > 1 RETURN age, cnt')
    expect(plan).toBeDefined()
  })

  it('[TCK-COMPLEX-15] OPTIONAL MATCH + WHERE', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 25 RETURN a, b')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-COMPLEX-16] 多 OPTIONAL MATCH', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) OPTIONAL MATCH (a)-[:WORKS_AT]->(c) RETURN a, b, c')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-COMPLEX-17] MATCH + WHERE IN + ORDER BY', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.name IN ["Alice", "Bob", "Charlie"] RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-COMPLEX-18] MATCH + WHERE AND + ORDER BY + LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 AND n.status = "active" RETURN n.name, n.age ORDER BY n.age DESC LIMIT 5')
    expect(plan.filters.length).toBe(2)
    expect(plan.orderBy.length).toBe(1)
    expect(plan.limit).toBe(5)
  })

  it('[TCK-COMPLEX-19] WITH + ORDER BY 多字段', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n ORDER BY n.name DESC, n.age ASC RETURN n.name, n.age')
    expect(plan).toBeDefined()
  })

  it('[TCK-COMPLEX-20] UNION + ORDER BY', async () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name ORDER BY name')
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-COMPLEX-21] UNION ALL + ORDER BY', async () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Person) RETURN b.name AS name ORDER BY name')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-COMPLEX-22] MATCH 多标签属性过滤组合', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 AND n.city = "NYC" RETURN n.name ORDER BY n.name LIMIT 10')
    expect(plan.filters.length).toBe(2)
  })

  it('[TCK-COMPLEX-23] MATCH + WHERE OR + ORDER BY', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age < 18 OR n.age > 60 RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-COMPLEX-24] 路径 + WHERE + ORDER BY 返回', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 25 RETURN a.name ORDER BY a.name')
    expect(plan.steps.length).toBe(1)
    expect(plan.orderBy.length).toBe(1)
  })

  it('[TCK-COMPLEX-25] ORDER BY 数字列', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.age ORDER BY n.age')
    expect(plan.orderBy[0].property).toBe('age')
  })

  it('[TCK-COMPLEX-26] LIMIT 0 返回空', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name LIMIT 0')
    expect(plan.limit).toBe(0)
    const data = [{ _label: 'Person', name: 'Alice' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(0)
  })

  it('[TCK-COMPLEX-27] SKIP 超过数据量', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name SKIP 100')
    const data = [{ _label: 'Person', name: 'A' }, { _label: 'Person', name: 'B' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(0)
  })

  it('[TCK-COMPLEX-28] MATCH + WHERE + SKIP + LIMIT + ORDER BY', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 RETURN n.name ORDER BY n.name SKIP 1 LIMIT 3')
    expect(plan.skip).toBe(1)
    expect(plan.limit).toBe(3)
    expect(plan.filters.length).toBeGreaterThan(0)
  })

  it('[TCK-COMPLEX-29] 带标签的 MATCH + WHERE NOT', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE NOT n.name = "Alice" RETURN n.name')
    expect(plan.filters[0].negated).toBe(true)
    const data = [{ _label: 'Person', name: 'Bob' }, { _label: 'Person', name: 'Alice' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })

  it('[TCK-COMPLEX-30] MATCH + 参数化 + ORDER BY', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > $1 RETURN n.name ORDER BY n.age', [18])
    expect(plan.orderBy.length).toBe(1)
    expect(plan.filters[0].value).toBe(18)
  })
})
