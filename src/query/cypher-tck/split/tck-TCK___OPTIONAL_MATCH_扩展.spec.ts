/**
 * tck-TCK___OPTIONAL_MATCH_扩展.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — OPTIONAL MATCH 扩展', () => {

  it('[TCK-OM-01] OPTIONAL MATCH 基本', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-02] OPTIONAL MATCH 带 WHERE', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 25 RETURN a, b')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-03] 多 OPTIONAL MATCH', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) OPTIONAL MATCH (a)-[:WORKS_AT]->(c) RETURN a, b, c')
    expect(plan.optionalMatchSteps!.length).toBe(2)
  })

  it('[TCK-OM-04] OPTIONAL MATCH 无标签', async () => {
    const plan = parseQuery('MATCH (a) OPTIONAL MATCH (a)--(b) RETURN a, b')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-05] OPTIONAL MATCH 返回空匹配', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b')
    const data = [{ _label: 'Person', name: 'Alice' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    // If OPTIONAL MATCH fails, b should be null
    expect(result.length).toBe(1)
  })

  it('[TCK-OM-06] OPTIONAL MATCH 带 LIMIT', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b LIMIT 5')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-07] OPTIONAL MATCH + WHERE + RETURN 排序', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 18 RETURN a.name ORDER BY a.name')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-08] OPTIONAL MATCH 带 label', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b:Person) RETURN a, b')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-09] OPTIONAL MATCH + WITH', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WITH a, b WHERE b IS NOT NULL RETURN a.name, b.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-OM-10] OPTIONAL MATCH 多步路径', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) RETURN a, b, c')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-11] OPTIONAL MATCH 返回属性', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.name, b.name')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-12] OPTIONAL MATCH WITH ORDER BY', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b ORDER BY a.name')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-13] OPTIONAL MATCH + 聚合', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.name, count(b) GROUP BY a.name')
    expect(plan).toBeDefined()
  })

  it('[TCK-OM-14] MATCH + OPTIONAL MATCH 语义不抛出', async () => {
    expect(() => parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-->(b) RETURN a, b')).not.toThrow()
  })

  it('[TCK-OM-15] OPTIONAL MATCH 变长路径', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS*1..2]->(c) RETURN a, c')
    expect(plan).toBeDefined()
  })

  it('[TCK-OM-16] OPTIONAL MATCH 边名赋值', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[r:KNOWS]->(b) RETURN a, r, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-OM-17] OPTIONAL MATCH 带 IN 过滤', async () => {
    const plan = parseQuery("MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.name IN ['Alice', 'Bob'] RETURN a, b")
    expect(plan).toBeDefined()
  })

  it('[TCK-OM-18] OPTIONAL MATCH 多方向', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)--(b) RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-OM-19] OPTIONAL MATCH 带 CREATE 后', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WITH a, b WHERE b IS NULL RETURN a')
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OM-20] OPTIONAL MATCH 聚合执行', async () => {
    const plan = parseQuery('MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.name, count(b) GROUP BY a.name')
    const data = [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(2)
  })
})
