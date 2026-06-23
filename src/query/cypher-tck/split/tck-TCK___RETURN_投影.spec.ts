/**
 * tck-TCK___RETURN_投影.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — RETURN 投影', () => {

  it('[TCK-RETURN-01] RETURN 整个节点', async () => {
    // Feature: Return
    // Scenario: Return whole node
    //   When executing query: """MATCH (n:Person) RETURN n"""
    const plan = parseQuery('MATCH (n:Person) RETURN n')
    expect(plan.returnColumns).toContain('n')
  })

  it('[TCK-RETURN-02] RETURN 节点属性', async () => {
    // Feature: Return
    // Scenario: Return property
    //   When executing query: """MATCH (n:Person) RETURN n.name"""
    const plan = parseQuery('MATCH (n:Person) RETURN n.name')
    expect(plan.returnColumns).toContain('name')
  })

  it('[TCK-RETURN-03] RETURN 属性别名', async () => {
    // Feature: Return
    // Scenario: Return property with alias
    //   When executing query: """MATCH (n:Person) RETURN n.name AS username"""
    const plan = parseQuery('MATCH (n:Person) RETURN n.name AS username')
    expect(plan.returnColumns).toContain('username')
  })

  it('[TCK-RETURN-04] RETURN 多属性', async () => {
    // Feature: Return
    // Scenario: Return multiple properties
    //   When executing query: """MATCH (n:Person) RETURN n.name, n.age"""
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, n.age')
    expect(plan.returnColumns).toContain('name')
    expect(plan.returnColumns).toContain('age')
  })

  it('[TCK-RETURN-05] RETURN 字面量', async () => {
    // Feature: Return
    // Scenario: Return literal
    //   When executing query: """RETURN 1 as num"""
    const plan = parseQuery('RETURN 1 as num')
    expect(plan.returnColumns).toContain('num')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-RETURN-06] RETURN 字符串字面量', async () => {
    // Feature: Return
    // Scenario: Return string literal
    //   When executing query: """RETURN "hello" as greeting"""
    const plan = parseQuery('RETURN "hello" as greeting')
    expect(plan.returnColumns).toContain('greeting')
  })

  it('[TCK-RETURN-07] RETURN DISTINCT — 已支持 DISTINCT 语法', async () => {
    // Feature: Return
    // Scenario: Return distinct
    //   When executing query: """MATCH (n:Person) RETURN DISTINCT n.age"""
    //   Cypher-lite parser now supports RETURN DISTINCT syntax.
    expect(() => parseQuery('MATCH (n:Person) RETURN DISTINCT n.age')).not.toThrow()
  })

  it('[TCK-RETURN-08] RETURN 排序', async () => {
    // Feature: Return
    // Scenario: Return with ORDER BY
    //   When executing query: """MATCH (n:Person) RETURN n.name ORDER BY n.name DESC"""
    const plan = parseQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name DESC')
    expect(plan.orderBy).toBeDefined()
    expect(plan.orderBy[0].direction).toBe('DESC')
  })
})
