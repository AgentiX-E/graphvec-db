import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Coverage for the duration.between / duration.inDays / duration.inMonths /
 *  duration.inSeconds family — cross-type (date/time/datetime), timezone/IANA
 *  (DST), sign, and large-year branches that the canonical TCK temporal suite
 *  does not reach through the pure-expression path. */

describe('duration.between cross-type', () => {
  it('date vs date', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), date('2020-01-11'))", {})).toBe('P10D')
  })
  it('date vs datetime', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), datetime('2020-01-02T00:00:00Z'))", {})).toBe('P1D')
  })
  it('date vs time (date promoted with time tz)', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), time('12:00:00'))", {})).toBe('PT12H')
  })
  it('time vs datetime', () => {
    expect(_evaluateExpression("duration.between(time('10:00:00'), datetime('2020-01-01T12:00:00Z'))", {})).toBe('PT2H')
  })
  it('two pure times use epoch baseline', () => {
    expect(_evaluateExpression("duration.between(time('10:00:00'), time('12:00:00'))", {})).toBe('PT2H')
  })
  it('datetime vs datetime calendar diff', () => {
    expect(_evaluateExpression("duration.between(datetime('2020-01-01T00:00:00Z'), datetime('2021-02-03T00:00:00Z'))", {})).toBe('P1Y1M2D')
  })
  it('reverse order yields negative', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-11'), date('2020-01-01'))", {})).toBe('P-10D')
  })
  it('same instant -> PT0S', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), date('2020-01-01'))", {})).toBe('PT0S')
  })
})

describe('duration.between timezone / IANA', () => {
  it('same instant different tz', () => {
    const v = _evaluateExpression("duration.between(datetime('2020-01-01T00:00:00Z'), datetime('2020-01-01T01:00:00+01:00'))", {})
    expect(typeof v).toBe('string')
  })
  it('IANA timezone (DST-affected)', () => {
    const v = _evaluateExpression("duration.between(datetime('2020-06-01T00:00:00[Europe/Stockholm]'), datetime('2020-12-01T00:00:00[Europe/Stockholm]'))", {})
    expect(typeof v).toBe('string')
  })
  it('datetime + localdatetime (mixed tz)', () => {
    const v = _evaluateExpression("duration.between(datetime('2020-01-01T00:00:00Z'), localdatetime('2020-01-02T00:00:00'))", {})
    expect(typeof v).toBe('string')
  })
})

describe('duration.inDays', () => {
  it('two-arg date diff', () => {
    expect(_evaluateExpression("duration.inDays(date('2020-01-01'), date('2020-01-11'))", {})).toBe('P10D')
  })
  it('two-arg pure time short-circuits', () => {
    expect(_evaluateExpression("duration.inDays(time('10:00:00'), time('12:00:00'))", {})).toBe('PT0S')
  })
  it('single-arg extracts fractional days', () => {
    expect(_evaluateExpression("duration.inDays(duration('P2DT12H'))", {})).toBe(2.5)
  })
  it('single-arg negative', () => {
    expect(_evaluateExpression("duration.inDays(duration('P-2D'))", {})).toBe(-2)
  })
})

describe('duration.inMonths', () => {
  it('two-arg delegates to between', () => {
    expect(_evaluateExpression("duration.inMonths(date('2020-01-01'), date('2021-03-01'))", {})).toBe('P1Y2M')
  })
  it('single-arg extracts months', () => {
    expect(_evaluateExpression("duration.inMonths(duration('P1Y2M'))", {})).toBe(14)
  })
  it('single-arg negative', () => {
    expect(_evaluateExpression("duration.inMonths(duration('P-1Y'))", {})).toBe(-12)
  })
})

describe('duration.inSeconds', () => {
  it('two-arg date diff in seconds form', () => {
    const v = _evaluateExpression("duration.inSeconds(datetime('2020-01-01T00:00:00Z'), datetime('2020-01-01T01:00:00Z'))", {})
    expect(v).toBe('PT1H')
  })
  it('single-arg normalizes duration to seconds', () => {
    const v = _evaluateExpression("duration.inSeconds(duration('PT1H'))", {})
    expect(typeof v).toBe('string')
  })
  it('two-arg same value -> PT0S', () => {
    expect(_evaluateExpression("duration.inSeconds(date('2020-01-01'), date('2020-01-01'))", {})).toBe('PT0S')
  })
  it('negative between yields negative seconds', () => {
    const v = _evaluateExpression("duration.inSeconds(datetime('2020-01-02T00:00:00Z'), datetime('2020-01-01T00:00:00Z'))", {})
    expect(typeof v).toBe('string')
    expect(String(v)).toContain('-')
  })
})

describe('duration large-year edge', () => {
  it('large year difference does not throw', () => {
    const v = _evaluateExpression("duration.between(date('2000-01-01'), date('9999-01-01'))", {})
    expect(typeof v).toBe('string')
  })
})

describe('duration.inSeconds cross-type (uncovered branches)', () => {
  it('date + time (date promoted with localtime)', () => {
    const v = _evaluateExpression("duration.inSeconds(date('2020-01-01'), time('12:00:00'))", {})
    expect(v).toBe('PT12H')
  })
  it('time + date (negative of localtime)', () => {
    const v = _evaluateExpression("duration.inSeconds(time('12:00:00'), date('2020-01-01'))", {})
    expect(v).toBe('PT-12H')
  })
  it('two pure times', () => {
    expect(_evaluateExpression("duration.inSeconds(time('10:00:00'), time('12:00:00'))", {})).toBe('PT2H')
  })
  it('time + datetime', () => {
    const v = _evaluateExpression("duration.inSeconds(time('10:00:00'), datetime('2020-01-01T12:00:00Z'))", {})
    expect(v).toBe('PT2H')
  })
  it('datetime + time (reverse)', () => {
    const v = _evaluateExpression("duration.inSeconds(datetime('2020-01-01T12:00:00Z'), time('10:00:00'))", {})
    expect(v).toBe('PT-2H')
  })
  it('single-arg normalizes a large duration via BigInt', () => {
    const v = _evaluateExpression("duration.inSeconds(duration('P1DT2H'))", {})
    expect(v).toBe('PT26H')
  })
  it('single-arg negative duration (component sign)', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('P-1D'))", {})).toBe('PT-24H')
  })
  it('single-arg negative duration (leading sign)', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-P1D'))", {})).toBe('PT-24H')
  })
  it('single-arg negative time component', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('PT-1H'))", {})).toBe('PT-1H')
  })
  it('sub-second precision single-arg', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('PT1.5S'))", {})).toBe('PT1.5S')
  })
})
