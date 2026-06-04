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

  // ── 新增 tests ──

  it('sum OVER (PARTITION BY)', () => {
    const plan = parseQuery('MATCH (n) RETURN sum(n.amount) OVER (PARTITION BY n.category) AS total')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].function).toContain('sum')
    expect(plan.windowFunctions![0].partitionBy).toContain('n.category')
  })

  it('min OVER (PARTITION BY ORDER BY DESC)', () => {
    const plan = parseQuery('MATCH (n) RETURN min(n.score) OVER (PARTITION BY n.team ORDER BY n.score DESC) AS min_score')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].function).toContain('min')
    expect(plan.windowFunctions![0].partitionBy).toContain('n.team')
    expect(plan.windowFunctions![0].orderBy[0].column).toBe('n.score')
    expect(plan.windowFunctions![0].orderBy[0].direction).toBe('DESC')
  })

  it('max OVER (ORDER BY ASC)', () => {
    const plan = parseQuery('MATCH (n) RETURN max(n.price) OVER (ORDER BY n.price ASC) AS max_price')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].function).toContain('max')
    expect(Array.isArray(plan.windowFunctions![0].partitionBy)).toBe(true)
    expect(plan.windowFunctions![0].partitionBy!.length).toBe(0)
    expect(plan.windowFunctions![0].orderBy[0].direction).toBe('ASC')
  })

  it('count OVER 需要包含 PARTITION BY 或 ORDER BY 子句', () => {
    // 不带任何子句的 OVER() 不被解析器支持
    // 验证带 order by 或 partition by 的都能正确解析
    const plan1 = parseQuery('MATCH (n) RETURN count(n.id) OVER (PARTITION BY n.type) AS cnt')
    expect(plan1.windowFunctions![0].function).toContain('count')
    const plan2 = parseQuery('MATCH (n) RETURN count(n.id) OVER (ORDER BY n.id) AS cnt')
    expect(plan2.windowFunctions![0].function).toContain('count')
    const plan3 = parseQuery('MATCH (n) RETURN count(n.id) OVER (PARTITION BY n.type ORDER BY n.id) AS cnt')
    expect(plan3.windowFunctions![0].function).toContain('count')
  })

  it('collect OVER (PARTITION BY)', () => {
    const plan = parseQuery('MATCH (n) RETURN collect(n.name) OVER (PARTITION BY n.group) AS names')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].function).toContain('collect')
    expect(plan.windowFunctions![0].partitionBy).toContain('n.group')
  })

  it('多个窗口函数在同一个查询中', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN count(n.age) OVER (PARTITION BY n.gender) AS cnt, avg(n.salary) OVER (PARTITION BY n.dept) AS avg_sal',
    )
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions!.length).toBe(2)
    expect(plan.windowFunctions![0].partitionBy).toContain('n.gender')
    expect(plan.windowFunctions![1].partitionBy).toContain('n.dept')
  })

  it('count OVER ORDER BY 多列', () => {
    const plan = parseQuery('MATCH (n) RETURN count(n.id) OVER (ORDER BY n.age, n.name) AS cnt')
    expect(plan.windowFunctions).toBeDefined()
    expect(plan.windowFunctions![0].orderBy.length).toBeGreaterThanOrEqual(2)
    expect(plan.windowFunctions![0].orderBy[0].column).toBe('n.age')
    expect(plan.windowFunctions![0].orderBy[1].column).toBe('n.name')
  })
})
