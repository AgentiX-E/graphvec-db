import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock `duration.between` fractional-second correctness across BOTH code paths:
// the calendar-diff path (datetime + datetime, which uses field subtraction) and
// the millisecond fallback path (localtime + localtime, which uses getTime()
// floor division). Pure sub-second differences previously lost their sign on the
// calendar path (`PT0.5S` instead of `PT-0.5S`) and rounded up a full second on
// the fallback path (`PT1.5S` instead of `PT0.5S`).

describe('duration.between fractional-second sign', () => {
  it('datetime forward sub-second difference is positive', () => {
    expect(_evaluateExpression("duration.between(datetime('2024-01-01T00:00:00Z'), datetime('2024-01-01T00:00:00.5Z'))", {}))
      .toBe('PT0.5S')
  })

  it('datetime backward sub-second difference is negative', () => {
    expect(_evaluateExpression("duration.between(datetime('2024-01-01T00:00:00.5Z'), datetime('2024-01-01T00:00:00Z'))", {}))
      .toBe('PT-0.5S')
  })

  it('datetime whole-and-fractional seconds keep magnitude and sign', () => {
    expect(_evaluateExpression("duration.between(datetime('2024-01-01T00:00:00Z'), datetime('2024-01-01T00:00:01.5Z'))", {}))
      .toBe('PT1.5S')
    expect(_evaluateExpression("duration.between(datetime('2024-01-01T00:00:01.5Z'), datetime('2024-01-01T00:00:00Z'))", {}))
      .toBe('PT-1.5S')
  })

  it('localtime forward sub-second difference is positive', () => {
    expect(_evaluateExpression("duration.between(localtime('00:00:00'), localtime('00:00:00.5'))", {}))
      .toBe('PT0.5S')
  })

  it('localtime backward sub-second difference is negative', () => {
    expect(_evaluateExpression("duration.between(localtime('00:00:00.5'), localtime('00:00:00'))", {}))
      .toBe('PT-0.5S')
  })

  it('localtime whole-and-fractional seconds keep magnitude and sign', () => {
    expect(_evaluateExpression("duration.between(localtime('00:00:00'), localtime('00:00:01.5'))", {}))
      .toBe('PT1.5S')
    expect(_evaluateExpression("duration.between(localtime('00:00:01.5'), localtime('00:00:00'))", {}))
      .toBe('PT-1.5S')
  })

  it('whole-second differences are unaffected', () => {
    expect(_evaluateExpression("duration.between(datetime('2024-01-01T00:00:01Z'), datetime('2024-01-01T00:00:00Z'))", {}))
      .toBe('PT-1S')
    expect(_evaluateExpression("duration.between(localtime('00:00:00'), localtime('00:01:00'))", {}))
      .toBe('PT1M')
  })
})
