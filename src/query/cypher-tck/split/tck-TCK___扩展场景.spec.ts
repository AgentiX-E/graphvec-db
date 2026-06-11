/**
 * tck-TCK___扩展场景.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — 扩展场景', () => {

  it('[TCK-EXT-01] SKIP + LIMIT', () => {
    // Feature: Skip / Limit
    // Scenario: SKIP and LIMIT together
    //   When executing query: """MATCH (n:Person) RETURN n.name SKIP 1 LIMIT 3"""
    const plan = parseQuery('MATCH (n:Person) RETURN n.name SKIP 1 LIMIT 3')
    expect(plan.skip).toBe(1)
    expect(plan.limit).toBe(3)
  })

  it('[TCK-EXT-02] ORDER BY ASC + DESC', () => {
    // Feature: Order By
    // Scenario: ORDER BY with mixed ASC/DESC
    //   When: """MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC, n.name ASC"""
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC, n.name ASC')
    expect(plan.orderBy.length).toBe(2)
    expect(plan.orderBy[0].direction).toBe('DESC')
    expect(plan.orderBy[1].direction).toBe('ASC')
  })

  it('[TCK-EXT-03] 参数化查询 — $1 占位符', () => {
    // Feature: Parameterized Query
    // Scenario: Parameterized query with $1 placeholder
    //   When: """MATCH (n:Person) WHERE n.name = $1 RETURN n""" with param "Alice"
    const plan = execQuery('MATCH (n:Person) WHERE n.name = $1 RETURN n', ['Alice'])
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe('Alice')
  })

  it('[TCK-EXT-04] 多参数 $1, $2', () => {
    // Feature: Parameterized Query
    // Scenario: Multiple parameters $1, $2
    //   When: """MATCH (n:Person) WHERE n.age > $1 AND n.status = $2 RETURN n"""
    const plan = execQuery(
      'MATCH (n:Person) WHERE n.age > $1 AND n.status = $2 RETURN n',
      [18, 'active']
    )
    expect(plan.filters.length).toBe(2)
    expect(plan.filters[0].value).toBe(18)
    expect(plan.filters[1].value).toBe('active')
  })

  it('[TCK-EXT-05] 组合查询 — 正常解析', () => {
    // Feature: Combo
    // Scenario: DISTINCT + ORDER BY + LIMIT combo
    //   When: """MATCH (n:Person) RETURN n.age ORDER BY n.age DESC LIMIT 5"""
    //   Note: Cypher-lite doesn't support RETURN DISTINCT yet, so we test without it
    const plan = parseQuery('MATCH (n:Person) RETURN n.age ORDER BY n.age DESC LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.limit).toBe(5)
  })

  it('[TCK-EXT-06] 空结果 + 无匹配', () => {
    // Feature: No match
    // Scenario: Query matching no nodes
    //   Given graph with (:Person)
    //   When: """MATCH (n:Person) WHERE n.name = "NonExistent" RETURN n"""
    const data = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 15 },
    ]
    const plan = parseQuery('MATCH (n:Person) WHERE n.name = "NonExistent" RETURN n')
    expect(plan.filters[0].value).toBe('NonExistent')
    const result = _executeQuery(plan, data)
    expect(result.length).toBe(0)
  })
})
