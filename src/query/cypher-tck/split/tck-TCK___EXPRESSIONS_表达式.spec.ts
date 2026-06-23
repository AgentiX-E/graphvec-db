/**
 * tck-TCK___EXPRESSIONS_表达式.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — EXPRESSIONS 表达式', () => {

  it('[TCK-EXPR-01] WHERE 算术加', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age + 1 > 18 RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-02] WHERE 算术减', async () => {
    expect(() => parseQuery('MATCH (n:Person) WHERE n.age - 5 < 30 RETURN n')).not.toThrow()
  })

  it('[TCK-EXPR-03] WHERE 算术乘', async () => {
    expect(() => parseQuery('MATCH (n:Person) WHERE n.age * 2 > 50 RETURN n')).not.toThrow()
  })

  it('[TCK-EXPR-04] WHERE 算术除', async () => {
    expect(() => parseQuery('MATCH (n:Person) WHERE n.age / 2 < 20 RETURN n')).not.toThrow()
  })

  it('[TCK-EXPR-05] WHERE IN 列表整数', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age IN [18, 21, 25] RETURN n')
    expect(plan).toBeDefined()
    const data = [{ _label: 'Person', age: 21 }, { _label: 'Person', age: 30 }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })

  it('[TCK-EXPR-06] WHERE IN 列表字符串', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.name IN ["Alice", "Bob"] RETURN n')
    expect(plan).toBeDefined()
    const data = [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Charlie' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })

  it('[TCK-EXPR-07] WHERE NOT IN', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE NOT n.name IN ["Alice"] RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-08] CASE WHEN 简单形式', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, CASE WHEN n.age > 18 THEN "adult" ELSE "minor" END AS category')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-09] CASE WHEN 多条件', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, CASE WHEN n.age < 18 THEN "child" WHEN n.age < 65 THEN "adult" ELSE "senior" END AS category')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-10] CASE WHEN 无 ELSE', async () => {
    const plan = parseQuery("MATCH (n:Person) RETURN n.name, CASE WHEN n.age > 18 THEN 'adult' END AS category")
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-11] CASE 简单形式', async () => {
    const plan = parseQuery("MATCH (n:Person) RETURN n.name, CASE n.age WHEN 18 THEN 'adult' WHEN 65 THEN 'senior' END AS label")
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-12] WHERE AND 两个条件', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age > 18 AND n.status = "active" RETURN n')
    expect(plan.filters.length).toBe(2)
    const data = [{ _label: 'Person', age: 25, status: 'active' }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-EXPR-13] WHERE OR 两个条件', async () => {
    // OR is now supported in the engine
    const plan = parseQuery('MATCH (n:Person) WHERE n.age < 18 OR n.age > 60 RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-14] WHERE 复合 NOT', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE NOT n.age = 25 RETURN n')
    expect(plan.filters[0].negated).toBe(true)
  })

  it('[TCK-EXPR-15] RETURN 多字面量', async () => {
    const plan = parseQuery('RETURN 1 AS a, "hello" AS b, true AS c')
    expect(plan.returnColumns).toContain('a')
    expect(plan.returnColumns).toContain('b')
    expect(plan.returnColumns).toContain('c')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-EXPR-16] RETURN 属性加字面量', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name, 42 AS constant')
    expect(plan.returnColumns).toContain('name')
    expect(plan.returnColumns).toContain('constant')
  })

  it('[TCK-EXPR-17] WHERE 属性不等于比较', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.name <> "Alice" RETURN n')
    const data = [{ _label: 'Person', name: 'Bob' }, { _label: 'Person', name: 'Alice' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
    expect(result[0].n.name).toBe('Bob')
  })

  it('[TCK-EXPR-18] WHERE 标签属性大于过滤', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.score > 80 RETURN n')
    const data = [{ _label: 'Person', score: 95 }, { _label: 'Person', score: 60 }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })

  it('[TCK-EXPR-19] WHERE STARTS_WITH 字符串过滤', async () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.name STARTS WITH 'A' RETURN n")
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-20] WHERE ENDS_WITH 字符串过滤', async () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.name ENDS WITH 'e' RETURN n")
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-21] WHERE CONTAINS 字符串过滤', async () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.name CONTAINS 'li' RETURN n")
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-22] RETURN 别名表达式', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name + "!" AS greeting')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-23] WHERE 数字链式比较', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age >= 18 AND n.age <= 65 RETURN n')
    expect(plan.filters.length).toBe(2)
  })

  it('[TCK-EXPR-24] WHERE 属性与自身比较', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age = n.score RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-EXPR-25] RETURN 负数字面量', async () => {
    expect(() => parseQuery('RETURN -1 AS neg')).not.toThrow()
  })
})
