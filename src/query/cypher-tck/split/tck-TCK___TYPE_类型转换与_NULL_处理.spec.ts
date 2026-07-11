/**
 * tck-TCK___TYPE_类型转换与_NULL_处理.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — TYPE 类型转换与 NULL 处理', () => {

  it('[TCK-TYPE-01] RETURN 数字字面量', async () => {
    const plan = parseQuery('RETURN 42 AS num')
    expect(plan.returnColumns).toContain('num')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-02] RETURN 字符字面量', async () => {
    const plan = parseQuery('RETURN "hello" AS greeting')
    expect(plan.returnColumns).toContain('greeting')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-03] RETURN 布尔字面量', async () => {
    const plan = parseQuery('RETURN true AS flag')
    expect(plan.returnColumns).toContain('flag')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-04] RETURN 假值布尔', async () => {
    const plan = parseQuery('RETURN false AS flag')
    expect(plan.returnColumns).toContain('flag')
  })

  it('[TCK-TYPE-05] RETURN 空值', async () => {
    const plan = parseQuery('RETURN null AS nothing')
    expect(plan.returnColumns).toContain('nothing')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-06] RETURN 浮点数字', async () => {
    const plan = parseQuery('RETURN 3.14 AS pi')
    expect(plan.returnColumns).toContain('pi')
    const result = await _executeQuery(plan, [])
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-07] RETURN 负整数', async () => {
    expect(() => parseQuery('RETURN -42 AS neg')).not.toThrow()
  })

  it('[TCK-TYPE-08] RETURN 大整数', async () => {
    const plan = parseQuery('RETURN 99999 AS big')
    expect(plan.returnColumns).toContain('big')
  })

  it('[TCK-TYPE-09] WHERE NULL 比较可解析', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.name IS NULL RETURN n')
    expect(plan).toBeDefined()
  })

  it('[TCK-TYPE-10] WHERE IS NOT NULL 不抛出Error', async () => {
    expect(() => parseQuery('MATCH (n:Person) WHERE n.name IS NOT NULL RETURN n')).not.toThrow()
  })

  it('[TCK-TYPE-11] WHERE 字符串比较', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.name = "Alice" RETURN n')
    const data = [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
    expect(result[0].n.name).toBe('Alice')
  })

  it('[TCK-TYPE-12] WHERE 数字比较相等', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age = 30 RETURN n')
    const data = [{ _label: 'Person', age: 30 }, { _label: 'Person', age: 25 }]
    const result = await _executeQuery(plan, data)
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-13] WHERE 不等于比较', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.name <> "Alice" RETURN n')
    expect(plan.filters[0].operator).toBe('NEQ')
  })

  it('[TCK-TYPE-14] WHERE 大于等于', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age >= 18 RETURN n')
    expect(plan.filters[0].operator).toBe('GTE')
    const data = [{ _label: 'Person', age: 21 }, { _label: 'Person', age: 17 }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-15] WHERE 小于等于', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.age <= 65 RETURN n')
    expect(plan.filters[0].operator).toBe('LTE')
  })

  it('[TCK-TYPE-16] WHERE 布尔属性', async () => {
    const plan = parseQuery('MATCH (n:Person) WHERE n.active = true RETURN n')
    expect(plan).toBeDefined()
    const data = [{ _label: 'Person', active: true }, { _label: 'Person', active: false }]
    const result = await _executeQuery(plan, data) as Record<string, any>[]
    expect(result.length).toBe(1)
  })

  it('[TCK-TYPE-17] RETURN 字符串拼接', async () => {
    // String concatenation via parse
    expect(() => parseQuery('RETURN "Hello " + "World" AS greeting')).not.toThrow()
  })

  it('[TCK-TYPE-18] toUpper 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN toUpper(n.name) AS upper_name')).not.toThrow()
  })

  it('[TCK-TYPE-19] toLower 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN toLower(n.name) AS lower_name')).not.toThrow()
  })

  it('[TCK-TYPE-20] toString 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN toString(n.age) AS age_str')).not.toThrow()
  })

  it('[TCK-TYPE-21] toInteger 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN toInteger(n.age) AS age_int')).not.toThrow()
  })

  it('[TCK-TYPE-22] toFloat 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN toFloat(n.age) AS age_float')).not.toThrow()
  })

  it('[TCK-TYPE-23] abs 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN abs(n.score) AS abs_score')).not.toThrow()
  })

  it('[TCK-TYPE-24] round 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN round(n.score) AS rounded')).not.toThrow()
  })

  it('[TCK-TYPE-25] coalesce 内置函数', async () => {
    expect(() => parseQuery('MATCH (n:Person) RETURN coalesce(n.name, "Unknown") AS name')).not.toThrow()
  })
})
