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
})
