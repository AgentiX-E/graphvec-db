import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Coverage for string & scalar built-in functions (trim/reverse/substring/etc). */

describe('string functions', () => {
  it('toupper / tolower', () => {
    expect(_evaluateExpression("toUpper('abc')", {})).toBe('ABC')
    expect(_evaluateExpression("toLower('ABC')", {})).toBe('abc')
  })
  it('trim', () => expect(_evaluateExpression("trim('  hi  ')", {})).toBe('hi'))
  it('reverse (string)', () => expect(_evaluateExpression("reverse('abc')", {})).toBe('cba'))
  it('reverse (list)', () => expect(_evaluateExpression('reverse([1,2,3])', {})).toEqual([3, 2, 1]))
  it('substring with length', () => expect(_evaluateExpression("substring('hello', 1, 3)", {})).toBe('ell'))
  it('substring without length', () => expect(_evaluateExpression("substring('hello', 2)", {})).toBe('llo'))
  it('left / right', () => {
    expect(_evaluateExpression("left('hello', 2)", {})).toBe('he')
    expect(_evaluateExpression("right('hello', 2)", {})).toBe('lo')
  })
  it('replace', () => expect(_evaluateExpression("replace('hello', 'l', 'x')", {})).toBe('hexxo'))
  it('split', () => expect(_evaluateExpression("split('a,b,c', ',')", {})).toEqual(['a', 'b', 'c']))
})

describe('size', () => {
  it('list size', () => expect(_evaluateExpression('size([1,2,3])', {})).toBe(3))
  it('string size', () => expect(_evaluateExpression("size('hello')", {})).toBe(5))
  it('null -> null', () => expect(_evaluateExpression('size(null)', {})).toBe(null))
  it('non-list/non-string -> 0', () => expect(_evaluateExpression('size(42)', {})).toBe(0))
})

describe('type conversions', () => {
  it('toString null -> null', () => expect(_evaluateExpression('toString(null)', {})).toBe(null))
  it('toString number', () => expect(_evaluateExpression('toString(42)', {})).toBe('42'))
  it('toInteger', () => expect(_evaluateExpression("toInteger('42')", {})).toBe(42))
  it('toInteger invalid -> null', () => expect(_evaluateExpression("toInteger('abc')", {})).toBe(null))
  it('toFloat integral -> __float marker', () => {
    const r = _evaluateExpression('toFloat(3)', {})
    expect(r).toEqual({ __float: 3 })
  })
  it('toFloat non-integral', () => expect(_evaluateExpression("toFloat('3.5')", {})).toBe(3.5))
  it('toBoolean true/false', () => {
    expect(_evaluateExpression("toBoolean('true')", {})).toBe(true)
    expect(_evaluateExpression("toBoolean('false')", {})).toBe(false)
    expect(_evaluateExpression("toBoolean('other')", {})).toBe(null)
  })
  it('toBoolean number throws', () => {
    expect(() => _evaluateExpression('toBoolean(1)', {})).toThrow()
  })
  it('isNaN', () => {
    expect(_evaluateExpression('isNaN(0/0)', {})).toBe(true)
    expect(_evaluateExpression('isNaN(1.5)', {})).toBe(false)
  })
})

describe('coalesce / sign', () => {
  it('coalesce returns first non-null', () => {
    expect(_evaluateExpression('coalesce(null, null, 5)', {})).toBe(5)
    expect(_evaluateExpression('coalesce(null, 3, 5)', {})).toBe(3)
    expect(_evaluateExpression('coalesce(null, null)', {})).toBe(null)
  })
  it('sign', () => {
    expect(_evaluateExpression('sign(-5)', {})).toBe(-1)
    expect(_evaluateExpression('sign(5)', {})).toBe(1)
    expect(_evaluateExpression('sign(0)', {})).toBe(0)
  })
})

describe('list functions', () => {
  it('head / last / tail', () => {
    expect(_evaluateExpression('head([1,2,3])', {})).toBe(1)
    expect(_evaluateExpression('last([1,2,3])', {})).toBe(3)
    expect(_evaluateExpression('tail([1,2,3])', {})).toEqual([2, 3])
  })
  it('head on empty -> null', () => expect(_evaluateExpression('head([])', {})).toBe(null))
  it('range ascending', () => expect(_evaluateExpression('range(1, 5)', {})).toEqual([1, 2, 3, 4, 5]))
  it('range with step', () => expect(_evaluateExpression('range(1, 10, 3)', {})).toEqual([1, 4, 7, 10]))
  it('range descending', () => expect(_evaluateExpression('range(5, 1, -2)', {})).toEqual([5, 3, 1]))
  it('range direction mismatch -> empty', () => expect(_evaluateExpression('range(5, 1)', {})).toEqual([]))
  it('range zero step throws', () => {
    expect(() => _evaluateExpression('range(1, 5, 0)', {})).toThrow()
  })
  it('range non-integer throws', () => {
    expect(() => _evaluateExpression('range(1.5, 5)', {})).toThrow()
  })
  it('range string arg throws', () => {
    expect(() => _evaluateExpression("range('1', 5)", {})).toThrow()
  })
})

describe('node/relationship accessors', () => {
  const node = { _label: 'Person', name: 'Alice', _id: 7 }
  it('id', () => expect(_evaluateExpression('id(n)', { n: node })).toBe(7))
  it('id on non-object -> 0', () => expect(_evaluateExpression('id(42)', {})).toBe(0))
  it('properties filters internal keys', () => {
    expect(_evaluateExpression('properties(n)', { n: node })).toEqual({ name: 'Alice' })
  })
  it('keys', () => {
    expect(_evaluateExpression('keys(n)', { n: node })).toEqual(['name'])
  })
  it('labels', () => {
    expect(_evaluateExpression('labels(n)', { n: node })).toEqual(['Person'])
  })
  it('labels on non-object throws', () => {
    expect(() => _evaluateExpression('labels(42)', {})).toThrow(/labels/)
  })
  it('type on relationship', () => {
    const rel = { __edgeLabel: 'KNOWS' }
    expect(_evaluateExpression('type(r)', { r: rel })).toBe('KNOWS')
  })
  it('startNode / endNode', () => {
    const rel = { _startNode: 1, _endNode: 2 }
    expect(_evaluateExpression('startNode(r)', { r: rel })).toBe(1)
    expect(_evaluateExpression('endNode(r)', { r: rel })).toBe(2)
  })
})
