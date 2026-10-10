import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Extended temporal-expression coverage.
 *
 * These tests exercise the complex branches of the date/time/datetime/duration
 * normalizers, truncation units, timezone conversion, and week/quarter/ordinal
 * arithmetic through the same `_evaluateExpression` entry point the query
 * pipeline uses.  Where Cypher semantics are unambiguous, expected outputs are
 * asserted exactly; this is also how edge-case bugs are surfaced.
 */

describe('date() normalization of many string shapes', () => {
  it('YYYYMMDD -> YYYY-MM-DD', () => {
    expect(_evaluateExpression("date('20200105')", {})).toBe('2020-01-05')
  })
  it('YYYY-MM -> YYYY-MM-01', () => {
    expect(_evaluateExpression("date('2020-03')", {})).toBe('2020-03-01')
  })
  it('YYYYMM -> YYYY-MM-01', () => {
    expect(_evaluateExpression("date('202003')", {})).toBe('2020-03-01')
  })
  it('YYYY -> YYYY-01-01', () => {
    expect(_evaluateExpression("date('2020')", {})).toBe('2020-01-01')
  })
  it('ISO week-date 2020-W01 -> 2019-12-30', () => {
    expect(_evaluateExpression("date('2020-W01')", {})).toBe('2019-12-30')
  })
  it('ISO ordinal 2020-032 -> 2020-02-01', () => {
    expect(_evaluateExpression("date('2020-032')", {})).toBe('2020-02-01')
  })
  it('a full datetime string truncates to its date part', () => {
    expect(_evaluateExpression("date('1984-10-11T12:00:00')", {})).toBe('1984-10-11')
  })
})

describe('date component access (.prop)', () => {
  it('quarter / month / day / ordinalDay / weekDay / dayOfQuarter', () => {
    // 2020-03-15: Q1, ordinal day 75, weekDay Sunday=7, dayOfQuarter 75
    expect(_evaluateExpression("date('2020-03-15').quarter", {})).toBe(1)
    expect(_evaluateExpression("date('2020-03-15').month", {})).toBe(3)
    expect(_evaluateExpression("date('2020-03-15').ordinalDay", {})).toBe(75)
    expect(_evaluateExpression("date('2020-03-15').weekDay", {})).toBe(7)
    expect(_evaluateExpression("date('2020-03-15').dayOfQuarter", {})).toBe(75)
  })
  it('year / week / weekYear', () => {
    expect(_evaluateExpression("date('2020-03-15').year", {})).toBe(2020)
    expect(_evaluateExpression("date('2021-01-01').weekYear", {})).toBe(2020)
    expect(_evaluateExpression("date('2021-01-01').week", {})).toBe(53)
  })
})

describe('time() / localtime() normalization', () => {
  it('time from HHMMSS (no colons)', () => {
    expect(_evaluateExpression("time('123456')", {})).toBe('12:34:56Z')
  })
  it('time from HH:MM adds :00 and Z', () => {
    expect(_evaluateExpression("time('12:34')", {})).toBe('12:34Z')
  })
  it('time from HH sharp', () => {
    expect(_evaluateExpression("time('12')", {})).toBe('12:00Z')
  })
  it('time with ±HHMM offset normalizes to ±HH:MM', () => {
    expect(_evaluateExpression("time('12:34:56+0230')", {})).toBe('12:34:56+02:30')
  })
  it('time -00:00 normalizes to Z', () => {
    expect(_evaluateExpression("time('12:34:56-00:00')", {})).toBe('12:34:56Z')
  })
  it('localtime strips offset', () => {
    expect(_evaluateExpression("localtime('12:34:56+02:30')", {})).toBe('12:34:56')
  })
})

describe('datetime() timezone handling', () => {
  it('appends Z when no tz present', () => {
    expect(_evaluateExpression("datetime('2015-06-24T12:50:35')", {})).toBe('2015-06-24T12:50:35Z')
  })
  it('normalizes ±HHMM to ±HH:MM', () => {
    expect(_evaluateExpression("datetime('2015-06-24T12:50:35.556+0100')", {})).toBe('2015-06-24T12:50:35.556+01:00')
  })
  it('normalizes -00:00 to Z', () => {
    expect(_evaluateExpression("datetime('2015-06-24T12:50:35-00:00')", {})).toBe('2015-06-24T12:50:35Z')
  })
  it('resolves [IANA] to a concrete offset with the IANA suffix retained', () => {
    // Europe/London on 2015-01-01 is winter time (UTC+00), IANA suffix kept
    expect(_evaluateExpression("datetime('2015-01-01T00:00:00[Europe/London]')", {})).toBe('2015-01-01T00:00:00+00:00[Europe/London]')
  })
})

describe('date/datetime map construction with overrides', () => {
  it('date with week+dayOfWeek override', () => {
    // 2021-W01 Monday = 2021-01-04
    expect(_evaluateExpression("date({year: 2021, week: 1, dayOfWeek: 1})", {})).toBe('2021-01-04')
  })
  it('date with quarter override', () => {
    expect(_evaluateExpression("date({year: 2021, quarter: 2, day: 1})", {})).toBe('2021-04-01')
  })
  it('date with ordinalDay override', () => {
    expect(_evaluateExpression("date({year: 2021, ordinalDay: 32})", {})).toBe('2021-02-01')
  })
  it('date with two-digit-like year stays 4-digit', () => {
    // date({year: 1}) must be 0001-01-01, not 1901
    expect(_evaluateExpression("date({year: 1})", {})).toBe('0001-01-01')
  })
})

describe('duration component extraction', () => {
  it('weeks folds days/7 via .weeks', () => {
    expect(_evaluateExpression("duration('P14D').weeks", {})).toBe(2)
  })
  it('milliseconds / microseconds of second', () => {
    expect(_evaluateExpression("duration('PT0.5S').millisecondsOfSecond", {})).toBe(500)
    expect(_evaluateExpression("duration('PT0.5S').microsecondsOfSecond", {})).toBe(500000)
  })
  it('minutesOfHour / secondsOfMinute', () => {
    expect(_evaluateExpression("duration('PT2H5M').minutesOfHour", {})).toBe(5)
    expect(_evaluateExpression("duration('PT2H5M').secondsOfMinute", {})).toBe(0)
  })
  it('monthsOfQuarter', () => {
    expect(_evaluateExpression("duration('P4M').monthsOfQuarter", {})).toBe(1)
  })
})

describe('temporal truncation units', () => {
  it('date.truncate year', () => {
    expect(_evaluateExpression("date.truncate('year', date('1990-02-03'))", {})).toBe('1990-01-01')
  })
  it('date.truncate month', () => {
    expect(_evaluateExpression("date.truncate('month', date('1990-02-03'))", {})).toBe('1990-02-01')
  })
  it('date.truncate day', () => {
    expect(_evaluateExpression("date.truncate('day', date('1990-02-03'))", {})).toBe('1990-02-03')
  })
  it('date.truncate quarter', () => {
    expect(_evaluateExpression("date.truncate('quarter', date('1990-08-03'))", {})).toBe('1990-07-01')
  })
  it('date.truncate decade / century / millennium', () => {
    expect(_evaluateExpression("date.truncate('decade', date('1990-02-03'))", {})).toBe('1990-01-01')
    expect(_evaluateExpression("date.truncate('century', date('1990-02-03'))", {})).toBe('1900-01-01')
    expect(_evaluateExpression("date.truncate('millennium', date('1990-02-03'))", {})).toBe('1000-01-01')
  })
  it('datetime.truncate hour / minute / second', () => {
    expect(_evaluateExpression("datetime.truncate('hour', datetime('1990-02-03T12:34:56'))", {})).toBe('1990-02-03T12:00Z')
    expect(_evaluateExpression("datetime.truncate('minute', datetime('1990-02-03T12:34:56'))", {})).toBe('1990-02-03T12:34Z')
    expect(_evaluateExpression("datetime.truncate('second', datetime('1990-02-03T12:34:56.789'))", {})).toBe('1990-02-03T12:34:56Z')
  })
})
