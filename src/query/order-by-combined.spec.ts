/**
 * ORDER BY combined tests — ORDER BY + LIMIT / SKIP combinations.
 *
 * Coverage:
 *   - ORDER BY + LIMIT (sort then truncate)
 *   - ORDER BY + SKIP + LIMIT (sort, skip, truncate)
 *   - ORDER BY multi-column + LIMIT
 *   - ORDER BY + WHERE + LIMIT
 *   - ORDER BY on RETURN aliases
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

describe('ORDER BY 组合测试', () => {
  // Shared test data (nodes carry `_label` and queries use MATCH (n:Person))
  const nodes = [
    { _label: 'Person', id: 1, name: 'Alice', age: 30, score: 95 },
    { _label: 'Person', id: 2, name: 'Bob', age: 25, score: 80 },
    { _label: 'Person', id: 3, name: 'Carol', age: 35, score:90 },
    { _label: 'Person', id: 4, name: 'Dave', age: 20, score: 85 },
    { _label: 'Person', id: 5, name: 'Eve', age: 28, score: 88 },
    { _label: 'Person', id: 6, name: 'Frank', age: 32, score: 92 },
  ]

  it('ORDER BY n.age DESC + LIMIT 3 — 取年龄最大的 3 人', async () => {
    const query = 'MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC LIMIT 3'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]

    expect(result).toHaveLength(3)
    // 年龄最大的 3 人: Carol(35), Frank(32), Alice(30)
    expect(result[0].age).toBe(35) // Carol
    expect(result[1].age).toBe(32) // Frank
    expect(result[2].age).toBe(30) // Alice
  })

  it('ORDER BY n.score ASC + LIMIT 2 — 取分数最低的 2 人', async () => {
    const query = 'MATCH (n:Person) RETURN n.name, n.score ORDER BY n.score ASC LIMIT 2'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]

    expect(result).toHaveLength(2)
    expect(result[0].score).toBe(80) // Bob
    expect(result[1].score).toBe(85) // Dave
  })

  it('ORDER BY n.age ASC + SKIP 2 + LIMIT 2 — 跳过头 2 名取第 3-4 名', async () => {
    const query = 'MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age ASC SKIP 2 LIMIT 2'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]

    expect(result).toHaveLength(2)
    // SKIP 2 + LIMIT 2 → [Eve(28), Alice(30)]
    expect(result[0].age).toBe(28) // Eve
    expect(result[1].age).toBe(30) // Alice
  })

  it('ORDER BY n.age DESC, n.score ASC + LIMIT 2 — 二级排序后截断取前 2', async () => {
    const query = 'MATCH (n:Person) RETURN n.name, n.age, n.score ORDER BY n.age DESC, n.score ASC LIMIT 2'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]

    expect(result).toHaveLength(2)
    // LIMIT 2 → [Carol(35), Frank(32)]
    expect(result[0].name).toBe('Carol')
    expect(result[1].name).toBe('Frank')
  })

  it('ORDER BY 与 WHERE 组合 — 先过滤再排序', async () => {
    const query = 'MATCH (n:Person) WHERE n.age >= 28 RETURN n.name, n.age ORDER BY n.age ASC'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]

    // 过滤 age >= 28: Eve(28), Alice(30), Frank(32), Carol(35)
    expect(result).toHaveLength(4)
    expect(result[0].age).toBe(28)
    expect(result[1].age).toBe(30)
    expect(result[2].age).toBe(32)
    expect(result[3].age).toBe(35)
  })

  it('ORDER BY n.score DESC + WHERE + LIMIT — 过滤后取分数最高 3 人', async () => {
    const query = 'MATCH (n:Person) WHERE n.age >= 25 RETURN n.name, n.age, n.score ORDER BY n.score DESC LIMIT 3'
    const result = await _executeQuery(parseQuery(query), nodes, query) as any[]

    // 按 score DESC LIMIT 3: Alice(95), Frank(92), Carol(90)
    expect(result).toHaveLength(3)
    expect(result[0].score).toBe(95) // Alice
    expect(result[1].score).toBe(92) // Frank
    expect(result[2].score).toBe(90) // Carol
  })

  // ── ORDER BY on RETURN aliases ──

  it('ORDER BY 子查询的列名（非属性路径）— 按 RETURN 列名排序', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name AS personName, n.age AS personAge ORDER BY personAge DESC',
    ) as any

    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('personAge')
    expect(plan.orderBy[0].direction).toBe('DESC')
  })

  it('ORDER BY 别名 — 使用 AS 别名排序', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.age AS a, n.name AS nm ORDER BY nm ASC',
    ) as any

    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('nm')
    expect(plan.orderBy[0].direction).toBe('ASC')
  })

  it('ORDER BY 别名 + LIMIT — 别名排序后截断', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.score AS s, n.name AS nm ORDER BY s DESC LIMIT 3',
    ) as any

    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('s')
    expect(plan.orderBy[0].direction).toBe('DESC')
  })
})
