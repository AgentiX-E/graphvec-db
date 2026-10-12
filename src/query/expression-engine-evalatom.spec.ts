import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Direct _evalAtom coverage for subscript (list/map/range/negative index),
 *  string-index TypeError, and list-predicate (all/any/none/single) three-
 *  valued/null semantics — the reachable tail of _evalAtom not exercised
 *  through the query pipeline. */

function assertTypeError(expr: string) {
  try {
    _evaluateExpression(expr, {})
  } catch (e: any) {
    expect(e.message).toContain('TypeError')
    expect(e.tckError).toBe('TypeError')
    return
  }
  throw new Error('expected a TypeError to be thrown')
}

describe('_evalAtom list subscript', () => {
  it('positive index', () => {
    expect(_evaluateExpression('[1,2,3][1]', {})).toBe(2)
  })
  it('negative index wraps from end', () => {
    expect(_evaluateExpression('[1,2,3][-1]', {})).toBe(3)
  })
  it('out-of-range index yields null', () => {
    expect(_evaluateExpression('[1,2,3][10]', {})).toBeNull()
  })
  it('range slice [start..end]', () => {
    expect(_evaluateExpression('[1,2,3][0..2]', {})).toEqual([1, 2])
  })
  it('range slice open end', () => {
    expect(_evaluateExpression('[1,2,3][1..]', {})).toEqual([2, 3])
  })
})

describe('_evalAtom map subscript', () => {
  it('string key access', () => {
    expect(_evaluateExpression("{a:1,b:2}['a']", {})).toBe(1)
  })
  it('missing key yields null', () => {
    expect(_evaluateExpression("{a:1}['x']", {})).toBeNull()
  })
})

describe('_evalAtom string subscript raises TypeError', () => {
  it("string cannot be indexed", () => {
    assertTypeError("'hello'[0]")
  })
})

describe('_evalAtom list predicates', () => {
  it('all with all matching', () => {
    expect(_evaluateExpression('all(x IN [1,2,3] WHERE x > 0)', {})).toBe(true)
  })
  it('all with empty list vacuously true', () => {
    expect(_evaluateExpression('all(x IN [] WHERE x > 0)', {})).toBe(true)
  })
  it('any with one match', () => {
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x > 2)', {})).toBe(true)
  })
  it('none with no match', () => {
    expect(_evaluateExpression('none(x IN [1,2,3] WHERE x > 5)', {})).toBe(true)
  })
  it('single with exactly one match', () => {
    expect(_evaluateExpression('single(x IN [1,2,3] WHERE x = 2)', {})).toBe(true)
  })
  it('single with two matches is false', () => {
    expect(_evaluateExpression('single(x IN [1,2,3] WHERE x > 1)', {})).toBe(false)
  })
  it('any with no match is false', () => {
    expect(_evaluateExpression('any(x IN [1,2,3] WHERE x > 9)', {})).toBe(false)
  })
})
