/**
 * REDUCE 查询解析测试
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _preprocessQuery } from './query-engine'

describe('REDUCE 解析', () => {
  it('_preprocessQuery 提取 REDUCE', () => {
    const { extracts } = _preprocessQuery('RETURN REDUCE(acc = 0, x IN [1,2,3] | acc + x) AS sum')
    expect(extracts.reduceExtract).toBeDefined()
    expect(extracts.reduceExtract!.accumulator).toBe('acc')
    expect(extracts.reduceExtract!.variable).toBe('x')
  })

  it('parseQuery 返回 reduce 子句', () => {
    const plan = parseQuery('RETURN REDUCE(acc = 0, x IN [1,2,3] | acc + x) AS sum')
    expect(plan.reduce).toBeDefined()
    expect(plan.reduce!.accumulator).toBe('acc')
    expect(plan.reduce!.variable).toBe('x')
    expect(plan.reduce!.initial).toBe(0)
    expect(plan.reduce!.isVarRef).toBe(false)
  })

  it('REDUCE 列表为数字数组', () => {
    const plan = parseQuery('RETURN REDUCE(acc = 0, x IN [1,2,3] | acc + x) AS sum')
    expect(plan.reduce!.list).toEqual([1, 2, 3])
  })

  it('REDUCE 字符串初始值', () => {
    const plan = parseQuery('RETURN REDUCE(acc = "", x IN ["a","b","c"] | acc + x) AS concat')
    expect(plan.reduce!.initial).toBe('')
  })

  it('无 REDUCE 的查询 reduce 为 undefined', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.reduce).toBeUndefined()
  })
})
