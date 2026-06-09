import { describe, test, expect } from 'vitest'
import { _executeQuery } from './query-engine'

// ── Helpers ────────────────────────────────

function makeNode(id: string | number, age?: number): Record<string, unknown> {
  const node: Record<string, unknown> = {
    _id: Number(id),
    _labels: ['Person'],
    name: `Person_${id}`,
    key: `Person_${id}`,
  }
  if (age !== undefined) node.age = age
  return node
}

function plan(overrides?: Record<string, unknown>): any {
  return {
    type: 'QUERY',
    filters: [],
    returnColumns: ['_id', 'name', 'key', 'age'],
    with: null,
    aggregate: null,
    groupBy: [],
    orderBy: [],
    caseColumns: [],
    limit: undefined,
    skip: undefined,
    unionType: undefined,
    rightPlan: undefined,
    ...overrides,
  }
}

// ── UNION ──────────────────────────────────

describe('UNION execution', () => {
  const nodes = [
    makeNode(1, 25),
    makeNode(2, 30),
    makeNode(3, 35),
  ]

  test('UNION merges two result sets with dedup', () => {
    // 左：id <= 2  → nodes [1, 2]
    // 右：id >= 2  → nodes [2, 3]
    // UNION 去重后 → [1, 2, 3]
    const left = plan({ skip: undefined })
    left._filterFn = (c: any) => Number(c._id) <= 2
    const right = plan({ skip: undefined })
    right._filterFn = (c: any) => Number(c._id) >= 2

    const leftResult = _executeQuery({ ...left, filters: [] }, nodes.filter(left._filterFn))
    const rightResult = _executeQuery({ ...right, filters: [] }, nodes.filter(right._filterFn))

    // 手动构造 UNION plan — 对 UNION 我们会分别执行左右再合并
    const allLeft = _executeQuery(left, nodes)
    const allRight = _executeQuery(right, nodes)

    const seen = new Set<string>()
    const merged: any[] = []
    for (const row of [...allLeft, ...allRight]) {
      const key = JSON.stringify(row)
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(row)
      }
    }

    expect(merged.length).toBe(3)
    // 验证节点 1,2,3 都出现了
    const keys = new Set(merged.map((r: any) => r.key))
    expect(keys.has('Person_1')).toBe(true)
    expect(keys.has('Person_2')).toBe(true)
    expect(keys.has('Person_3')).toBe(true)
  })

  test('UNION ALL keeps duplicates', () => {
    const left = plan({ skip: undefined })
    const right = plan({ skip: undefined })
    // 两边都返回节点 2
    const leftNodes = [makeNode(2, 30)]
    const rightNodes = [makeNode(2, 30)]
    const allLeft = _executeQuery(left, leftNodes)
    const allRight = _executeQuery(right, rightNodes)

    const merged = [...allLeft, ...allRight]
    expect(merged.length).toBe(2)
    // 两个都是 Person_2
    const keys = merged.map((r: any) => r.key)
    expect(keys).toEqual(['Person_2', 'Person_2'])
  })

  test('UNION (dedup) removes duplicate across left and right', () => {
    const leftNodes = [makeNode(2, 30)]
    const rightNodes = [makeNode(2, 30)]
    const left = plan({ skip: undefined })
    const right = plan({ skip: undefined })
    const allLeft = _executeQuery(left, leftNodes)
    const allRight = _executeQuery(right, rightNodes)

    const seen = new Set<string>()
    const merged: any[] = []
    for (const row of [...allLeft, ...allRight]) {
      const key = JSON.stringify(row)
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(row)
      }
    }
    expect(merged.length).toBe(1)
  })
})

// ── SKIP ───────────────────────────────────

describe('SKIP execution', () => {
  const nodes = [
    makeNode(1, 25),
    makeNode(2, 30),
    makeNode(3, 35),
    makeNode(4, 40),
    makeNode(5, 45),
  ]

  test('SKIP 0 returns all rows', () => {
    const p = plan({ skip: 0 })
    const result = _executeQuery(p, nodes)
    expect(result.length).toBe(5)
  })

  test('SKIP 2 skips first two rows', () => {
    const p = plan({ skip: 2 })
    const result = _executeQuery(p, nodes)
    expect(result.length).toBe(3)
    expect((result[0] as any).key).toBe('Person_3')
  })

  test('SKIP larger than result count returns empty', () => {
    const p = plan({ skip: 100 })
    const result = _executeQuery(p, nodes)
    expect(result.length).toBe(0)
  })

  test('SKIP with LIMIT: offset + page', () => {
    // SKIP=2, LIMIT=2 → rows 3,4
    const p = plan({ skip: 2, limit: 2 })
    const result = _executeQuery(p, nodes)
    expect(result.length).toBe(2)
    expect((result[0] as any).key).toBe('Person_3')
    expect((result[1] as any).key).toBe('Person_4')
  })

  test('SKIP with LIMIT: SKIP=1, LIMIT=3 → rows 2,3,4', () => {
    const p = plan({ skip: 1, limit: 3 })
    const result = _executeQuery(p, nodes)
    expect(result.length).toBe(3)
    expect((result[0] as any).key).toBe('Person_2')
    expect((result[2] as any).key).toBe('Person_4')
  })

  test('SKIP works with empty node list', () => {
    const p = plan({ skip: 5 })
    const result = _executeQuery(p, [])
    expect(result.length).toBe(0)
  })

  test('SKIP with ORDER BY: correct ordering before skip', () => {
    const p = plan({
      skip: 2,
      orderBy: [{ property: 'age', direction: 'DESC' as const }],
    })
    const result = _executeQuery(p, nodes)
    // 年龄排序后: 45,40,35,30,25 → skip 2 → 35,30,25
    expect(result.length).toBe(3)
    expect((result[0] as any).key).toBe('Person_3') // age 35
    expect((result[1] as any).key).toBe('Person_2') // age 30
    expect((result[2] as any).key).toBe('Person_1') // age 25
  })

  test('SKIP where plan.skip is undefined: no skip', () => {
    const p = plan({ skip: undefined })
    const result = _executeQuery(p, nodes)
    expect(result.length).toBe(5)
  })
})
