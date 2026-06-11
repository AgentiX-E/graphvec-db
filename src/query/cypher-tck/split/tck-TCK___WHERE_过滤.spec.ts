/**
 * tck-TCK___WHERE_过滤.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — WHERE 过滤', () => {

  it('[TCK-WHERE-01] WHERE 相等比较 — 字符串相等', () => {
    // Feature: Where
    // Scenario: Equality comparison
    //   Given a graph with (:Person {name: "Alice"})
    //   When executing query: """MATCH (n:Person) WHERE n.name = "Alice" RETURN n"""
    //   Then result should contain Alice
    const plan = parseQuery('MATCH (n:Person) WHERE n.name = "Alice" RETURN n')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.filters[0].operator).toBe('EQ')
    expect(plan.filters[0].value).toBe('Alice')
    const data = [{ _label: 'Person', name: 'Alice', age: 30 }]
    const result = _executeQuery(plan, data)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const row = result[0] as Record<string, any>
    expect(row.n.name).toBe('Alice')
  })

  it('[TCK-WHERE-02] WHERE 大于比较 — 数字比较', () => {
    // Feature: Where
    // Scenario: Greater than comparison
    //   Given a graph with (:Person {age: 35})
    //   When executing query: """MATCH (n:Person) WHERE n.age > 30 RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 30 RETURN n')
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.filters[0].operator).toBe('GT')
    const data = [{ _label: 'Person', name: 'Alice', age: 35 }]
    const result = _executeQuery(plan, data)
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('[TCK-WHERE-03] WHERE 小于比较 — 数字比较', () => {
    // Feature: Where
    // Scenario: Less than comparison
    //   When executing query: """MATCH (n:Person) WHERE n.age < 25 RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WHERE n.age < 25 RETURN n')
    expect(plan.filters[0].operator).toBe('LT')
    const data = [
      { _label: 'Person', name: 'Young', age: 20 },
      { _label: 'Person', name: 'Old', age: 40 },
    ]
    const result = _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
    expect(result[0].n.name).toBe('Young')
  })

  it('[TCK-WHERE-04] WHERE AND 复合条件', () => {
    // Feature: Where
    // Scenario: AND conjunction
    //   When executing query: """MATCH (n:Person) WHERE n.age > 18 AND n.status = "active" RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 AND n.status = "active" RETURN n')
    expect(plan.filters.length).toBe(2)
    const data = [
      { _label: 'Person', name: 'A', age: 25, status: 'active' },
      { _label: 'Person', name: 'B', age: 17, status: 'active' },
      { _label: 'Person', name: 'C', age: 25, status: 'inactive' },
    ]
    const result = _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
    expect(result[0].n.name).toBe('A')
  })

  it('[TCK-WHERE-05] WHERE OR 复合条件', () => {
    // Feature: Where
    // Scenario: OR disjunction
    //   When executing query: """MATCH (n:Person) WHERE n.age > 30 OR n.status = "vip" RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 30 OR n.status = "vip" RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-WHERE-06] WHERE NOT 否定', () => {
    // Feature: Where
    // Scenario: NOT negation
    //   When executing query: """MATCH (n:Person) WHERE NOT n.name = "Alice" RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WHERE NOT n.name = "Alice" RETURN n')
    expect(plan).toBeDefined()
    expect(plan.filters.length).toBeGreaterThan(0)
  })

  it('[TCK-WHERE-07] WHERE IN 列表', () => {
    // Feature: Where
    // Scenario: IN list
    //   When executing query: """MATCH (n:Person) WHERE n.name IN ["Alice", "Bob"] RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WHERE n.name IN ["Alice", "Bob"] RETURN n')
    expect(plan).toBeDefined()
    const data = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Charlie' },
    ]
    const result = _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBeGreaterThan(0)
  })

  it('[TCK-WHERE-08] WHERE IS NOT NULL', () => {
    // Feature: Where
    // Scenario: IS NOT NULL
    //   When executing query: """MATCH (n:Person) WHERE n.name IS NOT NULL RETURN n"""
    expect(() => parseQuery('MATCH (n:Person) WHERE n.name IS NOT NULL RETURN n')).not.toThrow()
  })
})
