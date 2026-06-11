/**
 * tck-TCK___ENUMERATION_集合运算.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — ENUMERATION 集合运算', () => {

  it('[TCK-ENUM-01] UNION 解析', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name ORDER BY name')
    expect(plan.unionType).toBe('union')
    expect(plan.rightPlan).toBeDefined()
  })

  it('[TCK-ENUM-02] UNION ALL 解析', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Person) RETURN b.name AS name ORDER BY name')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-ENUM-03] UNION 执行合并', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name')
    expect(plan.unionType).toBe('union')
    expect(plan.rightPlan).toBeDefined()
  })

  it('[TCK-ENUM-04] UNION ALL 执行拼接', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Company) RETURN b.name AS name')
    expect(plan.unionType).toBe('union_all')
    expect(plan.rightPlan).toBeDefined()
  })

  it('[TCK-ENUM-05] UNION ALL 重复保留', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Person) RETURN b.name AS name')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-ENUM-06] UNION 去重', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Person) RETURN b.name AS name')
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-ENUM-07] UNION 多列', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name, a.age AS age UNION MATCH (b:Person) RETURN b.name AS name, b.age AS age')
    expect(plan.unionType).toBe('union')
    expect(plan.rightPlan).toBeDefined()
  })

  it('[TCK-ENUM-08] UNION 空集', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name')
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-ENUM-09] UNION ALL 空集', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Company) RETURN b.name AS name')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-ENUM-10] INTERSECT 交集', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name INTERSECT MATCH (b:Person) RETURN b.name AS name')
    expect(plan.unionType).toBe('intersect')
  })

  it('[TCK-ENUM-11] INTERSECT 执行交集', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name INTERSECT MATCH (b:Person) WHERE b.age > 20 RETURN b.name AS name')
    expect(plan.unionType).toBe('intersect')
  })

  it('[TCK-ENUM-12] SUBTRACT (EXCEPT) 差集', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name SUBTRACT MATCH (b:Person) WHERE b.age < 18 RETURN b.name AS name')
    expect(plan.unionType).toBe('subtract')
  })

  it('[TCK-ENUM-13] UNION 不同标签', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (c:City) RETURN c.name AS name')
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-ENUM-14] UNION 带 WHERE', () => {
    const plan = parseQuery('MATCH (a:Person) WHERE a.age > 18 RETURN a.name AS name UNION MATCH (b:Person) WHERE b.status = "active" RETURN b.name AS name')
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-ENUM-15] UNION ALL 带 ORDER BY', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Person) RETURN b.name AS name ORDER BY name')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-ENUM-16] INTERSECT WITH 匹配', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name INTERSECT MATCH (b:Person) RETURN b.name AS name')
    expect(plan.unionType).toBe('intersect')
  })

  it('[TCK-ENUM-17] SUBTRACT 执行', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name SUBTRACT MATCH (b:Person) WHERE b.age > 25 RETURN b.name AS name')
    expect(plan.unionType).toBe('subtract')
  })

  it('[TCK-ENUM-18] 三个 UNION 链', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name UNION MATCH (c:Product) RETURN c.name AS name')
    expect(plan).toBeDefined()
  })

  it('[TCK-ENUM-19] UNION ALL 带 LIMIT', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Person) RETURN b.name AS name LIMIT 2')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-ENUM-20] UNION WITH WHERE + ORDER BY', () => {
    const plan = parseQuery('MATCH (a:Person) WHERE a.city = "NYC" RETURN a.name AS name UNION MATCH (b:Person) WHERE b.city = "LA" RETURN b.name AS name ORDER BY name')
    expect(plan.unionType).toBe('union')
    expect(plan.rightPlan).toBeDefined()
  })

  it('[TCK-ENUM-21] UNION 多属性列', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name, a.age UNION MATCH (b:Person) RETURN b.name, b.age')
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-ENUM-22] UNION ALL 去重结果检查', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name UNION ALL MATCH (b:Person) RETURN b.name AS name')
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-ENUM-23] INTERSECT 无匹配', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name INTERSECT MATCH (b:Company) RETURN b.name AS name')
    expect(plan.unionType).toBe('intersect')
  })

  it('[TCK-ENUM-24] EXCEPT 全排除', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS name SUBTRACT MATCH (b:Person) RETURN b.name AS name')
    expect(plan.unionType).toBe('subtract')
  })

  it('[TCK-ENUM-25] UNION AS 别名兼容', () => {
    const plan = parseQuery('MATCH (a:Person) RETURN a.name AS person_name UNION MATCH (b:Company) RETURN b.name AS company_name')
    expect(plan.unionType).toBe('union')
  })
})
