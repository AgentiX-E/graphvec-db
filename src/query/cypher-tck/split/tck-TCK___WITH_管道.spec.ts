/**
 * tck-TCK___WITH_管道.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — WITH 管道', () => {

  it('[TCK-WITH-01] WITH 简单投影', async () => {
    // Feature: With
    // Scenario: Simple WITH projection
    //   When executing query: """MATCH (n:Person) WITH n.name AS name RETURN name"""
    const plan = parseQuery('MATCH (n:Person) WITH n.name AS name RETURN name')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITH-02] WITH WHERE 过滤', async () => {
    // Feature: With
    // Scenario: WITH WHERE filter
    //   When executing query: """MATCH (n:Person) WITH n WHERE n.age > 18 RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WITH n WHERE n.age > 18 RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITH-03] WITH ORDER BY + LIMIT', async () => {
    // Feature: With
    // Scenario: WITH ORDER BY
    //   When executing query: """MATCH (n:Person) WITH n ORDER BY n.name SKIP 1 LIMIT 2 RETURN n"""
    const plan = parseQuery('MATCH (n:Person) WITH n ORDER BY n.name SKIP 1 LIMIT 2 RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITH-04] WITH 聚合', async () => {
    // Feature: With
    // Scenario: WITH aggregation
    //   When executing query: """MATCH (n:Person) WITH n.age AS age, count(*) AS cnt RETURN age, cnt"""
    const plan = parseQuery('MATCH (n:Person) WITH n.age AS age, count(*) AS cnt RETURN age, cnt')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITH-05] WITH DISTINCT', async () => {
    // Feature: With
    // Scenario: WITH DISTINCT
    //   When executing query: """MATCH (n:Person) WITH DISTINCT n.age AS age RETURN age"""
    const plan = parseQuery('MATCH (n:Person) WITH DISTINCT n.age AS age RETURN age')
    expect(plan).toBeDefined()
  })

  it('[TCK-WITH-06] WITH 链式传递', async () => {
    // Feature: With
    // Scenario: Chained WITH
    //   When executing query: """MATCH (n:Person) WITH n WHERE n.age > 18 WITH n.name AS name RETURN name"""
    const plan = parseQuery('MATCH (n:Person) WITH n WHERE n.age > 18 WITH n.name AS name RETURN name')
    expect(plan).toBeDefined()
  })
})
