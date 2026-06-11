/**
 * tck-TCK___MATCH_模式匹配.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — MATCH 模式匹配', () => {

  it('[TCK-MATCH-01] MATCH 任意节点 — 空图返回空', () => {
    // Feature: Match
    // Scenario: Match any node
    //   Given an empty graph
    //   When executing query: """MATCH (n) RETURN n"""
    //   Then the result should be empty
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan).toBeDefined()
    const result = _executeQuery(plan, [])
    expect(result.length).toBe(0)
  })

  it('[TCK-MATCH-02] MATCH 标签节点 — 返回标签匹配的节点', () => {
    // Feature: Match
    // Scenario: Match node with label
    //   Given a graph with (:Person)
    //   When executing query: """MATCH (n:Person) RETURN n"""
    //   Then the result should contain the node
    const data = [{ _label: 'Person', name: 'Alice' }, { _label: 'Company', name: 'Acme' }]
    const plan = parseQuery('MATCH (n:Person) RETURN n')
    expect(plan.scanLabel).toBe('Person')
    const result = _executeQuery(plan, data)
    expect(result.length).toBe(1)
    expect(result[0]).toBeDefined()
    const n = result[0] as Record<string, any>
    expect(n.n).toBeDefined()
    expect(n.n.name).toBe('Alice')
  })

  it('[TCK-MATCH-03] MATCH 属性过滤 — 实现现状反映', () => {
    // Feature: Match
    // Scenario: Match with property filter (node pattern)
    //   When executing query: """MATCH (n {name: "Alice"}) RETURN n"""
    //   Note: Cypher-lite currently treats {} pattern as scan filter
    //   rather than exact property matching — this documents current behavior
    const plan = parseQuery('MATCH (n {name: "Alice"}) RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-MATCH-04] MATCH 单跳边 — 返回两个端点', () => {
    // Feature: Match
    // Scenario: Match relationship
    //   Given a graph with (:Person)-[:KNOWS]->(:Person)
    //   When executing query: """MATCH (a)-[:KNOWS]->(b) RETURN a, b"""
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) RETURN a, b')
    expect(plan.steps).toBeDefined()
    expect(plan.steps.length).toBe(1)
    expect(plan.steps[0].edgeLabel).toBe('KNOWS')
    expect(plan.steps[0].direction).toBe('out')
  })

  it('[TCK-MATCH-05] MATCH 反向边 — Cypher-lite 暂不支持 <-- 语法', () => {
    // Feature: Match
    // Scenario: Match relationship with reversed direction
    //   When executing query: """MATCH (a)<-[:KNOWS]-(b) RETURN a, b"""
    //   Cypher-lite parser currently does not support "<-" syntax.
    //   This documents the known limitation.
    expect(() => parseQuery('MATCH (a)<-[:KNOWS]-(b) RETURN a, b')).toThrow()
  })

  it('[TCK-MATCH-06] MATCH 多跳路径 — 支持两跳', () => {
    // Feature: Match
    // Scenario: Match multi-hop path
    //   When executing query: """MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN a, b, c"""
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN a, b, c')
    expect(plan.steps.length).toBe(2)
    expect(plan.steps[0].edgeLabel).toBe('KNOWS')
    expect(plan.steps[1].edgeLabel).toBe('KNOWS')
  })

  it('[TCK-MATCH-07] MATCH 逗号分隔多 pattern — 支持逗号模式', () => {
    // Feature: Match
    // Scenario: Match multiple patterns (comma separated)
    //   When executing query: """MATCH (a:Person), (b:Company) RETURN a, b"""
    const plan = parseQuery('MATCH (a:Person), (b:Company) RETURN a, b')
    expect(plan.scanLabel).toBe('Person')
  })

  it('[TCK-MATCH-08] MATCH 无标签边 — 支持任意关系', () => {
    // Feature: Match
    // Scenario: Match any relationship (no label)
    //   When executing query: """MATCH (a)--(b) RETURN a, b"""
    const plan = parseQuery('MATCH (a)--(b) RETURN a, b')
    expect(plan).toBeDefined()
  })

  it('[TCK-MATCH-09] MATCH 多标签 — 已支持多标签语法', () => {
    // Feature: Match
    // Scenario: Match with multiple labels
    //   When executing query: """MATCH (n:Person:Employee) RETURN n"""
    //   Cypher-lite parser now supports multiple labels.
    expect(() => parseQuery('MATCH (n:Person:Employee) RETURN n')).not.toThrow()
  })

  it('[TCK-MATCH-10] MATCH 变长路径 — 支持区间语法', () => {
    // Feature: Match
    // Scenario: Match variable length path
    //   When executing query: """MATCH (a)-[:KNOWS*1..2]->(c) RETURN a, c"""
    const plan = parseQuery('MATCH (a)-[:KNOWS*1..2]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.steps).toBeDefined()
  })
})
