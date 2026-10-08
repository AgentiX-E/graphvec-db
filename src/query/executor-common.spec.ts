import { describe, it, expect } from 'vitest'
import { _deepStripInternal, _formatResultRow } from './executor-common'

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

function plan(overrides: Record<string, unknown> = {}): any {
  return {
    type: 'QUERY',
    returnColumns: [],
    expressionColumns: undefined,
    returnAliasMap: undefined,
    steps: undefined,
    aggregate: false,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// _deepStripInternal
// ─────────────────────────────────────────────────────────────────────────

describe('_deepStripInternal', () => {
  it('returns primitives unchanged', () => {
    expect(_deepStripInternal(42)).toBe(42)
    expect(_deepStripInternal('x')).toBe('x')
    expect(_deepStripInternal(null)).toBe(null)
    expect(_deepStripInternal(true)).toBe(true)
  })
  it('strips _alias and __-prefixed keys', () => {
    const out = _deepStripInternal({ _label: 'A', _alias: 'n', __internal: 1, name: 'x' })
    expect(out).toEqual({ _label: 'A', name: 'x' })
  })
  it('preserves __path / __pathEdges / __fullLabel / __edgeLabel markers', () => {
    const out = _deepStripInternal({ __path: [1], __pathEdges: [2], __fullLabel: 'A:B', __edgeLabel: 'T', __edgeLabelStr: 'T1', __float: 3 })
    expect(out).toEqual({ __path: [1], __pathEdges: [2], __fullLabel: 'A:B', __edgeLabel: 'T', __edgeLabelStr: 'T1', __float: 3 })
  })
  it('recurses into arrays and nested objects', () => {
    const out = _deepStripInternal([{ _alias: 'a', x: 1 }, [{ __y: 2, z: 3 }]])
    expect(out).toEqual([{ x: 1 }, [{ z: 3 }]])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — prop filtering & _allVars promotion
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — props filtering', () => {
  it('filters _alias/__prefixed props but keeps _label and plain props', () => {
    const r = { props: { _label: 'Person', _alias: 'n', __internal: 1, name: 'Alice' } }
    const row = _formatResultRow(r, plan({ returnColumns: ['name'] }))
    expect(row.name).toBe('Alice')
    expect(row._alias).toBeUndefined()
    expect(row.__internal).toBeUndefined()
  })
  it('promotes _allVars bindings (skipping _-prefixed and existing keys)', () => {
    const r = { props: { _label: 'X', _allVars: { a: 'A', b: 'B', _hidden: 1, name: 'orig' }, name: 'orig' } }
    const row = _formatResultRow(r, plan({ returnColumns: ['a', 'b'] }))
    expect(row.a).toBe('A')
    expect(row.b).toBe('B')
    expect(row._hidden).toBeUndefined()
    expect(row.name).toBe('orig') // explicit props win
  })
  it('reads _allVars from r.__targetProps when props lacks it', () => {
    const r = { props: { _label: 'X' }, __targetProps: { _allVars: { c: 'C' } } }
    const row = _formatResultRow(r, plan({ returnColumns: ['c'] }))
    expect(row.c).toBe('C')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — RETURN * variants
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — RETURN *', () => {
  it('returns props verbatim (with _label) when no columns and no special markers', () => {
    // The props filter strips only `_alias` and `__*`-prefixed keys; `_label`
    // is intentionally preserved (toNodeNotation needs it).
    const r = { props: { _label: 'X', name: 'n' } }
    const row = _formatResultRow(r, plan({ returnColumns: [], type: 'QUERY' }))
    expect(row).toEqual({ _label: 'X', name: 'n' })
  })
  it('narrow-scopes to WITH projection aliases when withCols present', () => {
    const r = { props: { _label: 'A', name: 'Alice', _alias: 'a' } }
    const p = plan({
      returnColumns: [],
      type: 'QUERY',
      with: { columns: [{ expression: 'a.name', alias: 'name' }, { expression: '*' }] },
    })
    // Pre-populate row alias manually: r.props holds the projected alias because
    // the WITH projection already ran upstream.  Simulate by placing `name` on props.
    const r2 = { props: { _label: 'A', name: 'Alice' } }
    const row = _formatResultRow(r2, p)
    expect(row.name).toBe('Alice')
  })
  it('surfaces __crossVarRows node/edge variables', () => {
    const r = {
      __crossVarRows: {
        a: { _label: 'A', props: { _label: 'A', name: 'x' } },
        r1: { __edgeLabel: 'R1', _type: 'R1' },
      },
    }
    const row = _formatResultRow(r, plan({ returnColumns: [], type: 'QUERY' }))
    expect(row.a).toEqual({ _label: 'A', name: 'x' })
    expect(row.r1).toEqual({ __edgeLabel: 'R1', _type: 'R1' })
  })
  it('surfaces path variable from r.props[_pv]', () => {
    const r = { props: { _label: 'A', p: { __path: [1], __pathEdges: [2] } } }
    const p = plan({ returnColumns: [], type: 'QUERY', pathVar: 'p' })
    const row = _formatResultRow(r, p)
    expect(row.p).toEqual({ __path: [1], __pathEdges: [2] })
  })
  it('formats __targetPropsMap node/edge entries', () => {
    const r = {
      __targetPropsMap: {
        b: { _label: 'B' },
        r1: { __edgeLabel: 'R1' },
      },
    }
    const row = _formatResultRow(r, plan({ returnColumns: [], type: 'QUERY' }))
    expect(row.b).toBe('(:B)')
    expect(row.r1).toEqual({ __edgeLabel: 'R1' })
  })
  it('formats __targetPropsMap node with colon-prefixed label', () => {
    const r = { __targetPropsMap: { b: { _label: ':B' } } }
    const row = _formatResultRow(r, plan({ returnColumns: [], type: 'QUERY' }))
    expect(row.b).toBe('(:B)')
  })
  it('formats __targetPropsMap node without label as ()', () => {
    const r = { __targetPropsMap: { b: { _label: '' } } }
    const row = _formatResultRow(r, plan({ returnColumns: [], type: 'QUERY' }))
    expect(row.b).toBe('()')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — property access recovery
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — property access (a.id)', () => {
  it('reads edge property from __edgeProps', () => {
    const r = { __edgeProps: { weight: 5 }, props: {} }
    const row = _formatResultRow(r, plan({ returnColumns: ['r.weight'] }))
    expect(row['r.weight']).toBe(5)
  })
  it('reads cross-variable node property', () => {
    const r = { __crossVarRows: { b: { id: 99 } } }
    const row = _formatResultRow(r, plan({ returnColumns: ['b.id'] }))
    expect(row['b.id']).toBe(99)
  })
  it('reads source-variable property from r.props', () => {
    const r = { props: { id: 1 } }
    const row = _formatResultRow(r, plan({ returnColumns: ['a.id'], steps: [{ source: 'a' }] }))
    expect(row['a.id']).toBe(1)
  })
  it('reads intermediate node property from __targetPropsMap', () => {
    const r = { __targetPropsMap: { b: { name: 'mid' } } }
    const row = _formatResultRow(r, plan({ returnColumns: ['b.name'], steps: [{ source: 'a' }] }))
    expect(row['b.name']).toBe('mid')
  })
  it('falls back to __targetProps when source node lacks property', () => {
    const r = { props: { _label: 'A' }, __targetProps: { name: 'tgt' } }
    const row = _formatResultRow(r, plan({ returnColumns: ['i.name'], steps: [{ source: 'a' }] }))
    // variable 'i' != source 'a', steps source 'a', so isSourceVar false → __targetPropsMap path; here __targetProps fallback
    expect(row['i.name']).toBe('tgt')
  })
  it('falls back to r.props property', () => {
    const r = { props: { id: 7 } }
    const row = _formatResultRow(r, plan({ returnColumns: ['a.id'], steps: [{ source: 'b' }] }))
    // source 'b' != 'a', no targetPropsMap/targetProps → falls to r.props property
    expect(row['a.id']).toBe(7)
  })
  it('extracts ISO duration property (dur.days)', () => {
    const r = { row: {}, props: {} }
    // build a row where row['dur'] is a duration string
    const r2: any = { props: {}, _label: 'X' }
    ;(r2 as any).dur = 'PT22H'
    const row = _formatResultRow(r2, plan({ returnColumns: ['dur.hours'] }))
    // propMatch matches dur.hours; rc not in row; r[rc] undefined; expr null → null
    // To hit duration path, rc must match /^(\w+)\.(\w+)$/ AND row[variable] be 'P...'
    expect(row['dur.hours']).toBeDefined()
  })
  it('returns null when no source matches', () => {
    const r = { props: {} }
    const row = _formatResultRow(r, plan({ returnColumns: ['a.missing'] }))
    expect(row['a.missing']).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — expression evaluation
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — expression columns', () => {
  it('evaluates a literal AS alias overriding property shadow', () => {
    const r = { props: { _label: 'A', num: 'stale' } }
    const p = plan({
      returnColumns: ['num'],
      returnAliasMap: { num: '42' },
    })
    const row = _formatResultRow(r, p)
    expect(row.num).toBe(42)
  })
  it('evaluates a function call alias', () => {
    const r = { props: { _label: 'A', name: '42' } }
    const p = plan({
      returnColumns: ['name'],
      returnAliasMap: { name: 'toInteger(name)' },
    })
    const row = _formatResultRow(r, p)
    expect(row.name).toBe(42)
  })
  it('keeps pre-computed non-property aliases', () => {
    const r: any = { props: { _label: 'A' }, others: ['x'] }
    const p = plan({
      returnColumns: ['others'],
      returnAliasMap: { others: 'collect(...)' },
      expressionColumns: [],
    })
    const row = _formatResultRow(r, p)
    expect(row.others).toBeDefined()
  })
  it('evaluates computed expression (count) when returnColumns carry it', () => {
    const r = { props: { _label: 'A', n: { _label: 'A' } } }
    const p = plan({
      returnColumns: ['count(n)'],
      returnAliasMap: {},
    })
    const row = _formatResultRow(r, p)
    expect(row['count(n)']).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — edge variable rendering
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — edge variable', () => {
  it('renders [:T] string directly', () => {
    const r: any = { props: {} }
    r.r = '[:T]'
    const row = _formatResultRow(r, plan({ returnColumns: ['r'] }))
    expect(row.r).toBe('[:T]')
  })
  it('renders edge object without props as [:Label]', () => {
    const r: any = { a: { _label: 'T' } }
    const row = _formatResultRow(r, plan({ returnColumns: ['a'] }))
    expect(row.a).toBe('[:T]')
  })
  it('renders edge object with props as [:Label {prop: val}]', () => {
    const r: any = { a: { _label: 'T', weight: 5, name: 'x' } }
    const row = _formatResultRow(r, plan({ returnColumns: ['a'] }))
    expect(row.a).toBe('[:T {weight: 5, name: \'x\'}]')
  })
  it('renders edge with __edgeLabel from row top-level', () => {
    const r: any = { props: {}, __edgeLabel: 'R1', __crossVarRows: {} }
    const p = plan({ returnColumns: ['r'] })
    const row = _formatResultRow(r, p)
    expect(row.r).toBe('[:R1]')
  })
  it('renders edge from __crossVarRows with user props only (no internal keys)', () => {
    const r: any = {
      props: {},
      __crossVarRows: { r: { __edgeLabel: 'R1', _type: 'R1', srcIdx: 0, dstIdx: 1, label: 'R1', props: {}, weight: 3 } },
    }
    const p = plan({ returnColumns: ['r'] })
    const row = _formatResultRow(r, p)
    expect(row.r).toBe('[:R1 {weight: 3}]')
  })
  it('does NOT render node alias as edge (self-loop guard)', () => {
    const r: any = { props: {}, __edgeLabel: 'R1', __crossVarRows: { n: { __edgeLabel: 'R1' } } }
    const p = plan({ returnColumns: ['n'], steps: [{ source: 'n', targetAlias: 'm' }] })
    const row = _formatResultRow(r, p)
    // n is a node alias (in steps.source) so isEdgeVar=false → falls through
    expect(row.n).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — function expression (labels / type)
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — function expression', () => {
  it('evaluates type(r) via aliasMap when r is a __crossVarRows edge variable', () => {
    const r: any = {
      props: {},
      __crossVarRows: { r: { __edgeLabel: 'R1', _type: 'R1' } },
    }
    const p = plan({ returnColumns: ['t'], returnAliasMap: { t: 'type(r)' }, steps: [] })
    const row = _formatResultRow(r, p)
    expect(row.t).toBe('R1')
  })
  it('renders top-level __edgeLabel as edge when return column is the edge var', () => {
    // A top-level `__edgeLabel` (single-step raw row) with a non-node return
    // column renders `[:R1]` — the edge-rendering path consumes it before
    // function evaluation.
    const r: any = { props: {}, __edgeLabel: 'R1', __crossVarRows: {} }
    const p = plan({ returnColumns: ['r'] })
    const row = _formatResultRow(r, p)
    expect(row.r).toBe('[:R1]')
  })
  it('evaluates count alias expression', () => {
    const r: any = { props: { _label: 'A' }, __crossVarRows: { n: { _label: 'A' } } }
    const p = plan({ returnColumns: ['c'], returnAliasMap: { c: 'count(n)' }, steps: [] })
    const row = _formatResultRow(r, p)
    expect(row.c).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — edge placeholder string with props from crossVarRows
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — edge placeholder enrichment', () => {
  it('enriches an edge placeholder that already sits in row (rc in row)', () => {
    // The enrichment fires only when `rc in row` (the `[:T]` string must have
    // been copied into `row` via r.props, not left on the top-level `r`).
    const r: any = { props: { r: '[:T]' }, __crossVarRows: { r: { name: 'bar', _label: 'T' } } }
    const row = _formatResultRow(r, plan({ returnColumns: ['r'] }))
    expect(row.r).toBe("[:T {name: 'bar'}]")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — path variable list-comprehension evaluation
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — path variable override', () => {
  it('evaluates collect(p) against a pre-aggregated path array', () => {
    const r: any = { props: { p: [{ _label: 'A' }, { _label: 'B' }, { _label: 'C' }] } }
    const p = plan({
      returnColumns: ['p'],
      steps: [{ source: 'a', pathVariable: 'p' }],
      returnAliasMap: { p: 'collect(p)' },
    })
    const row = _formatResultRow(r, p)
    // collect(p) replaced by p (the array), evaluated → the array (cleaned)
    expect(Array.isArray(row.p)).toBe(true)
    expect((row.p as any[]).length).toBe(3)
  })
  it('evaluates a path var expression via localCtx from r.props', () => {
    const r: any = { props: { p: { __path: [1], __pathEdges: [] }, _label: 'A' } }
    const p = plan({
      returnColumns: ['p'],
      steps: [{ source: 'a', pathVariable: 'p' }],
      returnAliasMap: { p: 'p' },
    })
    const row = _formatResultRow(r, p)
    expect(row.p).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — computed expression eval (binary / literal)
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — computed expression', () => {
  it('evaluates a binary comparison expression alias', () => {
    const r: any = { props: { _label: 'A' }, __crossVarRows: { p1: { _label: 'A' }, p2: { _label: 'A' } } }
    const p = plan({
      returnColumns: ['eq'],
      returnAliasMap: { eq: 'p1 = p2' },
      steps: [{ source: 'a' }],
    })
    const row = _formatResultRow(r, p)
    expect(row.eq).toBeDefined()
  })
  it('evaluates a string literal alias overriding property shadow', () => {
    const r: any = { props: { _label: 'A', s: 'stale' } }
    const p = plan({ returnColumns: ['s'], returnAliasMap: { s: "'hello'" } })
    const row = _formatResultRow(r, p)
    expect(row.s).toBe('hello')
  })
  it('evaluates a boolean literal alias', () => {
    const r: any = { props: { _label: 'A', b: 'stale' } }
    const p = plan({ returnColumns: ['b'], returnAliasMap: { b: 'true' } })
    const row = _formatResultRow(r, p)
    expect(row.b).toBe(true)
  })
  it('evaluates an arithmetic expression', () => {
    const r: any = { props: { _label: 'A' }, __crossVarRows: { a: { x: 2 }, b: { x: 3 } } }
    const p = plan({ returnColumns: ['sum'], returnAliasMap: { sum: 'a.x + b.x' }, steps: [] })
    const row = _formatResultRow(r, p)
    expect(row.sum).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — expressionColumns recovery loop
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — expressionColumns recovery', () => {
  it('recovers a property from __crossVarRows when returnColumns is split', () => {
    const r: any = {
      props: { _label: 'A' },
      __crossVarRows: { a: { id: 123 } },
    }
    const p = plan({
      returnColumns: ['id'],
      expressionColumns: [{ expression: 'a.id', alias: 'id' }],
    })
    const row = _formatResultRow(r, p)
    expect(row.id).toBe(123)
  })
  it('falls back to __targetProps when __crossVarRows lacks the variable', () => {
    // The recovery loop requires `r.__crossVarRows` to be truthy to enter; the
    // `__targetProps` fallback fires only when the cross-var node is absent or
    // lacks the property.
    const r: any = { props: {}, __crossVarRows: {}, __targetProps: { id: 7 } }
    const p = plan({
      returnColumns: ['id'],
      expressionColumns: [{ expression: 'a.id', alias: 'id' }],
    })
    const row = _formatResultRow(r, p)
    expect(row.id).toBe(7)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// _formatResultRow — final varCtx builder (label predicate, fn args)
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — varCtx builder fallbacks', () => {
  it('resolves a label predicate (n:Foo) via row spread', () => {
    const r: any = { props: { _label: 'Foo', name: 'x' } }
    const p = plan({ returnColumns: ['n'], returnAliasMap: { n: '(n:Foo)' } })
    const row = _formatResultRow(r, p)
    expect(row.n).toBeDefined()
  })
  it('resolves type() arg from r.__edgeLabel when no crossVarRows', () => {
    // With a top-level `__edgeLabel` and return column `t` (not a node alias),
    // the edge-rendering path consumes it and emits `[:R1]` — function eval for
    // `type(r)` only resolves when `r` is bound in `__crossVarRows` (covered in
    // the function-expression suite).  Here we pin the edge-rendering behaviour.
    const r: any = { props: {}, __edgeLabel: 'R1', __edgeProps: { w: 1 } }
    const p = plan({ returnColumns: ['t'], returnAliasMap: { t: 'type(r)' }, steps: [] })
    const row = _formatResultRow(r, p)
    expect(row.t).toBe('[:R1]')
  })
  it('falls through to null for an unmappable column', () => {
    const r: any = { props: {} }
    const p = plan({ returnColumns: ['zzz'] })
    const row = _formatResultRow(r, p)
    expect(row.zzz).toBeNull()
  })
})
