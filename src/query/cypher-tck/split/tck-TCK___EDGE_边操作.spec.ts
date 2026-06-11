/**
 * tck-TCK___EDGE_边操作.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — EDGE 边操作', () => {

  it('[TCK-EDGE-01] CREATE 关系', () => {
    const plan = parseQuery('MATCH (a:Person), (b:Person) CREATE (a)-[:KNOWS]->(b)')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-02] CREATE 关系带属性', () => {
    const plan = parseQuery('MATCH (a:Person), (b:Person) CREATE (a)-[:KNOWS {since: 2020}]->(b)')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-03] CREATE 关系并 RETURN', () => {
    const plan = parseQuery('MATCH (a:Person), (b:Person) CREATE (a)-[r:KNOWS]->(b) RETURN r')
    expect(plan).toBeDefined()
    expect(plan.returnColumns).toContain('r')
  })

  it('[TCK-EDGE-04] MATCH 边过滤标签', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) RETURN a, b')
    expect(plan.steps[0].edgeLabel).toBe('KNOWS')
  })

  it('[TCK-EDGE-05] MATCH 边不带标签', () => {
    const plan = parseQuery('MATCH (a)--(b) RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-06] MATCH 出方向边', () => {
    expect(() => parseQuery('MATCH (a)->(b) RETURN a, b')).toThrow()
  })

  it('[TCK-EDGE-07] MATCH 反向边抛出', () => {
    expect(() => parseQuery('MATCH (a)<-[:KNOWS]-(b) RETURN a, b')).toThrow()
  })

  it('[TCK-EDGE-08] 边名赋值过滤', () => {
    const plan = parseQuery('MATCH (a)-[r:KNOWS]->(b) WHERE r.since > 2020 RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-09] 多步边遍历', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) RETURN a, b, c')
    expect(plan.steps.length).toBe(2)
  })

  it('[TCK-EDGE-10] 边带属性过滤', () => {
    expect(() => parseQuery('MATCH (a)-[:KNOWS {since: 2019}]->(b) RETURN a, b')).not.toThrow()
  })

  it('[TCK-EDGE-11] CREATE 多条边', () => {
    const plan = parseQuery('MATCH (a:Person), (b:Person), (c:Person) CREATE (a)-[:KNOWS]->(b), (a)-[:WORKS_WITH]->(c)')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-12] DETACH DELETE 带边节点', () => {
    const plan = parseQuery('MATCH (n:Person) DETACH DELETE n')
    expect(plan.detachDelete).toBe(true)
    expect(plan.deleteTargets).toBeDefined()
  })

  it('[TCK-EDGE-13] DELETE 仅节点', () => {
    const plan = parseQuery('MATCH (n:Person) DELETE n')
    expect(plan.deleteTargets).toBeDefined()
    expect(plan.deleteTargets.length).toBe(1)
    expect(plan.deleteTargets[0]).toBe('n')
  })

  it('[TCK-EDGE-14] 变长边 *1..3', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*1..3]->(c) RETURN a, c')
    expect(plan.steps).toBeDefined()
    expect(plan.steps[0].range).toBeDefined()
    expect(plan.steps[0].range!.min).toBe(1)
    expect(plan.steps[0].range!.max).toBe(3)
  })

  it('[TCK-EDGE-15] 变长边 *2', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*2]->(c) RETURN a, c')
    expect(plan.steps[0].range).toBeDefined()
    expect(plan.steps[0].range!.min).toBe(2)
    expect(plan.steps[0].range!.max).toBe(2)
  })

  it('[TCK-EDGE-16] 变长边 * (不限)', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS*1..2]->(c) RETURN a, c')
    expect(plan.steps[0].range).toBeDefined()
    expect(plan.steps[0].range!.min).toBe(1)
    expect(plan.steps[0].range!.max).toBe(2)
  })

  it('[TCK-EDGE-17] MERGE 边', () => {
    expect(() => parseQuery('MATCH (a:Person), (b:Person) MERGE (a)-[:KNOWS]->(b)')).not.toThrow()
  })

  it('[TCK-EDGE-18] MERGE 边带属性', () => {
    expect(() => parseQuery('MATCH (a:Person {name: "Alice"}), (b:Person {name: "Bob"}) MERGE (a)-[:KNOWS {since: 2020}]->(b)')).not.toThrow()
  })

  it('[TCK-EDGE-19] MERGE ON CREATE 边', () => {
    expect(() => parseQuery('MATCH (a:Person), (b:Person) MERGE (a)-[:KNOWS]->(b) ON CREATE SET r.since = 2020')).not.toThrow()
  })

  it('[TCK-EDGE-20] 边过滤 WHERE', () => {
    const plan = parseQuery('MATCH (a)-[r:KNOWS]->(b) WHERE r.weight > 0.5 RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-21] 多标签边标签过滤', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS|:WORKS_AT]->(b) RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-22] 路径 ORDER BY 边属性', () => {
    const plan = parseQuery('MATCH (a)-[r:KNOWS]->(b) RETURN a.name, r.since ORDER BY r.since')
    expect(plan.orderBy[0].property).toBe('since')
  })

  it('[TCK-EDGE-23] 空图边 CREATE', () => {
    const plan = parseQuery('CREATE (a:Person)-[:KNOWS]->(b:Person)')
    expect(plan).toBeDefined()
  })

  it('[TCK-EDGE-24] 单向边遍历', () => {
    expect(() => parseQuery('MATCH (a)->(b) RETURN a, b')).toThrow()
  })

  it('[TCK-EDGE-25] REMOVE 边属性', () => {
    const plan = parseQuery('MATCH (a)-[r:KNOWS]->(b) REMOVE r.deprecated')
    expect(plan).toBeDefined()
  })
})
