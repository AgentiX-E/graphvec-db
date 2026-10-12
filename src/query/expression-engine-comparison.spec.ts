import { describe, it, expect } from 'vitest'
import { _evaluateExpression, _evalComparison, _listLexCompare } from './expression-engine'

/**
 * Coverage for _evalComparison: regex (=~), chained comparisons (>= 2 ops),
 * IS NULL / IS NOT NULL (suffix and embedded on comparison RHS), IN
 * 3-valued logic, string predicates (STARTS WITH / CONTAINS / ENDS WITH)
 * with boolean continuation, and list lexicographic comparison.
 */

describe('regex matching =~', () => {
  it('matches', () => {
    expect(_evaluateExpression("'hello' =~ 'h.*o'", {})).toBe(true)
  })
  it('does not match', () => {
    expect(_evaluateExpression("'hello' =~ '^x'", {})).toBe(false)
  })
  it('invalid regex returns false', () => {
    expect(_evaluateExpression("'abc' =~ '['", {})).toBe(false)
  })
})

describe('chained comparisons', () => {
  it('three-way lessthan', () => {
    expect(_evaluateExpression('1 < 2 < 3', {})).toBe(true)
    expect(_evaluateExpression('1 < 2 < 1', {})).toBe(false)
  })
  it('three-way equality', () => {
    expect(_evaluateExpression('1 = 1 = 1', {})).toBe(true)
  })
  it('mixed operators', () => {
    expect(_evaluateExpression('1 < 2 <= 3', {})).toBe(true)
    expect(_evaluateExpression('1 <= 1 < 2', {})).toBe(true)
  })
  it('greaterthan descending', () => {
    expect(_evaluateExpression('3 > 2 > 1', {})).toBe(true)
  })
})

describe('IS NULL / IS NOT NULL', () => {
  it('standalone IS NULL', () => {
    expect(_evaluateExpression('null IS NULL', {})).toBe(true)
    expect(_evaluateExpression('1 IS NULL', {})).toBe(false)
  })
  it('standalone IS NOT NULL', () => {
    expect(_evaluateExpression('1 IS NOT NULL', {})).toBe(true)
    expect(_evaluateExpression('null IS NOT NULL', {})).toBe(false)
  })
  it('comparison with null propagates null', () => {
    expect(_evaluateExpression('null = null', {})).toBeNull()
    expect(_evaluateExpression('1 = null', {})).toBeNull()
  })
})

describe('IN 3-valued logic', () => {
  it('member present', () => {
    expect(_evaluateExpression('1 IN [1,2,3]', {})).toBe(true)
  })
  it('member absent', () => {
    expect(_evaluateExpression('5 IN [1,2,3]', {})).toBe(false)
  })
  it('LHS null on non-empty list is unknown', () => {
    expect(_evaluateExpression('null IN [1,2]', {})).toBeNull()
  })
  it('LHS null on empty list is false', () => {
    expect(_evaluateExpression('null IN []', {})).toBe(false)
  })
  it('RHS contains null -> unknown without match', () => {
    expect(_evaluateExpression('5 IN [null, 2]', {})).toBeNull()
  })
  it('match wins over null in RHS', () => {
    expect(_evaluateExpression('3 IN [1, null, 3]', {})).toBe(true)
  })
  it('RHS null returns unknown regardless of LHS', () => {
    expect(_evaluateExpression('1 IN null', {})).toBeNull()
    expect(_evaluateExpression('null IN null', {})).toBeNull()
  })
})

describe('string predicates with boolean continuation', () => {
  it('STARTS WITH true AND', () => {
    expect(_evaluateExpression("'hello world' STARTS WITH 'hello' AND 1 = 1", {})).toBe(true)
  })
  it('STARTS WITH false AND short-circuits', () => {
    expect(_evaluateExpression("'hello world' STARTS WITH 'x' AND 1 = 1", {})).toBe(false)
  })
  it('CONTAINS with OR', () => {
    expect(_evaluateExpression("'hello world' CONTAINS 'lo' OR 1 = 2", {})).toBe(true)
  })
  it('ENDS WITH with XOR', () => {
    expect(_evaluateExpression("'hello world' ENDS WITH 'rld' XOR false", {})).toBe(true)
  })
  it('nested string predicates', () => {
    expect(_evaluateExpression("'abc' STARTS WITH 'a' AND 'bcd' STARTS WITH 'b'", {})).toBe(true)
  })
  it('null or non-string LHS returns null', () => {
    expect(_evaluateExpression("null STARTS WITH 'a'", {})).toBeNull()
    expect(_evaluateExpression("123 STARTS WITH '1'", {})).toBeNull()
  })
})

describe('list lexicographic comparison', () => {
  it('element-wise less than', () => {
    expect(_evaluateExpression('[1,2] < [1,3]', {})).toBe(true)
  })
  it('equal lists not less than', () => {
    expect(_evaluateExpression('[1,2] < [1,2]', {})).toBe(false)
  })
  it('prefix is less than longer list', () => {
    expect(_evaluateExpression('[1] < [1,2]', {})).toBe(true)
  })
  it('longer list greater than prefix', () => {
    expect(_evaluateExpression('[1,2,3] > [1,2]', {})).toBe(true)
  })
  it('string lists compare lexically', () => {
    expect(_evaluateExpression("['a','b'] < ['a','c']", {})).toBe(true)
  })
  it('<= and >= on equal lists', () => {
    expect(_evaluateExpression('[1,2] <= [1,2]', {})).toBe(true)
    expect(_evaluateExpression('[1,2] >= [1,2]', {})).toBe(true)
  })
})

describe('_listLexCompare direct', () => {
  it('element-wise', () => {
    expect(_listLexCompare([1, 2], [1, 3], '<')).toBe(true)
  })
  it('prefix shorter', () => {
    expect(_listLexCompare([1], [1, 2], '<')).toBe(true)
  })
  it('longer greater', () => {
    expect(_listLexCompare([1, 2], [1], '>')).toBe(true)
  })
})
