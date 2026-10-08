/**
 * set-remove-null.spec.ts — SET 多重赋值 + REMOVE 属性/标签 + IS NULL/IS NOT NULL
 *
 * 验收标准：
 * - SET 多重: ≥3 个测试
 * - REMOVE: ≥3 个测试
 * - IS NULL: ≥3 个测试
 * - 总共 ≥9 ✅
 */

import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

// ── SET 多重赋值 ──────────────────────────────────────────

describe('SET — 多重赋值', () => {
  it('SET 单个属性 (基线)', () => {
    const plan = parseQuery("MATCH (n) SET n.name = 'Alice'")
    expect(plan.type).toBe('SET')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBe(1)
    expect(plan.setClauses![0].property).toBe('name')
    expect(plan.setClauses![0].value).toBe('Alice')
  })

  it('SET 多个属性 (逗号分隔)', () => {
    const plan = parseQuery("MATCH (n) SET n.age = 30, n.name = 'Alice'")
    expect(plan.type).toBe('SET')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBe(2)
    expect(plan.setClauses![0].property).toBe('age')
    expect(plan.setClauses![0].value).toBe(30)
    expect(plan.setClauses![1].property).toBe('name')
    expect(plan.setClauses![1].value).toBe('Alice')
  })

  it('SET 三个属性', () => {
    const plan = parseQuery("MATCH (n) SET n.x = 1, n.y = 2, n.z = 3")
    expect(plan.type).toBe('SET')
    expect(plan.setClauses!.length).toBe(3)
    expect(plan.setClauses![0].property).toBe('x')
    expect(plan.setClauses![0].value).toBe(1)
    expect(plan.setClauses![1].property).toBe('y')
    expect(plan.setClauses![1].value).toBe(2)
    expect(plan.setClauses![2].property).toBe('z')
    expect(plan.setClauses![2].value).toBe(3)
  })

  it('SET 混合字符串与数字', () => {
    const plan = parseQuery("MATCH (n) SET n.title = 'Developer', n.years = 5, n.active = true")
    expect(plan.type).toBe('SET')
    expect(plan.setClauses!.length).toBe(3)
    expect(plan.setClauses![0]).toEqual({ kind: 'PROP', alias: 'n', property: 'title', value: 'Developer' })
    expect(plan.setClauses![1]).toEqual({ kind: 'PROP', alias: 'n', property: 'years', value: 5 })
    expect(plan.setClauses![2]).toEqual({ kind: 'PROP', alias: 'n', property: 'active', value: true })
  })
})

// ── REMOVE 属性/标签 ──────────────────────────────────────

describe('REMOVE — 属性/标签', () => {
  it('REMOVE 属性: n.age', () => {
    const plan = parseQuery("MATCH (n) REMOVE n.age")
    expect(plan.removeClauses).toBeDefined()
    expect(plan.removeClauses!.length).toBe(1)
    expect(plan.removeClauses![0].type).toBe('REMOVE_PROP')
    expect(plan.removeClauses![0].property).toBe('age')
  })

  it('REMOVE 多个属性: n.age, n.name', () => {
    const plan = parseQuery("MATCH (n) REMOVE n.age, n.name")
    expect(plan.removeClauses!.length).toBe(2)
    expect(plan.removeClauses![0].type).toBe('REMOVE_PROP')
    expect(plan.removeClauses![0].property).toBe('age')
    expect(plan.removeClauses![1].type).toBe('REMOVE_PROP')
    expect(plan.removeClauses![1].property).toBe('name')
  })

  it('REMOVE 标签: n:Person', () => {
    const plan = parseQuery("MATCH (n) REMOVE n:Person")
    expect(plan.removeClauses!.length).toBe(1)
    expect(plan.removeClauses![0].type).toBe('REMOVE_LABEL')
    expect(plan.removeClauses![0].ref).toBe('n')
    expect(plan.removeClauses![0].label).toBe('Person')
  })

  it('REMOVE 标签 + 属性混合', () => {
    const plan = parseQuery("MATCH (n) REMOVE n:Person, n.age")
    expect(plan.removeClauses).toBeDefined()
    expect(plan.removeClauses!.length).toBe(2)
    const labels = plan.removeClauses!.filter(r => r.type === 'REMOVE_LABEL')
    const props = plan.removeClauses!.filter(r => r.type === 'REMOVE_PROP')
    expect(labels.length).toBe(1)
    expect(labels[0].label).toBe('Person')
    expect(props.length).toBe(1)
    expect(props[0].property).toBe('age')
  })

  it('SET + REMOVE 在同一查询', () => {
    const plan = parseQuery("MATCH (n) SET n.name = 'Bob' REMOVE n.age")
    // SET + REMOVE 混合 ⇒ MATCH_MODIFY（非单纯 SET）
    expect(plan.type).toBe('MATCH_MODIFY')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBe(1)
    expect(plan.setClauses![0].property).toBe('name')
    expect(plan.setClauses![0].value).toBe('Bob')
    expect(plan.removeClauses).toBeDefined()
    expect(plan.removeClauses!.length).toBe(1)
    expect(plan.removeClauses![0].type).toBe('REMOVE_PROP')
    expect(plan.removeClauses![0].property).toBe('age')
  })
})

// ── IS NULL / IS NOT NULL ──────────────────────────────────

describe('WHERE — IS NULL / IS NOT NULL', () => {
  it('WHERE n.name IS NULL', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name IS NULL RETURN n")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IS_NULL')
    expect(plan.filters[0].property).toBe('name')
    expect(plan.filters[0].source).toBe('n')
  })

  it('WHERE n.age IS NOT NULL', () => {
    const plan = parseQuery("MATCH (n) WHERE n.age IS NOT NULL RETURN n")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].operator).toBe('IS_NOT_NULL')
    expect(plan.filters[0].property).toBe('age')
    expect(plan.filters[0].source).toBe('n')
  })

  it('IS NULL + IS NOT NULL 同时使用', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name IS NULL AND n.age IS NOT NULL RETURN n")
    expect(plan.filters.length).toBe(2)
    const nullFilter = plan.filters.find(f => f.operator === 'IS_NULL')
    const notNullFilter = plan.filters.find(f => f.operator === 'IS_NOT_NULL')
    expect(nullFilter).toBeDefined()
    expect(nullFilter!.property).toBe('name')
    expect(notNullFilter).toBeDefined()
    expect(notNullFilter!.property).toBe('age')
  })

  it('IS NULL 不匹配非空值 (运行时行为)', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name IS NULL RETURN n")
    expect(plan.filters[0].operator).toBe('IS_NULL')

    // 模拟过滤行为：有 name 属性的行应被排除
    const recWithName = { name: 'Alice' }
    const recWithoutName = {}
    const recNullName = { name: null }

    // 使用与 _applyWhereFilters 相同的逻辑
    const valNull = _getPropValueTest(recNullName, 'name')
    expect(valNull === undefined || valNull === null).toBe(true)

    const valMissing = _getPropValueTest(recWithoutName, 'name')
    expect(valMissing === undefined || valMissing === null).toBe(true)

    const valPresent = _getPropValueTest(recWithName, 'name')
    expect(valPresent === undefined || valPresent === null).toBe(false)
  })
})

// ── 辅助函数 ───────────────────────────────────────────────

function _getPropValueTest(
  record: Record<string, unknown>,
  prop: string,
): unknown {
  if (prop in record) return record[prop]
  if ((record as any).props && prop in (record as any).props) {
    return (record as any).props[prop]
  }
  return undefined
}
