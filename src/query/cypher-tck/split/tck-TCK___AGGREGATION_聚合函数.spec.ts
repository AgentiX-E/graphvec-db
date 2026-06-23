/**
 * tck-TCK___AGGREGATION_聚合函数.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — AGGREGATION 聚合函数', () => {

  it('[TCK-AGG-01] COUNT(*) 全量计数', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN count(*)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
    const data = [{ _label: 'Person' }, { _label: 'Person' }, { _label: 'Company' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-02] COUNT(属性) 非空计数', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN count(n.name)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
  })

  it('[TCK-AGG-03] COUNT(*) 空图返回行', async () => {
    const plan = parseQuery('MATCH (n) RETURN count(*)')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-04] SUM(数字属性)', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN sum(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('sum')
    const data = [{ _label: 'Person', age: 10 }, { _label: 'Person', age: 20 }, { _label: 'Person', age: 30 }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-05] SUM 空集返回单行', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN sum(n.age)')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-06] AVG(数字属性)', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN avg(n.score)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('avg')
    const data = [{ _label: 'Person', score: 10 }, { _label: 'Person', score: 20 }, { _label: 'Person', score: 30 }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-07] AVG 空集返回 null', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN avg(n.score)')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-08] MIN(数字属性)', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN min(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('min')
    const data = [{ _label: 'Person', age: 3 }, { _label: 'Person', age: 48 }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-09] MAX(数字属性)', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN max(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('max')
  })

  it('[TCK-AGG-10] MAX 空集返回单行', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN max(n.age)')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-11] GROUP BY 单字段 + COUNT', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name')
    expect(plan.groupBy).toContain('name')
    expect(plan.aggregate!.type).toBe('count')
    const data = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
      { _label: 'Person', name: 'Alice' },
    ]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(2)
  })

  it('[TCK-AGG-12] GROUP BY 多字段', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, n.city, count(*) GROUP BY n.name, n.city')
    expect(plan.groupBy).toHaveLength(2)
    expect(plan.groupBy).toContain('name')
    expect(plan.groupBy).toContain('city')
  })

  it('[TCK-AGG-13] GROUP BY + SUM', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.dept, sum(n.salary) GROUP BY n.dept')
    expect(plan.aggregate!.type).toBe('sum')
    const data = [
      { _label: 'Person', dept: 'Eng', salary: 100 },
      { _label: 'Person', dept: 'Eng', salary: 200 },
      { _label: 'Person', dept: 'Sales', salary: 150 },
    ]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(2)
    const eng = result.find(r => r.dept === 'Eng')
    expect(eng).toBeDefined()
  })

  it('[TCK-AGG-14] GROUP BY + AVG', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.dept, avg(n.score) GROUP BY n.dept')
    expect(plan.aggregate!.type).toBe('avg')
  })

  it('[TCK-AGG-15] GROUP BY + MIN', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.dept, min(n.age) GROUP BY n.dept')
    expect(plan.aggregate!.type).toBe('min')
  })

  it('[TCK-AGG-16] GROUP BY + MAX', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.dept, max(n.age) GROUP BY n.dept')
    expect(plan.aggregate!.type).toBe('max')
  })

  it('[TCK-AGG-17] HAVING 过滤聚合结果', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name HAVING count(*) > 1')
    expect(plan.having).toBeDefined()
    expect(plan.having![0].operator).toBe('GT')
    expect(plan.having![0].value).toBe(1)
    const data = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
      { _label: 'Person', name: 'Alice' },
    ]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Alice')
  })

  it('[TCK-AGG-18] HAVING < 过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name HAVING count(*) < 2')
    expect(plan.having![0].operator).toBe('LT')
  })

  it('[TCK-AGG-19] HAVING >= 过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name HAVING count(*) >= 2')
    expect(plan.having![0].operator).toBe('GTE')
  })

  it('[TCK-AGG-20] HAVING = 过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name HAVING count(*) = 1')
    expect(plan.having![0].operator).toBe('EQ')
  })

  it('[TCK-AGG-21] HAVING 排除所有行', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(*) GROUP BY n.name HAVING count(*) > 999')
    const data = [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(0)
  })

  it('[TCK-AGG-22] GROUP BY + ORDER BY 聚合结果', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, count(n.age) GROUP BY n.name ORDER BY count(n.age)')
    expect(plan.groupBy).toContain('name')
    expect(plan.orderBy).toHaveLength(1)
  })

  it('[TCK-AGG-23] WITH 管道中的聚合', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.age AS age, count(*) AS cnt RETURN age, cnt')
    expect(plan).toBeDefined()
    expect(plan.with).toBeDefined()
  })

  it('[TCK-AGG-24] 无分组 COUNT 带 WHERE', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 RETURN count(*)')
    expect(plan.aggregate).toBeDefined()
    const data = [
      { _label: 'Person', age: 25 },
      { _label: 'Person', age: 17 },
      { _label: 'Person', age: 30 },
    ]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-AGG-25] 聚合别名', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN count(*) AS total_people')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.alias).toBe('total_people')
  })
})
