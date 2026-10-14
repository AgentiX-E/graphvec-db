import { describe, it, expect } from 'vitest'
import { _evaluateExpression, _isExprValue } from './expression-engine'

// Lock duration fractional-component normalization. Fractional year/month/day/
// hour/minute/second components must decompose into the next-smaller integer
// component (month -> ~30.437 days via AVG_DAYS_PER_MONTH) rather than being
// truncated or dropped, and fractional seconds must transfer into nanoseconds.

describe('duration fractional component decomposition', () => {
  it('decomposes fractional months into days/hours/minutes/seconds', () => {
    expect(_evaluateExpression('duration({months: 1.5})', {})).toBe('P1M15DT5H14M33S')
  })

  it('decomposes fractional days into hours', () => {
    expect(_evaluateExpression('duration({days: 1.5})', {})).toBe('P1DT12H')
  })

  it('decomposes fractional hours into minutes', () => {
    expect(_evaluateExpression('duration({hours: 1.5})', {})).toBe('PT1H30M')
  })

  it('decomposes fractional minutes into seconds', () => {
    expect(_evaluateExpression('duration({minutes: 1.5})', {})).toBe('PT1M30S')
  })

  it('decomposes fractional ISO-8601 months string', () => {
    expect(_evaluateExpression("duration('P1.5M')", {})).toBe('P1M15DT5H14M33S')
  })

  it('decomposes fractional ISO-8601 hours string', () => {
    expect(_evaluateExpression("duration('PT1.5H')", {})).toBe('PT1H30M')
  })

  it('scales a duration into a fractional month, then decomposes', () => {
    expect(_evaluateExpression("duration('P2M') / 4", {})).toBe('P15DT5H14M33S')
  })
})

// Lock the `_isExprValue` classifier: it distinguishes structured-expression
// strings (function calls, property paths, operators, unary prefixes) from bare
// literal values, steering the top-level evaluation path.
describe('_isExprValue classifier', () => {
  it('recognizes a function-call expression', () => {
    expect(_isExprValue('toUpper(name)')).toBe(true)
    expect(_isExprValue('coalesce(a.b, 0)')).toBe(true)
  })

  it('recognizes an operator expression', () => {
    expect(_isExprValue('1 + 2')).toBe(true)
    expect(_isExprValue('a = b')).toBe(true)
    expect(_isExprValue('x IN [1,2,3]')).toBe(true)
  })

  it('recognizes a property-path expression', () => {
    expect(_isExprValue('node.name')).toBe(true)
    expect(_isExprValue('a.b.c')).toBe(true)
  })

  it('recognizes a unary-prefix expression', () => {
    expect(_isExprValue('-5')).toBe(true)
    expect(_isExprValue('!flag')).toBe(true)
    expect(_isExprValue('NOT x')).toBe(true)
  })

  it('rejects bare literals and identifiers', () => {
    expect(_isExprValue('name')).toBe(false)
    expect(_isExprValue('42')).toBe(false)
    expect(_isExprValue("'hello'")).toBe(false)
  })
})
