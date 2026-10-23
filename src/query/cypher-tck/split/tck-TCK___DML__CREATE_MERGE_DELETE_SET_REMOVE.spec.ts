/**
 * tck-TCK___DML__CREATE_MERGE_DELETE_SET_REMOVE.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — DML (CREATE/MERGE/DELETE/SET/REMOVE)', () => {

  it('[TCK-DML-01] CREATE 节点', async () => {
    // Feature: Create
    // Scenario: Create node
    //   When executing query: """CREATE (n:Person {name: "Alice"})"""
    const plan = parseQuery('CREATE (n:Person {name: "Alice"})')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes!.length).toBeGreaterThan(0)
  })

  it('[TCK-DML-02] CREATE 关系', async () => {
    // Feature: Create
    // Scenario: Create relationship
    //   When executing query: """MATCH (a:Person {name:"Alice"}), (b:Person {name:"Bob"}) CREATE (a)-[:KNOWS]->(b)"""
    const plan = parseQuery(
      'MATCH (a:Person {name: "Alice"}), (b:Person {name: "Bob"}) CREATE (a)-[:KNOWS]->(b)'
    )
    expect(plan).toBeDefined()
  })

  it('[TCK-DML-03] CREATE 并 RETURN', async () => {
    // Feature: Create
    // Scenario: Create node and return
    //   When executing query: """CREATE (n:Person {name: "Alice"}) RETURN n"""
    const plan = parseQuery('CREATE (n:Person {name: "Alice"}) RETURN n')
    expect(plan.createNodes).toBeDefined()
    expect(plan.returnColumns).toContain('n')
  })

  it('[TCK-DML-04] DELETE 节点', async () => {
    // Feature: Delete
    // Scenario: Delete node
    //   Given a graph with (:Person {name: "Alice"})
    //   When executing query: """MATCH (n:Person {name: "Alice"}) DELETE n"""
    const plan = parseQuery('MATCH (n:Person {name: "Alice"}) DELETE n')
    expect(plan).toBeDefined()
    expect(plan.deleteTargets).toBeDefined()
    expect(plan.deleteTargets!.length).toBe(1)
  })

  it('[TCK-DML-05] DETACH DELETE', async () => {
    // Feature: Delete
    // Scenario: DETACH DELETE
    //   When executing query: """MATCH (n) DETACH DELETE n"""
    const plan = parseQuery('MATCH (n) DETACH DELETE n')
    expect(plan).toBeDefined()
  })

  it('[TCK-DML-06] SET 属性', async () => {
    // Feature: Set
    // Scenario: Set property
    //   When executing query: """MATCH (n:Person {name:"Alice"}) SET n.age = 30"""
    const plan = parseQuery('MATCH (n:Person {name: "Alice"}) SET n.age = 30')
    expect(plan).toBeDefined()
    const data = [{ _label: 'Person', name: 'Alice' }]
    expect(() => _executeQuery(plan, data)).not.toThrow()
  })

  it('[TCK-DML-07] SET 多属性', async () => {
    // Feature: Set
    // Scenario: Set multiple properties
    //   When executing query: """MATCH (n:Person) SET n.name = "Bob", n.age = 25"""
    const plan = parseQuery('MATCH (n:Person) SET n.name = "Bob", n.age = 25')
    expect(plan).toBeDefined()
    expect(() => _executeQuery(plan, [{ _label: 'Person', name: 'Alice' }])).not.toThrow()
  })

  it('[TCK-DML-08] REMOVE 属性', async () => {
    // Feature: Remove
    // Scenario: Remove property
    //   When executing query: """MATCH (n:Person) REMOVE n.deprecated"""
    const plan = parseQuery('MATCH (n:Person) REMOVE n.deprecated')
    expect(plan).toBeDefined()
    const data = [{ _label: 'Person', name: 'Test', deprecated: true }]
    expect(() => _executeQuery(plan, data)).not.toThrow()
  })

  it('[TCK-DML-09] MERGE 节点', async () => {
    // Feature: Merge
    // Scenario: Merge node
    //   When executing query: """MERGE (n:Person {name: "Alice"})"""
    const plan = parseQuery('MERGE (n:Person {name: "Alice"})')
    expect(plan).toBeDefined()
    expect(plan.mergeNodes).toBeDefined()
    expect(plan.mergeNodes!.length).toBeGreaterThan(0)
  })

  it('[TCK-DML-10] MERGE ON CREATE SET', async () => {
    // Feature: Merge
    // Scenario: MERGE with ON CREATE SET
    //   When executing query: """MERGE (n:Person {name:"Alice"}) ON CREATE SET n.created = 1000"""
    expect(() => parseQuery('MERGE (n:Person {name: "Alice"}) ON CREATE SET n.created = 1000')).not.toThrow()
  })
})
