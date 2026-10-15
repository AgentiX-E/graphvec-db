import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock duration string-constructor normalization symmetry: an ISO-8601 string
// duration with an out-of-range (negative or positive) component must normalize
// to the same result as the equivalent map-constructed duration. The string path
// previously only carried positive overflow, leaving `PT-90S` as `PT-90S` while
// `{seconds:-90}` normalized to `PT-1M-30S`.

describe('duration string negative-component normalization', () => {
  it('normalizes negative seconds overflow', () => {
    expect(_evaluateExpression("duration('PT-90S')", {})).toBe('PT-1M-30S')
    expect(_evaluateExpression('duration({seconds: -90})', {})).toBe('PT-1M-30S')
  })

  it('normalizes a larger negative seconds overflow', () => {
    expect(_evaluateExpression("duration('PT-150S')", {})).toBe('PT-2M-30S')
    expect(_evaluateExpression('duration({seconds: -150})', {})).toBe('PT-2M-30S')
  })

  it('normalizes negative minutes overflow', () => {
    expect(_evaluateExpression("duration('PT-90M')", {})).toBe('PT-1H-30M')
    expect(_evaluateExpression('duration({minutes: -90})', {})).toBe('PT-1H-30M')
  })

  it('normalizes negative hours overflow into a negative day', () => {
    expect(_evaluateExpression("duration('PT-30H')", {})).toBe('P-1DT-6H')
    expect(_evaluateExpression('duration({hours: -30})', {})).toBe('P-1DT-6H')
  })

  it('still normalizes positive overflow identically', () => {
    expect(_evaluateExpression("duration('PT90S')", {})).toBe('PT1M30S')
    expect(_evaluateExpression("duration('PT90M')", {})).toBe('PT1H30M')
  })

  it('handles a leading-sign duration string', () => {
    expect(_evaluateExpression("duration('-P2D')", {})).toBe('P-2D')
  })

  it('preserves a fractional negative duration', () => {
    expect(_evaluateExpression("duration('PT-1.5S')", {})).toBe('PT-1.5S')
  })
})
