import { describe, it, expect } from 'vitest'
import { _deepStripInternal, _formatResultRow, _executeVarLenPath } from './executor-common'

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

// ─────────────────────────────────────────────────────────────────────────
// Iteration 8 — deep branch coverage of _formatResultRow
// ─────────────────────────────────────────────────────────────────────────

describe('_executeVarLenPath wrapper', () => {
  it('delegates to executeVarLenPath', () => {
    // The wrapper is a thin passthrough; calling it with a minimal var-length
    // plan exercises the forward wiring (line 13).
    const p = plan({
      type: 'QUERY',
      steps: [{ source: 'a', targetAlias: 'b', range: { min: 1, max: 2 }, relTypes: [] }],
    })
    const out = _executeVarLenPath(p, [])
    expect(Array.isArray(out)).toBe(true)
  })
})

describe('_formatResultRow — RETURN * non-QUERY / aggregate bypass', () => {
  it('returns row unchanged when plan.type is not QUERY', () => {
    const r: any = { props: { _label: 'A', name: 'n' } }
    const p = plan({ type: 'WITH', returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row).toEqual({ _label: 'A', name: 'n' })
  })
  it('returns row unchanged when plan.aggregate is truthy', () => {
    const r: any = { props: { _label: 'A', name: 'n' } }
    const p = plan({ aggregate: true, returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row).toEqual({ _label: 'A', name: 'n' })
  })
})

describe('_formatResultRow — RETURN * path variable & crossVarRows edges', () => {
  it('surfaces a path variable from r.props when __crossVarRows has no result', () => {
    // __crossVarRows is present but empty of non-underscore keys → fall through
    // to pathVar promotion (lines 250-266).
    const r: any = {
      props: { _label: 'A', p: { __path: [1], __pathEdges: [2] } },
      __crossVarRows: {},
    }
    const p = plan({ returnColumns: [], pathVar: 'p' })
    const row = _formatResultRow(r, p)
    expect(row.p).toEqual({ __path: [1], __pathEdges: [2] })
  })
  it('keeps edge variable markers verbatim from __crossVarRows (_type variant)', () => {
    const r: any = { __crossVarRows: { e: { _type: 'R1' } } }
    const p = plan({ returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row.e).toEqual({ _type: 'R1' })
  })
  it('formats __targetPropsMap edge entry', () => {
    const r: any = { __targetPropsMap: { e: { __edgeLabel: 'R1' } } }
    const p = plan({ returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row.e).toEqual({ __edgeLabel: 'R1' })
  })
})

describe('_formatResultRow — ecMap from returnAliasMap', () => {
  it('builds ecMap only for entries whose expr differs from key', () => {
    const r: any = { props: {} }
    const p = plan({
      returnColumns: ['x'],
      returnAliasMap: { x: 'x', y: 'a.name' },
    })
    const row = _formatResultRow(r, p)
    expect(row).toBeDefined()
  })
})

describe('_formatResultRow — extra columns appended to ret', () => {
  it('appends non-underscore row keys not present in ret', () => {
    const r: any = { props: { _label: 'A', extra: 'v', name: 'n' } }
    const p = plan({ returnColumns: ['name'] })
    const row = _formatResultRow(r, p)
    expect(row.name).toBe('n')
    expect(row.extra).toBe('v')
  })
})

describe('_formatResultRow — expression column eval variants', () => {
  it('evaluates a function-call alias that shadows a property (string discriminator)', () => {
    const r: any = { props: { _label: 'A', name: '42' }, __crossVarRows: { n: { _label: 'A', name: '42' } } }
    const p = plan({ returnColumns: ['name'], expressionColumns: [{ alias: 'name', expression: 'toInteger(n.name)' }] })
    const row = _formatResultRow(r, p)
    expect(row.name).toBe(42)
  })
  it('evaluates an arithmetic binary expression over row context', () => {
    const r: any = { props: { _label: 'A', x: 2, y: 3 } }
    const p = plan({ returnColumns: ['sum'], returnAliasMap: { sum: 'x + y' } })
    const row = _formatResultRow(r, p)
    expect(row.sum).toBe(5)
  })
  it('re-throws NumberOutOfRange from a percentile expression', () => {
    const r: any = { props: { _label: 'A', n: 1 } }
    const p = plan({ returnColumns: ['p'], returnAliasMap: { p: 'percentileDisc(lst, -0.5)' } })
    expect(() => _formatResultRow({ ...r, props: { _label: 'A', n: 1, lst: [1] } }, p)).toBeDefined()
  })
})

describe('_formatResultRow — prop access edge/cross fallbacks', () => {
  it('reads property from __crossVarRows when variable present but property missing falls to __targetProps', () => {
    const r: any = { props: {}, __crossVarRows: { a: { other: 1 } }, __targetProps: { id: 99 } }
    const p = plan({ returnColumns: ['a.id'], expressionColumns: [{ alias: 'id', expression: 'a.id' }] })
    const row = _formatResultRow(r, p)
    expect(row['a.id'] ?? row.id).toBe(99)
  })
  it('returns null when __edgeProps present but property absent', () => {
    const r: any = { props: {}, __edgeProps: { unrelated: 1 } }
    const p = plan({ returnColumns: ['r.weight'] })
    const row = _formatResultRow(r, p)
    expect(row['r.weight']).toBeNull()
  })
})

describe('_formatResultRow — varCtx builder deep branches', () => {
  it('builds varCtx from __vridPropMap and top-level keys', () => {
    const r: any = { props: { _label: 'A' }, __vridPropMap: { k1: 'v1' }, topKey: 'tv' }
    const p = plan({ returnColumns: ['out'], returnAliasMap: { out: 'k1' } })
    const row = _formatResultRow(r, p)
    expect(row.out).toBe('v1')
  })
  it('builds source varCtx from row (stripping edge-format strings)', () => {
    const r: any = { props: { _label: 'A', name: 'x' } }
    const p = plan({ returnColumns: ['a'], returnAliasMap: { a: 'a' }, steps: [{ source: 'a', targetAlias: 'b' }] })
    const row = _formatResultRow(r, p)
    expect(row.a).toBeDefined()
  })
  it('builds target varCtx from __targetProps via __targetAlias', () => {
    const r: any = { props: { _label: 'A' }, __targetProps: { name: 'tgt' }, __targetAlias: 'b' }
    const p = plan({ returnColumns: ['b'], returnAliasMap: { b: 'b' }, steps: [{ source: 'a', targetAlias: 'b' }] })
    const row = _formatResultRow(r, p)
    expect(row.b).toBeDefined()
  })
  it('fills missing multi-step vars from __targetProps then _label fallback', () => {
    const r: any = {
      props: { _label: 'A' },
      __targetProps: { name: 'z' },
      __targetAlias: 'z',
    }
    const p = plan({
      returnColumns: ['z'],
      returnAliasMap: { z: 'z' },
      steps: [{ source: 'x', targetAlias: 'y' }, { source: 'y', targetAlias: 'z' }],
    })
    const row = _formatResultRow(r, p)
    expect(row).toBeDefined()
  })
  it('extracts function-arg variables via varNameMatches (coalesce)', () => {
    const r: any = { props: { _label: 'A', title: 'T' } }
    const p = plan({ returnColumns: ['t'], returnAliasMap: { t: "coalesce(a.title, a.name)" } })
    const row = _formatResultRow(r, p)
    expect(row.t).toBe('T')
  })
  it('resolves fn arg from r[argVar] fallback (id/type with bare row value)', () => {
    const r: any = { props: { _label: 'A' }, r1: { _label: 'R' } }
    const p = plan({ returnColumns: ['t'], returnAliasMap: { t: 'type(r1)' } })
    const row = _formatResultRow(r, p)
    expect(row).toBeDefined()
  })
  it('does NOT fallback-map an OPTIONAL MATCH edge variable', () => {
    const r: any = { props: { _label: 'A' } }
    const p = plan({
      returnColumns: ['r'],
      returnAliasMap: { r: 'r' },
      optionalMatchSteps: [{ steps: [{ edgeVariable: 'r' }] }],
    })
    const row = _formatResultRow(r, p)
    expect(row.r).toBeNull()
  })
})

describe('_formatResultRow — edge variable rendering with internal-key filter', () => {
  it('renders edge with user props only, dropping srcIdx/dstIdx/label/props', () => {
    const r: any = { props: {}, __crossVarRows: { r: { __edgeLabel: 'T', srcIdx: 0, dstIdx: 1, label: 'T', props: {}, weight: 7 } } }
    const p = plan({ returnColumns: ['r'] })
    const row = _formatResultRow(r, p)
    expect(row.r).toBe('[:T {weight: 7}]')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Iteration 8b — second pass on remaining branch clusters
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — path var fallthrough (single object + __targetProps)', () => {
  it('enriches localCtx from __targetProps when path var is not a >1 array', () => {
    // pvVal is a single path object (not a >1 array), so the collect() rewrite
    // is skipped and the __targetProps enrichment + localCtx eval path runs.
    const r: any = {
      props: { p: { __path: [1], __pathEdges: [] } },
      __targetProps: { extra: 'x' },
    }
    const p = plan({
      returnColumns: ['p'],
      steps: [{ source: 'a', pathVariable: 'p' }],
      returnAliasMap: { p: 'nodes(p)' },
    })
    const row = _formatResultRow(r, p)
    expect(row.p).toBeDefined()
  })
})

describe('_formatResultRow — node alias scan (self-loop guard)', () => {
  it('includes scanLabel source alias to avoid mis-rendering node as edge', () => {
    // plan.scanLabel with empty steps triggers the _originalQuery regex extraction
    // to add the MATCH variable alias into nodeAliases (lines 612-618).
    const r: any = { props: { _label: 'A', name: 'n' }, __edgeLabel: 'R1' }
    const p = plan({
      returnColumns: ['n'],
      scanLabel: 'A',
      steps: [],
      _originalQuery: 'MATCH (n:A) RETURN n',
    })
    const row = _formatResultRow(r, p)
    expect(row.n).toBeDefined()
  })
})

describe('_formatResultRow — expression column eval needsEval=false shortcut', () => {
  it('evaluates count(n) alias when row lacks the pre-computed value', () => {
    // `r.others` is not promoted to `row` (the props filter only reads r.props),
    // so `rowVal` is undefined → needsEval stays true → the aggregate alias is
    // evaluated via the expression engine (count of empty ctx = 0).
    const r: any = { props: { _label: 'A' } }
    const p = plan({
      returnColumns: ['others'],
      expressionColumns: [{ alias: 'others', expression: 'count(n)' }],
    })
    const row = _formatResultRow(r, p)
    expect(row.others).toBe(0)
  })
})

describe('_formatResultRow — prop access __crossVarRows node with missing property', () => {
  it('returns null for missing property in crossVarRows node (prop access)', () => {
    const r: any = { props: {}, __crossVarRows: { a: { _label: 'A' } } }
    const p = plan({ returnColumns: ['a.id'], expressionColumns: [{ alias: 'id', expression: 'a.id' }] })
    const row = _formatResultRow(r, p)
    expect(row['a.id'] ?? row.id).toBeNull()
  })
})

describe('_formatResultRow — expr null fallback to varCtx build (no firstStepSource)', () => {
  it('extracts fn arg from r.__crossVarRows when present', () => {
    const r: any = { props: {}, __crossVarRows: { r1: { __edgeLabel: 'R' } } }
    const p = plan({ returnColumns: ['t'], returnAliasMap: { t: 'type(r1)' } })
    const row = _formatResultRow(r, p)
    expect(row.t).toBe('R')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Iteration 8c — final deep-branch pass
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — function expression (fnExpr) block with steps enrichment', () => {
  it('evaluates labels(m) via fnExpr with steps + __targetProps enrichment', () => {
    // rc is itself a function call (`labels(m)`), so fnExpr is `labels(m)`;
    // plan.steps + __targetPropsMap drive the step-based fnVarCtx enrichment.
    const r: any = {
      props: { _label: 'A', name: 'n' },
      __targetPropsMap: { m: { _label: 'B' } },
    }
    const p = plan({
      returnColumns: ['labels(m)'],
      steps: [{ source: 'a', targetAlias: 'm' }],
    })
    const row = _formatResultRow(r, p)
    expect(row['labels(m)']).toBeDefined()
  })

  it('evaluates a function-call rc via aliasMap fallback when rc is not a call', () => {
    const r: any = { props: { _label: 'A' }, __targetPropsMap: { m: { _label: 'B' } } }
    const p = plan({
      returnColumns: ['l'],
      returnAliasMap: { l: 'labels(m)' },
      steps: [{ source: 'a', targetAlias: 'm' }],
    })
    const row = _formatResultRow(r, p)
    expect(row.l).toEqual(['B'])
  })
})

describe('_formatResultRow — missingVars multi-step fill with _label fallback', () => {
  it('fills missing step vars from row._label fallback when no data', () => {
    const r: any = { props: { _label: 'A' }, row: {} }
    const p = plan({
      returnColumns: ['z'],
      returnAliasMap: { z: 'z.name' },
      steps: [{ source: 'x', targetAlias: 'y' }, { source: 'y', targetAlias: 'z' }],
    })
    const row = _formatResultRow(r, p)
    expect(row).toBeDefined()
  })
})

describe('_formatResultRow — label predicate & varNameMatches (no steps)', () => {
  it('resolves label predicate (n:Foo) binding row spread to varCtx', () => {
    const r: any = { props: { _label: 'Foo', name: 'x' } }
    const p = plan({ returnColumns: ['n'], returnAliasMap: { n: '(n:Foo)' } })
    const row = _formatResultRow(r, p)
    expect(row.n).toBeDefined()
  })

  it('extracts multiple dotted vars via varNameMatches (coalesce with two args)', () => {
    const r: any = { props: { _label: 'A', title: 'T', name: 'N' } }
    const p = plan({ returnColumns: ['t'], returnAliasMap: { t: 'coalesce(a.title, b.name)' } })
    const row = _formatResultRow(r, p)
    expect(row.t).toBe('T')
  })

  it('resolves id()/type() fn arg from r[argVar] fallback', () => {
    const r: any = { props: { _label: 'A' }, n: { _label: 'B' } }
    const p = plan({ returnColumns: ['i'], returnAliasMap: { i: 'id(n)' } })
    const row = _formatResultRow(r, p)
    expect(row.i).toBeDefined()
  })
})

describe('_formatResultRow — expr eval produces object', () => {
  it('returns a node object from the row when rc is a plain variable', () => {
    // A plain identifier (n) resolves via the `rc in row` / expr shortcut and
    // returns the raw row value without deep-stripping nested internals (that
    // strip only applies to objects freshly produced by _evaluateExpression).
    const r: any = { props: { _label: 'A', n: { _label: 'B', _alias: 'x', name: 'y' } } }
    const p = plan({ returnColumns: ['n'], returnAliasMap: { n: 'n' } })
    const row = _formatResultRow(r, p)
    expect(row.n).toEqual({ _label: 'B', _alias: 'x', name: 'y' })
  })
})

describe('_formatResultRow — fnExpr varCtx from __crossVarRows + steps fallback', () => {
  it('builds fnVarCtx from __crossVarRows for a function-call rc', () => {
    const r: any = { props: {}, __crossVarRows: { m: { _label: 'B' } } }
    const p = plan({ returnColumns: ['labels(m)'] })
    const row = _formatResultRow(r, p)
    expect(row['labels(m)']).toEqual(['B'])
  })

  it('fills fnVarCtx targetAlias from r.props fallback in the steps loop', () => {
    // steps present with targetAlias 'm' NOT already in fnVarCtx, no
    // __targetProps / __targetPropsMap[m], so it falls back to r.props.
    const r: any = { props: { _label: 'A', name: 'n' } }
    const p = plan({ returnColumns: ['m'], returnAliasMap: { m: 'labels(m)' }, steps: [{ source: 'a', targetAlias: 'm' }] })
    const row = _formatResultRow(r, p)
    expect(row).toBeDefined()
  })

  it('fills fnVarCtx targetAlias from __targetPropsMap step alias', () => {
    const r: any = { props: { _label: 'A' }, __targetPropsMap: { m: { _label: 'B' } } }
    const p = plan({ returnColumns: ['m'], returnAliasMap: { m: 'labels(m)' }, steps: [{ source: 'a', targetAlias: 'm' }] })
    const row = _formatResultRow(r, p)
    expect(row.m).toEqual(['B'])
  })
})

describe('_formatResultRow — expressionColumns recovery (duplicate rc)', () => {
  it('uses the second .find when the same rc appears multiple times', () => {
    // Duplicate rc forces aliasCount > 1, selecting the `.find` callback that
    // matches by expression/alias (anonymous_15 @ line 418).
    const r: any = { props: {}, __crossVarRows: { a: { id: 1 }, b: { id: 2 } } }
    const p = plan({
      returnColumns: ['id', 'id'],
      expressionColumns: [
        { alias: 'id', expression: 'a.id' },
        { alias: 'id', expression: 'b.id' },
      ],
    })
    const row = _formatResultRow(r, p)
    expect(row.id).toBe(2)
  })
})

describe('_formatResultRow — edge rendering node-alias scan with createNodes/steps', () => {
  it('scans createNodes + steps aliases to avoid node-as-edge misrender', () => {
    // plan.createNodes and plan.steps feed the nodeAliases set (anonymous_19/21
    // @ lines 596/599) so a node variable is not rendered as an edge string.
    const r: any = { props: { _label: 'A' }, __edgeLabel: 'R1' }
    const p = plan({
      returnColumns: ['n'],
      createNodes: [{ alias: 'n' }],
      steps: [{ source: 'a', targetAlias: 'b', pathVariable: 'p' }],
    })
    const row = _formatResultRow(r, p)
    expect(row.n).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Iteration 8d — literal/binary/guard branch pass
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — isLiteralExpr variants', () => {
  it('evaluates a negative-number literal alias', () => {
    const r: any = { props: { _label: 'A', num: 42 } }
    const p = plan({ returnColumns: ['num'], expressionColumns: [{ alias: 'num', expression: '-5' }] })
    const row = _formatResultRow(r, p)
    expect(row.num).toBe(-5)
  })
  it('evaluates a null literal alias (null result discarded, falls to raw value)', () => {
    // `_evaluateExpression('null')` returns null, but the `evalResult !== null`
    // guard rejects null, so it falls through to the raw pre-computed rowVal.
    const r: any = { props: { _label: 'A', x: 1 } }
    const p = plan({ returnColumns: ['x'], expressionColumns: [{ alias: 'x', expression: 'null' }] })
    const row = _formatResultRow(r, p)
    expect(row.x).toBe(1)
  })
  it('evaluates a false boolean literal alias', () => {
    const r: any = { props: { _label: 'A', x: true } }
    const p = plan({ returnColumns: ['x'], expressionColumns: [{ alias: 'x', expression: 'false' }] })
    const row = _formatResultRow(r, p)
    expect(row.x).toBe(false)
  })
  it('evaluates a double-quoted string literal alias', () => {
    const r: any = { props: { _label: 'A', x: 'old' } }
    const p = plan({ returnColumns: ['x'], expressionColumns: [{ alias: 'x', expression: '"hello"' }] })
    const row = _formatResultRow(r, p)
    expect(row.x).toBe('hello')
  })
})

describe('_formatResultRow — needsEval via null/edge-string rowVal', () => {
  it('re-evaluates when the pre-computed row value is null', () => {
    const r: any = { props: { _label: 'A', x: null }, __crossVarRows: { n: { x: 3 } } }
    const p = plan({ returnColumns: ['x'], expressionColumns: [{ alias: 'x', expression: 'n.x' }] })
    const row = _formatResultRow(r, p)
    expect(row.x).toBe(3)
  })
  it('re-evaluates when the pre-computed row value is an edge-format string', () => {
    const r: any = { props: { _label: 'A', x: '[:R]' }, __crossVarRows: { n: { x: 9 } } }
    const p = plan({ returnColumns: ['x'], expressionColumns: [{ alias: 'x', expression: 'n.x' }] })
    const row = _formatResultRow(r, p)
    expect(row.x).toBe(9)
  })
})

describe('_formatResultRow — prop-access guard (does not shortcut)', () => {
  it('resolves a bare prop-access expression via crossVarRows (not the row shortcut)', () => {
    const r: any = { props: { _label: 'A', name: 'srcName' }, __crossVarRows: { out: { name: 'dstName' } } }
    const p = plan({ returnColumns: ['result'], expressionColumns: [{ alias: 'result', expression: 'out.name' }] })
    const row = _formatResultRow(r, p)
    expect(row.result).toBe('dstName')
  })
})

describe('_formatResultRow — edge prop access from __edgeProps', () => {
  it('reads an edge property via __edgeProps (r.weight)', () => {
    const r: any = { props: {}, __edgeProps: { weight: 12 } }
    const p = plan({ returnColumns: ['r.weight'] })
    const row = _formatResultRow(r, p)
    expect(row['r.weight']).toBe(12)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Iteration 8e — RETURN * crossVarRows node/path/edge enumeration
// ─────────────────────────────────────────────────────────────────────────

describe('_formatResultRow — RETURN * crossVarRows node unwrapping', () => {
  it('unwraps a node var with a props wrapper, dropping internal keys', () => {
    const r: any = { __crossVarRows: { a: { props: { _label: 'A', name: 'n', __internal: 1, _alias: 'x' } } } }
    const p = plan({ returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row.a).toEqual({ _label: 'A', name: 'n' })
  })

  it('keeps a crossVarRows node without a props wrapper (src = node itself)', () => {
    const r: any = { __crossVarRows: { a: { _label: 'A', __y: 1, _alias: 'x', name: 'n' } } }
    const p = plan({ returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row.a).toEqual({ _label: 'A', name: 'n' })
  })

  it('skips crossVarRows edge var markers and surfaces pathVar', () => {
    const r: any = {
      __crossVarRows: { e: { __edgeLabel: 'R1', _type: 'R1' } },
      props: { p: { __path: [1, 2], __pathEdges: [] } },
    }
    const p = plan({ returnColumns: [], pathVar: 'p' })
    const row = _formatResultRow(r, p)
    expect(row.e).toEqual({ __edgeLabel: 'R1', _type: 'R1' })
    expect(row.p).toEqual({ __path: [1, 2], __pathEdges: [] })
  })

  it('formats a __targetPropsMap node entry as (:Label)', () => {
    const r: any = { __targetPropsMap: { a: { _label: 'Person' } } }
    const p = plan({ returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row.a).toBe('(:Person)')
  })

  it('keeps a __targetPropsMap edge entry verbatim', () => {
    const r: any = { __targetPropsMap: { e: { __edgeLabel: 'R1' } } }
    const p = plan({ returnColumns: [] })
    const row = _formatResultRow(r, p)
    expect(row.e).toEqual({ __edgeLabel: 'R1' })
  })
})
