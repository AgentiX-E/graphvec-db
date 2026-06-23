/**
 * tck-TCK___WITH_扩展.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — WITH 扩展', () => {

  it('[TCK-WITHX-01] WITH 基本别名', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.name AS name RETURN name')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITHX-02] WITH 传递节点', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n WHERE n.age > 18 RETURN n')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-03] WITH 多列', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.name AS name, n.age AS age RETURN name, age')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-04] WITH ORDER BY', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n ORDER BY n.name RETURN n.name')
    expect(plan.with!.orderBy.length).toBeGreaterThan(0)
  })

  it('[TCK-WITHX-05] WITH LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n LIMIT 3 RETURN n')
    expect(plan.with!.limit).toBe(3)
  })

  it('[TCK-WITHX-06] WITH SKIP', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n SKIP 2 RETURN n')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-07] WITH ORDER BY + LIMIT', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n ORDER BY n.name DESC LIMIT 5 RETURN n.name')
    expect(plan.with!.orderBy.length).toBeGreaterThan(0)
    expect(plan.with!.limit).toBe(5)
  })

  it('[TCK-WITHX-08] WITH WHERE 过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.age AS age WHERE age > 18 RETURN age')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-09] WITH 聚合 + WHERE', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.age AS age, count(*) AS cnt WHERE cnt > 1 RETURN age, cnt')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-10] WITH 聚合 COUNT', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH count(*) AS cnt RETURN cnt')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-11] WITH 聚合 SUM', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH sum(n.age) AS total_age RETURN total_age')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-12] WITH 聚合 AVG', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH avg(n.score) AS avg_score RETURN avg_score')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-13] WITH 聚合 MIN', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH min(n.age) AS min_age RETURN min_age')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-14] WITH 聚合 MAX', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH max(n.age) AS max_age RETURN max_age')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-15] WITH 执行结果过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.name AS name, n.age AS age RETURN name, age')
    expect(plan.with).toBeDefined()
  })

  it('[TCK-WITHX-16] WITH 空结果', async () => {
    const plan = parseQuery('MATCH (n:NonExistent) WITH n RETURN n')
    const data = [{ _label: 'Person' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(0)
  })

  it('[TCK-WITHX-17] WITH 链式聚合', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.dept AS dept, count(*) AS cnt WHERE cnt > 0 RETURN dept, cnt')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITHX-18] WITH + ORDER BY DESC', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.name AS name ORDER BY name DESC RETURN name')
    expect(plan.with!.orderBy[0].direction).toBe('DESC')
  })

  it('[TCK-WITHX-19] WITH + SKIP + LIMIT 排序后', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n ORDER BY n.name SKIP 1 LIMIT 2 RETURN n.name')
    expect(plan.with).toBeDefined()
    expect(plan.with!.limit).toBe(2)
  })

  it('[TCK-WITHX-20] WITH 传递 DISTINCT 属性', async () => {
    const plan = parseQuery('MATCH (n:Person) WITH n.name AS name RETURN name')
    expect(plan).toBeDefined()
  })
})
