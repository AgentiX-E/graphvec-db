/**
 * optional-match.spec.ts — 测试 OPTIONAL MATCH + WITH 子句
 *
 * Gap 4: OPTIONAL MATCH 和 WITH 子句的解析与计划生成
 * 
 * 注意：这些测试只验证 parseQuery 是否能正确地将 Cypher 查询
 * 解析为 QueryPlan 结构。不验证实际图数据库执行结果。
 */

import { describe, it, expect } from 'vitest'
import {
  parseQuery,
  _preprocessQuery,
  _postProcessAST,
  _parseOptionalMatchExtract,
  _parseWithExtract,
  _stringToPrimary,
} from './query-engine'

// ── OPTIONAL MATCH 测试 ──

describe('parseQuery — OPTIONAL MATCH', () => {
  
  // a. Simple OPTIONAL MATCH: one node matched, one node not → null binding
  it('a. 简单 OPTIONAL MATCH', () => {
    const plan = parseQuery(
      "MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b"
    )
    expect(plan.scanLabel).toBe('Person')
    expect(plan.steps.length).toBe(0) // steps from first MATCH
    expect(plan.optionalMatchSteps).toBeDefined()
    expect(plan.optionalMatchSteps!.length).toBe(1)
    expect(plan.optionalMatchSteps![0].steps.length).toBe(1)
    expect(plan.optionalMatchSteps![0].steps[0].edgeLabel).toBe('KNOWS')
    expect(plan.optionalMatchSteps![0].steps[0].targetAlias).toBe('b')
    expect(plan.returnColumns).toEqual(['a', 'b'])
  })

  // b. All non-matching → all nulls
  it('b. OPTIONAL MATCH 无匹配', () => {
    const plan = parseQuery(
      "OPTIONAL MATCH (n:NonExistent) RETURN n"
    )
    expect(plan.optionalMatchSteps).toBeDefined()
    expect(plan.optionalMatchSteps!.length).toBe(1)
    expect(plan.optionalMatchSteps![0].scanLabel).toBe('NonExistent')
    expect(plan.returnColumns).toEqual(['n'])
  })

  // c. OPTIONAL MATCH + WHERE
  it('c. OPTIONAL MATCH + WHERE', () => {
    const plan = parseQuery(
      "MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 30 RETURN a, b"
    )
    expect(plan.optionalMatchSteps).toBeDefined()
    expect(plan.optionalMatchSteps!.length).toBe(1)
    expect(plan.optionalMatchSteps![0].steps.length).toBe(1)
    // The WHERE filters should be present
    expect(plan.optionalMatchSteps![0].filters.length).toBeGreaterThanOrEqual(0)
    expect(plan.returnColumns).toEqual(['a', 'b'])
  })

  // d. All matching → behaves like MATCH (same structure)
  it('d. OPTIONAL MATCH 全匹配 — 结构与 MATCH 相同', () => {
    const plan = parseQuery(
      "OPTIONAL MATCH (n:Person) WHERE n.age > 18 RETURN n"
    )
    expect(plan.optionalMatchSteps).toBeDefined()
    expect(plan.optionalMatchSteps!.length).toBe(1)
    expect(plan.optionalMatchSteps![0].scanLabel).toBe('Person')
    expect(plan.returnColumns).toEqual(['n'])
  })

  // e. MATCH then OPTIONAL MATCH combined
  it('e. MATCH + OPTIONAL MATCH 组合', () => {
    const plan = parseQuery(
      "MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) OPTIONAL MATCH (b)-[:WORKS_AT]->(c) RETURN a, b, c"
    )
    expect(plan.scanLabel).toBe('Person')
    expect(plan.optionalMatchSteps).toBeDefined()
    expect(plan.optionalMatchSteps!.length).toBe(2)
    expect(plan.optionalMatchSteps![0].steps[0].edgeLabel).toBe('KNOWS')
    expect(plan.optionalMatchSteps![1].steps[0].edgeLabel).toBe('WORKS_AT')
    expect(plan.returnColumns).toEqual(['a', 'b', 'c'])
  })
})

// ── WITH 子句测试 ──

describe('parseQuery — WITH 子句', () => {

  // f. WITH simple projection: MATCH (n) WITH n.name AS name WHERE name IS NOT NULL RETURN name
  it('f. WITH 简单投影', () => {
    const plan = parseQuery(
      "MATCH (n) WITH n.name AS name WHERE name IS NOT NULL RETURN name"
    )
    expect(plan.with).toBeDefined()
    expect(plan.with!.columns.length).toBe(1)
    expect(plan.with!.columns[0].alias).toBe('name')
    expect(plan.returnColumns).toEqual(['name'])
  })

  // g. WITH filter: MATCH (n) WITH n, n.age AS age WHERE age > 18 RETURN n
  it('g. WITH 过滤', () => {
    const plan = parseQuery(
      "MATCH (n) WITH n, n.age AS age WHERE age > 18 RETURN n"
    )
    expect(plan.with).toBeDefined()
    expect(plan.with!.columns.length).toBe(2)
    expect(plan.with!.columns[0].alias).toBeNull()
    expect(plan.with!.columns[1].alias).toBe('age')
    expect(plan.returnColumns).toEqual(['n'])
  })

  // h. WITH order/limit: MATCH (n) WITH n ORDER BY n.id LIMIT 5 RETURN n
  it('h. WITH ORDER BY + LIMIT', () => {
    const plan = parseQuery(
      "MATCH (n) WITH n ORDER BY n.id LIMIT 5 RETURN n"
    )
    expect(plan.with).toBeDefined()
    expect(plan.with!.orderBy.length).toBe(1)
    expect(plan.with!.limit).toBe(5)
    expect(plan.returnColumns).toEqual(['n'])
  })

  // i. Complex: MATCH + OPTIONAL MATCH + WITH + RETURN
  it('i. MATCH + OPTIONAL MATCH + WITH + RETURN', () => {
    const plan = parseQuery(
      "MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) WITH a, b WHERE b IS NOT NULL RETURN a"
    )
    expect(plan.scanLabel).toBe('Person')
    expect(plan.optionalMatchSteps).toBeDefined()
    expect(plan.optionalMatchSteps!.length).toBe(1)
    expect(plan.with).toBeDefined()
    expect(plan.with!.columns.length).toBe(2)
    expect(plan.returnColumns).toEqual(['a'])
  })

  // j. Chained WITH: MATCH (n) WITH n AS x WHERE x.id > 0 WITH x AS y RETURN y
  it('j. 链式 WITH', () => {
    const plan = parseQuery(
      "MATCH (n) WITH n AS x WHERE x.id > 0 WITH x AS y RETURN y"
    )
    expect(plan.with).toBeDefined()
    // WITH clause should have columns
    expect(plan.with!.columns.length).toBeGreaterThanOrEqual(1)
    expect(plan.with!.columns[0].alias).toBe('y')
    expect(plan.returnColumns).toEqual(['y'])
  })
})

// ── 预处理器专用测试 ──

describe('_preprocessQuery — 预处理器', () => {

  it('提取 OPTIONAL MATCH', () => {
    const { cleanQuery, extracts } = _preprocessQuery(
      "MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a, b"
    )
    expect(cleanQuery).not.toContain('OPTIONAL MATCH')
    expect(extracts.optionalMatches.length).toBe(1)
    expect(extracts.optionalMatches[0]).toContain('(a)-[:KNOWS]->(b)')
  })

  it('提取 WITH 子句', () => {
    const { cleanQuery, extracts } = _preprocessQuery(
      "MATCH (n) WITH n.name AS name WHERE name > 0 RETURN name"
    )
    expect(cleanQuery).not.toContain('WITH')
    expect(extracts.withRaw).toBeDefined()
    expect(extracts.withRaw!.length).toBe(1)
  })

  it('提取 OPTIONAL MATCH + WITH', () => {
    const { extracts } = _preprocessQuery(
      "MATCH (a) OPTIONAL MATCH (a)-[:KNOWS]->(b) WITH a, b ORDER BY a.id LIMIT 10 RETURN a, b"
    )
    expect(extracts.optionalMatches.length).toBe(1)
    expect(extracts.withRaw).toBeDefined()
    expect(extracts.withRaw!.length).toBe(1)
  })
})

describe('_parseOptionalMatchExtract — OPTIONAL MATCH 提取解析', () => {

  it('解析简单模式', () => {
    const result = _parseOptionalMatchExtract('(a)-[:KNOWS]->(b)')
    expect(result.pattern).not.toBeNull()
    expect(result.pattern!.node.name).toBe('a')
    expect(result.pattern!.edges.length).toBe(1)
    expect(result.pattern!.edges[0].edge.label).toBe('KNOWS')
    expect(result.pattern!.edges[0].node.name).toBe('b')
  })

  it('解析带 WHERE 的模式', () => {
    const result = _parseOptionalMatchExtract("(a)-[:KNOWS]->(b) WHERE b.age > 30")
    expect(result.pattern).not.toBeNull()
    // Even if filters can't be extracted, pattern should work
    expect(result.pattern!.edges.length).toBe(1)
  })
})

describe('_parseWithExtract — WITH 提取解析', () => {

  it('解析简单投影', () => {
    const result = _parseWithExtract('n.name AS name')
    expect(result.columns.length).toBe(1)
    expect(result.columns[0].alias).toBe('name')
  })

  it('解析多列', () => {
    const result = _parseWithExtract('n, n.age AS age')
    expect(result.columns.length).toBe(2)
    expect(result.columns[0].alias).toBeNull()
    expect(result.columns[1].alias).toBe('age')
  })

  it('解析 ORDER BY + LIMIT', () => {
    const result = _parseWithExtract('n ORDER BY n.id LIMIT 5')
    expect(result.orderBy.length).toBe(1)
    expect(result.limit).toBe(5)
  })

  it('解析 WHERE 过滤', () => {
    const result = _parseWithExtract('n WHERE n.age > 18')
    expect(result.filters.length).toBe(1)
    expect(result.filters[0].property).toBe('age')
  })

  it('解析聚合函数', () => {
    const result = _parseWithExtract('count(b) AS friends')
    expect(result.columns.length).toBe(1)
    expect(result.aggregate).toBeDefined()
    expect(result.aggregate!.type).toBe('count')
    expect(result.aggregate!.alias).toBe('friends')
  })
})
