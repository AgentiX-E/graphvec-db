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
import { _executeQuery, QueryPlan, parseQuery } from '../query/query-engine'

describe('UNWIND executor', () => {
  it('unwinds literal array', async () => {
    const plan: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: [1, 2, 3],
        name: 'x',
      },
      returnColumns: [],
    }
    const result = await _executeQuery(plan, [])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ x: 1 })
    expect(result[1]).toEqual({ x: 2 })
    expect(result[2]).toEqual({ x: 3 })
  })

  it('unwinds string array', async () => {
    // String list elements are stored as quoted raw text by the parser (to
    // preserve the empty string / whitespace), so a hand-built plan must
    // match that representation.
    const plan: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: ["'a'", "'b'", "'c'"],
        name: 'v',
      },
      returnColumns: [],
    }
    const result = await _executeQuery(plan, [])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ v: 'a' })
    expect(result[1]).toEqual({ v: 'b' })
    expect(result[2]).toEqual({ v: 'c' })
  })

  it('unwinds object array', async () => {
    const plan: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: [{ id: 1 }, { id: 2 }],
        name: 'obj',
      },
      returnColumns: [],
    }
    const result = await _executeQuery(plan, [])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ obj: { id: 1 } })
    expect(result[1]).toEqual({ obj: { id: 2 } })
  })

  it('handles empty array (returns empty)', async () => {
    const plan: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: [],
        name: 'x',
      },
      returnColumns: [],
    }
    const result = await _executeQuery(plan, [])
    expect(result).toHaveLength(0)
  })

  it('handles single element array', async () => {
    const plan: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: [42],
        name: 'x',
      },
      returnColumns: [],
    }
    const result = await _executeQuery(plan, [])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ x: 42 })
  })

  it('preserves existing columns from MATCH', async () => {
    // MATCH + UNWIND must widen each matched node with one row per unwound
    // element (cartesian product), keeping the node columns intact.
    const plan = parseQuery('MATCH (n:Person) UNWIND [10, 20] AS val RETURN val')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
    ]
    const result = await _executeQuery(plan, nodes)
    expect(result).toHaveLength(2)
    for (const row of result) {
      expect(row.name).toBe('Alice')
      expect(row.age).toBe(30)
    }
    expect(result[0].val).toBe(10)
    expect(result[1].val).toBe(20)
  })

  it('multiple UNWIND in sequence should be handled as separate queries', async () => {
    const plan1: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: [1, 2],
        name: 'a',
      },
      returnColumns: [],
    }
    const r1 = await _executeQuery(plan1, [])
    expect(r1).toHaveLength(2)

    const plan2: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: ["'x'", "'y'"],
        name: 'b',
      },
      returnColumns: [],
    }
    const r2 = await _executeQuery(plan2, [])
    expect(r2).toHaveLength(2)
  })

  it('UNWIND with WITH chain does not crash', async () => {
    const plan: QueryPlan = {
      scanLabel: null,
      labelExpr: null,
      steps: [],
      orderBy: [],
      limit: undefined,
      skip: undefined,
      filters: [],
      unwind: {
        list: [1, 2],
        name: 'x',
      },
      with: {
        columns: [{
          expression: 'x',
          alias: 'y',
        }],
        filters: [],
        orderBy: [],
        limit: undefined,
        skip: undefined,
      },
      returnColumns: [],
    }
    const result = await _executeQuery(plan, [])
    expect(result).toHaveLength(2)
  })
})

describe('UNWIND parser (extractUnwind bound-variable name)', () => {
  // Regression guard: `UNWIND range(0, i) AS j` must bind `j`, not the `i`
  // that appears inside the range expression.  The bound name is always the
  // trailing VariableContext after `AS`.

  it('binds the AS name when the list expression references a variable', () => {
    const plan = parseQuery('UNWIND range(0, i) AS j CREATE (s)-[:REL]->()')
    expect(plan.unwind?.name).toBe('j')
    expect(plan.unwind?.var).toBe('range(0, i)')
  })

  it('binds the AS name with multiple variables in the range expression', () => {
    const plan = parseQuery('UNWIND range(i, k) AS dest RETURN dest')
    expect(plan.unwind?.name).toBe('dest')
    expect(plan.unwind?.var).toBe('range(i, k)')
  })

  it('binds the AS name for a literal list (no variables in the expression)', () => {
    const plan = parseQuery('UNWIND [1, 2, 3] AS x RETURN x')
    expect(plan.unwind?.name).toBe('x')
    expect(plan.unwind?.list).toEqual([1, 2, 3])
  })

  it('binds the AS name for a string literal list', () => {
    const plan = parseQuery("UNWIND ['a', 'b'] AS v RETURN v")
    expect(plan.unwind?.name).toBe('v')
  })

  it('binds the AS name for a plain variable list', () => {
    const plan = parseQuery('UNWIND someList AS z RETURN z')
    expect(plan.unwind?.name).toBe('z')
    expect(plan.unwind?.var).toBe('someList')
  })
})

describe('UNWIND executor: MATCH variable property projection', () => {
  // Regression guard: `MATCH (n) UNWIND ... RETURN n.prop` must project `n.prop`
  // from the matched node (held in varCtx), not null.  The matched variable `n`
  // lives in varCtx while the unwound row only carries the unwind alias.

  it('projects a node property alongside the unwound value', async () => {
    const q = 'MATCH (n:Person) UNWIND [10, 20] AS val RETURN n.age, val'
    const plan = parseQuery(q)
    const nodes = [{ _label: 'Person', name: 'Alice', age: 30 }]
    const result = await _executeQuery(plan, nodes, q)
    expect(result).toHaveLength(2)
    expect(result[0].age).toBe(30)
    expect(result[0].val).toBe(10)
    expect(result[1].age).toBe(30)
    expect(result[1].val).toBe(20)
  })

  it('projects a string node property in the cartesian product', async () => {
    const q = 'MATCH (n:Person) UNWIND [1, 2] AS i RETURN n.name, i'
    const plan = parseQuery(q)
    const nodes = [{ _label: 'Person', name: 'Bob', age: 25 }]
    const result = await _executeQuery(plan, nodes, q)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Bob')
    expect(result[0].i).toBe(1)
    expect(result[1].name).toBe('Bob')
    expect(result[1].i).toBe(2)
  })

  it('preserves matched node columns for a plain RETURN val', async () => {
    const q = 'MATCH (n:Person) UNWIND [10, 20] AS val RETURN val'
    const plan = parseQuery(q)
    const nodes = [{ _label: 'Person', name: 'Alice', age: 30 }]
    const result = await _executeQuery(plan, nodes, q)
    expect(result).toHaveLength(2)
    expect(result[0].val).toBe(10)
    expect(result[1].val).toBe(20)
  })
})
