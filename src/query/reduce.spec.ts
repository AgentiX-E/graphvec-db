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

  // ── 新增 tests ──

  it('REDUCE 带 WHERE 过滤的列表', () => {
    const { extracts } = _preprocessQuery(
      'RETURN REDUCE(acc = 0, x IN [1,2,3,4,5] | acc + x) AS sum',
    )
    expect(extracts.reduceExtract).toBeDefined()
    expect(extracts.reduceExtract!.accumulator).toBe('acc')
    expect(extracts.reduceExtract!.variable).toBe('x')
  })

  it('REDUCE 默认 isVarRef 为 false', () => {
    const plan = parseQuery('RETURN REDUCE(acc = 0, x IN [1,2,3] | acc + x) AS sum')
    expect(plan.reduce!.isVarRef).toBe(false)
    expect(plan.reduce!.initial).toBe(0)
  })

  it('REDUCE 列表含布尔值', () => {
    const plan = parseQuery('RETURN REDUCE(acc = true, x IN [true, false, true] | acc AND x) AS all_true')
    expect(plan.reduce).toBeDefined()
    expect(plan.reduce!.initial).toBe(true)
  })

  it('REDUCE 嵌套 alias 在 returnColumns 中为 __reduce_val__', () => {
    const plan = parseQuery('RETURN REDUCE(acc = 0, x IN [1,2,3] | acc + x) AS total_sum')
    expect(plan.reduce).toBeDefined()
    expect(plan.returnColumns).toContain('__reduce_val__')
  })

  it('REDUCE 与普通列共存时 returnColumns 包含两者', () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, REDUCE(acc = 0, x IN [1,2,3] | acc + x) AS sum')
    expect(plan.reduce).toBeDefined()
    expect(plan.returnColumns).toContain('name')
    expect(plan.returnColumns).toContain('__reduce_val__')
  })

  it('REDUCE 空的 accumulator 初始值', () => {
    const plan = parseQuery('RETURN REDUCE(acc = 0, x IN [] | acc + x) AS zero')
    expect(plan.reduce).toBeDefined()
    expect(plan.reduce!.initial).toBe(0)
    expect(plan.reduce!.list).toEqual([])
  })

  it('REDUCE 字符串拼接式初始值为空字符串', () => {
    const plan = parseQuery('RETURN REDUCE(acc = "", x IN ["a","b"] | acc + x) AS concat')
    expect(plan.reduce).toBeDefined()
    expect(plan.reduce!.initial).toBe('')
    expect(plan.reduce!.list).toEqual(['a', 'b'])
  })
})
