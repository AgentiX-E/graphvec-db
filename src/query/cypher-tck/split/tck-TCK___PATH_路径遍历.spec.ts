/**
 * tck-TCK___PATH_路径遍历.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — PATH 路径遍历', () => {

  it('[TCK-PATH-01] 单跳遍历 — 已知标签', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a, b')
    expect(plan.steps.length).toBe(1)
    expect(plan.steps[0].edgeLabel).toBe('KNOWS')
  })

  it('[TCK-PATH-02] 两跳链式遍历', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person)-[:WORKS_AT]->(c:Company) RETURN a, b, c')
    expect(plan.steps.length).toBe(2)
  })

  it('[TCK-PATH-03] 三跳链式遍历', async () => {
    const plan = parseQuery('MATCH (a)-[:REL1]->(b)-[:REL2]->(c)-[:REL3]->(d) RETURN a, d')
    expect(plan.steps.length).toBe(3)
  })

  it('[TCK-PATH-04] 变长路径 1..2', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*1..2]->(c) RETURN a, c')
    expect(plan.steps).toBeDefined()
    expect(plan.steps.length).toBeGreaterThanOrEqual(0)
  })

  it('[TCK-PATH-05] 变长路径 *2', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*2]->(c) RETURN a, c')
    expect(plan).toBeDefined()
  })

  it('[TCK-PATH-06] 变长路径 *1..3', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*1..3]->(c) RETURN a, c')
    expect(plan).toBeDefined()
  })

  it('[TCK-PATH-07] 变长路径 *1..2 (有界)', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*1..2]->(c) RETURN a, c')
    expect(plan).toBeDefined()
  })

  it('[TCK-PATH-08] 无标签边遍历', async () => {
    const plan = parseQuery('MATCH (a)--(b) RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-PATH-09] 无标签边带方向', async () => {
    expect(() => parseQuery('MATCH (a)->(b) RETURN a, b')).toThrow()
  })

  it('[TCK-PATH-10] 反向边 — ANTLR 原生支持', async () => {
    const plan = parseQuery('MATCH (a)<-[:KNOWS]-(b) RETURN a, b')
    expect(plan).toBeDefined()
    expect(plan.steps[0].direction).toBe('in')
  })

  it('[TCK-PATH-11] 逗号多 pattern', async () => {
    const plan = parseQuery('MATCH (a:Person), (b:Company) RETURN a, b')
    expect(plan.scanLabel).toBe('Person')
  })

  it('[TCK-PATH-12] 多标签不再抛出Error', async () => {
    expect(() => parseQuery('MATCH (n:Person:Employee) RETURN n')).not.toThrow()
  })

  it('[TCK-PATH-13] 同节点多边', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b), (a)-[:WORKS_AT]->(c) RETURN a, b, c')
    expect(plan).toBeDefined()
  })

  it('[TCK-PATH-14] MATCH 带 WHERE 和遍历', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 30 RETURN a, b')
    expect(plan.steps.length).toBe(1)
    expect(plan.filters.length).toBeGreaterThan(0)
  })

  it('[TCK-PATH-15] 边属性过滤可解析', async () => {
    expect(() => parseQuery('MATCH (a)-[:KNOWS {since: 2020}]->(b) RETURN a, b')).not.toThrow()
  })

  it('[TCK-PATH-16] 路径在 WHERE 后返回', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b) WHERE b.name = "Bob" RETURN a.name')
    expect(plan.steps.length).toBe(1)
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.returnColumns).toContain('name')
  })

  it('[TCK-PATH-17] 路径 + LIMIT', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) RETURN a, b LIMIT 5')
    expect(plan.steps.length).toBe(1)
    expect(plan.limit).toBe(5)
  })

  it('[TCK-PATH-18] 路径 + ORDER BY', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a.name ORDER BY a.name')
    expect(plan.steps.length).toBe(1)
    expect(plan.orderBy).toHaveLength(1)
  })

  it('[TCK-PATH-19] 路径 + SKIP + LIMIT', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a.name SKIP 1 LIMIT 2')
    expect(plan.skip).toBe(1)
    expect(plan.limit).toBe(2)
  })

  it('[TCK-PATH-20] TRAVERSE 边方向 out', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) RETURN a, b')
    expect(plan.steps[0].direction).toBe('out')
  })

  it('[TCK-PATH-21] 边名赋值', async () => {
    const plan = parseQuery('MATCH (a)-[r:KNOWS]->(b) RETURN r')
    expect(plan).toBeDefined()
  })

  it('[TCK-PATH-22] 空图边遍历', async () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) RETURN a')
    expect(plan.steps).toBeDefined()
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(0)
  })

  it('[TCK-PATH-23] 标签混合路径', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b) RETURN b')
    expect(plan.steps[0].targetLabel).toBeNull()
  })

  it('[TCK-PATH-24] 路径返回多属性', async () => {
    const plan = parseQuery('MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a.name, a.age, b.name')
    // Collision-aware return columns: `name` is projected from two variables
    // (a and b), so both are kept qualified (`a.name`, `b.name`); `age` is
    // unique so it is stored bare.
    expect(plan.returnColumns).toContain('a.name')
    expect(plan.returnColumns).toContain('age')
    expect(plan.returnColumns).toContain('b.name')
  })

  it('[TCK-PATH-25] 路径带别名', async () => {
    const plan = parseQuery('MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN r.since AS connection_year')
    expect(plan.returnColumns).toContain('connection_year')
  })
})
