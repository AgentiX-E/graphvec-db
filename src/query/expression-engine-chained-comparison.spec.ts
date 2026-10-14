import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock chained boolean comparison evaluation and temporal ordering across
// mixed-offset instants. These exercise the boolean-continuation path and the
// IANA-vs-numeric-offset instant normalization used by all comparison operators.

describe('chained boolean comparison', () => {
  it('evaluates AND/OR continuation left-to-right', () => {
    expect(_evaluateExpression('true AND true OR false', {})).toBe(true)
    expect(_evaluateExpression('false OR true AND true', {})).toBe(true)
  })

  it('evaluates XOR continuation', () => {
    expect(_evaluateExpression('true XOR false AND true', {})).toBe(true)
  })
})

describe('mixed-offset temporal equality and ordering', () => {
  it('compares an IANA-instant with an equivalent Z instant', () => {
    // 12:00 America/New_York (UTC-5 in winter) == 17:00 Z
    expect(_evaluateExpression("datetime('2024-01-01T12:00:00[America/New_York]') = datetime('2024-01-01T17:00:00Z')", {}))
      .toBe(true)
  })

  it('compares an IANA-instant with its numeric-offset equivalent', () => {
    expect(_evaluateExpression("datetime('2024-01-01T12:00:00[America/New_York]') = datetime('2024-01-01T12:00:00-05:00')", {}))
      .toBe(true)
  })

  it('resolves daylight-time IANA instants against Z', () => {
    // July: America/New_York is UTC-4, so 12:00 local == 16:00 Z
    expect(_evaluateExpression("datetime('2024-07-01T12:00:00[America/New_York]') = datetime('2024-07-01T16:00:00Z')", {}))
      .toBe(true)
  })

  it('orders an equal IANA/Z instant as neither less nor greater', () => {
    expect(_evaluateExpression("datetime('2024-01-01T12:00:00[America/New_York]') < datetime('2024-01-01T17:00:00Z')", {}))
      .toBe(false)
    expect(_evaluateExpression("datetime('2024-01-01T12:00:00[America/New_York]') > datetime('2024-01-01T17:00:00Z')", {}))
      .toBe(false)
  })

  it('orders an IANA-instant relative to a genuinely later instant', () => {
    expect(_evaluateExpression("datetime('2024-01-01T12:00:00[America/New_York]') < datetime('2024-01-01T18:00:00Z')", {}))
      .toBe(true)
  })
})

describe('date map dayOfWeek and quarter', () => {
  it('resolves a week + dayOfWeek into a concrete date', () => {
    expect(_evaluateExpression('date({year: 2024, week: 5, dayOfWeek: 3})', {})).toBe('2024-01-31')
  })

  it('resolves a quarter + dayOfQuarter into a concrete date', () => {
    expect(_evaluateExpression('date({year: 2024, quarter: 2, dayOfQuarter: 45})', {})).toBe('2024-05-15')
  })
})
