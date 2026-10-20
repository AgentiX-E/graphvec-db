/**
 * pattern-comprehension-units.spec.ts — Unit tests for the pattern-comprehension
 * helpers exported from expression-engine.ts.
 *
 * These functions back the execution-layer behavior validated end-to-end by
 * pattern-comprehension-eval.spec.ts.  Testing them directly gives full branch
 * coverage of the parser/filter/traversal internals (anonymous endpoints, arrow
 * spellings, variable-length quantifiers, edge deduplication, direction and
 * relationship-label filtering) that a black-box query cannot isolate.
 */

import { describe, it, expect } from 'vitest'
import {
  _parsePatternNodeTok,
  _parsePatternRelTok,
  _findPipeSep,
  _incidentEdges,
  _walkVarLenPaths,
  _evalPatternComprehension,
} from './expression-engine'
import { _setActivePatternNodes } from './pattern-comprehension-state'

function node(label: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { _label: label, __edges: [] as any[], ...(extra || {}) }
}

function edge(nodes: Record<string, unknown>[], from: number, to: number, label = 'T'): void {
  (nodes[from].__edges as any[]).push({ srcIdx: from, dstIdx: to, label, props: null })
}

describe('_parsePatternNodeTok', () => {
  it('parses a bare variable', () => {
    expect(_parsePatternNodeTok('n')).toEqual({ var: 'n', label: '', props: '' })
  })
  it('parses a label-only anonymous node', () => {
    expect(_parsePatternNodeTok(':X')).toEqual({ var: '', label: 'X', props: '' })
  })
  it('parses variable + label', () => {
    expect(_parsePatternNodeTok('n:X')).toEqual({ var: 'n', label: 'X', props: '' })
  })
  it('parses variable + label + props', () => {
    expect(_parsePatternNodeTok('n:X {a: 1}')).toEqual({ var: 'n', label: 'X', props: '{a: 1}' })
  })
  it('parses an empty node', () => {
    expect(_parsePatternNodeTok('')).toEqual({ var: '', label: '', props: '' })
  })
  it('parses props without a label', () => {
    expect(_parsePatternNodeTok('n {x}')).toEqual({ var: 'n', label: '', props: '{x}' })
  })
})

describe('_parsePatternRelTok', () => {
  it('parses empty relationship', () => {
    expect(_parsePatternRelTok('')).toEqual({ var: '', label: '', varLen: false, props: '' })
  })
  it('parses a label-only relationship', () => {
    expect(_parsePatternRelTok(':T')).toEqual({ var: '', label: 'T', varLen: false, props: '' })
  })
  it('parses variable + label', () => {
    expect(_parsePatternRelTok('r:T')).toEqual({ var: 'r', label: 'T', varLen: false, props: '' })
  })
  it('parses a bare variable-length spec', () => {
    expect(_parsePatternRelTok('*')).toEqual({ var: '', label: '', varLen: true, props: '' })
  })
  it('parses variable-length with bounds and label', () => {
    const r = _parsePatternRelTok('r:T*2..3')
    expect(r.var).toBe('r')
    expect(r.label).toBe('T')
    expect(r.varLen).toBe(true)
  })
  it('parses relationship with props', () => {
    const r = _parsePatternRelTok('r:T {w: 1}')
    expect(r.var).toBe('r')
    expect(r.label).toBe('T')
    expect(r.varLen).toBe(false)
    expect(r.props).toBe('{w: 1}')
  })
})

describe('_findPipeSep', () => {
  it('finds the top-level pipe', () => {
    expect(_findPipeSep('(n)-->(:Y) | 1')).toBeGreaterThan(0)
  })
  it('ignores a pipe inside a string literal', () => {
    expect(_findPipeSep("(n)-->(:Y) | 'a|b'")).toBeGreaterThan(0)
  })
  it('ignores a pipe inside nested brackets', () => {
    const s = '(n)-[x IN [1|2]]->(:Y) | 1'
    // first | is inside the list comprehension brackets, so it is skipped
    const idx = _findPipeSep(s)
    expect(s.slice(idx + 1).trim()).toBe('1')
  })
  it('returns -1 when there is no pipe', () => {
    expect(_findPipeSep('(n)-->(:Y)')).toBe(-1)
  })
})

describe('_incidentEdges', () => {
  it('returns outgoing and incoming edges for a node', () => {
    const nodes = [node('A'), node('B'), node('C')]
    edge(nodes, 0, 1) // A -> B
    edge(nodes, 2, 0) // C -> A
    const edges = _incidentEdges(nodes, 0)
    expect(edges).toHaveLength(2)
    expect(edges.some(e => e.dir === 'out' && e.label === 'T')).toBe(true)
    expect(edges.some(e => e.dir === 'in' && e.label === 'T')).toBe(true)
  })
  it('deduplicates the same relationship stored on both endpoints', () => {
    const nodes = [node('A'), node('B')]
    const shared = { srcIdx: 0, dstIdx: 1, label: 'T', props: null }
    ;(nodes[0].__edges as any[]).push(shared)
    ;(nodes[1].__edges as any[]).push(shared)
    const edges = _incidentEdges(nodes, 0)
    expect(edges).toHaveLength(1)
  })
  it('returns an empty array for a node with no edges', () => {
    const nodes = [node('A'), node('B')]
    expect(_incidentEdges(nodes, 0)).toEqual([])
  })
})

describe('_walkVarLenPaths', () => {
  it('enumerates a single outgoing step', () => {
    const nodes = [node('A'), node('B')]
    edge(nodes, 0, 1)
    const paths = _walkVarLenPaths(nodes, 0, 'out', '', 10)
    expect(paths).toHaveLength(1)
    expect(paths[0][0].nodeIdx).toBe(1)
  })
  it('enumerates a two-hop chain', () => {
    const nodes = [node('A'), node('B'), node('C')]
    edge(nodes, 0, 1)
    edge(nodes, 1, 2)
    const paths = _walkVarLenPaths(nodes, 0, 'out', '', 10)
    // A->B (1), A->B->C (1)
    expect(paths).toHaveLength(2)
  })
  it('filters by relationship label', () => {
    const nodes = [node('A'), node('B'), node('C')]
    edge(nodes, 0, 1, 'T')
    edge(nodes, 0, 2, 'X')
    const paths = _walkVarLenPaths(nodes, 0, 'out', 'X', 10)
    expect(paths).toHaveLength(1)
    expect(paths[0][0].nodeIdx).toBe(2)
  })
  it('respects the direction filter', () => {
    const nodes = [node('A'), node('B')]
    edge(nodes, 0, 1) // A -> B
    expect(_walkVarLenPaths(nodes, 1, 'in', '', 10)).toHaveLength(1)
    expect(_walkVarLenPaths(nodes, 1, 'out', '', 10)).toHaveLength(0)
  })
  it('does not revisit nodes (no cycles)', () => {
    const nodes = [node('A'), node('B')]
    edge(nodes, 0, 1)
    edge(nodes, 1, 0)
    const paths = _walkVarLenPaths(nodes, 0, 'out', '', 10)
    // A->B only; B would loop back to A but A was already visited.
    expect(paths).toHaveLength(1)
  })
})

describe('_evalPatternComprehension', () => {
  it('collects the projection for each outgoing match', () => {
    const nodes = [node('A', { _alias: 'a' }), node('B'), node('C')]
    edge(nodes, 0, 1)
    edge(nodes, 0, 2)
    _setActivePatternNodes(nodes as any)
    const row = { a: { _alias: 'a', _label: 'A' } as any }
    const result = _evalPatternComprehension('(a)-->() | 1', row)
    expect(result).toEqual([1, 1])
    _setActivePatternNodes(null)
  })
  it('binds the target variable for the projection', () => {
    const nodes = [node('A', { _alias: 'a' }), node('B', { name: 'bee' })]
    edge(nodes, 0, 1)
    _setActivePatternNodes(nodes as any)
    const row = { a: { _alias: 'a', _label: 'A' } as any }
    const result = _evalPatternComprehension('(a)-->(b) | b.name', row)
    expect(result).toEqual(['bee'])
    _setActivePatternNodes(null)
  })
  it('returns null when there is no pipe separator', () => {
    expect(_evalPatternComprehension('(a)-->(b)')).toBeNull()
  })
  it('returns an empty array when the source is unknown', () => {
    _setActivePatternNodes([node('A')] as any)
    const row = { a: { _alias: 'missing', _label: 'A' } as any }
    expect(_evalPatternComprehension('(a)-->() | 1', row)).toEqual([])
    _setActivePatternNodes(null)
  })
  it('evaluates a variable-length path projection down to a labelled target', () => {
    const nodes = [node('A', { _alias: 'a' }), node('B'), node('C')]
    edge(nodes, 0, 1)
    edge(nodes, 1, 2)
    _setActivePatternNodes(nodes as any)
    const row = { a: { _alias: 'a', _label: 'A' } as any }
    // `(:C)` anchors the endpoint on the label, so only the two-hop path
    // (A -> B -> C) matches, not the single hop (A -> B).
    const result = _evalPatternComprehension('p = (a)-[*]->(:C) | p', row)
    expect(Array.isArray(result)).toBe(true)
    expect((result as any[]).length).toBe(1)
    const p = (result as any[])[0] as any
    expect(Array.isArray(p.__path)).toBe(true)
    expect(p.__path.length).toBe(3)
    _setActivePatternNodes(null)
  })
})
