/**
 * NOT 运算符测试
 *
 * 测试范围：
 * 1. WHERE NOT n.name = 'Alice' — 字段不等于字面量（解析 + 执行）
 * 2. WHERE NOT (n.age > 30) — 否定括号表达式
 * 3. WHERE NOT n.name STARTS WITH 'A' — 否定字符串谓词
 * 4. NOT 与 AND 组合
 * 5. NOT 与 IN 组合
 */
import { describe, it, expect } from 'vitest'
import {
  parseQuery,
  _executeQuery,
} from './query-engine'

// =============================================================
// NOT 解析测试
// =============================================================

describe('NOT 解析', () => {
  it('WHERE NOT: 解析 NOT n.name = "Alice" → negated EQ filter', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE NOT n.name = 'Alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const nameFilter = plan.filters.find(f => f.property === 'name')
    expect(nameFilter).toBeDefined()
    expect(nameFilter!.negated).toBe(true)
    expect(nameFilter!.operator).toBe('EQ')
    expect(nameFilter!.value).toBe('Alice')
  })

  it('WHERE NOT: 解析 NOT (n.age > 30) → negated GT filter', () => {
    const plan = parseQuery('MATCH (n:Person) WHERE NOT (n.age > 30) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const ageFilter = plan.filters.find(f => f.property === 'age')
    expect(ageFilter).toBeDefined()
    expect(ageFilter!.negated).toBe(true)
    expect(ageFilter!.operator).toBe('GT')
    expect(ageFilter!.value).toBe(30)
  })

  it('NOT 不干扰普通 WHERE 条件（无 NOT 标记）', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age > 25 RETURN n")
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const ageFilter = plan.filters.find(f => f.property === 'age')
    expect(ageFilter).toBeDefined()
    expect(ageFilter!.negated).toBeUndefined() // 无 NOT 标记
    expect(ageFilter!.operator).toBe('GT')
    expect(ageFilter!.value).toBe(25)
  })

  it('WHERE NOT: 解析 NOT n.name STARTS WITH "A" → negated STRING_PREDICATE', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE NOT n.name STARTS WITH 'A' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.filters).toBeDefined()
    const nameFilter = plan.filters.find(f => f.property === 'name')
    expect(nameFilter).toBeDefined()
    expect(nameFilter!.negated).toBe(true)
    expect(nameFilter!.operator).toBe('STARTS_WITH')
    expect(nameFilter!.value).toBe('A')
  })
})

// =============================================================
// NOT 执行测试
// =============================================================

describe('NOT 执行 — _executeQuery 集成', () => {
  it('WHERE NOT n.name = "Charlie": 排除匹配节点', () => {
    const nodes = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ]
    const plan = parseQuery("MATCH (n) WHERE NOT n.name = 'Charlie' RETURN n")
    const result = _executeQuery(plan, nodes)
    // RETURN n 返回整行，result[i].n 是节点对象
    expect(result).toHaveLength(2)
    const names = result.map((r: any) => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Bob'])
  })

  it('WHERE NOT (n.age > 30): 保留年龄 ≤ 30 的节点', () => {
    const nodes = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ]
    const plan = parseQuery('MATCH (n) WHERE NOT (n.age > 30) RETURN n')
    const result = _executeQuery(plan, nodes)
    // NOT (age > 30) === age <= 30
    expect(result).toHaveLength(2)
    const names = result.map((r: any) => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Bob'])
  })

  it('WHERE NOT n.name STARTS WITH "A": 排除以A开头的名字', () => {
    const nodes = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Anna', age: 28 },
      { name: 'Charlie', age: 35 },
    ]
    const plan = parseQuery("MATCH (n) WHERE NOT n.name STARTS WITH 'A' RETURN n")
    const result = _executeQuery(plan, nodes)
    // 排除 Alice 和 Anna (以 A 开头)
    expect(result).toHaveLength(2)
    const names = result.map((r: any) => r.n.name).sort()
    expect(names).toEqual(['Bob', 'Charlie'])
  })

  it('NOT 与 AND 组合: WHERE NOT n.name = "Alice" AND n.age > 25', () => {
    const nodes = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ]
    const plan = parseQuery("MATCH (n) WHERE NOT n.name = 'Alice' AND n.age > 25 RETURN n")
    const result = _executeQuery(plan, nodes)
    // NOT name=Alice → 排除 Alice
    // age>25 → 保留 Charlie (Bob 25 不满足)
    expect(result).toHaveLength(1)
    expect(result[0].n.name).toBe('Charlie')
  })

  it('NOT 与 IN 组合: WHERE NOT n.name IN ["Alice", "Bob"]', () => {
    const nodes = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ]
    const plan = parseQuery("MATCH (n) WHERE NOT n.name IN ['Alice', 'Bob'] RETURN n")
    const result = _executeQuery(plan, nodes)
    // 排除 Alice 和 Bob
    expect(result).toHaveLength(1)
    expect(result[0].n.name).toBe('Charlie')
  })
})
