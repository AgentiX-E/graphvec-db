import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Coverage for _evalAtom: label predicates, list predicates, subscript/slice, property access, type errors. */

describe('label predicates', () => {
  const node = { props: { _label: 'Person', name: 'Alice' }, _label: 'Person' }
  it('n:Label via props._label', () => {
    expect(_evaluateExpression('(n:Person)', { n: node })).toBe(true)
  })
  it('n:Wrong', () => {
    expect(_evaluateExpression('(n:Animal)', { n: node })).toBe(false)
  })
  it(':Label without variable -> null', () => {
    expect(_evaluateExpression('(:Person)', {})).toBe(null)
  })
  it('standalone n:Label (no parens)', () => {
    expect(_evaluateExpression('n:Person', { n: node })).toBe(true)
  })
  it('label conjunction a:A:B', () => {
    const n = { _label: 'A:B', __fullLabel: 'A:B' }
    expect(_evaluateExpression('a:A:B', { a: n })).toBe(true)
    expect(_evaluateExpression('a:A:C', { a: n })).toBe(false)
  })
  it('label conjunction with &', () => {
    const n = { _label: 'B:C', __fullLabel: 'B:C' }
    expect(_evaluateExpression('x:B&C', { x: n })).toBe(true)
  })
  it('relationship edge label test', () => {
    const r = { __edgeLabel: 'T2', _type: 'T2' }
    expect(_evaluateExpression('r:T2', { r })).toBe(true)
    expect(_evaluateExpression('r:T3', { r })).toBe(false)
  })
})

describe('IS NULL / IS NOT NULL on parenthesized expr', () => {
  it('(x) IS NULL', () => {
    expect(_evaluateExpression('(n) IS NULL', { n: null })).toBe(true)
    expect(_evaluateExpression('(n) IS NULL', { n: 5 })).toBe(false)
  })
  it('(x) IS NOT NULL', () => {
    expect(_evaluateExpression('(n) IS NOT NULL', { n: 7 })).toBe(true)
  })
})

describe('list predicates all/any/none/single', () => {
  it('all', () => {
    expect(_evaluateExpression('all(x IN [1,2,3] WHERE x > 0)', {})).toBe(true)
    expect(_evaluateExpression('all(x IN [1,2,3] WHERE x > 2)', {})).toBe(false)
    expect(_evaluateExpression('all(x IN [] WHERE x > 0)', {})).toBe(true)
  })
  it('any', () => {
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x = 2)', {})).toBe(true)
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x = 9)', {})).toBe(false)
  })
  it('none', () => {
    expect(_evaluateExpression('none(x IN [1,2,3] WHERE x > 9)', {})).toBe(true)
    expect(_evaluateExpression('none(x IN [1,2,3] WHERE x = 2)', {})).toBe(false)
  })
  it('single', () => {
    expect(_evaluateExpression('single(x IN [1,2,3] WHERE x = 2)', {})).toBe(true)
    expect(_evaluateExpression('single(x IN [1,2,2] WHERE x = 2)', {})).toBe(false)
  })
  it('any short-circuits on first true', () => {
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x = 1)', {})).toBe(true)
  })
})

describe('subscript / slice', () => {
  it('list index', () => {
    expect(_evaluateExpression('[10,20,30][1]', {})).toBe(20)
    expect(_evaluateExpression('[10,20,30][5]', {})).toBe(null)
  })
  it('list slice [start..end]', () => {
    expect(_evaluateExpression('[10,20,30][1..3]', {})).toEqual([20, 30])
  })
  it('list slice open-ended [1..]', () => {
    expect(_evaluateExpression('[10,20,30][1..]', {})).toEqual([20, 30])
  })
  it('string slice via variable', () => {
    expect(_evaluateExpression('s[1..3]', { s: 'hello' })).toBe('el')
  })
  it('negative index returns last element (Cypher semantics)', () => {
    expect(_evaluateExpression('[10,20,30][-1]', {})).toBe(30)
  })
  it('negative index via variable', () => {
    expect(_evaluateExpression('l[-1]', { l: [10, 20, 30] })).toBe(30)
  })
  it('map index by string', () => {
    expect(_evaluateExpression("{name:'Alice', age:30}['name']", {})).toBe('Alice')
  })
  it('list index non-integer throws TypeError', () => {
    expect(() => _evaluateExpression('[10,20][1.5]', {})).toThrow(/integer/i)
  })
  it('map index non-string throws TypeError', () => {
    expect(() => _evaluateExpression("{a:1}[0]", {})).toThrow(/Map index must be a string/)
  })
  it('string index via variable throws TypeError (strings are not indexable)', () => {
    expect(() => _evaluateExpression('s[1]', { s: 'hello' })).toThrow(/non-map\/non-list/)
  })
})

describe('property access', () => {
  it('map prop', () => {
    expect(_evaluateExpression('n.name', { n: { name: 'Alice' } })).toBe('Alice')
  })
  it('null prop -> null', () => {
    expect(_evaluateExpression('n.name', { n: null })).toBe(null)
  })
  it('chained a.b.c', () => {
    expect(_evaluateExpression('a.b.c', { a: { b: { c: 42 } } })).toBe(42)
  })
  it('backtick prop', () => {
    expect(_evaluateExpression('n.`name`', { n: { name: 'X' } })).toBe('X')
  })
  it('property access on non-map throws', () => {
    expect(() => _evaluateExpression('n.name', { n: 42 })).toThrow(/non-map/)
  })
})

describe('duration/date/time property access', () => {
  it("duration('P1DT2H').days", () => {
    expect(_evaluateExpression("duration('P1DT2H').days", {})).toBe(1)
  })
  it("date('2023-05-17').year", () => {
    expect(_evaluateExpression("date('2023-05-17').year", {})).toBe(2023)
  })
  it("datetime('2023-05-17T12:34:56Z').hour", () => {
    expect(_evaluateExpression("datetime('2023-05-17T12:34:56Z').hour", {})).toBe(12)
  })
})

describe('variable reference', () => {
  it('direct var', () => {
    expect(_evaluateExpression('x', { x: 99 })).toBe(99)
  })
  it('_alias match', () => {
    const r = { _alias: 'foo', a: 1 }
    expect(_evaluateExpression('foo', r)).toBe(r)
  })
})
