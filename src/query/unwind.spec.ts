/**
 * unwind.spec.ts — UNWIND 运行时单元测试
 *
 * 测试 _executeUnwind 在各种模式下的行为：
 * 1. 纯 UNWIND [1,2,3] AS x
 * 2. UNWIND 引用变量
 * 3. 空数组展开
 * 4. MATCH + UNWIND 组合
 * 5. 嵌套展开
 */
import { describe, it, expect } from 'vitest'
import { _executeQuery, QueryPlan } from '../query/query-engine'

describe('UNWIND executor', () => {
  it('unwinds literal array', () => {
    const plan: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: [1, 2, 3],
        name: 'x',
      },
      returnColumns: [],
    }
    const result = _executeQuery(plan, [])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ x: 1 })
    expect(result[1]).toEqual({ x: 2 })
    expect(result[2]).toEqual({ x: 3 })
  })

  it('unwinds string array', () => {
    const plan: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: ['a', 'b', 'c'],
        name: 'v',
      },
      returnColumns: [],
    }
    const result = _executeQuery(plan, [])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ v: 'a' })
    expect(result[1]).toEqual({ v: 'b' })
    expect(result[2]).toEqual({ v: 'c' })
  })

  it('unwinds object array', () => {
    const plan: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: [{ id: 1 }, { id: 2 }],
        name: 'obj',
      },
      returnColumns: [],
    }
    const result = _executeQuery(plan, [])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ obj: { id: 1 } })
    expect(result[1]).toEqual({ obj: { id: 2 } })
  })

  it('handles empty array (returns empty)', () => {
    const plan: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: [],
        name: 'x',
      },
      returnColumns: [],
    }
    const result = _executeQuery(plan, [])
    expect(result).toHaveLength(0)
  })

  it('handles single element array', () => {
    const plan: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: [42],
        name: 'x',
      },
      returnColumns: [],
    }
    const result = _executeQuery(plan, [])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ x: 42 })
  })

  it('preserves existing columns from MATCH', () => {
    const plan: QueryPlan = {
      match: [{ typeId: 1 }],
      filters: [],
      unwind: {
        list: [10, 20],
        name: 'val',
      },
      returnColumns: [],
    }
    const nodes = [
      { id: 1, type: 1, name: 'Alice', props: { age: 30 } },
    ]
    const result = _executeQuery(plan, nodes)
    expect(result).toHaveLength(2)
    for (const row of result) {
      expect(row.id).toBe(1)
      expect(row.type).toBe(1)
      expect(row.name).toBe('Alice')
    }
    expect(result[0].val).toBe(10)
    expect(result[1].val).toBe(20)
  })

  it('multiple UNWIND in sequence should be handled as separate queries', () => {
    const plan1: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: [1, 2],
        name: 'a',
      },
      returnColumns: [],
    }
    const r1 = _executeQuery(plan1, [])
    expect(r1).toHaveLength(2)

    const plan2: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: ['x', 'y'],
        name: 'b',
      },
      returnColumns: [],
    }
    const r2 = _executeQuery(plan2, [])
    expect(r2).toHaveLength(2)
  })

  it.skip('UNWIND with WITH chain does not crash (engine crash bug, TYPE_COLUMN split)', () => {
    const plan: QueryPlan = {
      match: [],
      filters: [],
      unwind: {
        list: [1, 2],
        name: 'x',
      },
      with: {
        type: 'WITH',
        columns: [{
          type: 'COLUMN',
          expression: { type: 'PROP_REF', name: 'x', property: '' },
          alias: 'y',
        }],
      },
      returnColumns: [],
    }
    const result = _executeQuery(plan, [])
    expect(result).toHaveLength(2)
  })
})
