import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock the leading-sign normalization of `duration()`. ISO 8601 allows a whole
// duration to be negated (`-P2D`), and the sign must apply to EVERY component.
// A previous fix moved the sign onto only the first component, so `-PT1M30S`
// became `PT-1M30S` (minutes negative, seconds positive), which is `-30s` not
// `-90s`. It must normalize to `PT-1M-30S` so that arithmetic is correct.

describe('duration leading-sign normalization', () => {
  it('negates every component of a pure-time duration', () => {
    expect(_evaluateExpression("duration('-PT1M30S')", {})).toBe('PT-1M-30S')
  })

  it('negates a whole-day calendar duration', () => {
    expect(_evaluateExpression("duration('-P2D')", {})).toBe('P-2D')
  })

  it('negates a calendar+time duration on every component', () => {
    expect(_evaluateExpression("duration('-P1DT2H')", {})).toBe('P-1DT-2H')
  })

  it('ignores a leading plus sign', () => {
    expect(_evaluateExpression("duration('+PT1M30S')", {})).toBe('PT1M30S')
  })

  it('negates a single-component pure-time duration', () => {
    expect(_evaluateExpression("duration('-PT30S')", {})).toBe('PT-30S')
  })

  it('negates a fractional-second duration keeping the fraction', () => {
    expect(_evaluateExpression("duration('-PT45.5S')", {})).toBe('PT-45.5S')
  })

  it('negates a whole-and-fractional mixed multi-component duration', () => {
    expect(_evaluateExpression("duration('-PT1H30.5S')", {})).toBe('PT-1H-30.5S')
  })

  it('negates every component of a full calendar+time duration', () => {
    expect(_evaluateExpression("duration('-P1Y2M3DT4H5M6S')", {})).toBe('P-1Y-2M-3DT-4H-5M-6S')
  })

  it('equates leading-sign form with per-component form', () => {
    expect(_evaluateExpression("duration('-PT1M30S') = duration('PT-1M-30S')", {})).toBe(true)
  })

  it('subtraction with a leading-sign duration is correct', () => {
    // -90s - 120s = -210s = -3m30s
    expect(_evaluateExpression("duration('-PT1M30S') - duration('PT2M')", {})).toBe('PT-3M-30S')
  })

  it('subtracting a leading-sign duration is correct', () => {
    // 120s - (-90s) = 210s = 3m30s
    expect(_evaluateExpression("duration('PT2M') - duration('-PT1M30S')", {})).toBe('PT3M30S')
  })
})
