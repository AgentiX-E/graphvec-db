/**
 * transaction.spec.ts — 测试 BEGIN / COMMIT / ROLLBACK 事务语句
 *
 * 多语句事务语法：解析即可，执行留空（no-op）。
 */

import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

describe('parseQuery — 事务语句 (BEGIN / COMMIT / ROLLBACK)', () => {

  // 1. BEGIN 解析
  it('a. BEGIN 解析', () => {
    const plan = parseQuery('BEGIN')
    expect(plan.type).toBe('BEGIN')
    expect(plan.scanLabel).toBeNull()
    expect(plan.steps).toEqual([])
    expect(plan.filters).toEqual([])
    expect(plan.returnColumns).toEqual([])
  })

  // 2. COMMIT 解析
  it('b. COMMIT 解析', () => {
    const plan = parseQuery('COMMIT')
    expect(plan.type).toBe('COMMIT')
    expect(plan.scanLabel).toBeNull()
  })

  // 3. ROLLBACK 解析
  it('c. ROLLBACK 解析', () => {
    const plan = parseQuery('ROLLBACK')
    expect(plan.type).toBe('ROLLBACK')
    expect(plan.scanLabel).toBeNull()
  })

  // 4. 不区分大小写
  it('d. 不区分大小写 — begin / commit / rollback', () => {
    const beginPlan = parseQuery('begin')
    expect(beginPlan.type).toBe('BEGIN')

    const commitPlan = parseQuery('Commit')
    expect(commitPlan.type).toBe('COMMIT')

    const rollbackPlan = parseQuery('ROLLBACK')
    expect(rollbackPlan.type).toBe('ROLLBACK')
  })

  // 5. 非法语法报错
  it('e. 非法事务关键字报错', () => {
    expect(() => parseQuery('XFER')).toThrow('Query parse error')
    expect(() => parseQuery('SAVEPOINT x')).toThrow('Query parse error')
    expect(() => parseQuery('ABORT')).toThrow('Query parse error')
  })

  // ── 新增 tests ──

  // 6. BEGIN/COMMIT 带尾随空格
  it('f. BEGIN / COMMIT / ROLLBACK 带尾随空格', () => {
    const plan1 = parseQuery('BEGIN ')
    expect(plan1.type).toBe('BEGIN')

    const plan2 = parseQuery('COMMIT ')
    expect(plan2.type).toBe('COMMIT')

    const plan3 = parseQuery('ROLLBACK ')
    expect(plan3.type).toBe('ROLLBACK')
  })

  // 7. 混合大小写
  it('g. 混合大小写 BeGiN / ComMiT / RoLlBaCk', () => {
    const plan1 = parseQuery('BeGiN')
    expect(plan1.type).toBe('BEGIN')

    const plan2 = parseQuery('ComMiT')
    expect(plan2.type).toBe('COMMIT')

    const plan3 = parseQuery('RoLlBaCk')
    expect(plan3.type).toBe('ROLLBACK')
  })

  // 8. BEGIN 后 returnColumns 等字段应为空数组
  it('h. BEGIN 语句的类型字段一致性', () => {
    const plan = parseQuery('BEGIN')
    expect(plan.type).toBe('BEGIN')
    expect(Array.isArray(plan.steps)).toBe(true)
    expect(plan.steps).toHaveLength(0)
    expect(Array.isArray(plan.filters)).toBe(true)
    expect(plan.filters).toHaveLength(0)
    expect(Array.isArray(plan.returnColumns)).toBe(true)
    expect(plan.returnColumns).toHaveLength(0)
  })

  // 9. COMMIT 的类型检查
  it('i. COMMIT 语句类型 = COMMIT', () => {
    const plan = parseQuery('COMMIT')
    expect(plan.type).toBe('COMMIT')
  })

  // 10. ROLLBACK 的类型检查
  it('j. ROLLBACK 语句类型 = ROLLBACK', () => {
    const plan = parseQuery('ROLLBACK')
    expect(plan.type).toBe('ROLLBACK')
  })
})
