import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

/**
 * String concatenation with `+` and STARTS WITH / ENDS WITH / CONTAINS.
 *
 * Coverage:
 *   - `'Hello ' + 'World'` -> "Hello World"
 *   - mixed-type `'Age: ' + 42` -> "Age: 42"
 *   - numeric addition stays addition `1 + 2` -> 3
 *   - WHERE n.name STARTS WITH 'A'
 *   - WHERE n.name ENDS WITH 'son'
 *   - WHERE n.name CONTAINS 'li'
 *   - non-matching predicates return empty result sets
 */

describe('字符串拼接和模式匹配操作符', () => {

  // ── 1. String concatenation `+` ─────────────────────────

  it('字符串拼接 RETURN "Hello " + "World" 返回 "Hello World"', async () => {
    const query = "RETURN 'Hello ' + 'World'"
    const plan = parseQuery(query)
    const colName = plan.returnColumns[0]
    expect(colName).toBeTruthy()

    const rows = await _executeQuery(plan, [], query) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0][colName]).toBe('Hello World')
  })

  it('混合类型拼接 "Age: " + 42 返回 "Age: 42"', async () => {
    const query = "RETURN 'Age: ' + 42"
    const plan = parseQuery(query)
    const colName = plan.returnColumns[0]
    const rows = await _executeQuery(plan, [], query) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0][colName]).toBe('Age: 42')
  })

  it('数字相加仍为加法 1 + 2 返回 3', async () => {
    const query = 'RETURN 1 + 2'
    const plan = parseQuery(query)
    const colName = plan.returnColumns[0]
    const rows = await _executeQuery(plan, [], query) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0][colName]).toBe(3)
  })

  // ── 4. STARTS WITH ─────────────────────────────────────

  it('WHERE n.name STARTS WITH "A" 匹配正确的节点', async () => {
    const query = "MATCH (n:Person) WHERE n.name STARTS WITH 'A' RETURN n"
    const plan = parseQuery(query)
    expect(plan.filters.length).toBeGreaterThan(0)
    const filter = plan.filters[0]
    expect(filter.operator).toBe('STARTS_WITH')
    expect(filter.property).toBe('name')
    expect(filter.value).toBe('A')

    const nodes = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
      { _label: 'Person', name: 'Amy' },
      { _label: 'Person', name: 'Charlie' },
    ]
    const rows = await _executeQuery(plan, nodes, query) as any[]
    expect(rows.length).toBe(2)
    const names = rows.map(r => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Amy'])
  })

  // ── 5. ENDS WITH ───────────────────────────────────────

  it('WHERE n.name ENDS WITH "son" 匹配正确的节点', async () => {
    const query = "MATCH (n:Person) WHERE n.name ENDS WITH 'son' RETURN n"
    const plan = parseQuery(query)
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.filters[0].operator).toBe('ENDS_WITH')
    expect(plan.filters[0].value).toBe('son')

    const nodes = [
      { _label: 'Person', name: 'Jackson' },
      { _label: 'Person', name: 'Johnson' },
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bobson' },
    ]
    const rows = await _executeQuery(plan, nodes, query) as any[]
    expect(rows.length).toBe(3)
    const names = rows.map(r => r.n.name).sort()
    expect(names).toEqual(['Bobson', 'Jackson', 'Johnson'])
  })

  // ── 6. CONTAINS ────────────────────────────────────────

  it('WHERE n.name CONTAINS "li" 匹配正确的节点', async () => {
    const query = "MATCH (n:Person) WHERE n.name CONTAINS 'li' RETURN n"
    const plan = parseQuery(query)
    expect(plan.filters.length).toBeGreaterThan(0)
    expect(plan.filters[0].operator).toBe('CONTAINS')
    expect(plan.filters[0].value).toBe('li')

    const nodes = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
      { _label: 'Person', name: 'Cliff' },
      { _label: 'Person', name: 'Oliver' },
      { _label: 'Person', name: 'Lily' },
    ]
    const rows = await _executeQuery(plan, nodes, query) as any[]
    expect(rows.length).toBe(3)
    const names = rows.map(r => r.n.name).sort()
    expect(names).toEqual(['Alice', 'Cliff', 'Oliver'])
  })

  // ── 7. Non-matching STARTS WITH ────────────────────────

  it('不匹配的 STARTS WITH 返回空行集', async () => {
    const query = "MATCH (n:Person) WHERE n.name STARTS WITH 'Z' RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    const rows = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(rows.length).toBe(0)
  })

  // ── 8. Non-matching ENDS WITH ──────────────────────────

  it('不匹配的 ENDS WITH 返回空行集', async () => {
    const query = "MATCH (n:Person) WHERE n.name ENDS WITH 'zzz' RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    const rows = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(rows.length).toBe(0)
  })

  // ── 9. Non-matching CONTAINS ───────────────────────────

  it('不匹配的 CONTAINS 返回空行集', async () => {
    const query = "MATCH (n:Person) WHERE n.name CONTAINS 'xyz' RETURN n"
    const nodes = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    const rows = await _executeQuery(parseQuery(query), nodes, query) as any[]
    expect(rows.length).toBe(0)
  })
})
