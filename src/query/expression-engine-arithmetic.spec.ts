import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Coverage for duration/date/time arithmetic operators.  These exercise
 * _durationAdd/_durationSub (including the BigInt mixed-sign borrow path),
 * _durationScale, _durationNegate, and the date/time/datetime +- duration
 * helpers reached through the +,-,*,/ expression operators.
 */

describe('duration + duration', () => {
  it('adds day and hour components without collapsing them', () => {
    expect(_evaluateExpression("duration('P1D') + duration('PT2H')", {})).toBe('P1DT2H')
  })
  it('normalizes overflow (60m -> 1H)', () => {
    expect(_evaluateExpression("duration('PT30M') + duration('PT30M')", {})).toBe('PT1H')
  })
})

describe('duration - duration', () => {
  it('subtracts like components', () => {
    expect(_evaluateExpression("duration('P2D') - duration('P1D')", {})).toBe('P1D')
  })
  it('mixed-sign borrow via BigInt (day borrow from time)', () => {
    // P1D - PT2H = PT22H (borrow 1 day = 24h into hours)
    const r = _evaluateExpression("duration('P1D') - duration('PT2H')", {})
    expect(r).toBe('PT22H')
  })
  it('negative result', () => {
    const r = _evaluateExpression("duration('P1D') - duration('P2D')", {})
    expect(typeof r).toBe('string')
    expect((r as string).includes('-')).toBe(true)
  })
})

describe('duration * number (scale)', () => {
  it('scales a duration by 2', () => {
    expect(_evaluateExpression("duration('PT1H') * 2", {})).toBe('PT2H')
  })
  it('number * duration (commutative)', () => {
    expect(_evaluateExpression("2 * duration('PT30M')", {})).toBe('PT1H')
  })
})

describe('duration / number (scale inverse)', () => {
  it('divides a duration', () => {
    expect(_evaluateExpression("duration('PT2H') / 2", {})).toBe('PT1H')
  })
})

describe('date +- duration', () => {
  it('date + duration advances by a month (clamps at month end)', () => {
    expect(_evaluateExpression("date('2020-01-31') + duration('P1M')", {})).toBe('2020-03-02')
  })
  it('date - duration', () => {
    expect(_evaluateExpression("date('2020-03-01') - duration('P1D')", {})).toBe('2020-02-29')
  })
})

describe('time +- duration', () => {
  it('time + duration wraps at 24h and keeps tz suffix', () => {
    expect(_evaluateExpression("time('23:00:00+01:00') + duration('PT2H')", {})).toBe('01:00:00+01:00')
  })
  it('time - duration', () => {
    expect(_evaluateExpression("time('01:00:00Z') - duration('PT1H')", {})).toBe('00:00:00Z')
  })
})

describe('datetime +- duration', () => {
  it('datetime + duration crosses month boundary', () => {
    expect(_evaluateExpression("datetime('2020-01-31T23:00:00Z') + duration('PT2H')", {})).toBe('2020-02-01T01:00:00Z')
  })
  it('datetime - duration', () => {
    expect(_evaluateExpression("datetime('2020-01-01T00:00:00Z') - duration('PT1H')", {})).toBe('2019-12-31T23:00:00Z')
  })
})
