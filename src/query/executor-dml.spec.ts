/**
 * executor-dml.spec.ts — direct unit tests for `_buildDmlRows` (and its filter
 * helpers), driving every DML fan-out path with crafted plan + allNodes fixtures.
 *
 * Why direct (not end-to-end): `_buildDmlRows(plan, allNodes)` is the DML result
 * builder invoked from `query-executor.ts:4427`.  The existing end-to-end
 * `query-engine-dml.spec.ts` only reaches 12% statement coverage because its
 * assertions are loose sanity checks.  Driving the builder directly lets each
 * fan-out branch (relationship MERGE, MATCH rows, UNWIND CREATE, aggregation,
 * alias-scoped projection, DELETE fan-out) be hit deterministically and its
 * output asserted precisely — turning latent projection bugs into failing tests.
 */
import { describe, it, expect } from 'vitest'
import { _buildDmlRows } from './executor-dml'
import type { QueryPlan } from './query-types'

/** Minimal plan object — fields beyond what a path reads are optional. */
function planOf(overrides: Record<string, unknown> = {}): QueryPlan {
  return {
    returnColumns: [],
    ...overrides,
  } as QueryPlan
}

/** A node seed, optionally with `_alias`/`_label`/`props` and magic `__` slots. */
type Node = Record<string, unknown>

describe('_buildDmlRows — relationship MERGE multi-pair fan-out (__relVarList)', () => {
  it('emits one row per edge when RETURN projects the relationship variable', () => {
    const edges = [
      { _type: 'KNOWS', __srcIdx: 0, __dstIdx: 1 },
      { _type: 'KNOWS', __srcIdx: 1, __dstIdx: 2 },
    ]
    const allNodes: Node[] = []
    ;(allNodes as any).__relVarList = edges
    const plan = planOf({
      returnColumns: ['r'],
      returnAliasMap: { r: 'r' },
      mergeEdges: [{ variable: 'r', source: 'a', target: 'b', label: 'KNOWS', direction: 'out' }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0].r).toBe(edges[0])
    expect(rows[1].r).toBe(edges[1])
  })

  it('falls through when no edge resolves (empty relVarList)', () => {
    const allNodes: Node[] = [{ _label: 'Node', name: 'x' }]
    ;(allNodes as any).__relVarList = []
    const plan = planOf({ returnColumns: ['n'], createNodes: [{ alias: 'n', label: 'Node', props: { name: 'x' } }] })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('_buildDmlRows — MATCH-row driven MERGE fan-out (__matchRows)', () => {
  it('projects WITH aliases per matched row', () => {
    const matchRows = [
      { x: 1, y: 'a' },
      { x: 2, y: 'b' },
      { x: 3, y: 'c' },
    ]
    const allNodes: Node[] = []
    ;(allNodes as any).__matchRows = matchRows
    const plan = planOf({ returnColumns: ['x', 'y'], returnAliasMap: {} })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ x: 1, y: 'a' })
    expect(rows[2]).toEqual({ x: 3, y: 'c' })
  })

  it('resolves dotted alias against a nested matched object', () => {
    const matchRows = [{ foo: { id: 7 } }, { foo: { id: 8 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__matchRows = matchRows
    const plan = planOf({ returnColumns: ['id'], returnAliasMap: { id: 'foo.id' } })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(7)
    expect(rows[1].id).toBe(8)
  })

  it('falls through to single-row projection when no MATCH row fully resolves', () => {
    const matchRows = [{ x: 1 }, { x: 2 }]
    const allNodes: Node[] = []
    ;(allNodes as any).__matchRows = matchRows
    // `missing` is not in any match row and has no dot → allResolved=false for every
    // row, so the __matchRows path is bypassed and DML falls through to the
    // generic single-row projection (which yields a single null-valued row).
    const plan = planOf({ returnColumns: ['missing'], returnAliasMap: {} })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].missing).toBeNull()
  })
})

describe('_buildDmlRows — MATCH-driven node fan-out (hasMatch + matchVar)', () => {
  it('fans out one row per matched node, projecting the match variable', () => {
    const allNodes: Node[] = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
      { _label: 'Person', name: 'Cara' },
    ]
    const plan = planOf({
      returnColumns: ['n'],
      hasMatch: true,
      matchVar: 'n',
      scanLabel: 'Person',
      mergeEdges: [],
      returnAliasMap: {},
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(3)
    expect(rows.map(r => (r.n as Node).name)).toEqual(['Alice', 'Bob', 'Cara'])
  })

  it('projects a property of the match variable per row', () => {
    const allNodes: Node[] = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    const plan = planOf({
      returnColumns: ['name'],
      hasMatch: true,
      matchVar: 'n',
      scanLabel: 'Person',
      mergeEdges: [],
      returnAliasMap: { name: 'n.name' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('Alice')
    expect(rows[1].name).toBe('Bob')
  })

  it('resolves a non-match (MERGE) alias via the binding table', () => {
    const created = { _label: 'Person', name: 'New', _alias: 'm' }
    const allNodes: Node[] = [created]
    ;(allNodes as any).__varToNodeMap = new Map([['m', created]])
    const plan = planOf({
      returnColumns: ['m'],
      hasMatch: true,
      matchVar: 'n',
      scanLabel: 'Person',
      mergeEdges: [],
      returnAliasMap: {},
    })
    // No matched Person nodes → matched=[] but __matchFanOutCount forces the fan-out
    const rows = _buildDmlRows(plan, allNodes)
    // The created node itself carries the Person label, so it matches too.
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  it('resolves a non-match alias via the _alias tag scan (no binding-table entry)', () => {
    const matched1 = { _label: 'Person', name: 'Alice' }
    const matched2 = { _label: 'Person', name: 'Bob' }
    const created = { _label: 'Other', name: 'Merged', _alias: 'm' }
    const allNodes: Node[] = [matched1, matched2, created]
    // No __varToNodeMap — resolution must fall through to the _alias scan.
    const plan = planOf({
      returnColumns: ['m'],
      hasMatch: true,
      matchVar: 'n',
      scanLabel: 'Person',
      mergeEdges: [],
      returnAliasMap: {},
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) {
      expect((r.m as Node).name).toBe('Merged')
    }
  })

  it('resolves a non-match alias via a top-level property scan', () => {
    const matched1 = { _label: 'Person', name: 'Alice' }
    const matched2 = { _label: 'Person', name: 'Bob' }
    const carrier = { _label: 'Other', status: 'ok' }
    const allNodes: Node[] = [matched1, matched2, carrier]
    const plan = planOf({
      returnColumns: ['status'],
      hasMatch: true,
      matchVar: 'n',
      scanLabel: 'Person',
      mergeEdges: [],
      returnAliasMap: { status: 'x.status' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) {
      expect(r.status).toBe('ok')
    }
  })
})

describe('_buildDmlRows — UNWIND + CREATE relationship multi-row (__createEdges)', () => {
  it('emits one row per created edge projecting the edge property', () => {
    const edges = [{ props: { num: 1 } }, { props: { num: 2 } }, { props: { num: 3 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2, 3], name: 'x' },
      returnAliasMap: { num: 'r.num' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.num)).toEqual([1, 2, 3])
  })

  it('projects the whole edge when the column is the relationship variable', () => {
    const edges = [{ props: { num: 1 }, _type: 'R' }, { props: { num: 2 }, _type: 'R' }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['r'],
      unwind: { list: [1, 2], name: 'x' },
      returnAliasMap: { r: 'r' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0].r).toBe(edges[0])
  })

  it('aggregates sum(r.num) over created edges', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['sum'],
      unwind: { list: [1, 2], name: 'x' },
      with: { aggregates: [{ function: 'sum', field: 'r.num', alias: 'sum' }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].sum).toBe(30)
  })

  it('aggregates avg(r.num) over created edges', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['avg'],
      unwind: { list: [1, 2], name: 'x' },
      with: { aggregate: { function: 'avg', field: 'r.num', alias: 'avg' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].avg).toBe(15)
  })

  it('aggregates max/min over created edges (plan.aggregate path)', () => {
    const edges = [{ props: { num: 5 } }, { props: { num: 9 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['mx'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'max', field: 'r.num', alias: 'mx', column: 'max(r.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node).mx ?? (rows[0] as Node)['max(r.num)']).toBe(9)
  })

  it('counts created edges for count aggregate', () => {
    const edges = [{ props: { num: 1 } }, { props: { num: 2 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['c'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'count', field: 'r', alias: '', column: 'count(r)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0][(rows[0] as any)['count(r)'] !== undefined ? 'count(r)' : 'c']).toBe(2)
  })

  it('applies WITH WHERE edge filters (r.num % 2 = 0)', () => {
    const edges = [{ props: { num: 1 } }, { props: { num: 2 } }, { props: { num: 4 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2, 3], name: 'x' },
      returnAliasMap: { num: 'r.num' },
      with: { filters: [{ expression: 'r.num % 2 = 0', operator: 'EQ', value: true }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.num)).toEqual([2, 4])
  })

  it('applies edge filters with GT/GTE/LT comparison operators', () => {
    const edges = [{ props: { num: 1 } }, { props: { num: 5 } }, { props: { num: 10 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2, 3], name: 'x' },
      returnAliasMap: { num: 'r.num' },
      // GT 4 → 5, 10
      with: { filters: [{ expression: 'r.num', operator: 'GT', value: 4 }] },
    })
    let rows = _buildDmlRows(plan, allNodes)
    expect(rows.map(r => r.num)).toEqual([5, 10])

    const planGte = planOf({
      returnColumns: ['num'], unwind: { list: [1, 2, 3], name: 'x' },
      returnAliasMap: { num: 'r.num' },
      with: { filters: [{ expression: 'r.num', operator: 'GTE', value: 5 }] },
    })
    rows = _buildDmlRows(planGte, allNodes)
    expect(rows.map(r => r.num)).toEqual([5, 10])
  })

  it('counts created edges via WITH aggregate (count)', () => {
    const edges = [{ props: { num: 1 } }, { props: { num: 2 } }, { props: { num: 3 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['c'],
      unwind: { list: [1, 2, 3], name: 'x' },
      with: { aggregate: { function: 'count', field: 'r', alias: 'c' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].c).toBe(3)
  })

  it('aggregates min over created edges via WITH aggregate', () => {
    const edges = [{ props: { num: 8 } }, { props: { num: 3 } }, { props: { num: 12 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['mn'],
      unwind: { list: [1, 2, 3], name: 'x' },
      with: { aggregate: { function: 'min', field: 'r.num', alias: 'mn' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].mn).toBe(3)
  })

  it('aggregates max over created edges via WITH aggregate', () => {
    const edges = [{ props: { num: 8 } }, { props: { num: 3 } }, { props: { num: 12 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['mx'],
      unwind: { list: [1, 2, 3], name: 'x' },
      with: { aggregate: { function: 'max', field: 'r.num', alias: 'mx' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].mx).toBe(12)
  })

  it('unknown aggregate function falls back to 0 (default branch)', () => {
    const edges = [{ props: { num: 1 }, _type: 'R' }, { props: { num: 2 }, _type: 'R' }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    // Unknown aggregate fn (`_unknown_`) with no field → default branch emits 0.
    const plan = planOf({
      returnColumns: ['c'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: '_unknown_', field: '', alias: 'c', column: '_unknown_(r)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node).c ?? (rows[0] as Node)['_unknown_(r)']).toBe(0)
  })
})

describe('_buildDmlRows — UNWIND + CREATE node multi-row (createdAlias)', () => {
  it('emits one row per freshly created node', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 1 },
      { _label: 'Node', _alias: 'n', num: 2 },
      { _label: 'Node', _alias: 'n', num: 3 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.num)).toEqual([1, 2, 3])
  })

  it('aggregates sum over freshly created nodes via WITH aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 15 },
    ]
    const plan = planOf({
      returnColumns: ['sum'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      with: { aggregates: [{ function: 'sum', field: 'n.num', alias: 'sum' }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].sum).toBe(20)
  })

  it('aggregates min/max over freshly created nodes (plan.aggregate path)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 15 },
      { _label: 'Node', _alias: 'n', num: 10 },
    ]
    const plan = planOf({
      returnColumns: ['mn', 'mx'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      aggregate: { function: 'min', field: 'n.num', alias: 'mn', column: 'min(n.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node).mn ?? (rows[0] as Node)['min(n.num)']).toBe(5)
  })

  it('counts freshly created nodes via WITH aggregate (count)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 1 },
      { _label: 'Node', _alias: 'n', num: 2 },
      { _label: 'Node', _alias: 'n', num: 3 },
    ]
    const plan = planOf({
      returnColumns: ['c'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      with: { aggregate: { function: 'count', field: 'n', alias: 'c' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].c).toBe(3)
  })

  it('aggregates min over created nodes via WITH aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 2 },
      { _label: 'Node', _alias: 'n', num: 9 },
    ]
    const plan = planOf({
      returnColumns: ['mn'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      with: { aggregate: { function: 'min', field: 'n.num', alias: 'mn' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].mn).toBe(2)
  })

  it('aggregates max over created nodes via WITH aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 2 },
      { _label: 'Node', _alias: 'n', num: 9 },
    ]
    const plan = planOf({
      returnColumns: ['mx'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      with: { aggregate: { function: 'max', field: 'n.num', alias: 'mx' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].mx).toBe(9)
  })

  it('aggregates avg over created nodes via plan.aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 10 },
      { _label: 'Node', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['avg'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      aggregate: { function: 'avg', field: 'n.num', alias: 'avg', column: 'avg(n.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node).avg ?? (rows[0] as Node)['avg(n.num)']).toBe(15)
  })

  it('aggregates max over created nodes via plan.aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 25 },
    ]
    const plan = planOf({
      returnColumns: ['mx'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      aggregate: { function: 'max', field: 'n.num', alias: 'mx', column: 'max(n.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node).mx ?? (rows[0] as Node)['max(n.num)']).toBe(25)
  })

  it('applies WITH WHERE node filters (n.num % 2 = 0)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 1 },
      { _label: 'Node', _alias: 'n', num: 2 },
      { _label: 'Node', _alias: 'n', num: 4 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ expression: 'n.num % 2 = 0', operator: 'EQ', value: true }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.num)).toEqual([2, 4])
  })

  it('applies a plain property comparison filter (non-expression, GT)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 15 },
      { _label: 'Node', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'GT', value: 10 }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.num)).toEqual([15, 20])
  })

  it('negated filter inverts the match', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 15 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'EQ', value: 5, negated: true }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(15)
  })

  it('applies LTE/GTE/LT/NEQ comparison operators', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 3 },
      { _label: 'Node', _alias: 'n', num: 10 },
      { _label: 'Node', _alias: 'n', num: 20 },
    ]
    // LTE keeps num <= 10 → 3, 10
    const planLte = planOf({
      returnColumns: ['num'], unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'LTE', value: 10 }] },
    })
    let rows = _buildDmlRows(planLte, allNodes)
    expect(rows.map(r => r.num)).toEqual([3, 10])

    // GTE keeps num >= 10 → 10, 20
    const planGte = planOf({
      returnColumns: ['num'], unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'GTE', value: 10 }] },
    })
    rows = _buildDmlRows(planGte, allNodes)
    expect(rows.map(r => r.num)).toEqual([10, 20])

    // LT keeps num < 10 → 3
    const planLt = planOf({
      returnColumns: ['num'], unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'LT', value: 10 }] },
    })
    rows = _buildDmlRows(planLt, allNodes)
    expect(rows.map(r => r.num)).toEqual([3])

    // NEQ keeps num != 10 → 3, 20
    const planNeq = planOf({
      returnColumns: ['num'], unwind: { list: [1, 2, 3], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'NEQ', value: 10 }] },
    })
    rows = _buildDmlRows(planNeq, allNodes)
    expect(rows.map(r => r.num)).toEqual([3, 20])
  })

  it('expression filter that throws drops the row (catch → keep=false)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 1 },
      { _label: 'Node', _alias: 'n', num: 2 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      // Evaluating a non-existent variable path throws → matches() returns false.
      with: { filters: [{ expression: 'missing.deep.access', operator: 'EQ', value: true }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    // The throwing expression causes matches() to return false → both rows dropped.
    expect(rows).toHaveLength(0)
  })
})

describe('_buildDmlRows — single-row DML projection', () => {
  it('CREATE without RETURN produces no rows', () => {
    const plan = planOf({ returnColumns: [], createNodes: [{ alias: 'n', label: 'Person', props: { name: 'Alice' } }] })
    const rows = _buildDmlRows(plan, [])
    expect(rows).toHaveLength(0)
  })

  it('RETURN a variable projects the created node via alias match', () => {
    const plan = planOf({
      returnColumns: ['n'],
      createNodes: [{ alias: 'n', label: 'Person', props: { name: 'Alice' } }],
    })
    const rows = _buildDmlRows(plan, [])
    expect(rows).toHaveLength(1)
    expect((rows[0].n as Node).name).toBe('Alice')
  })

  it('RETURN a bare variable with no props yields the label placeholder', () => {
    const plan = planOf({
      returnColumns: ['n'],
      createNodes: [{ alias: 'n', label: 'Thing', props: null }],
    })
    const rows = _buildDmlRows(plan, [])
    expect(rows).toHaveLength(1)
    expect((rows[0].n as Node)._label).toBe('Thing')
  })

  it('aggregate count(*) over bare DML yields 1 (not the node count)', () => {
    const plan = planOf({
      returnColumns: ['count'],
      aggregate: { function: 'count', field: 'n', alias: 'count', column: 'count(n)' },
      createNodes: [{ alias: 'n', label: 'Person', props: { name: 'Alice' } }],
    })
    const rows = _buildDmlRows(plan, [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }])
    expect(rows).toHaveLength(1)
    // `alias === function` is NOT a signal of an absent alias, so the canonical
    // result key falls back to the full `column` (`count(n)`).
    expect((rows[0] as Node)['count(n)']).toBe(1)
  })

  it('aggregate sum over node properties keyed by column when alias equals function', () => {
    const allNodes: Node[] = [{ age: 10 }, { age: 20 }, { age: 30 }]
    const plan = planOf({
      returnColumns: ['sum'],
      aggregate: { function: 'sum', field: 'age', alias: 'sum', column: 'sum(n.age)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['sum(n.age)']).toBe(60)
  })

  it('aggregate sum keyed by a distinct AS alias', () => {
    const allNodes: Node[] = [{ age: 10 }, { age: 20 }]
    const plan = planOf({
      returnColumns: ['total'],
      aggregate: { function: 'sum', field: 'age', alias: 'total', column: 'sum(n.age)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node).total ?? (rows[0] as Node)['sum(n.age)']).toBe(30)
  })

  it('alias-scoped projection prefers the aliased node over a same-named seed', () => {
    // seed node `a` carries num=42; created node `a` carries num=43.
    const allNodes: Node[] = [
      { _label: 'Seed', num: 42 },
      { _label: 'Created', num: 43, _alias: 'a' },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      returnAliasMap: { num: 'a.num' },
      createNodes: [{ alias: 'a', label: 'Created', props: { num: 43 } }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(43)
  })

  it('resolves relationship variable property via __relVarMap', () => {
    const edgeObj = { _type: 'T', props: { name: 'rel3' } }
    const allNodes: Node[] = []
    ;(allNodes as any).__relVarMap = new Map([['t2', edgeObj]])
    const plan = planOf({
      returnColumns: ['name'],
      returnAliasMap: { name: 't2.name' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('rel3')
  })

  it('evaluates a function-call return column (labels(node))', () => {
    const allNodes: Node[] = [{ _label: 'TheLabel:Foo', _alias: 'a' }]
    const plan = planOf({
      returnColumns: ['labels(a)'],
      createNodes: [{ alias: 'a', label: 'TheLabel', props: null }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    // labels() returns an array containing the full label string(s)
    const labels = (rows[0] as Node)['labels(a)']
    expect(Array.isArray(labels)).toBe(true)
  })

  it('resolves a bound-variable alias (WITH n AS a then CREATE (a))', () => {
    const bound = { _label: 'Person', name: 'Alice' }
    const allNodes: Node[] = [bound]
    ;(allNodes as any).__varToNodeMap = new Map([['a', bound]])
    const plan = planOf({
      returnColumns: ['a'],
      createNodes: [{ alias: 'a', label: null, props: {} }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0].a as Node).name).toBe('Alice')
  })

  it('resolves a dot property from the created-node props via returnAliasMap', () => {
    const allNodes: Node[] = [{ _label: 'Person', _alias: 'n', props: { name: 'Zed' } }]
    const plan = planOf({
      returnColumns: ['name'],
      returnAliasMap: { name: 'n.name' },
      createNodes: [{ alias: 'n', label: 'Person', props: { name: 'Zed' } }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Zed')
  })

  it('resolves a WITH re-bound map projection (__withVarMap)', () => {
    const allNodes: Node[] = [{ _label: 'M', id: 42 }]
    ;(allNodes as any).__withVarMap = new Map([['m', { first: 42 }]])
    const plan = planOf({
      returnColumns: ['first'],
      returnAliasMap: { first: 'm.first' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].first).toBe(42)
  })

  it('resolves a relationship path function (type(r)) via the expression engine', () => {
    const edgeObj = { _type: 'KNOWS' }
    const allNodes: Node[] = [{ _label: 'A' }]
    ;(allNodes as any).__relVarMap = new Map([['r', edgeObj]])
    const plan = planOf({
      returnColumns: ['type(r)'],
      returnAliasMap: { 'type(r)': 'type(r)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node)['type(r)']).toBe('KNOWS')
  })

  it('resolves a dynamic property expression (n["nam" + "e"])', () => {
    // The live node carries the property at top level (expanded props), so the
    // expression engine can resolve `n["nam" + "e"]` against it.
    const allNodes: Node[] = [{ _label: 'P', _alias: 'n', name: 'Dyn' }]
    const plan = planOf({
      returnColumns: ['v'],
      returnAliasMap: { v: "n['nam' + 'e']" },
      createNodes: [{ alias: 'n', label: 'P', props: { name: 'Dyn' } }],
      parameters: {},
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].v).toBe('Dyn')
  })

  it('resolves a createEdges property via returnAliasMap when not on any node', () => {
    const allNodes: Node[] = [{ _label: 'A' }]
    const plan = planOf({
      returnColumns: ['num'],
      returnAliasMap: { num: 'r.num' },
      createEdges: [{ source: 'a', target: 'b', label: 'R', direction: 'out', props: { num: 99 } }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(99)
  })
})

describe('_buildDmlRows — relationship MERGE DELETE fan-out (__matchFanOutCount)', () => {
  it('expands a single projected row to the preserved pre-delete cardinality', () => {
    const allNodes: Node[] = [{ _label: 'T' }]
    ;(allNodes as any).__matchFanOutCount = 3
    const plan = planOf({
      returnColumns: ['name'],
      returnAliasMap: { name: 't2.name' },
      mergeEdges: [{ source: 'a', target: 'b', label: 'T', direction: 'out' }],
    })
    ;(allNodes as any).__relVarMap = new Map([['t2', { _type: 'T', props: { name: 'rel3' } }]])
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(3)
    expect(rows[0].name).toBe('rel3')
    expect(rows[2].name).toBe('rel3')
  })

  it('does not fan out when the delete cardinality is 1', () => {
    const allNodes: Node[] = [{ _label: 'T' }]
    ;(allNodes as any).__matchFanOutCount = 1
    const plan = planOf({
      returnColumns: ['name'],
      returnAliasMap: { name: 't2.name' },
      mergeEdges: [{ source: 'a', target: 'b', label: 'T', direction: 'out' }],
    })
    ;(allNodes as any).__relVarMap = new Map([['t2', { _type: 'T', props: { name: 'rel3' } }]])
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
  })
})

describe('_buildDmlRows — plain plan.aggregate over bare DML (prop-field switch)', () => {
  it('aggregates avg over node properties', () => {
    const allNodes: Node[] = [{ age: 10 }, { age: 20 }, { age: 30 }]
    const plan = planOf({
      returnColumns: ['avg'],
      aggregate: { function: 'avg', field: 'age', alias: 'avg', column: 'avg(n.age)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['avg(n.age)']).toBe(20)
  })

  it('aggregates max over node properties', () => {
    const allNodes: Node[] = [{ age: 10 }, { age: 30 }, { age: 20 }]
    const plan = planOf({
      returnColumns: ['max'],
      aggregate: { function: 'max', field: 'age', alias: 'max', column: 'max(n.age)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['max(n.age)']).toBe(30)
  })

  it('aggregates min over node properties', () => {
    const allNodes: Node[] = [{ age: 10 }, { age: 30 }, { age: 20 }]
    const plan = planOf({
      returnColumns: ['min'],
      aggregate: { function: 'min', field: 'age', alias: 'min', column: 'min(n.age)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['min(n.age)']).toBe(10)
  })

  it('unknown aggregate function falls back to 0 (default switch)', () => {
    const allNodes: Node[] = [{ age: 10 }]
    const plan = planOf({
      returnColumns: ['x'],
      aggregate: { function: 'collect', field: 'age', alias: 'x', column: 'collect(n.age)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBe(0)
  })

  it('aggregate without a prop field falls back to 0', () => {
    const plan = planOf({
      returnColumns: ['x'],
      aggregate: { function: 'sum', field: '', alias: 'x', column: 'sum(*)' },
    })
    const rows = _buildDmlRows(plan, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBe(0)
  })
})

describe('_buildDmlRows — stage-4b createEdges property + fnCall fallback', () => {
  it('resolves a createEdges property via returnAliasMap (edge prop not on any node)', () => {
    const plan = planOf({
      returnColumns: ['num'],
      returnAliasMap: { num: 'r.num' },
      createEdges: [{ source: 'a', target: 'b', label: 'R', props: { num: 99 } }],
    })
    const rows = _buildDmlRows(plan, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(99)
  })

  it('resolves a function-call column via __varToNodeMap fallback (no _alias)', () => {
    const bound = { _label: 'Person', name: 'Alice' }
    const allNodes: Node[] = [bound]
    ;(allNodes as any).__varToNodeMap = new Map([['a', bound]])
    const plan = planOf({
      returnColumns: ['id(a)'],
      createNodes: [{ alias: 'a', label: 'Person', props: null }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0] as Node)['id(a)']).toBeDefined()
  })
})

describe('_buildDmlRows — _applyWithFilters operator variants', () => {
  it('plain-property NEQ filter', () => {
    const nodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 3 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: null, props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'NEQ', value: 3 }] },
    })
    const rows = _buildDmlRows(plan, nodes)
    // NEQ 3 → keeps num=5 only
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(5)
  })

  it('expression filter that throws drops the row (catch → return false)', () => {
    const nodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 7 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: null, props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ expression: 'nosuchfn(n.num)', operator: 'EQ', value: 0 }] },
    })
    const rows = _buildDmlRows(plan, nodes)
    // unknown function → _evaluateExpression throws → catch → return false → dropped
    expect(rows).toHaveLength(0)
  })

  it('unknown operator defaults to no-match (default switch)', () => {
    const nodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 5 },
      { _label: 'Node', _alias: 'n', num: 5 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: null, props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ property: 'num', operator: 'LIKE', value: 5 }] },
    })
    const rows = _buildDmlRows(plan, nodes)
    expect(rows).toHaveLength(0)
  })
})

describe('_buildDmlRows — _applyEdgeWithFilters operator variants', () => {
  it('negative-filter early continue when no expression (guard)', () => {
    const edges: Node[] = [{ props: { num: 5 } }, { props: { num: 8 } }]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      returnAliasMap: { num: 'r.num' },
      with: { filters: [{ operator: 'EQ', value: 5 }] },
    })
    const nodes = [{}] as Node[]
    ;(nodes as any).__createEdges = edges
    const rows = _buildDmlRows(plan, nodes)
    // No expression → the filter is skipped (continue), so all rows survive.
    expect(rows).toHaveLength(2)
  })

  it('NEQ/LT/LTE comparison operators', () => {
    const mk = (operator: string, value: number, nums: number[]) => {
      const edges: Node[] = nums.map(num => ({ props: { num } }))
      const plan = planOf({
        returnColumns: ['num'],
        unwind: { list: nums, name: 'x' },
        returnAliasMap: { num: 'r.num' },
        with: { filters: [{ expression: 'r.num', operator, value }] },
      })
      const nodes = [{}] as Node[]
      ;(nodes as any).__createEdges = edges
      return _buildDmlRows(plan, nodes)
    }
    // NEQ 3 keeps 5 (and drops 3)
    expect(mk('NEQ', 3, [5, 3])).toHaveLength(1)
    // LT 5 keeps 3 (drops 5, 8)
    expect(mk('LT', 5, [3, 5, 8])).toHaveLength(1)
    // LTE 5 keeps 5 (drops 8)
    expect(mk('LTE', 5, [5, 8])).toHaveLength(1)
    // unknown operator → matched=false → dropped
    expect(mk('BOGUS', 5, [5, 8])).toHaveLength(0)
  })

  it('negated edge filter inverts the keep decision', () => {
    const edges: Node[] = [{ props: { num: 5 } }, { props: { num: 9 } }]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      returnAliasMap: { num: 'r.num' },
      with: { filters: [{ expression: 'r.num', operator: 'EQ', value: 5, negated: true }] },
    })
    const nodes = [{}] as Node[]
    ;(nodes as any).__createEdges = edges
    // negated + matched(5==5) → dropped; 9 != 5 → kept
    const rows = _buildDmlRows(plan, nodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(9)
  })
})

describe('_buildDmlRows — edge aggregate default / no-prop variants (createEdges)', () => {
  it('_withAggRel sum variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['s'],
      unwind: { list: [1, 2], name: 'x' },
      with: { aggregate: { function: 'sum', field: 'r.num', alias: 's' } },
    })
    expect(_buildDmlRows(plan, allNodes)).toEqual([{ s: 30 }])
  })

  it('_withAggRel avg variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['a'],
      unwind: { list: [1, 2], name: 'x' },
      with: { aggregate: { function: 'avg', field: 'r.num', alias: 'a' } },
    })
    expect(_buildDmlRows(plan, allNodes)).toEqual([{ a: 15 }])
  })

  it('_withAggRel default (unknown fn) variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      with: { aggregate: { function: 'bogus', field: 'r.num', alias: 'x' } },
    })
    expect(_buildDmlRows(plan, allNodes)).toEqual([{ x: 0 }])
  })

  it('_withAggRel no-prop (empty field) variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      with: { aggregate: { function: 'sum', field: '', alias: 'x' } },
    })
    expect(_buildDmlRows(plan, allNodes)).toEqual([{ x: 0 }])
  })

  it('plan.aggregate avg variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['a'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'avg', field: 'r.num', alias: 'a', column: 'avg(r.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['avg(r.num)']).toBe(15)
  })

  it('plan.aggregate default (unknown fn) variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'bogus', field: 'r.num', alias: 'x', column: 'bogus(r.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['bogus(r.num)']).toBe(0)
  })

  it('plan.aggregate no-prop (empty field) variant', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'sum', field: '', alias: 'x', column: 'sum(*)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['sum(*)']).toBe(0)
  })

  it('plan.aggregate sum variant (createEdges)', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['s'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'sum', field: 'r.num', alias: 's', column: 'sum(r.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['sum(r.num)']).toBe(30)
  })

  it('plan.aggregate min variant (createEdges)', () => {
    const edges = [{ props: { num: 10 } }, { props: { num: 20 } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['m'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'min', field: 'r.num', alias: 'm', column: 'min(r.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['min(r.num)']).toBe(10)
  })
})

describe('_buildDmlRows — single-row projection stage internals', () => {
  it('skips empty return-column entries across all fan-out paths (if !rc continue)', () => {
    // A falsy '' return column fires the `if (!rc) continue` guard in the
    // __relVarList, __matchRows, __matchVar, unwoundNodes, and single-row loops.
    const allNodes: Node[] = []
    ;(allNodes as any).__relVarList = [{ _type: 'R' }, { _type: 'R' }]
    ;(allNodes as any).__matchRows = [{ x: 1 }, { x: 2 }]
    const plan = planOf({ returnColumns: ['', 'x'] })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('stage-1 rescans rc in node top-level and node.props', () => {
    // rc directly on a node top-level (not via aliasMap) → stage-1 first branch.
    const allNodes: Node[] = [{ name: 'Alice' }]
    const plan = planOf({ returnColumns: ['name'] })
    expect(_buildDmlRows(plan, allNodes)).toEqual([{ name: 'Alice' }])

    // rc inside node.props (not top-level) → stage-1 second branch.
    const allNodes2: Node[] = [{ props: { age: 30 } }]
    expect(_buildDmlRows(planOf({ returnColumns: ['age'] }), allNodes2)).toEqual([{ age: 30 }])
  })

  it('target-node v2n binding-table resolution', () => {
    // _targetNodeFor prefers the v2n binding table over the _alias tag scan.
    const binding = { _label: 'Person', name: 'Bound' }
    const allNodes: Node[] = [{ _alias: 'a', _label: 'Other', name: 'Tagged' }]
    ;(allNodes as any).__varToNodeMap = new Map([['a', binding]])
    const plan = planOf({
      returnColumns: ['name'],
      returnAliasMap: { name: 'a.name' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Bound')
  })

  it('bound-variable alias resolves via _alias tag when v2n misses', () => {
    // Stage-2 bound-variable fallback: v2n has no entry, so the `_alias` scan
    // finds the tagged node.
    const allNodes: Node[] = [{ _alias: 'a', _label: 'Person', name: 'Tagged' }]
    const plan = planOf({
      returnColumns: ['a'],
      createNodes: [{ alias: 'a', label: null, props: {} }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect((rows[0].a as Node).name).toBe('Tagged')
  })

  it('dynamic expression binds created node template via clean builder (no live node)', () => {
    // No live _alias-tagged node exists → varCtx falls back to the clean
    // template (props with `value` unwrap + label). A non-dotted expression
    // (`id(a)`) enters the dynamic block, hitting lines 555-560.
    const allNodes: Node[] = [{ unrelated: true }]
    const plan = planOf({
      returnColumns: ['out'],
      returnAliasMap: { out: 'id(a)' },
      createNodes: [{ alias: 'a', label: 'Person', props: { name: { value: 'Templated' } } }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    // id(a) resolves the clean template node (id → a stable synthetic value).
    expect(rows[0].out).not.toBeNull()
  })

  it('dynamic expression binds parameters from plan.parameters', () => {
    const allNodes: Node[] = []
    const plan = planOf({
      returnColumns: ['out'],
      returnAliasMap: { out: 'p' },
      parameters: { p: 42 },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].out).toBe(42)
  })

  it('alias property split falls back to scanning node.props', () => {
    // The final property-split scan (lines 580-584) resolves `a.age` from a node's
    // props when no live node/varCtx/v2n matches the alias.
    const allNodes: Node[] = [{ props: { age: 55 } }]
    const plan = planOf({
      returnColumns: ['age'],
      returnAliasMap: { age: 'a.age' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].age).toBe(55)
  })

  it('fnCall builds clean template when no live node and no v2n entry', () => {
    // fnCall block (lines 620-623): no _alias-tagged live node AND no v2n entry
    // → clean template from cn.props + cn.label.
    const allNodes: Node[] = []
    const plan = planOf({
      returnColumns: ['labels(a)'],
      createNodes: [{ alias: 'a', label: 'Person', props: { name: 'x' } }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(Array.isArray(rows[0]['labels(a)'])).toBe(true)
    expect(rows[0]['labels(a)']).toContain('Person')
  })

  it('_resolveColumn returns null for an unresolvable non-match alias', () => {
    // In the MATCH fan-out path (hasMatch + fanOutCount > 1), a column
    // referencing an alias with no binding-table entry, no _alias tag, and no
    // matching property → `!target return null`.
    const allNodes: Node[] = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    ;(allNodes as any).__varToNodeMap = new Map()
    const plan = planOf({
      hasMatch: true,
      matchVar: 'person',
      scanLabel: 'Person',
      returnColumns: ['ghost.prop'],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0]['ghost.prop']).toBe(null)
    expect(rows[1]['ghost.prop']).toBe(null)
  })

  it('_resolveColumn resolves non-match alias via v2n binding table', () => {
    const binding = { _label: 'Node', name: 'Bound' }
    const allNodes: Node[] = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    ;(allNodes as any).__varToNodeMap = new Map([['x', binding]])
    const plan = planOf({
      hasMatch: true,
      matchVar: 'person',
      scanLabel: 'Person',
      returnColumns: ['x.name'],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0]['x.name']).toBe('Bound')
  })

  it('_resolveColumn returns null when target prop is undefined (v===undefined→null)', () => {
    const binding = { _label: 'Node' } // no `name` property
    const allNodes: Node[] = [
      { _label: 'Person', name: 'Alice' },
      { _label: 'Person', name: 'Bob' },
    ]
    ;(allNodes as any).__varToNodeMap = new Map([['x', binding]])
    const plan = planOf({
      hasMatch: true,
      matchVar: 'person',
      scanLabel: 'Person',
      returnColumns: ['x.missing'],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0]['x.missing']).toBe(null)
  })

  it('__matchRows fan-out skips empty return-column entries', () => {
    const allNodes: Node[] = [{ x: 1, y: 2 }]
    ;(allNodes as any).__matchRows = [{ x: 1, y: 2 }, { x: 3, y: 4 }]
    const plan = planOf({ returnColumns: ['', 'x'] })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
  })

  it('unwoundNodes per-node projection scans nodeProps and propPart fallback', () => {
    // rc resolved via dot-property returnAliasMap → nodeProps scan (line 274),
    // and propPart directly on the node (line 275).
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', props: { age: 30 } },
      { _label: 'N', _alias: 'n', age: 40 },
    ]
    const plan = planOf({
      returnColumns: ['a', 'b'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { age: 0 } }],
      returnAliasMap: { a: 'n.age', b: 'n.age' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
  })

  it('single-row projection skips empty return-column and nulls unresolvable', () => {
    // `if (!rc) continue` (line 440) plus final `row[rc] = null` (line 635).
    const allNodes: Node[] = [{ name: 'x' }]
    const plan = planOf({ returnColumns: ['', 'nosuchcol'] })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toEqual([{ nosuchcol: null }])
  })
})

describe('_buildDmlRows — filter catch/negated guards', () => {
  it('_applyWithFilters expression catch returns false (line 703)', () => {
    // A filter whose expression evaluation throws hits the `catch` → return false
    // branch in _applyWithFilters (only reachable via the unwoundNodes path).
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 1 },
      { _label: 'N', _alias: 'n', num: 2 },
    ]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      returnAliasMap: { num: 'n.num' },
      with: { filters: [{ expression: 'throw_expr(n.num)', operator: 'EQ', value: 1 }] },
    })
    const rows = _buildDmlRows(plan, allNodes)
    // Any throwing expression → each row drops via catch → return false.
    expect(rows).toHaveLength(0)
  })
})

describe('_buildDmlRows — unwoundNodes aggregate count/sum/default variants', () => {
  it('unwoundNodes count via plan.aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['c'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      aggregate: { function: 'count', field: 'n', alias: '', column: 'count(n)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].c ?? rows[0]['count(n)']).toBe(2)
  })

  it('unwoundNodes sum via plan.aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['s'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      aggregate: { function: 'sum', field: 'n.num', alias: '', column: 'sum(n.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].s ?? rows[0]['sum(n.num)']).toBe(30)
  })

  it('unwoundNodes default (unknown fn) via plan.aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      aggregate: { function: 'bogus', field: 'n.num', alias: 'x', column: 'bogus(n.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['bogus(n.num)']).toBe(0)
  })

  it('unwoundNodes no-prop (empty field) via plan.aggregate', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      aggregate: { function: 'sum', field: '', alias: 'x', column: 'sum(*)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['sum(*)']).toBe(0)
  })

  it('unwoundNodes _withAgg avg variant', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['a'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      with: { aggregate: { function: 'avg', field: 'n.num', alias: 'a' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].a).toBe(15)
  })

  it('unwoundNodes _withAgg default (unknown fn) variant', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      with: { aggregate: { function: 'bogus', field: 'n.num', alias: 'x' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBe(0)
  })

  it('unwoundNodes _withAgg no-prop (empty field) variant', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 10 },
      { _label: 'N', _alias: 'n', num: 20 },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N', props: { num: 0 } }],
      with: { aggregate: { function: 'sum', field: '', alias: 'x' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBe(0)
  })
})

describe('_buildDmlRows — branch false-arm coverage (last-mile if-guards)', () => {
  it('MATCH fan-out with exactly one matched node does not fan out (L149 false)', () => {
    const allNodes: Node[] = [{ _label: 'Person', name: 'Alice' }]
    const plan = planOf({
      returnColumns: ['person'],
      hasMatch: true,
      matchVar: 'person',
      scanLabel: 'Person',
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
  })

  it('UNWIND+CREATE with a single created node does not enter multi-row expansion (L236 false)', () => {
    const allNodes: Node[] = [{ _label: 'N', _alias: 'n', num: 42 }]
    const plan = planOf({
      returnColumns: ['num'],
      unwind: { list: [1], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N' }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
  })

  it('UNWIND+CREATE node projection resolves prop via returnAliasMap fallback (L268/L275)', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', props: { num: 10 } },
      { _label: 'N', _alias: 'n', props: { num: 20 } },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N' }],
      returnAliasMap: { x: 'n.num' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows[0].x).toBe(10)
    expect(rows[1].x).toBe(20)
  })

  it('alias-scoped target exists but property undefined -> stage-1 fallthrough (L452 false)', () => {
    const allNodes: Node[] = [{ _label: 'N', _alias: 'n', age: 7 }]
    const plan = planOf({
      returnColumns: ['n.missing'],
      createNodes: [{ alias: 'n', label: 'N' }],
      returnAliasMap: { 'n.missing': 'n.missing' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['n.missing']).toBeNull()
  })

  it('no node carries the column as a top-level prop -> null (L475 false)', () => {
    const allNodes: Node[] = [{ _label: 'N', _alias: 'n' }]
    const plan = planOf({
      returnColumns: ['ghost'],
      createNodes: [{ alias: 'n', label: 'N' }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].ghost).toBeNull()
  })

  it('matchNode without label/props and no bound node -> placeholder (L511/L514 false)', () => {
    const allNodes: Node[] = [{ _label: 'N' }]
    const plan = planOf({
      returnColumns: ['a'],
      createNodes: [{ alias: 'a' }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].a).toEqual({ _label: 'Default' })
  })

  it('matchNode label with empty props -> label placeholder (L475/L514)', () => {
    const allNodes: Node[] = []
    const plan = planOf({
      returnColumns: ['n'],
      createNodes: [{ alias: 'n', label: 'X', props: {} }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].n).toEqual({ _label: 'X' })
  })
})

describe('_buildDmlRows — if-guard false-arms (empty-rc, edge-match, binding-table)', () => {
  it('empty-string return column drives `if (!rc) continue` (L149/L236/L264)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 1 },
      { _label: 'Node', _alias: 'n', num: 2 },
    ]
    const plan = planOf({
      returnColumns: ['', 'num'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node' }],
      returnAliasMap: { num: 'n.num' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.num)).toEqual([1, 2])
  })

  it('relVarMap edge prop absent -> rval undefined (L511 false / L514 false)', () => {
    const allNodes: Node[] = []
    ;(allNodes as any).__relVarMap = new Map([['t2', { name: 'x', props: {} }]])
    const plan = planOf({
      returnColumns: ['t2.missing'],
      createNodes: [],
      returnAliasMap: { 't2.missing': 't2.missing' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['t2.missing']).toBeNull()
  })

  it('relVarMap edge prop present -> rval defined (L511 false / L514 true)', () => {
    const allNodes: Node[] = []
    ;(allNodes as any).__relVarMap = new Map([['t2', { name: 'rel', props: { name: 'rel' } }]])
    const plan = planOf({
      returnColumns: ['t2.name'],
      createNodes: [],
      returnAliasMap: { 't2.name': 't2.name' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['t2.name']).toBe('rel')
  })

  it('withVarMap expression resolving to null -> rval null (L533 false)', () => {
    const allNodes: Node[] = []
    ;(allNodes as any).__withVarMap = new Map([['m', { id: 1 }]])
    const plan = planOf({
      returnColumns: ['m.nope'],
      createNodes: [],
      returnAliasMap: { 'm.nope': 'm.nope' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['m.nope']).toBeNull()
  })

  it('createNode without alias skips alias binding (L546 false)', () => {
    const allNodes: Node[] = [{ _label: 'N', name: 'x' }]
    const plan = planOf({
      returnColumns: ['labels(n)'],
      createNodes: [{ label: 'N' }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
  })

  it('function-call return column resolving without node alias (L556/L559/L610 false)', () => {
    const allNodes: Node[] = []
    const plan = planOf({
      returnColumns: ['x'],
      createNodes: [{}],  // no label, no props
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBeNull()
  })

  it('dynamic expression undefined -> falls through to prop-split (L573 false)', () => {
    const allNodes: Node[] = [{ _label: 'N', _alias: 'n', name: 'v' }]
    const plan = planOf({
      returnColumns: ['n.name'],
      createNodes: [{ alias: 'n', label: 'N' }],
      returnAliasMap: { 'n.name': 'n.name' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['n.name']).toBe('v')
  })

  it('return column is a known prop key -> null-prop branch (L588 false)', () => {
    const allNodes: Node[] = [{ _label: 'N', _alias: 'n', name: 'v' }]
    const plan = planOf({
      returnColumns: ['name'],
      createNodes: [{ alias: 'n', label: 'N' }],
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('v')
  })
})

describe('_buildDmlRows — aggregate empty-values false arms (values.length ? : 0)', () => {
  it('avg over non-numeric (all-NaN) node props -> values empty -> 0 (L305/L339)', () => {
    const allNodes: Node[] = [
      { _label: 'Node', _alias: 'n', num: 'abc' },
      { _label: 'Node', _alias: 'n', num: 'def' },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'Node' }],
      with: { aggregate: { function: 'avg', field: 'n.num', alias: 'x' } },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBe(0)
  })

  it('max over non-numeric created edges -> values empty -> 0 (L196/L224)', () => {
    const edges = [{ props: { num: 'x' } }, { props: { num: 'y' } }]
    const allNodes: Node[] = []
    ;(allNodes as any).__createEdges = edges
    const plan = planOf({
      returnColumns: ['a'],
      unwind: { list: [1, 2], name: 'x' },
      aggregate: { function: 'max', field: 'r.num', alias: 'a', column: 'max(r.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['max(r.num)']).toBe(0)
  })

  it('min over non-numeric node props via plan.aggregate -> 0 (L340/L386)', () => {
    const allNodes: Node[] = [
      { _label: 'N', _alias: 'n', num: 'z' },
      { _label: 'N', _alias: 'n', num: 'w' },
    ]
    const plan = planOf({
      returnColumns: ['x'],
      unwind: { list: [1, 2], name: 'x' },
      createNodes: [{ alias: 'n', label: 'N' }],
      aggregate: { function: 'min', field: 'n.num', alias: 'x', column: 'min(n.num)' },
    })
    const rows = _buildDmlRows(plan, allNodes)
    expect(rows).toHaveLength(1)
    expect(rows[0]['min(n.num)']).toBe(0)
  })
})
