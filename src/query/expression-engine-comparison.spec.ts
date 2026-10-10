import { describe, it, expect } from 'vitest'
import {
  _evalComparison, _extractChain, _evaluateExpression, _listLexCompare, _comparableTypes, _compareValues,
} from './expression-engine'

/** Coverage for _evalComparison (IS NULL / IN / chain / regex / string predicates),
 *  _extractChain, and list lexicographic comparison. */

describe('_extractChain', () => {
  it('mixed operators produce chain', () => {
    expect(_extractChain('a < b = c')).toEqual([
      { left: 'a', op: '<', right: 'b' },
      { left: 'b', op: '=', right: 'c' },
    ])
  })
  it('single op -> empty', () => {
    expect(_extractChain('a = b')).toEqual([])
  })
  it('same-operator chain falls through (handled by _splitTopLevel)', () => {
    expect(_extractChain('1 < n.num < 3')).toEqual([])
  })
})

describe('_evalComparison — IS NULL / IS NOT NULL', () => {
  it('IS NULL true', () => expect(_evalComparison('null IS NULL', {})).toBe(true))
  it('IS NULL false for value', () => expect(_evalComparison('1 IS NULL', {})).toBe(false))
  it('IS NOT NULL', () => expect(_evalComparison('1 IS NOT NULL', {})).toBe(true))
  it('IS NOT NULL false for null', () => expect(_evalComparison('null IS NOT NULL', {})).toBe(false))
  it('value IS NULL via var', () => expect(_evalComparison('x IS NULL', { x: null })).toBe(true))
})

describe('_evalComparison — IN (three-valued)', () => {
  it('match found -> true', () => expect(_evalComparison('2 IN [1,2,3]', {})).toBe(true))
  it('no match -> false', () => expect(_evalComparison('5 IN [1,2,3]', {})).toBe(false))
  it('null IN [] -> false', () => expect(_evalComparison('null IN []', {})).toBe(false))
  it('null IN non-empty -> null', () => expect(_evalComparison('null IN [1,2]', {})).toBe(null))
  it('x IN [] -> false for non-null', () => expect(_evalComparison('5 IN []', {})).toBe(false))
  it('list contains null only -> null when no match', () => expect(_evalComparison('5 IN [null]', {})).toBe(null))
})

describe('_evalComparison — regex', () => {
  it('=~ match', () => expect(_evalComparison("'abc' =~ 'a.c'", {})).toBe(true))
  it('=~ no match', () => expect(_evalComparison("'abc' =~ 'z'", {})).toBe(false))
  it('=~ invalid regex -> false', () => expect(_evalComparison("'abc' =~ '('", {})).toBe(false))
})

describe('_evalComparison — chained comparison', () => {
  it('1 < 2 < 3', () => expect(_evalComparison('1 < 2 < 3', {})).toBe(true))
  it('1 < 3 < 2 short-circuits false', () => expect(_evalComparison('1 < 3 < 2', {})).toBe(false))
  it('a = b = c', () => expect(_evalComparison('1 = 1 = 1', {})).toBe(true))
  it('chain with null -> null', () => expect(_evalComparison('1 < null < 3', {})).toBe(null))
})

describe('_evalComparison — string predicates', () => {
  it('STARTS WITH', () => expect(_evalComparison("'hello' STARTS WITH 'he'", {})).toBe(true))
  it('CONTAINS', () => expect(_evalComparison("'hello' CONTAINS 'ell'", {})).toBe(true))
  it('ENDS WITH', () => expect(_evalComparison("'hello' ENDS WITH 'lo'", {})).toBe(true))
  it('STARTS WITH false', () => expect(_evalComparison("'hello' STARTS WITH 'xy'", {})).toBe(false))
  it('STARTS WITH combined via _evalBinary (top-level AND split)', () => expect(_evaluateExpression("'hello' STARTS WITH 'he' AND 'world' STARTS WITH 'w'", {})).toBe(true))
  it('STARTS WITH OR via _evalBinary', () => expect(_evaluateExpression("'hello' STARTS WITH 'he' OR 'world' STARTS WITH 'x'", {})).toBe(true))
  it('STARTS WITH null -> null', () => expect(_evalComparison("null STARTS WITH 'he'", {})).toBe(null))
})

describe('_evalComparison — parenthesized', () => {
  it('parenthesized expression pushes down', () => expect(_evalComparison('(1+1)', {})).toBe(2))
})

describe('_evalComparison — IS NULL precedence with comparison', () => {
  it('a = b IS NULL parses as a = (b IS NULL)', () => {
    // 1 = (null IS NULL) => 1 = true => false
    expect(_evalComparison('1 = x IS NULL', { x: null })).toBe(false)
  })
  it('a = b IS NOT NULL parses as a = (b IS NOT NULL)', () => {
    expect(_evalComparison('1 = x IS NOT NULL', { x: 1 })).toBe(false)
  })
})

describe('_listLexCompare', () => {
  it('equal lists is not <', () => expect(_listLexCompare([1, 2], [1, 2], '<')).toBe(false))
  it('equal lists is <=', () => expect(_listLexCompare([1, 2], [1, 2], '<=')).toBe(true))
  it('prefix is less', () => expect(_listLexCompare([1], [1, 2], '<')).toBe(true))
  it('lexicographic first-diff', () => expect(_listLexCompare([1, 5], [1, 3], '>')).toBe(true))
  it('null element -> null', () => expect(_listLexCompare([1, null], [1, 2], '<')).toBe(null))
  it('<= equal length', () => expect(_listLexCompare([1, 2], [1, 2], '<=')).toBe(true))
  it('>= shorter', () => expect(_listLexCompare([1, 2], [1], '>=')).toBe(true))
  it('>= shorter false', () => expect(_listLexCompare([1], [1, 2], '>=')).toBe(false))
})

describe('_comparableTypes', () => {
  it('same type', () => expect(_comparableTypes(1, 2)).toBe(true))
  it('number vs bigint', () => expect(_comparableTypes(1, 1n)).toBe(true))
  it('number vs string', () => expect(_comparableTypes(1, '1')).toBe(false))
})

describe('_compareValues fast paths', () => {
  it('number equality', () => expect(_compareValues(1, 1, '=')).toBe(true))
  it('number gt', () => expect(_compareValues(2, 1, '>')).toBe(true))
  it('number <>', () => expect(_compareValues(2, 1, '<>')).toBe(true))
  it('null -> null', () => expect(_compareValues(null, 1, '=')).toBe(null))
})
