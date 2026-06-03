import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery, QueryPlan } from './query-engine'

/**
 * Test: string concatenation with `+` and STARTS WITH / ENDS WITH / CONTAINS
 *
 * 测试目标：
 * 1. 字符串拼接 `'Hello ' + 'World'` → "Hello World"
 * 2. 混合类型拼接 `'Age: ' + 42` → "Age: 42"
 * 3. 数字相加仍为加法 `1 + 2` → 3
 * 4. WHERE n.name STARTS WITH 'A'
 * 5. WHERE n.name ENDS WITH 'son'
 * 6. WHERE n.name CONTAINS 'li'
 * 7. 不匹配的 STARTS WITH 返回空结果
 */

describe('字符串拼接和模式匹配操作符', () => {

  // ── 1. 字符串拼接 `+` ─────────────────────────────────────

  it('字符串拼接 RETURN "Hello " + "World" 返回 "Hello World"', () => {
    const plan = parseQuery("RETURN 'Hello ' + 'World'")
    const colName = plan.returnColumns[0]
    expect(colName).toBeTruthy()

    // 执行查询（无 MATCH），应返回一个含合成值的行
    const rows = _executeQuery(plan, [])
    expect(rows.length).toBe(1)
    expect(rows[0][colName]).toBe('Hello World')
  })

  it('混合类型拼接 "Age: " + 42 返回 "Age: 42"', () => {
    const plan = parseQuery("RETURN 'Age: ' + 42")
    const colName = plan.returnColumns[0]
    const rows = _executeQuery(plan, [])
    expect(rows.length).toBe(1)
    expect(rows[0][colName]).toBe('Age: 42')
  })

  it('数字相加仍为加法 1 + 2 返回 3', () => {
    const plan = parseQuery('RETURN 1 + 2')
    const colName = plan.returnColumns[0]
    const rows = _executeQuery(plan, [])
    expect(rows.length).toBe(1)
    expect(rows[0][colName]).toBe(3)
  })

  // ── 4. STARTS WITH ────────────────────────────────────────

  it('WHERE n.name STARTS WITH "A" 匹配正确的节点', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name STARTS WITH 'A' RETURN n")
    expect(plan.filters.length).toBeGreaterThan(0)
    const filter = plan.filters[0]
    expect(filter.operator).toBe('STARTS_WITH')
    expect(filter.property).toBe('name')
    expect(filter.value).toBe('A')

    // 用测试数据执行查询，RETURN n 返回完整的节点对象
    const nodes = [
      { name: 'Alice' },
      { name: 'Bob' },
      { name: 'Amy' },
      { name: 'Charlie' },
    ]
    const rows = _executeQuery(plan, nodes)
    expect(rows.length).toBe(2)
    // 行结构：{ n: { name: 'Alice' } }
    const names = rows.map(r => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Amy'])
  })

  // ── 5. ENDS WITH ──────────────────────────────────────────

  it('WHERE n.name ENDS WITH "son" 匹配正确的节点', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name ENDS WITH 'son' RETURN n")
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.filters[0].operator).toBe('ENDS_WITH')
    expect(plan.filters[0].value).toBe('son')

    const nodes = [
      { name: 'Jackson' },
      { name: 'Johnson' },
      { name: 'Alice' },
      { name: 'Bobson' },
    ]
    const rows = _executeQuery(plan, nodes)
    expect(rows.length).toBe(3)
    const names = rows.map(r => r.n.name).sort()
    expect(names).toEqual(['Bobson', 'Jackson', 'Johnson'])
  })

  // ── 6. CONTAINS ────────────────────────────────────────────

  it('WHERE n.name CONTAINS "li" 匹配正确的节点', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name CONTAINS 'li' RETURN n")
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.filters[0].operator).toBe('CONTAINS')
    expect(plan.filters[0].value).toBe('li')

    const nodes = [
      { name: 'Alice' },
      { name: 'Bob' },
      { name: 'Cliff' },
      { name: 'Oliver' },
      { name: 'Lily' },
    ]
    const rows = _executeQuery(plan, nodes)
    expect(rows.length).toBe(3)
    const names = rows.map(r => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Cliff', 'Oliver'])
  })

  // ── 7. 不匹配返回空结果 ────────────────────────────────────

  it('不匹配的 STARTS WITH 返回空行集', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name STARTS WITH 'Z' RETURN n")
    const nodes = [
      { name: 'Alice' },
      { name: 'Bob' },
    ]
    const rows = _executeQuery(plan, nodes)
    expect(rows.length).toBe(0)
  })

  // ── 8. ENDS WITH 不匹配 ────────────────────────────────────

  it('不匹配的 ENDS WITH 返回空行集', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name ENDS WITH 'zzz' RETURN n")
    const nodes = [
      { name: 'Alice' },
      { name: 'Bob' },
    ]
    const rows = _executeQuery(plan, nodes)
    expect(rows.length).toBe(0)
  })

  // ── 9. CONTAINS 不匹配 ─────────────────────────────────────

  it('不匹配的 CONTAINS 返回空行集', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name CONTAINS 'xyz' RETURN n")
    const nodes = [
      { name: 'Alice' },
      { name: 'Bob' },
    ]
    const rows = _executeQuery(plan, nodes)
    expect(rows.length).toBe(0)
  })
})
