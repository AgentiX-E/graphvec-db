/**
 * ORDER BY 组合测试 — ORDER BY + LIMIT / SKIP 组合
 *
 * 覆盖：
 *   - ORDER BY + LIMIT 组合（排序后截断）
 *   - ORDER BY + SKIP + LIMIT 组合（排序后跳过再截断）
 *   - ORDER BY 多列 + LIMIT
 *   - ORDER BY + WHERE + LIMIT 组合
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ═══════════════════════════════════════════════════════
// ORDER BY 组合测试
// ═══════════════════════════════════════════════════════

describe('ORDER BY 组合测试', () => {
  // 共享测试数据
  const nodes = [
    { id: 1, name: 'Alice', age: 30, score: 95 },
    { id: 2, name: 'Bob', age: 25, score: 80 },
    { id: 3, name: 'Carol', age: 35, score: 90 },
    { id: 4, name: 'Dave', age: 20, score: 85 },
    { id: 5, name: 'Eve', age: 28, score: 88 },
    { id: 6, name: 'Frank', age: 32, score: 92 },
  ]

  // ── ORDER BY + LIMIT ──

  it('ORDER BY n.age DESC + LIMIT 3 — 取年龄最大的 3 人', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name, n.age ORDER BY n.age DESC LIMIT 3',
    )
    const result = _executeQuery(plan, nodes)

    expect(result).toHaveLength(3)
    // 年龄最大的 3 人: Carol(35), Frank(32), Alice(30)
    expect(result[0].age).toBe(35) // Carol
    expect(result[1].age).toBe(32) // Frank
    expect(result[2].age).toBe(30) // Alice
  })

  it('ORDER BY n.score ASC + LIMIT 2 — 取分数最低的 2 人', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name, n.score ORDER BY n.score ASC LIMIT 2',
    )
    const result = _executeQuery(plan, nodes)

    expect(result).toHaveLength(2)
    // 分数最低的 2 人: Bob(80), Dave(85)
    expect(result[0].score).toBe(80) // Bob
    expect(result[1].score).toBe(85) // Dave
  })

  // ── ORDER BY + SKIP + LIMIT ──

  it('ORDER BY n.age ASC + SKIP 2 + LIMIT 2 — 跳过头 2 名取第 3-4 名', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name, n.age ORDER BY n.age ASC SKIP 2 LIMIT 2',
    )
    const result = _executeQuery(plan, nodes)

    expect(result).toHaveLength(2)
    // 年龄排序: Dave(20), Bob(25), Eve(28), Alice(30), Frank(32), Carol(35)
    // SKIP 2 + LIMIT 2 → [Eve(28), Alice(30)]
    expect(result[0].age).toBe(28) // Eve
    expect(result[1].age).toBe(30) // Alice
  })

  // ── ORDER BY 多列 + LIMIT ──

  it('ORDER BY n.age DESC, n.score ASC + LIMIT 2 — 二级排序后截断取前 2', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name, n.age, n.score ORDER BY n.age DESC, n.score ASC LIMIT 2',
    )
    const result = _executeQuery(plan, nodes)

    expect(result).toHaveLength(2)
    // 年龄降序: 35→Carol(90), 32→Frank(92), 30→Alice(95), 28→Eve(88), 25→Bob(80), 20→Dave(85)
    // LIMIT 2 → [Carol, Frank]
    expect(result[0].name).toBe('Carol')
    expect(result[1].name).toBe('Frank')
  })

  // ── ORDER BY + WHERE + LIMIT ──

  it('ORDER BY 与 WHERE 组合 — 先过滤再排序', () => {
    const plan = parseQuery(
      'MATCH (n) WHERE n.age >= 28 RETURN n.name, n.age ORDER BY n.age ASC',
    )
    const result = _executeQuery(plan, nodes)

    // 过滤 age >= 28: Eve(28), Alice(30), Frank(32), Carol(35)
    expect(result).toHaveLength(4)
    // 按 age ASC 排序
    expect(result[0].age).toBe(28) // Eve
    expect(result[1].age).toBe(30) // Alice
    expect(result[2].age).toBe(32) // Frank
    expect(result[3].age).toBe(35) // Carol
  })

  it('ORDER BY n.score DESC + WHERE + LIMIT — 过滤后取分数最高 3 人', () => {
    const plan = parseQuery(
      'MATCH (n) WHERE n.age >= 25 RETURN n.name, n.age, n.score ORDER BY n.score DESC LIMIT 3',
    )
    const result = _executeQuery(plan, nodes)

    // 过滤 age >= 25: Alice(30/95), Bob(25/80), Carol(35/90), Eve(28/88), Frank(32/92)
    // 按 score DESC LIMIT 3: Alice(95), Frank(92), Carol(90)
    expect(result).toHaveLength(3)
    expect(result[0].score).toBe(95) // Alice
    expect(result[1].score).toBe(92) // Frank
    expect(result[2].score).toBe(90) // Carol
  })

  // ── ORDER BY 子查询 RETURN 列名（非属性路径） ──

  it('ORDER BY 子查询的列名（非属性路径）— 按 RETURN 列名排序', () => {
    // RETURN n.name AS personName 将 ORDER BY personAge 解释为
    // 对 RETURN 投影列的引用（解析为 IDENTIFIER）
    const plan = parseQuery(
      'MATCH (n) RETURN n.name AS personName, n.age AS personAge ORDER BY personAge DESC',
    )

    // verify parse: orderBy 使用 personAge（别名）作为 column
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('personAge')
    expect(plan.orderBy[0].direction).toBe('DESC')
  })

  it('ORDER BY 别名 — 使用 AS 别名排序', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.age AS a, n.name AS nm ORDER BY nm ASC',
    )

    // verify parse: orderBy 使用 nm（别名）作为 column
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('nm')
    expect(plan.orderBy[0].direction).toBe('ASC')
  })

  it('ORDER BY 别名 + LIMIT — 别名排序后截断', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.score AS s, n.name AS nm ORDER BY s DESC LIMIT 3',
    )

    // verify parse: orderBy 使用 s（别名）作为 column
    expect(plan.orderBy).toHaveLength(1)
    expect(plan.orderBy[0].property).toBe('s')
    expect(plan.orderBy[0].direction).toBe('DESC')
  })
})
