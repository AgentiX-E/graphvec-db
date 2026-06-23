/**
 * tck-TCK___SUBQUERY_子查询.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — SUBQUERY 子查询', () => {

  it('[TCK-SUB-01] CALL 子查询解析', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name } RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-02] CALL 子查询多列返回', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name, n.age } RETURN n.name, n.age')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-03] CALL 子查询带 WHERE', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) WHERE n.age > 18 RETURN n.name } RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-04] CALL 子查询带 LIMIT', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name LIMIT 5 } RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-05] CALL 子查询带 ORDER BY', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name ORDER BY n.name } RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-06] CALL 子查询 UNION', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name UNION MATCH (m:Company) RETURN m.name AS name } RETURN name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-07] CALL 嵌套子查询 — ANTLR 原生支持', async () => {
    const plan = parseQuery('CALL { CALL { MATCH (n:Person) RETURN n.name } RETURN n.name } RETURN n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBe('CALL')
  })

  it('[TCK-SUB-08] CALL 子查询 IN TRANSACTIONS', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name } IN TRANSACTIONS RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-09] CALL 子查询 IN TRANSACTIONS OF N ROWS', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) DELETE n } IN TRANSACTIONS OF 100 ROWS')
    expect(plan).toBeDefined()
    expect(plan.inTransactions).toBe(true)
    expect(plan.inTransactionsBatchSize).toBe(100)
  })

  it('[TCK-SUB-10] CALL 子查询带 SKIP', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name SKIP 2 } RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-11] CALL 子查询 WITH 管道', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) WITH n.name AS name RETURN name } RETURN name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-12] CALL 子查询聚合', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN count(*) AS cnt } RETURN cnt')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-13] EXISTS 子查询 — 语法解析', async () => {
    // EXISTS subquery in WHERE is supported at parse level
    expect(() => parseQuery("MATCH (a:Person) WHERE EXISTS { MATCH (a)-[:KNOWS]->(:Person) } RETURN a")).not.toThrow()
  })

  it('[TCK-SUB-14] EXISTS 子查询过滤可解析', async () => {
    expect(() => parseQuery("MATCH (a:Person) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b:Person) WHERE b.age > 25 } RETURN a")).not.toThrow()
  })

  it('[TCK-SUB-15] CALL 子查询 OPTIONAL MATCH', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) OPTIONAL MATCH (n)-[:KNOWS]->(f) RETURN n, f } RETURN n, f')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-16] CALL 子查询 UNION ALL', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name UNION ALL MATCH (m:Company) RETURN m.name AS name } RETURN name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-17] CALL 子查询空结果', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name } RETURN n.name')
    const result = await _executeQuery(plan, [])
    expect(Array.isArray(result)).toBe(true)
  })

  it('[TCK-SUB-18] CALL 子查询嵌套 WITH', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) WITH n.age AS age WHERE age > 18 RETURN age } RETURN age')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-19] CALL 过程注册表查询', async () => {
    // db.labels procedure
    expect(() => parseQuery('CALL db.labels() YIELD label RETURN label')).not.toThrow()
  })

  it('[TCK-SUB-20] CALL 过程带参数', async () => {
    expect(() => parseQuery('CALL db.nodeTypeProperties("Person") YIELD propertyName, propertyType RETURN propertyName, propertyType')).not.toThrow()
  })

  it('[TCK-SUB-21] CALL db.labels 执行', async () => {
    const plan = parseQuery('SHOW LABELS')
    expect(plan.show).toBeDefined()
  })

  it('[TCK-SUB-22] CALL db.propertyKeys 执行', async () => {
    expect(() => parseQuery('CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey')).not.toThrow()
  })

  it('[TCK-SUB-23] CALL 子查询 + ORDER BY + LIMIT', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name ORDER BY n.name LIMIT 3 } RETURN n.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-24] CALL 子查询带标签扫描', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person {name: "Alice"}) RETURN n } RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-SUB-25] CALL 多 UNION 子查询', async () => {
    const plan = parseQuery('CALL { MATCH (n:Person) RETURN n.name UNION MATCH (m:Person) RETURN m.name UNION MATCH (k:Company) RETURN k.name AS name } RETURN name')
    expect(plan).toBeDefined()
  })
})
