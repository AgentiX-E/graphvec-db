import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Coverage for _evalAtom's label predicates, subscription/slicing, property
 * access, list predicates, and exponent delegation. These are pure-logic
 * branches (no graph-engine state) and are exercised directly via a crafted
 * row context.
 */

// ── Label predicates ────────────────────────────────────────────────
describe('_evalAtom label predicates', () => {
  it('(n:Foo) with props._label', () => {
    const row = { n: { props: { _label: 'Foo' } } }
    expect(_evaluateExpression('(n:Foo)', row)).toBe(true)
    expect(_evaluateExpression('(n:Bar)', row)).toBe(false)
  })
  it('(n:Foo) with fullLabel multi-label', () => {
    const row = { n: { props: { __fullLabel: 'A:B' } } }
    expect(_evaluateExpression('(n:A)', row)).toBe(true)
    expect(_evaluateExpression('(n:B)', row)).toBe(true)
    expect(_evaluateExpression('(n:C)', row)).toBe(false)
  })
  it('(:Foo) without variable -> null', () => {
    expect(_evaluateExpression('(:Foo)', {})).toBe(null)
  })
  it('(n:Foo) with undefined node -> null', () => {
    expect(_evaluateExpression('(n:Foo)', {})).toBe(null)
  })
  it('(n:Foo) with node._label directly (no props)', () => {
    const row = { n: { _label: 'Foo' } }
    expect(_evaluateExpression('(n:Foo)', row)).toBe(true)
  })
  it('n:Foo standalone (post paren-strip)', () => {
    const row = { n: { props: { _label: 'Foo' } } }
    expect(_evaluateExpression('n:Foo', row)).toBe(true)
    expect(_evaluateExpression('n:Bar', row)).toBe(false)
  })
  it('r:T2 relationship type test', () => {
    const row = { r: { props: { __edgeLabel: 'T2' } } }
    expect(_evaluateExpression('r:T2', row)).toBe(true)
    expect(_evaluateExpression('r:T3', row)).toBe(false)
  })
  it('r:T2 with _type', () => {
    const row = { r: { _type: 'T2' } }
    expect(_evaluateExpression('r:T2', row)).toBe(true)
  })
  it('multi-label conjunction a:A:B:C', () => {
    const row = { a: { props: { __fullLabel: 'A:B:C' } } }
    expect(_evaluateExpression('a:A:B:C', row)).toBe(true)
    expect(_evaluateExpression('a:A:X', row)).toBe(false)
  })
  it('ampersand conjunction a:B&C (order/repeat irrelevant)', () => {
    const row = { a: { props: { __fullLabel: 'C:A:B' } } }
    expect(_evaluateExpression('a:B&C', row)).toBe(true)
    expect(_evaluateExpression('a:B&C', { a: { props: { __fullLabel: 'A' } } })).toBe(false)
  })
  it('multi-label on relationship single type', () => {
    const row = { a: { props: { __edgeLabel: 'T2' } } }
    expect(_evaluateExpression('a:T2&T2', row)).toBe(true)
    expect(_evaluateExpression('a:T2&T3', row)).toBe(false)
  })
})

// ── Parenthesized atom + suffix ─────────────────────────────────────
describe('_evalAtom paren + suffix', () => {
  it('(expr) IS NULL', () => {
    expect(_evaluateExpression('(null) IS NULL', {})).toBe(true)
    expect(_evaluateExpression('(1) IS NULL', {})).toBe(false)
  })
  it('(expr) IS NOT NULL', () => {
    expect(_evaluateExpression('(null) IS NOT NULL', {})).toBe(false)
    expect(_evaluateExpression('(1) IS NOT NULL', {})).toBe(true)
  })
  it('(1 + 2) IS NULL -> false', () => {
    expect(_evaluateExpression('(1 + 2) IS NULL', {})).toBe(false)
  })
  it('(expr)[n] subscript on parenthesized list', () => {
    expect(_evaluateExpression('([10,20,30])[1]', {})).toBe(20)
  })
  it('(expr)[start..end] slice on parenthesized list', () => {
    expect(_evaluateExpression('([10,20,30,40])[1..3]', {})).toEqual([20, 30])
  })
  it('(expr).prop property access on parenthesized map', () => {
    expect(_evaluateExpression('({name: "x"}).name', {})).toBe('x')
  })
  it('(expr) followed by AND delegates to _evalBinary', () => {
    expect(_evaluateExpression('(1 = 1) AND (2 = 2)', {})).toBe(true)
  })
})

// ── Literal subscript / slicing (list & map only) ──────────────────
describe('_evalAtom literal subscript & slicing', () => {
  it('list subscript', () => {
    expect(_evaluateExpression('[10,20,30][0]', {})).toBe(10)
    expect(_evaluateExpression('[10,20,30][2]', {})).toBe(30)
  })
  it('list negative subscript', () => {
    expect(_evaluateExpression('[10,20,30][-1]', {})).toBe(30)
  })
  it('list out-of-range -> null', () => {
    expect(_evaluateExpression('[10,20,30][99]', {})).toBe(null)
  })
  it('list non-integer index throws TypeError', () => {
    expect(() => _evaluateExpression('[10,20,30][1.5]', {})).toThrow()
  })
  it('list null index -> null', () => {
    expect(_evaluateExpression('[10,20,30][null]', {})).toBe(null)
  })
  it('map subscript by string key', () => {
    expect(_evaluateExpression("{a:1, b:2}['a']", {})).toBe(1)
  })
  it('map subscript missing key -> null', () => {
    expect(_evaluateExpression("{a:1}['x']", {})).toBe(null)
  })
  it('map subscript non-string throws TypeError', () => {
    expect(() => _evaluateExpression('{a:1}[123]', {})).toThrow()
  })
  it('list slice', () => {
    expect(_evaluateExpression('[10,20,30,40][1..3]', {})).toEqual([20, 30])
  })
  it('list slice negative end', () => {
    expect(_evaluateExpression('[10,20,30,40][1..-1]', {})).toEqual([20, 30])
  })
  it('slice with null boundary -> null', () => {
    expect(_evaluateExpression('[10,20,30][null..2]', {})).toBe(null)
  })
  // Cypher does NOT index strings (single-index on a string raises TypeError),
  // consistent with the variable form (`WITH '1' AS list ... RETURN list[idx]`).
  // String *slicing* remains supported elsewhere.
  it('string literal indexing throws TypeError (strings are not indexable)', () => {
    expect(() => _evaluateExpression("'hello'[0]", {})).toThrow(/non-map\/non-list/)
  })
})

// ── Standalone bracket subscript on non-literal (a[b]) ─────────────
describe('_evalAtom bracket subscript a[b]', () => {
  it('var list subscript', () => {
    expect(_evaluateExpression('a[1]', { a: [10, 20, 30] })).toBe(20)
  })
  it('var slice', () => {
    expect(_evaluateExpression('a[0..2]', { a: [10, 20, 30] })).toEqual([10, 20])
  })
  it('index into string throws TypeError (strings are not indexable)', () => {
    expect(() => _evaluateExpression('s[0]', { s: 'abc' })).toThrow()
  })
  it('index into primitive throws TypeError', () => {
    expect(() => _evaluateExpression('n[0]', { n: 42 })).toThrow()
  })
})

// ── Property access a.b ─────────────────────────────────────────────
describe('_evalAtom property access', () => {
  it('map property', () => {
    expect(_evaluateExpression('m.name', { m: { name: 'x' } })).toBe('x')
  })
  it('backtick property name', () => {
    expect(_evaluateExpression('m.`name`', { m: { name: 'x' } })).toBe('x')
  })
  it('null.prop -> null', () => {
    expect(_evaluateExpression('n.name', { n: null })).toBe(null)
  })
  it('chained property path a.b.c', () => {
    expect(_evaluateExpression('a.b.c', { a: { b: { c: 'deep' } } })).toBe('deep')
  })
  it('chained path with missing mid -> null', () => {
    expect(_evaluateExpression('a.b.c', { a: { b: null } })).toBe(null)
  })
  it('non-map property access throws TypeError', () => {
    expect(() => _evaluateExpression('n.name', { n: 42 })).toThrow()
  })
  it('primitive (string) property access throws', () => {
    expect(() => _evaluateExpression('s.name', { s: 'hello' })).toThrow()
  })
  it('duration string property access routes to _extractDurationProp', () => {
    expect(_evaluateExpression("duration('P1D').days", {})).toBe(1)
  })
  it('date string property access', () => {
    expect(_evaluateExpression("date('2020-03-15').year", {})).toBe(2020)
  })
})

// ── List predicates (all/any/none/single) ──────────────────────────
describe('_evalAtom list predicates', () => {
  it('all() positive', () => {
    expect(_evaluateExpression('all(x IN [1,2,3] WHERE x > 0)', {})).toBe(true)
  })
  it('all() negative', () => {
    expect(_evaluateExpression('all(x IN [1,-2,3] WHERE x > 0)', {})).toBe(false)
  })
  it('all() empty -> true', () => {
    expect(_evaluateExpression('all(x IN [] WHERE x > 0)', {})).toBe(true)
  })
  it('any() positive short-circuit', () => {
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x = 2)', {})).toBe(true)
  })
  it('any() negative -> false', () => {
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x = 9)', {})).toBe(false)
  })
  it('none() positive', () => {
    expect(_evaluateExpression('none(x IN [1,2,3] WHERE x > 9)', {})).toBe(true)
  })
  it('none() negative', () => {
    expect(_evaluateExpression('none(x IN [1,2,3] WHERE x = 2)', {})).toBe(false)
  })
  it('single() exactly one', () => {
    expect(_evaluateExpression('single(x IN [1,2,3] WHERE x = 2)', {})).toBe(true)
  })
  it('single() more than one -> false', () => {
    expect(_evaluateExpression('single(x IN [1,2,3] WHERE x > 1)', {})).toBe(false)
  })
})

// ── Exponent delegation ─────────────────────────────────────────────
describe('_evalAtom exponent delegation', () => {
  it('top-level ^ delegates to _evalExp', () => {
    expect(_evaluateExpression('2 ^ 3', {})).toBe(8)
  })
  it('^ inside paren is not top-level', () => {
    expect(_evaluateExpression('2 ^ 3 ^ 1', {})).toBe(8)
  })
})
