/**
 * 窗口函数 OVER 解析测试
 */
import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

describe('窗口函数 OVER 解析', () => {
  it('count OVER (PARTITION BY)', () => {
    const plan = parseQuery('MATCH (n) RETURN count(n.age) OVER (PARTITION BY n.gender) AS cnt')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions!.length).toBe(1)
    expect(plan.windowFunctions![0].function).toContain('count')
    expect(plan.windowFunctions![0].partitionBy).toContain('n.gender')
  })

  it('count OVER (ORDER BY)', () => {
    const plan = parseQuery('MATCH (n) RETURN count(n.age) OVER (ORDER BY n.name DESC) AS cnt')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].orderBy[0].column).toBe('n.name')
    expect(plan.windowFunctions![0].orderBy[0].direction).toBe('DESC')
  })

  it('无 OVER 的查询为 undefined', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.windowFunctions).toBeUndefined()
  })

  it('avg OVER (PARTITION BY ORDER BY)', () => {
    const plan = parseQuery('MATCH (n) RETURN avg(n.salary) OVER (PARTITION BY n.dept ORDER BY n.salary) AS avg_sal')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].partitionBy).toContain('n.dept')
    expect(plan.windowFunctions![0].orderBy[0].column).toBe('n.salary')
  })
})
