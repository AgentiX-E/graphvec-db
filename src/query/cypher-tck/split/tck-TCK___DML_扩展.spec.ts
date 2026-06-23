/**
 * tck-TCK___DML_扩展.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — DML 扩展', () => {

  it('[TCK-DMLX-01] CREATE 节点带属性', async () => {
    const plan = parseQuery('CREATE (n:Person {name: "Alice", age: 30})')
    expect(plan).toBeDefined()
  })

  it('[TCK-DMLX-02] CREATE 多属性', async () => {
    const plan = parseQuery('CREATE (n:Product {name: "Laptop", price: 999, inStock: true})')
    expect(plan).toBeDefined()
  })

  it('[TCK-DMLX-03] CREATE 多个节点', async () => {
    const plan = parseQuery('CREATE (a:Person {name: "Alice"}), (b:Person {name: "Bob"})')
    expect(plan).toBeDefined()
  })

  it('[TCK-DMLX-04] CREATE 节点 + 关系', async () => {
    const plan = parseQuery('CREATE (a:Person {name: "Alice"})-[:KNOWS]->(b:Person {name: "Bob"})')
    expect(plan).toBeDefined()
  })

  it('[TCK-DMLX-05] MERGE 唯一节点', async () => {
    const plan = parseQuery('MERGE (n:Person {name: "Alice"})')
    expect(plan.mergeNodes).toBeDefined()
    expect(plan.mergeNodes!.length).toBeGreaterThan(0)
  })

  it('[TCK-DMLX-06] MERGE 带 ON CREATE', async () => {
    const plan = parseQuery('MERGE (n:Person {id: 1}) ON CREATE SET n.created_at = timestamp()')
    expect(plan.mergeOnCreate).toBeDefined()
    expect(plan.mergeOnCreate!.length).toBeGreaterThan(0)
  })

  it('[TCK-DMLX-07] MERGE 带 ON MATCH', async () => {
    const plan = parseQuery('MERGE (n:Person {id: 1}) ON MATCH SET n.updated_at = timestamp()')
    expect(plan.mergeOnMatch).toBeDefined()
  })

  it('[TCK-DMLX-08] SET 数字属性', async () => {
    const plan = parseQuery('MATCH (n:Person) SET n.age = 35')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBe(1)
  })

  it('[TCK-DMLX-09] SET 字符串属性', async () => {
    const plan = parseQuery('MATCH (n:Person) SET n.name = "Bob"')
    expect(plan.setClauses!.length).toBe(1)
  })

  it('[TCK-DMLX-10] SET 多属性', async () => {
    const plan = parseQuery('MATCH (n:Person) SET n.name = "Bob", n.age = 25')
    expect(plan.setClauses!.length).toBe(2)
  })

  it('[TCK-DMLX-11] REMOVE 属性', async () => {
    const plan = parseQuery('MATCH (n:Person) REMOVE n.temp_prop')
    expect(plan.removeClauses).toBeDefined()
    expect(plan.removeClauses!.length).toBe(1)
  })

  it('[TCK-DMLX-12] REMOVE 标签', async () => {
    const plan = parseQuery('MATCH (n:Person) REMOVE n:TempLabel')
    expect(plan.removeClauses).toBeDefined()
  })

  it('[TCK-DMLX-13] MATCH + CREATE + RETURN', async () => {
    const plan = parseQuery('CREATE (n:Person {name: "Alice"}) RETURN n')
    expect(plan.returnColumns).toContain('n')
  })

  it('[TCK-DMLX-14] MATCH + SET + RETURN', async () => {
    const plan = parseQuery('MATCH (n:Person) SET n.status = "updated" RETURN n')
    expect(plan.setClauses).toBeDefined()
    expect(plan.returnColumns).toContain('n')
  })

  it('[TCK-DMLX-15] DELETE 加 LABEL 过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) DELETE n')
    expect(plan.deleteTargets!).toContain('n')
  })

  it('[TCK-DMLX-16] DETACH DELETE 多节点', async () => {
    const plan = parseQuery('MATCH (a:Person), (b:Company) DETACH DELETE a, b')
    expect(plan.detachDelete).toBe(true)
  })

  it('[TCK-DMLX-17] CREATE 边带属性', async () => {
    expect(() => parseQuery('CREATE (a:Person)-[r:KNOWS {since: 2020}]->(b:Person) RETURN r')).not.toThrow()
  })

  it('[TCK-DMLX-18] MATCH + DELETE 空结果', async () => {
    const plan = parseQuery('MATCH (n:NonExistent) DELETE n')
    const data = [{ _label: 'Person', name: 'Alice' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(0)
  })

  it('[TCK-DMLX-19] MATCH + DETACH DELETE', async () => {
    const plan = parseQuery('MATCH (n:Person {active: false}) DETACH DELETE n')
    expect(plan.detachDelete).toBe(true)
  })

  it('[TCK-DMLX-20] MATCH + REMOVE + SET 链式 — ANTLR 原生支持', async () => {
    const plan = parseQuery('MATCH (n:Person) REMOVE n.temp SET n.finalized = true')
    expect(plan).toBeDefined()
    expect(plan.type).toBe('MATCH_MODIFY')
  })

  it('[TCK-DMLX-21] SET 字符串属性值', async () => {
    const plan = parseQuery('MATCH (n:Person) SET n.name = "New Name"')
    expect(plan.setClauses![0].value).toBe('New Name')
  })

  it('[TCK-DMLX-22] SET 布尔属性值', async () => {
    const plan = parseQuery('MATCH (n:Person) SET n.active = true')
    expect(plan.setClauses![0].value).toBe(true)
  })

  it('[TCK-DMLX-23] MATCH + SET + WHERE', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.id = 42 SET n.processed = true')
    expect(plan.setClauses).toBeDefined()
    expect(plan.filters).toBeDefined()
  })

  it('[TCK-DMLX-24] MERGE 多属性唯一键', async () => {
    const plan = parseQuery('MERGE (n:Person {firstName: "Alice", lastName: "Smith"})')
    expect(plan.mergeNodes!.length).toBeGreaterThan(0)
  })

  it('[TCK-DMLX-25] DETACH DELETE 执行', async () => {
    const plan = parseQuery('MATCH (n:Person) DETACH DELETE n')
    const data = [{ _label: 'Person', name: 'Alice' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })
})
