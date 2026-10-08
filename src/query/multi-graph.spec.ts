/**
 * multi-graph.spec.ts — 多图命名空间 (USE graph_name + Catalog)
 *
 * 测试覆盖：
 * 1. USE mygraph 解析为 USE plan
 * 2. USE + 后续 MATCH 的串联
 * 3. 多图名
 * 4. 非法标识符的容错
 * 5. _executeUse 执行（USE 返回当前数据）
 * 6. USE 执行后的数据传递
 */

import { parseQuery, _executeQuery } from './query-engine'

describe('parseQuery — USE 语句解析', () => {
  // TC-1: USE 简单图名
  it('USE mygraph 解析为 USE plan', () => {
    const plan = parseQuery('USE mygraph')
    expect(plan.type).toBe('USE')
    expect(plan.useGraph).toBe('mygraph')
  })

  // TC-2: USE 带下划线和数字的图名
  it('USE 带下划线 和 数字的图名', () => {
    const plan = parseQuery('USE graph_2024')
    expect(plan.type).toBe('USE')
    expect(plan.useGraph).toBe('graph_2024')
  })

  // TC-3: USE 多个不同图名
  it('USE 多个不同图名都能正确解析', () => {
    const names = ['production', 'staging', 'dev', 'analytics']
    for (const name of names) {
      const plan = parseQuery(`USE ${name}`)
      expect(plan.type).toBe('USE')
      expect(plan.useGraph).toBe(name)
    }
  })

  // TC-4: USE 不区分大小写
  it('USE 关键字不区分大小写', () => {
    const planLower = parseQuery('use default')
    expect(planLower.type).toBe('USE')
    expect(planLower.useGraph).toBe('default')

    const planMixed = parseQuery('Use MyGraph')
    expect(planMixed.type).toBe('USE')
    expect(planMixed.useGraph).toBe('MyGraph')
  })

  // TC-5: USE 后跟 MATCH 分别解析（语法验证）
  it('USE 后跟 MATCH 各自可独立解析', () => {
    // USE 独立解析
    const usePlan = parseQuery('USE mygraph')
    expect(usePlan.type).toBe('USE')
    expect(usePlan.useGraph).toBe('mygraph')

    // MATCH 独立解析（USE 不污染后续解析）
    const matchPlan = parseQuery('MATCH (n:Person) WHERE n.age > 18 RETURN n.name')
    expect(matchPlan.type).toBe('QUERY')
    expect(matchPlan.scanLabel).toBe('Person')
    expect(matchPlan.returnColumns).toEqual(['name'])
  })

  // TC-6: 空 USE（无图名）— 解析器宽松，退回通用 QUERY plan
  it('空 USE（无图名）退回通用 QUERY plan', () => {
    const plan = parseQuery('USE')
    expect(plan.type).not.toBe('USE')
    expect(plan.useGraph).toBeUndefined()
  })

  // TC-7: 图名以数字开头 — \w+ 允许数字，仍解析为 USE
  it('图名以数字开头仍解析为 USE（\\w+ 匹配）', () => {
    const plan = parseQuery('USE 123graph')
    expect(plan.type).toBe('USE')
    expect(plan.useGraph).toBe('123graph')
  })
})

describe('_executeUse — USE 执行测试', () => {
  // TC-8: USE 执行 — 切换活动数据库，返回确认行
  it('USE 执行 — 切换活动数据库并返回确认行', async () => {
    const plan = parseQuery('USE mygraph')
    const testData: Array<Record<string, unknown>> = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]
    const result = await _executeQuery(plan, testData, 'USE mygraph') as any[]
    // USE switches the active database namespace and returns a confirmation
    // row, not the input data.
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0].database).toBe('mygraph')
    expect(result[0].switched).toBe(true)
  })

  // TC-9: 空 USE 图名 — 退回通用 QUERY plan
  it('USE 空图名退回通用 QUERY plan', () => {
    const plan = parseQuery('USE ')
    expect(plan.type).not.toBe('USE')
    expect(plan.useGraph).toBeUndefined()
  })

  // TC-10: USE 后加 MATCH 分开执行（模拟执行器串联）
  it('USE 后加 MATCH 分别执行 — 数据可传递', async () => {
    const testData: Array<Record<string, unknown>> = [
      { id: 1, name: 'Alice', age: 30, _label: 'Person' },
      { id: 2, name: 'Bob', age: 25, _label: 'Person' },
      { id: 3, name: 'Rover', _label: 'Dog' },
    ]

    // 先执行 USE
    const usePlan = parseQuery('USE people')
    await _executeQuery(usePlan, testData, 'USE people')

    // 再执行 MATCH (n:Person) RETURN n
    const matchPlan = parseQuery('MATCH (n:Person) WHERE n.age > 18 RETURN n.name')
    expect(matchPlan.scanLabel).toBe('Person')

    const result = await _executeQuery(matchPlan, testData, 'MATCH (n:Person) WHERE n.age > 18 RETURN n.name') as any[]
    expect(result.length).toBe(2)
    // Expect filtered to Person only with age > 18
    expect(result.some(r => r.name === 'Alice')).toBe(true)
    expect(result.some(r => r.name === 'Bob')).toBe(true)
  })
})
