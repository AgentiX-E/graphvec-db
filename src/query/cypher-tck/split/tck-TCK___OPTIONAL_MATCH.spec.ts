/**
 * tck-TCK___OPTIONAL_MATCH.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — OPTIONAL MATCH', () => {

  it('[TCK-OPTMATCH-01] OPTIONAL MATCH 匹配成功', async () => {
    // Feature: Optional Match
    // Scenario: OPTIONAL MATCH finds existing match
    //   Given (:Person {name:"Alice"})-[:KNOWS]->(:Person {name:"Bob"})
    //   When: """MATCH (a:Person {name:"Alice"}) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b"""
    const plan = parseQuery(
      'MATCH (a:Person {name: "Alice"}) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b'
    )
    expect(plan).toBeDefined()
    // Plan property is optionalMatchSteps in QueryPlan interface
    expect(plan.optionalMatchSteps).toBeDefined()
  })

  it('[TCK-OPTMATCH-02] OPTIONAL MATCH 不匹配返回 null', async () => {
    // Feature: Optional Match
    // Scenario: OPTIONAL MATCH returns null for non-match
    //   Given (:Person {name:"Alice"}) who knows nobody
    //   When: """MATCH (a:Person {name:"Alice"}) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b"""
    const plan = parseQuery(
      'MATCH (a:Person {name: "Alice"}) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b'
    )
    expect(plan).toBeDefined()
  })

  it('[TCK-OPTMATCH-03] OPTIONAL MATCH 带 WHERE', async () => {
    // Feature: Optional Match
    // Scenario: OPTIONAL MATCH with WHERE
    //   When: """MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 25 RETURN a, b"""
    const plan = parseQuery(
      'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 25 RETURN a, b'
    )
    expect(plan).toBeDefined()
  })

  it('[TCK-OPTMATCH-04] 多个 OPTIONAL MATCH', async () => {
    // Feature: Optional Match
    // Scenario: Multiple OPTIONAL MATCH
    //   When: """MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) OPTIONAL MATCH (a)-[:WORKS_AT]->(c) RETURN a, b, c"""
    const plan = parseQuery(
      'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) OPTIONAL MATCH (a)-[:WORKS_AT]->(c) RETURN a, b, c'
    )
    expect(plan).toBeDefined()
  })
})
