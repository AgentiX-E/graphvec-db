/**
 * Built-in function + expression evaluator unit tests for expression-engine.ts.
 *
 * The built-in function registry (`_builtinFunctions`) and the recursive
 * expression evaluators (`_evalBinary`, `_evalComparison`, `_evalCase`,
 * `_evalOr/And/Xor/Not`, `_evalAddSub/MulDiv/Exp/Unary/Atom`, `_evalLiteral`)
 * form the second large self-contained cluster of the file.  Each built-in is
 * driven through the public `_evaluateExpression` entry point so every
 * assertion reflects real production behaviour.
 */

import { describe, it, expect } from 'vitest'
import {
  _evaluateExpression,
  _evalBinary,
  _evalComparison,
  _evalOr,
  _evalAnd,
  _evalXor,
  _evalNot,
  _evalUnary,
  _evalLiteral,
  _evalCase,
  _compareValues,
  _listLexCompare,
  _comparableTypes,
} from './expression-engine'

describe('logical operators', () => {
  it('_evalAnd', () => {
    expect(_evalAnd('true AND true', {})).toBe(true)
    expect(_evalAnd('true AND false', {})).toBe(false)
  })
  it('_evalOr', () => {
    expect(_evalOr('false OR true', {})).toBe(true)
    expect(_evalOr('false OR false', {})).toBe(false)
  })
  it('_evalXor', () => {
    expect(_evalXor('true XOR false', {})).toBe(true)
    expect(_evalXor('true XOR true', {})).toBe(false)
  })
  it('_evalNot', () => {
    expect(_evalNot('NOT true', {})).toBe(false)
    expect(_evalNot('NOT false', {})).toBe(true)
  })
})

describe('_evalBinary / comparisons', () => {
  it('numeric comparison', () => {
    expect(_evalComparison('1 < 2', {})).toBe(true)
    expect(_evalComparison('2 <= 2', {})).toBe(true)
    expect(_evalComparison('3 > 4', {})).toBe(false)
    expect(_evalComparison('4 >= 4', {})).toBe(true)
  })
  it('equality and inequality (<>)', () => {
    expect(_evalComparison('1 = 1', {})).toBe(true)
    expect(_evalComparison('1 <> 2', {})).toBe(true)
    // `!=` is not a supported operator in this engine (returns null)
    expect(_evalComparison('1 != 2', {})).toBe(null)
  })
  it('string comparison', () => {
    expect(_evalComparison("'a' < 'b'", {})).toBe(true)
  })
  it('NULL propagation', () => {
    expect(_evalComparison('1 = null', {})).toBe(null)
  })
  it('NULL-safe equality IS NULL', () => {
    expect(_evalComparison('null IS NULL', {})).toBe(true)
  })
})

describe('_compareValues', () => {
  it('mixed null handling', () => {
    expect(_compareValues(null, 1, '=')).toBe(null)
  })
  it('_listLexCompare lists element-wise', () => {
    expect(_listLexCompare([1, 2], [1, 3], '<')).toBe(true)
    expect(_listLexCompare([2], [1], '<')).toBe(false)
  })
  it('_comparableTypes', () => {
    expect(_comparableTypes(1, 2)).toBe(true)
    expect(_comparableTypes(1, 'x')).toBe(false)
  })
})

describe('arithmetic operators', () => {
  it('integer + - * / % ^', () => {
    expect(_evaluateExpression('1 + 2', {})).toBe(3)
    expect(_evaluateExpression('5 - 2', {})).toBe(3)
    expect(_evaluateExpression('3 * 4', {})).toBe(12)
    expect(_evaluateExpression('7 / 2', {})).toBe(3)
    expect(_evaluateExpression('7 % 3', {})).toBe(1)
    expect(_evaluateExpression('2 ^ 3', {})).toBe(8)
  })
  it('float arithmetic', () => {
    expect(_evaluateExpression('1.5 + 2.5', {})).toBe(4)
    expect(_evaluateExpression('1.0 + 2', {})).toBe(3)
  })
  it('unary minus and plus', () => {
    expect(_evalUnary('-5', {})).toBe(-5)
    expect(_evalUnary('+5', {})).toBe(5)
    expect(_evalUnary('-x', { x: -7 })).toBe(7)
  })
  it('string + string concat', () => {
    expect(_evaluateExpression("'foo' + 'bar'", {})).toBe('foobar')
  })
})

describe('_evalLiteral', () => {
  it('integer', () => expect(_evalLiteral('42', {})).toBe(42))
  it('float', () => expect(_evalLiteral('3.14', {})).toBe(3.14))
  it('scientific float', () => expect(_evalLiteral('1e3', {})).toEqual({ __float: 1000 }))
  it('string literal', () => expect(_evalLiteral("'hi'", {})).toBe('hi'))
  it('boolean', () => {
    expect(_evalLiteral('true', {})).toBe(true)
    expect(_evalLiteral('false', {})).toBe(false)
  })
  it('null', () => expect(_evalLiteral('null', {})).toBe(null))
  it('list literal', () => expect(_evalLiteral('[1, 2, 3]', {})).toEqual([1, 2, 3]))
  it('variable resolution via _evaluateExpression (not _evalLiteral)', () => {
    expect(_evaluateExpression('x', { x: 99 })).toBe(99)
  })
})

describe('_evalCase', () => {
  it('simple CASE with ELSE', () => {
    expect(_evalCase('CASE 2 WHEN 1 THEN 10 WHEN 2 THEN 20 ELSE 30 END', {})).toBe(20)
  })
  it('simple CASE fallthrough to ELSE', () => {
    expect(_evalCase('CASE 9 WHEN 1 THEN 10 ELSE 30 END', {})).toBe(30)
  })
  it('searched CASE (no operand)', () => {
    expect(_evalCase('CASE WHEN false THEN 1 WHEN true THEN 2 ELSE 3 END', {})).toBe(2)
  })
})

describe('built-in scalar functions', () => {
  it('abs', () => expect(_evaluateExpression('abs(-3)', {})).toBe(3))
  it('ceil', () => expect(_evaluateExpression('ceil(1.2)', {})).toBe(2))
  it('floor', () => expect(_evaluateExpression('floor(1.8)', {})).toBe(1))
  it('round', () => expect(_evaluateExpression('round(2.5)', {})).toBe(3))
  it('sign', () => expect(_evaluateExpression('sign(-5)', {})).toBe(-1))
  it('sqrt', () => expect(_evaluateExpression('sqrt(16)', {})).toBe(4))
  it('toInteger', () => expect(_evaluateExpression('toInteger("7")', {})).toBe(7))
  it('toFloat', () => expect(_evaluateExpression('toFloat("3.5")', {})).toBe(3.5))
  it('toString', () => expect(_evaluateExpression('toString(123)', {})).toBe('123'))
  it('toBoolean', () => expect(_evaluateExpression('toBoolean("true")', {})).toBe(true))
  it('toLower', () => expect(_evaluateExpression("toLower('ABC')", {})).toBe('abc'))
  it('toUpper', () => expect(_evaluateExpression("toUpper('abc')", {})).toBe('ABC'))
  it('trim', () => expect(_evaluateExpression("trim('  x  ')", {})).toBe('x'))
  it('substring', () => expect(_evaluateExpression("substring('hello', 1, 3)", {})).toBe('ell'))
  it('left', () => expect(_evaluateExpression("left('hello', 2)", {})).toBe('he'))
  it('right', () => expect(_evaluateExpression("right('hello', 2)", {})).toBe('lo'))
  it('replace', () => expect(_evaluateExpression("replace('hello', 'l', 'L')", {})).toBe('heLLo'))
  it('reverse', () => expect(_evaluateExpression("reverse('abc')", {})).toBe('cba'))
  it('split', () => expect(_evaluateExpression("split('a,b,c', ',')", {})).toEqual(['a', 'b', 'c']))
  it('coalesce', () => expect(_evaluateExpression('coalesce(null, null, 5)', {})).toBe(5))
  it('id returns node _id (fallback to numeric id, else 0)', () => {
    expect(_evaluateExpression('id(n)', { n: { _id: 12 } })).toBe(12)
    expect(_evaluateExpression('id(n)', { n: { id: 7 } })).toBe(7)
    expect(_evaluateExpression('id(n)', { n: { name: 'x' } })).toBe(0)
  })
  it('rand within [0,1)', () => {
    const r = _evaluateExpression('rand()', {}) as number
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThan(1)
  })
  it('isNaN', () => {
    expect(_evaluateExpression("isNaN('x')", {})).toBe(true)
    expect(_evaluateExpression('isNaN(1)', {})).toBe(false)
  })
})

describe('list/aggregate functions', () => {
  it('size of list', () => expect(_evaluateExpression('size([1,2,3])', {})).toBe(3))
  it('size of string', () => expect(_evaluateExpression("size('abc')", {})).toBe(3))
  it('head', () => expect(_evaluateExpression('head([1,2,3])', {})).toBe(1))
  it('tail', () => expect(_evaluateExpression('tail([1,2,3])', {})).toEqual([2, 3]))
  it('last', () => expect(_evaluateExpression('last([1,2,3])', {})).toBe(3))
  it('reverse list', () => expect(_evaluateExpression('reverse([1,2,3])', {})).toEqual([3, 2, 1]))
  it('range', () => expect(_evaluateExpression('range(1, 4)', {})).toEqual([1, 2, 3, 4]))
  it('keys of map', () => expect(_evaluateExpression('keys({a: 1, b: 2})', {})).toEqual(['a', 'b']))
  it('labels of node', () => {
    expect(_evaluateExpression('labels(n)', { n: { _label: 'Person:Employee' } })).toEqual(['Person', 'Employee'])
  })
  it('properties of node', () => {
    expect(_evaluateExpression('properties(n)', { n: { _label: 'P', name: 'x' } })).toEqual({ name: 'x' })
  })
  it('nodes / relationships of path', () => {
    const p = { __path: [{ name: 'a' }, { name: 'b' }], __pathEdges: [{ label: 'R' }] }
    expect(_evaluateExpression('nodes(p)', { p })).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(_evaluateExpression('relationships(p)', { p })).toEqual([{ label: 'R' }])
  })
  it('startnode / endnode of path (via _startNode/_endNode)', () => {
    const p = { _startNode: { name: 'a' }, _endNode: { name: 'b' } }
    expect(_evaluateExpression('startnode(p)', { p })).toEqual({ name: 'a' })
    expect(_evaluateExpression('endnode(p)', { p })).toEqual({ name: 'b' })
  })
  it('length of path / string / list', () => {
    const p = { __path: [{}, {}, {}], __pathEdges: [{}, {}] }
    expect(_evaluateExpression('length(p)', { p })).toBe(2)
    expect(_evaluateExpression("length('abc')", {})).toBe(3)
    expect(_evaluateExpression('length([1,2])', {})).toBe(2)
  })
  it('type of relationship', () => {
    expect(_evaluateExpression('type(r)', { r: { __edgeLabel: 'KNOWS' } })).toBe('KNOWS')
  })
  it('collect wraps the argument into a list', () => {
    expect(_evaluateExpression('collect([1,2])', {})).toEqual([[1, 2]])
  })
})

describe('percentile / aggregate helpers via scalar paths', () => {
  it('max/min are thin _evalBinary dispatchers (list literal passes through)', () => {
    expect(_evaluateExpression('max([1, 5, 3])', {})).toEqual([1, 5, 3])
    expect(_evaluateExpression('min([1, 5, 3])', {})).toEqual([1, 5, 3])
  })
})

describe('date/time/duration constructors', () => {
  it('date', () => expect(_evaluateExpression("date('2020-01-01')", {})).toBe('2020-01-01'))
  it('time', () => expect(_evaluateExpression("time('12:00:00')", {})).toBe('12:00:00Z'))
  it('localdatetime', () => expect(_evaluateExpression("localdatetime('2020-01-01T12:00:00')", {})).toBe('2020-01-01T12:00:00'))
  it('datetime', () => expect(_evaluateExpression("datetime('2020-01-01T12:00:00Z')", {})).toBe('2020-01-01T12:00:00Z'))
  it('localtime', () => expect(_evaluateExpression("localtime('12:00:00')", {})).toBe('12:00:00'))
  it('duration', () => expect(_evaluateExpression("duration('P1D')", {})).toBe('P1D'))
})

describe('case-insensitive function dispatch', () => {
  it('calls functions regardless of case', () => {
    expect(_evaluateExpression('ABS(-1)', {})).toBe(1)
    expect(_evaluateExpression('Size([1,2])', {})).toBe(2)
  })
  it('unknown function returns null', () => {
    expect(_evaluateExpression('noSuchFunction(1)', {})).toBeNull()
  })
})
