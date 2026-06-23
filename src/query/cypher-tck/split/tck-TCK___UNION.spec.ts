/**
 * tck-TCK___UNION.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — UNION', () => {

  it('[TCK-UNION-01] UNION 合并结果', async () => {
    // Feature: Union
    // Scenario: UNION combines results
    //   When: """MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name"""
    const plan = parseQuery(
      'MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name'
    )
    expect(plan).toBeDefined()
    expect(plan.unionType).toBe('union')
  })

  it('[TCK-UNION-02] UNION ALL 保留重复', async () => {
    // Feature: Union
    // Scenario: UNION ALL retains duplicates
    //   When: """MATCH (a:Person) RETURN a.name UNION ALL MATCH (b:Person) RETURN b.name"""
    const plan = parseQuery(
      'MATCH (a:Person) RETURN a.name UNION ALL MATCH (b:Person) RETURN b.name'
    )
    expect(plan).toBeDefined()
    expect(plan.unionType).toBe('union_all')
  })

  it('[TCK-UNION-03] UNION 各部分独立 WHERE', async () => {
    // Feature: Union
    // Scenario: UNION with WHERE on each part
    //   When: """MATCH (a:Person) WHERE a.age > 18 RETURN a.name UNION MATCH (b:Person) WHERE b.age < 65 RETURN b.name"""
    const plan = parseQuery(
      'MATCH (a:Person) WHERE a.age > 18 RETURN a.name UNION MATCH (b:Person) WHERE b.age < 65 RETURN b.name'
    )
    expect(plan).toBeDefined()
  })

  it('[TCK-UNION-04] UNION 末尾 ORDER BY', async () => {
    // Feature: Union
    // Scenario: UNION with ORDER BY at end
    //   When: """MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name ORDER BY name"""
    const plan = parseQuery(
      'MATCH (a:Person) RETURN a.name AS name UNION MATCH (b:Company) RETURN b.name AS name ORDER BY name'
    )
    expect(plan).toBeDefined()
  })
})
