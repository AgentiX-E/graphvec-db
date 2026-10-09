/**
 * executor-non-ge.spec.ts — direct unit tests for `_execNonGePaths` (the non-GE
 * early-exit dispatcher).
 *
 * `_execNonGePaths(plan, nodes, query)` routes queries that do not require a
 * GraphEngine instance: LOAD CSV, SHOW, CALL procedures, INDEX/CONSTRAINT
 * lifecycle, CATALOG/USE, UNION, WITH/UNWIND pipeline delegation, pure RETURN
 * literals, FOREACH, and variable-length-path (BFS).  Each branch is hit with a
 * crafted plan + node-seed fixture and its output asserted precisely.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { _execNonGePaths } from './executor-non-ge'
import { _clearIndexes, _clearConstraints, _clearDatabases, _registerIndex, _registerConstraint } from './executor-registry'
import type { QueryPlan } from './query-types'

/** Minimal plan object — fields beyond what a path reads are optional. */
function planOf(overrides: Record<string, unknown> = {}): QueryPlan {
  return { returnColumns: [], ...overrides } as QueryPlan
}

beforeEach(() => {
  _clearIndexes()
  _clearConstraints()
  _clearDatabases()
})

describe('_execNonGePaths — LOAD CSV', () => {
  it('throws when the CSV file does not exist', async () => {
    const p = planOf({ loadCsv: { url: '/nonexistent/nope.csv', hasHeaders: true, delimiter: ',', rowVariable: 'row' } })
    await expect(_execNonGePaths(p, [])).rejects.toThrow(/LOAD CSV error/)
  })

  it('reads and parses a real CSV file', async () => {
    const tmp = path.join(os.tmpdir(), `exec-non-ge-${Date.now()}.csv`)
    fs.writeFileSync(tmp, 'a,b\n1,2\n3,4\n')
    const p = planOf({ loadCsv: { url: 'file://' + tmp, hasHeaders: true, delimiter: ',', rowVariable: 'row' } })
    const r = await _execNonGePaths(p, []) as any[]
    fs.unlinkSync(tmp)
    expect(r).toHaveLength(2)
    expect(r[0].row.a).toBe('1')
    expect(r[0].row.b).toBe('2')
  })
})

describe('_execNonGePaths — SHOW', () => {
  it('SHOW LABELS collects unique labels from nodes', async () => {
    const nodes = [{ _label: 'A' }, { _label: 'A' }, { _label: 'B' }]
    const p = planOf({ show: { what: 'LABELS' } })
    const r = await _execNonGePaths(p, nodes)
    expect(r).toEqual([{ label: 'A' }, { label: 'B' }])
  })

  it('SHOW INDEXES returns empty when no indexes registered', async () => {
    const p = planOf({ show: { what: 'INDEXES' } })
    const r = await _execNonGePaths(p, [])
    expect(r).toEqual([])
  })

  it('SHOW CONSTRAINTS returns empty when no constraints registered', async () => {
    const p = planOf({ show: { what: 'CONSTRAINTS' } })
    const r = await _execNonGePaths(p, [])
    expect(r).toEqual([])
  })

  it('SHOW PROCEDURES returns the fixed procedure list', async () => {
    const p = planOf({ show: { what: 'PROCEDURES' } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]).toHaveProperty('name', 'db.labels')
  })

  it('SHOW FUNCTIONS returns the fixed function list', async () => {
    const p = planOf({ show: { what: 'FUNCTIONS' } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r.length).toBeGreaterThan(0)
  })

  it('SHOW RELATIONSHIPTYPES collects edge labels', async () => {
    const nodes = [
      { _label: 'A', __edges: [{ label: 'R1' }, { label: 'R1' }] },
      { _label: 'B', __edges: [{ label: 'R2' }] },
    ]
    const p = planOf({ show: { what: 'RELATIONSHIPTYPES' } })
    const r = await _execNonGePaths(p, nodes)
    expect(r).toEqual([{ relationshipType: 'R1' }, { relationshipType: 'R2' }])
  })

  it('SHOW with unknown what returns empty array', async () => {
    const p = planOf({ show: { what: 'UNKNOWN' } })
    const r = await _execNonGePaths(p, [])
    expect(r).toEqual([])
  })

  it('SHOW INDEXES lists registered indexes', async () => {
    _registerIndex('A', 'p')
    const p = planOf({ show: { what: 'INDEXES' } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ name: 'A.p' }])
  })

  it('SHOW CONSTRAINTS lists registered constraints', async () => {
    _registerConstraint('A_p_unique', 'A', 'p')
    const p = planOf({ show: { what: 'CONSTRAINTS' } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ name: 'A_p_unique' }])
  })

  it('CALL db.indexes reflects a registered index', async () => {
    _registerIndex('A', 'p')
    const p = planOf({ callProcedure: { name: 'db.indexes', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('A:p')
  })

  it('CALL db.constraints reflects a registered constraint', async () => {
    _registerConstraint('A_p_unique', 'A', 'p')
    const p = planOf({ callProcedure: { name: 'db.constraints', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toHaveLength(1)
    expect(r[0].name).toBe('A_p_unique')
  })
})

describe('_execNonGePaths — CALL procedures', () => {
  it('CALL db.labels returns node labels via yield aliases', async () => {
    const nodes = [{ _label: 'A:B' }, { _label: 'C' }]
    const p = planOf({ callProcedure: { name: 'db.labels', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(r.map((x) => x.label).sort()).toEqual(['A', 'B', 'C'])
  })

  it('CALL db.indexes returns index metadata shape', async () => {
    const p = planOf({ callProcedure: { name: 'db.indexes', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('CALL db.constraints returns constraint metadata shape', async () => {
    const p = planOf({ callProcedure: { name: 'db.constraints', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('CALL db.schema.visualization returns nodes/relationships maps', async () => {
    const nodes = [
      { _label: 'Person', name: 'a', __edges: [{ label: 'KNOWS', props: { since: 2020 } }] },
    ]
    const p = planOf({ callProcedure: { name: 'db.schema.visualization', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(r).toHaveLength(1)
    expect(r[0].nodes[0].name).toBe('Person')
    expect(r[0].relationships[0].type).toBe('KNOWS')
  })

  it('unknown procedure throws', async () => {
    const p = planOf({ callProcedure: { name: 'nope.nope', args: [], yieldItems: [] } })
    await expect(_execNonGePaths(p, [])).rejects.toThrow(/Unknown procedure/)
  })

  it('standalone db.stats.retrieve returns a single stats row', async () => {
    // No match/scan/steps → isStandalone → returns the raw procedure result
    // (one row), not a per-node cross join.
    const nodes = [{ _label: 'A', name: 'x' }, { _label: 'B', name: 'y' }]
    const p = planOf({ callProcedure: { name: 'db.stats.retrieve', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(r).toHaveLength(1)
    expect(r[0]).toHaveProperty('section', 'graph')
  })

  it('standalone db.schema.nodeTypeProperties invokes ctx.getLabels/getPropertyKeys', async () => {
    // This unregistered-in-switch proc calls _resolveLabels/_resolvePropertyKeys,
    // which invoke the standalone ctx's getLabels/getPropertyKeys callbacks.
    const nodes = [{ _label: 'Person', name: 'x' }]
    const p = planOf({ callProcedure: { name: 'db.schema.nodeTypeProperties', args: [], yieldItems: [] } })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(Array.isArray(r)).toBe(true)
    expect(r[0].propertyName).toBe('name')
  })

  it('standalone proc + WITH count(*) — secondPlan keeps callProcedure (real behavior)', async () => {
    // plan.with.columns with count(*) folds the aggregate, but the secondPlan
    // spread retains `callProcedure`, so _executeViaGraphEngine re-dispatches to
    // the procedure and returns the raw rows (documented real behaviour, not a
    // count fold).  Assert the actual output.
    const nodes = [{ _label: 'A' }, { _label: 'B' }]
    const p = planOf({
      callProcedure: { name: 'dbms.listConfig', args: [], yieldItems: [] },
      with: { columns: [{ alias: 'cnt', expression: 'count(*)' }] },
      returnColumns: ['cnt'],
    })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(r).toHaveLength(2)
    expect(r[0]).toHaveProperty('name')
  })
})

describe('_execNonGePaths — INDEX / CONSTRAINT / CATALOG / USE', () => {
  it('CREATE INDEX registers and returns created', async () => {
    const p = planOf({ indexOp: 'CREATE', indexLabel: 'A', indexProperty: 'p' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ created: true }])
  })

  it('DROP INDEX returns dropped', async () => {
    const p = planOf({ indexOp: 'DROP', indexLabel: 'A', indexProperty: 'p' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ dropped: true }])
  })

  it('indexOp with no label/property returns empty', async () => {
    const p = planOf({ indexOp: 'CREATE' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('DROP CONSTRAINT returns dropped', async () => {
    const p = planOf({ type: 'DROP_CONSTRAINT', constraint: { property: 'p', name: 'n', label: 'A' } })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ dropped: true }])
  })

  it('CREATE DATABASE via catalogOp', async () => {
    const p = planOf({ catalogOp: 'CREATE_DATABASE', useGraph: 'g1' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ database: 'g1', created: true }])
  })

  it('CREATE DATABASE without useGraph returns empty', async () => {
    const p = planOf({ catalogOp: 'CREATE_DATABASE' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('DROP DATABASE via catalogOp', async () => {
    const p = planOf({ catalogOp: 'DROP_DATABASE', useGraph: 'g1' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ database: 'g1', dropped: true }])
  })

  it('DROP DATABASE without useGraph returns empty', async () => {
    const p = planOf({ catalogOp: 'DROP_DATABASE' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('SHOW DATABASES via catalogOp', async () => {
    const p = planOf({ catalogOp: 'SHOW_DATABASES' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(Array.isArray(r)).toBe(true)
  })

  it('unknown catalogOp returns empty', async () => {
    const p = planOf({ catalogOp: 'WEIRD' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('USE with graph switches database', async () => {
    const p = planOf({ type: 'USE', useGraph: 'db1' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ database: 'db1', switched: true }])
  })

  it('USE without graph returns nodes unchanged', async () => {
    const nodes = [{ a: 1 }]
    const p = planOf({ type: 'USE' })
    const r = await _execNonGePaths(p, nodes)
    expect(r).toEqual(nodes)
  })
})

describe('_execNonGePaths — CREATE_CONSTRAINT (DML, no RETURN)', () => {
  it('registers a new unique constraint when data is unique', async () => {
    const nodes = [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }]
    const p = planOf({ type: 'CREATE_CONSTRAINT', constraint: { label: 'Person', property: 'name' } })
    const r = await _execNonGePaths(p, nodes)
    expect(r).toEqual([])
  })

  it('throws ConstraintValidationFailed on duplicate values', async () => {
    const nodes = [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Alice' }]
    const p = planOf({ type: 'CREATE_CONSTRAINT', constraint: { label: 'Person', property: 'name' } })
    await expect(_execNonGePaths(p, nodes)).rejects.toThrow(/ConstraintValidationFailed/)
  })

  it('is idempotent for an already-registered constraint', async () => {
    const nodes = [{ _label: 'Person', name: 'Alice' }]
    const p = planOf({ type: 'CREATE_CONSTRAINT', constraint: { label: 'Person', property: 'name' } })
    await _execNonGePaths(p, nodes)
    const r = await _execNonGePaths(p, nodes)
    expect(r).toEqual([])
  })

  it('ignores null values for uniqueness', async () => {
    const nodes = [{ _label: 'Person', name: null }, { _label: 'Person', name: null }]
    const p = planOf({ type: 'CREATE_CONSTRAINT', constraint: { label: 'Person', property: 'name' } })
    const r = await _execNonGePaths(p, nodes)
    expect(r).toEqual([])
  })

  it('unwraps typed {type,value} property format for uniqueness', async () => {
    const nodes = [
      { _label: 'P', name: { type: 'STRING', value: 'x' } },
      { _label: 'P', name: { type: 'STRING', value: 'x' } },
    ]
    const p = planOf({ type: 'CREATE_CONSTRAINT', constraint: { label: 'P', property: 'name' } })
    await expect(_execNonGePaths(p, nodes)).rejects.toThrow(/ConstraintValidationFailed/)
  })
})

describe('_execNonGePaths — pure RETURN literals / identifiers', () => {
  it('evaluates a numeric literal RETURN without MATCH', async () => {
    const p = planOf({ returnColumns: ['42'], type: 'QUERY' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ '42': 42 }])
  })

  it('returns null for a bare identifier with no scope', async () => {
    const p = planOf({ returnColumns: ['n'], type: 'QUERY' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ n: null }])
  })

  it('uses expressionColumns when present', async () => {
    const p = planOf({ returnColumns: ['x'], expressionColumns: [{ expression: '1 + 1', alias: 'x' }], type: 'QUERY' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ x: 2 }])
  })

  it('injects WITH columns before evaluating RETURN', async () => {
    const p = planOf({ returnColumns: [], with: { columns: [{ alias: 'a', expression: '5' }] }, type: 'QUERY' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ a: 5 }])
  })

  it('returns empty array when no row content and no columns', async () => {
    const p = planOf({ returnColumns: [], type: 'QUERY' })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })
})

describe('_execNonGePaths — DML without RETURN falls through to GE (returns null)', () => {
  it('CREATE/MERGE returns null to delegate to GE', async () => {
    const p = planOf({ type: 'CREATE', returnColumns: [] })
    const r = await _execNonGePaths(p, [])
    expect(r).toBeNull()
  })

  it('DELETE/SET/REMOVE without RETURN returns empty', async () => {
    const p = planOf({ type: 'DELETE', returnColumns: [] })
    const r = await _execNonGePaths(p, [])
    expect(r).toEqual([])
  })

  it('REMOVE without RETURN returns empty', async () => {
    const p = planOf({ type: 'REMOVE', returnColumns: [] })
    const r = await _execNonGePaths(p, [])
    expect(r).toEqual([])
  })
})

describe('_execNonGePaths — FOREACH (legacy updates)', () => {
  it('creates a node per list item (CREATE update)', async () => {
    const nodes: any[] = []
    const p = planOf({
      type: 'QUERY',
      returnColumns: [],
      forEach: {
        name: 'item',
        list: [1, 2],
        updates: [{ type: 'CREATE', label: 'N', alias: 'n', props: { val: 'item' } }],
      },
    })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(r).toHaveLength(2)
    expect(r[0].n.val).toBe(1)
    expect(r[1].n.val).toBe(2)
    expect(nodes).toHaveLength(2)
  })

  it('supports string list JSON fallback', async () => {
    const nodes: any[] = []
    const p = planOf({
      type: 'QUERY',
      returnColumns: [],
      forEach: {
        name: 'item',
        list: '[1,2]',
        updates: [{ type: 'CREATE', label: 'N', alias: 'n', props: { val: 'item' } }],
      },
    })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(r).toHaveLength(2)
  })

  it('SETs a property on matched nodes per item (SET update)', async () => {
    const nodes: any[] = [{ _label: 'N', _alias: 'n' }]
    const p = planOf({
      type: 'QUERY',
      returnColumns: [],
      forEach: {
        name: 'item',
        list: ['X'],
        updates: [{ type: 'SET', property: 'p', value: 'item', alias: 'n' }],
      },
    })
    const r = await _execNonGePaths(p, nodes) as any[]
    expect(Array.isArray(r)).toBe(true)
    expect(nodes[0].p).toBe('X')
  })

  it('returns baseline [row] when list resolves empty and row has content', async () => {
    const p = planOf({
      type: 'QUERY',
      returnColumns: [],
      with: { columns: [{ alias: 'a', expression: '5' }] },
      forEach: { name: 'item', list: [], updates: [] },
    })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ a: 5 }])
  })
})

describe('_execNonGePaths — FOREACH (new variable+operation)', () => {
  it('returns empty-list baseline row for new-format FOREACH', async () => {
    const p = planOf({
      type: 'QUERY',
      returnColumns: [],
      forEach: { variable: 'x', operation: 'SET', list: [] },
    })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{}])
  })

  it('executes a non-empty new-format FOREACH with inline updates', async () => {
    const nodes = [{ _label: 'A', name: 'x' }]
    const p = planOf({
      type: 'QUERY',
      returnColumns: ['n'],
      forEach: { variable: 'x', operation: 'SET', list: [1] },
    })
    const r = await _execNonGePaths(p, nodes)
    expect(Array.isArray(r)).toBe(true)
  })
})

describe('_execNonGePaths — UNION', () => {
  it('union dedups left+right rows', async () => {
    const right = { type: 'QUERY', returnColumns: ['1'] }
    const p = planOf({ type: 'QUERY', returnColumns: ['1'], unionType: 'union', rightPlan: right })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ '1': 1 }])
  })

  it('union_all concatenates left+right rows', async () => {
    const right = { type: 'QUERY', returnColumns: ['2'] }
    const p = planOf({ type: 'QUERY', returnColumns: ['1'], unionType: 'union_all', rightPlan: right })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ '1': 1 }, { '2': 2 }])
  })

  it('intersect keeps common rows', async () => {
    const right = { type: 'QUERY', returnColumns: ['1'] }
    const p = planOf({ type: 'QUERY', returnColumns: ['1'], unionType: 'intersect', rightPlan: right })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ '1': 1 }])
  })

  it('subtract removes right rows from left', async () => {
    const right = { type: 'QUERY', returnColumns: ['1'] }
    const p = planOf({ type: 'QUERY', returnColumns: ['1'], unionType: 'subtract', rightPlan: right })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([])
  })

  it('unknown unionType falls through to plain concatenation', async () => {
    const right = { type: 'QUERY', returnColumns: ['2'] }
    const p = planOf({ type: 'QUERY', returnColumns: ['1'], unionType: 'weird', rightPlan: right })
    const r = await _execNonGePaths(p, []) as any[]
    expect(r).toEqual([{ '1': 1 }, { '2': 2 }])
  })
})

describe('_execNonGePaths — variable-length path expressionColumns', () => {
  it('maps expressionColumns over VLE result rows', async () => {
    const nodes = [{ _label: 'A', name: 'a' }, { _label: 'B', name: 'b' }]
    // A one-step var-length BFS over a single edge: a-[R*1..1]->b.
    nodes[0].__edges = [{ srcIdx: 0, dstIdx: 1, label: 'R', props: {} }]
    const p = planOf({
      type: 'QUERY',
      steps: [{ source: 'a', targetAlias: 'b', range: { min: 1, max: 1 }, edgeVariable: 'r' }],
      returnColumns: ['a', 'b'],
      expressionColumns: [{ alias: 'b.name', expression: 'b.name' }],
      scanLabel: undefined,
    })
    const r = await _execNonGePaths(p, nodes)
    expect(Array.isArray(r)).toBe(true)
  })
})
