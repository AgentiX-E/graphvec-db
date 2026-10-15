import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock negative fractional-second duration semantics (string construction).
//
// Two real bugs are covered here:
//   1. BUG-20: a pure sub-second negative (`PT-0.5S` / `-PT0.5S`) dropped the
//      sign and rendered as `PT0.5S` because `_parseDuration` took `Math.abs`
//      of the sub-second remainder, losing the negative sign.
//   2. BUG-21: adding a positive and negative fractional duration carried
//      incorrectly (`PT45.5S + PT-45.5S` -> `PT1S` instead of `PT0S`) because
//      both parsed to a *positive* nanosecond magnitude, so `0.5s + 0.5s`
//      overflowed into a full second instead of cancelling.

describe('duration() negative fractional-second construction', () => {
  it('keeps the fraction on a negative whole+fractional second', () => {
    expect(_evaluateExpression("duration('PT-45.5S')", {})).toBe('PT-45.5S')
  })

  it('keeps the fraction under a leading sign', () => {
    expect(_evaluateExpression("duration('-PT45.5S')", {})).toBe('PT-45.5S')
  })

  it('keeps the sign on a pure sub-second negative', () => {
    expect(_evaluateExpression("duration('PT-0.5S')", {})).toBe('PT-0.5S')
  })

  it('keeps the sign on a leading pure sub-second negative', () => {
    expect(_evaluateExpression("duration('-PT0.5S')", {})).toBe('PT-0.5S')
  })

  it('preserves positive fractional seconds untouched', () => {
    expect(_evaluateExpression("duration('PT0.5S')", {})).toBe('PT0.5S')
  })
})

describe('duration() negative fractional-second arithmetic', () => {
  it('cancels a positive and negative fractional second exactly', () => {
    expect(_evaluateExpression("duration('PT45.5S') + duration('PT-45.5S')", {})).toBe('PT0S')
  })

  it('cancels under a leading-sign representation too', () => {
    expect(_evaluateExpression("duration('PT45.5S') + duration('-PT45.5S')", {})).toBe('PT0S')
  })

  it('cancels pure sub-second values exactly', () => {
    expect(_evaluateExpression("duration('PT0.5S') + duration('PT-0.5S')", {})).toBe('PT0S')
  })

  it('subtracts a negative fractional duration correctly', () => {
    expect(_evaluateExpression("duration('PT2M') - duration('-PT1M30S')", {})).toBe('PT3M30S')
  })
})
