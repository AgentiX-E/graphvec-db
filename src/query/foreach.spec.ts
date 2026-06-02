/**
 * FOREACH 查询解析测试
 */
import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

describe('FOREACH 解析', () => {
  it('FOREACH CREATE 应包含 forEach 子句', () => {
    const plan = parseQuery('FOREACH (x IN [1,2,3] | CREATE (n:Node {id: x})) RETURN n')
    expect(plan.forEach).toBeDefined()
    expect(plan.forEach!.variable).toBe('x')
    expect(plan.forEach!.operation.type).toBe('CREATE')
  })

  it('FOREACH 列表为字面量时 isVarRef 为 false', () => {
    const plan = parseQuery('FOREACH (x IN [1,2,3] | CREATE (n:Node {id: x})) RETURN n')
    expect(plan.forEach).toBeDefined()
    expect(plan.forEach!.isVarRef).toBe(false)
    expect(Array.isArray(plan.forEach!.list)).toBe(true)
  })

  it('FOREACH SET 操作', () => {
    const plan = parseQuery('MATCH (n) FOREACH (x IN [1] | SET n.flag = x) RETURN n')
    expect(plan.forEach).toBeDefined()
    expect(plan.forEach!.operation.type).toBe('SET')
  })

  it('FOREACH DELETE 操作', () => {
    const plan = parseQuery('MATCH (n) FOREACH (x IN [1] | DELETE n) RETURN n')
    expect(plan.forEach).toBeDefined()
    expect(plan.forEach!.operation.type).toBe('DELETE')
  })

  it('不含 FOREACH 的查询无 forEach 子句', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.forEach).toBeUndefined()
  })

  it('FOREACH 不干扰其他匹配', () => {
    const plan = parseQuery('MATCH (n:Person) FOREACH (x IN [1,2,3] | CREATE (m:Log {val: x})) RETURN n')
    expect(plan.forEach).toBeDefined()
    expect(plan.forEach!.variable).toBe('x')
    expect(plan.forEach!.isVarRef).toBe(false)
    expect(plan.forEach!.list).toHaveLength(3)
  })
})
