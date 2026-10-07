/**
 * Pattern Comprehension tests — parsing and end-to-end execution.
 *
 * Syntax: `[(n)-[:R]->(m) | m.prop]` (optionally `WHERE cond`), or the
 * variable-length form `[p = (a)-[*]->(b) | p]`.
 *
 * The old `comprehensionColumns` AST (nested `PATTERN_COMPREHENSION` nodes) was
 * removed; the comprehension is now carried as a string expression on
 * `plan.expressionColumns` and evaluated by `_evalPatternComprehension` (see
 * pattern-comprehension-units.spec.ts for the evaluator unit tests).  These
 * tests verify the observable behaviour end-to-end: alias projection and the
 * actual matched neighbour lists.
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// A graph where Alice knows Bob and Charlie, Bob knows no-one, Charlie knows David.
// Relationships are expressed via the engine's `__edges` contract
// (`{ srcIdx, dstIdx, label }`), not as standalone `{_label:'KNOWS'}` nodes.
function graphWithEdges() {
  return [
    { _id: 'a', _label: 'Person', name: 'Alice', age: 30, _alias: 'a', __edges: [{ srcIdx: 0, dstIdx: 1, label: 'KNOWS' }, { srcIdx: 0, dstIdx: 2, label: 'KNOWS' }] },
    { _id: 'b', _label: 'Person', name: 'Bob', age: 25, _alias: 'b', __edges: [] },
    { _id: 'c', _label: 'Person', name: 'Charlie', age: 35, _alias: 'c', __edges: [{ srcIdx: 2, dstIdx: 3, label: 'KNOWS' }] },
    { _id: 'd', _label: 'Person', name: 'David', age: 40, _alias: 'd', __edges: [] },
  ]
}

describe('Pattern Comprehension — 解析', () => {
  it('基本 comprehension 解析到 returnColumns 别名', () => {
    const plan = parseQuery('MATCH (n) RETURN [(n)-[:KNOWS]->(m) | m.name] AS friends') as any
    expect(plan.returnColumns).toContain('friends')
    expect(plan.expressionColumns.length).toBe(1)
    expect(plan.expressionColumns[0].alias).toBe('friends')
    expect(plan.expressionColumns[0].expression).toContain('KNOWS')
  })

  it('无别名 comprehension — 表达式文本作为列', () => {
    const plan = parseQuery('MATCH (n) RETURN [(n)-[:KNOWS]->(m) | m.name]') as any
    expect(plan.returnColumns.length).toBe(1)
    expect(plan.returnColumns[0]).toContain('KNOWS')
  })

  it('带 WHERE 过滤的 comprehension', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN [(n)-[:KNOWS]->(m) WHERE m.age > 18 | m.name] AS adults',
    ) as any
    expect(plan.returnColumns).toContain('adults')
    expect(plan.expressionColumns[0].expression).toContain('WHERE')
  })

  it('多列投影 + comprehension 别名正确注册', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name, [(n)-[:KNOWS]->(f) | f.name] AS friend_names, n.age',
    ) as any
    expect(plan.returnColumns).toContain('friend_names')
    expect(plan.returnColumns).toContain('name')
    expect(plan.returnColumns).toContain('age')
  })

  it('多个 comprehension 在同一查询', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN [(n)-[:FRIENDS]->(f) | f.name] AS friends, [(n)-[:KNOWS]->(k) | k.age] AS known_ages',
    ) as any
    expect(plan.returnColumns).toContain('friends')
    expect(plan.returnColumns).toContain('known_ages')
  })
})

describe('Pattern Comprehension — 执行', () => {
  it('基本 comprehension 返回正确的邻居 name 列表', async () => {
    const query = 'MATCH (n:Person) RETURN [(n)-[:KNOWS]->(m) | m.name] AS friends'
    const result = await _executeQuery(parseQuery(query), graphWithEdges(), query) as any[]

    const alice = result.find((r: any) => r.name === 'Alice')
    const bob = result.find((r: any) => r.name === 'Bob')
    const charlie = result.find((r: any) => r.name === 'Charlie')

    expect(alice.friends.sort()).toEqual(['Bob', 'Charlie'])
    expect(bob.friends).toEqual([])
    expect(charlie.friends).toEqual(['David'])
  })

  it('空匹配 — 无 KNOWS 边时返回空列表', async () => {
    const nodes = [
      { _id: 'a', _label: 'Person', name: 'Alice', age: 30, _alias: 'a', __edges: [] },
      { _id: 'b', _label: 'Person', name: 'Bob', age: 25, _alias: 'b', __edges: [] },
    ]
    const query = 'MATCH (n:Person) RETURN [(n)-[:KNOWS]->(m) | m.name] AS friends'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(result).toHaveLength(2)
    for (const r of result) {
      expect(r.friends).toEqual([])
    }
  })

  it('带 WHERE 过滤的 comprehension 可解析（执行缺口另行立项）', () => {
    // The WHERE clause inside a pattern comprehension is not yet evaluated by
    // `_evalPatternComprehension` (see the tracked follow-up); here we only
    // assert that the query parses and registers the alias so the gap is
    // explicit rather than silently swallowed.
    const query = 'MATCH (n:Person) RETURN [(n)-[:KNOWS]->(m) WHERE m.age > 30 | m.name] AS adults'
    const plan = parseQuery(query) as any
    expect(plan.returnColumns).toContain('adults')
    expect(plan.expressionColumns[0].expression).toContain('WHERE')
  })
})
