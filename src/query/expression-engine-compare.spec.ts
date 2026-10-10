import { describe, it, expect } from 'vitest'
import {
  _compareValues, _deepEq, _deepEqWithNull, _listLexCompare, _comparableTypes,
  _evaluateExpression,
} from './expression-engine'

/**
 * Coverage for the comparison/equality cluster: _compareValues (all ops, NaN,
 * cross-type, duration value-semantics, list lexicographic), _deepEq and
 * _deepEqWithNull (nested list/map, null propagation), _listLexCompare.
 */

describe('_compareValues — scalar', () => {
  it('numeric fast path', () => {
    expect(_compareValues(1, 1, '=')).toBe(true)
    expect(_compareValues(1, 2, '<')).toBe(true)
    expect(_compareValues(2, 1, '>')).toBe(true)
    expect(_compareValues(1, 1, '<=')).toBe(true)
    expect(_compareValues(1, 1, '>=')).toBe(true)
    expect(_compareValues(1, 1, '<>')).toBe(false)
  })
  it('null -> null (three-valued logic)', () => {
    expect(_compareValues(null, 1, '=')).toBe(null)
    expect(_compareValues(1, null, '=')).toBe(null)
  })
  it('int vs float marker compare equal', () => {
    expect(_compareValues(1, { __float: 1.0 }, '=')).toBe(true)
    expect(_compareValues({ __float: 1.0 }, 2, '<')).toBe(true)
  })
  it('NaN ordering returns false', () => {
    expect(_compareValues(NaN, 1, '<')).toBe(false)
    expect(_compareValues(NaN, 1, '>')).toBe(false)
  })
  it('cross-type comparison returns null', () => {
    expect(_compareValues('abc', 1, '<')).toBe(null)
    expect(_compareValues(1, 'abc', '>')).toBe(null)
  })
  it('string lexical ordering', () => {
    expect(_compareValues('a', 'b', '<')).toBe(true)
    expect(_compareValues('b', 'a', '>')).toBe(true)
  })
})

describe('_compareValues — list lexicographic', () => {
  it('prefix shorter-than-longer', () => {
    expect(_compareValues([1, 2], [1, 2, 3], '<')).toBe(true)
    expect(_compareValues([1, 2, 3], [1, 2], '>')).toBe(true)
  })
  it('first-differing element decides', () => {
    expect(_compareValues([1, 5], [1, 9], '<')).toBe(true)
    expect(_compareValues([1, 9], [1, 5], '>')).toBe(true)
  })
  it('equal lists', () => {
    expect(_compareValues([1, 2], [1, 2], '<=')).toBe(true)
    expect(_compareValues([1, 2], [1, 2], '>=')).toBe(true)
    expect(_compareValues([1, 2], [1, 2], '<')).toBe(false)
  })
  it('null element -> null', () => {
    expect(_compareValues([1, null], [1, 2], '<')).toBe(null)
  })
})

describe('_compareValues — duration value semantics', () => {
  it('equal durations', () => {
    expect(_compareValues('PT60S', 'PT1M', '=')).toBe(true)
  })
  it('different years -> false', () => {
    expect(_compareValues('P1Y', 'P2Y', '=')).toBe(false)
  })
})

describe('_deepEq / _deepEqWithNull', () => {
  it('deep list equality', () => {
    expect(_deepEq([1, [2, 3]], [1, [2, 3]])).toBe(true)
    expect(_deepEq([1, [2, 3]], [1, [2, 4]])).toBe(false)
  })
  it('deep map equality (key order independent)', () => {
    expect(_deepEq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(_deepEq({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false)
  })
  it('length mismatch', () => {
    expect(_deepEq([1, 2], [1, 2, 3])).toBe(false)
  })
  it('null in list -> not equal', () => {
    expect(_deepEq([1, null], [1, null])).toBe(false)
  })
  it('bigint vs string big-precision equality', () => {
    expect(_deepEq(9007199254740993n, '9007199254740993')).toBe(true)
  })
  it('_deepEqWithNull propagates null (null = unknown, keeps match on rest)', () => {
    expect(_deepEqWithNull([1, 2], [1, 2])).toEqual({ match: true, hasNull: false })
    // null element marks hasNull but does not flip match=false (three-valued)
    expect(_deepEqWithNull([1, null], [1, 2])).toEqual({ match: true, hasNull: true })
    expect(_deepEqWithNull([1, 2], [1, 3])).toEqual({ match: false, hasNull: false })
    expect(_deepEqWithNull(null, null)).toEqual({ match: true, hasNull: true })
  })
})

describe('_listLexCompare', () => {
  it('handles equality with prefix', () => {
    expect(_listLexCompare([1, 2], [1, 2, 3], '<')).toBe(true)
    expect(_listLexCompare([1, 2, 3], [1, 2], '>')).toBe(true)
  })
  it('null element -> null', () => {
    expect(_listLexCompare([1, null], [1, 2], '<')).toBe(null)
  })
  it('ge/le on equal length', () => {
    expect(_listLexCompare([1, 2], [1, 2], '>=')).toBe(true)
    expect(_listLexCompare([1, 2], [1, 2], '<=')).toBe(true)
  })
})

describe('_comparableTypes', () => {
  it('same type', () => expect(_comparableTypes(1, 2)).toBe(true))
  it('bigint and number', () => expect(_comparableTypes(1n, 2)).toBe(true))
  it('string vs number false', () => expect(_comparableTypes('a', 1)).toBe(false))
})

describe('expression-level comparisons', () => {
  it('list ordering via expression', () => {
    expect(_evaluateExpression('[1,2] < [1,2,3]', {})).toBe(true)
  })
  it('null comparison yields null', () => {
    expect(_evaluateExpression('null = 1', {})).toBe(null)
  })
  it('int == float', () => {
    expect(_evaluateExpression('1 = 1.0', {})).toBe(true)
  })
})
