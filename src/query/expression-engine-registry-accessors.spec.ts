import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock the function-registry path accessors and numeric predicates. These are
// the registry-variant handlers (distinct from the entity-accessor set): type()
// reads a relationship `_type`/`label` or a plain string, nodes()/relationships()
// unwrap a `__path`/`__pathEdges` envelope, and isNaN() tests NaN membership.

const path = { __path: [{ id: 1 }, { id: 2 }], __pathEdges: [{ _type: 'REL' }] }

describe('registry path accessors', () => {
  it('type() reads a relationship _type', () => {
    expect(_evaluateExpression('type(e)', { e: { _type: 'KNOWS' } })).toBe('KNOWS')
  })

  it('type() returns empty string for a plain object without type/label', () => {
    expect(_evaluateExpression('type(x)', { x: { name: 'a' } })).toBe('')
  })

  it('nodes() unwraps the __path list', () => {
    expect(_evaluateExpression('nodes(p)', { p: path })).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('nodes() returns null without a __path', () => {
    expect(_evaluateExpression('nodes(x)', { x: { name: 'a' } })).toBe(null)
  })

  it('relationships() unwraps the __pathEdges list', () => {
    expect(_evaluateExpression('relationships(p)', { p: path })).toEqual([{ _type: 'REL' }])
  })

  it('relationships() returns null without __pathEdges', () => {
    expect(_evaluateExpression('relationships(x)', { x: { name: 'a' } })).toBe(null)
  })
})

describe('isNaN predicate', () => {
  it('returns true for NaN', () => {
    expect(_evaluateExpression('isNaN(0.0 / 0.0)', {})).toBe(true)
  })

  it('returns false for a finite number', () => {
    expect(_evaluateExpression('isNaN(5)', {})).toBe(false)
  })
})
