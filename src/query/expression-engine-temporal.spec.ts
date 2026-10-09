/**
 * Temporal / duration helper unit tests for expression-engine.ts.
 *
 * The temporal engine is a large self-contained pure-function cluster
 * (lines ~246–1240 and ~3462–3665).  Much of it is only reachable indirectly
 * via `_evaluateExpression`; this spec drives the exported API directly and
 * exercises the duration arithmetic + normalization helpers through the public
 * `_evaluateExpression` entry point to keep every assertion tied to real
 * behaviour (no mocked branches).
 */

import { describe, it, expect } from 'vitest'
import {
  _resolveNanoseconds,
  _formatTime,
  _extractTimeMap,
  _extractTimeProp,
  _extractDurationProp,
  _formatTimezone,
  _resolveNamedTimezone,
  _tzLocalToUTC,
  _isoYear,
  _isoWeek1Monday,
  _isoWeeksInYear,
  _isoWeekNumber,
  _resolveDateFromMap,
  _evaluateExpression,
} from './expression-engine'

describe('_resolveNanoseconds', () => {
  it('reads plural millisecond/microsecond/nanosecond keys', () => {
    expect(_resolveNanoseconds({ milliseconds: 2, microseconds: 3, nanoseconds: 4 })).toBe(2003004)
  })
  it('reads singular keys as fallback', () => {
    expect(_resolveNanoseconds({ millisecond: 1, microsecond: 2, nanosecond: 3 })).toBe(1002003)
  })
  it('defaults missing components to zero', () => {
    expect(_resolveNanoseconds({})).toBe(0)
  })
})

describe('_formatTime', () => {
  it('renders full time with nanosecond fraction', () => {
    expect(_formatTime(1, 2, 3, 456000000)).toBe('01:02:03.456')
  })
  it('renders HH:MM:SS when second > 0 but nanosecond == 0', () => {
    expect(_formatTime(1, 2, 3, 0)).toBe('01:02:03')
  })
  it('renders HH:MM when second == 0', () => {
    expect(_formatTime(1, 2, 0, 0)).toBe('01:02')
  })
})

describe('_extractTimeMap', () => {
  it('pulls hour/minute/second/nanosecond with defaults', () => {
    expect(_extractTimeMap({ hour: 5, minute: 6, second: 7, nanosecond: 8 })).toEqual({
      hour: 5, minute: 6, second: 7, nanosecond: 8,
    })
  })
  it('defaults missing fields to zero', () => {
    expect(_extractTimeMap({})).toEqual({ hour: 0, minute: 0, second: 0, nanosecond: 0 })
  })
})

describe('_extractTimeProp', () => {
  const t = '12:34:56.789012345+02:30'
  it('extracts hour', () => expect(_extractTimeProp(t, 'hour')).toBe(12))
  it('extracts minute', () => expect(_extractTimeProp(t, 'minute')).toBe(34))
  it('extracts second', () => expect(_extractTimeProp(t, 'second')).toBe(56))
  it('extracts millisecond', () => expect(_extractTimeProp(t, 'millisecond')).toBe(789))
  it('extracts microsecond', () => expect(_extractTimeProp(t, 'microsecond')).toBe(789012))
  it('extracts nanosecond', () => expect(_extractTimeProp(t, 'nanosecond')).toBe(789012345))
  it('extracts offset', () => expect(_extractTimeProp(t, 'offset')).toBe('+02:30'))
  it('extracts offsetMinutes', () => expect(_extractTimeProp(t, 'offsetMinutes')).toBe(150))
  it('extracts offsetSeconds', () => expect(_extractTimeProp(t, 'offsetSeconds')).toBe(9000))
  it('returns null offset when no tz', () => expect(_extractTimeProp('01:02:03', 'offset')).toBeNull())
  it('extracts timezone name from IANA suffix', () => {
    expect(_extractTimeProp('12:00:00[Europe/London]', 'timezone')).toBe('Europe/London')
  })
  it('offset for Z is +00:00', () => expect(_extractTimeProp('12:00:00Z', 'offset')).toBe('+00:00'))
  it('returns undefined for unknown prop', () => expect(_extractTimeProp('12:00:00', 'bogus')).toBeUndefined())
})

describe('_extractDurationProp', () => {
  const d = 'P1Y2M3DT4H5M6.5S'
  it('years', () => expect(_extractDurationProp(d, 'years')).toBe(1))
  it('months (calendar total)', () => expect(_extractDurationProp(d, 'months')).toBe(14))
  it('days', () => expect(_extractDurationProp(d, 'days')).toBe(3))
  it('hours', () => expect(_extractDurationProp(d, 'hours')).toBe(4))
  it('minutes (dayTime total)', () => expect(_extractDurationProp(d, 'minutes')).toBe(245))
  it('seconds (dayTime total)', () => expect(_extractDurationProp(d, 'seconds')).toBe(14706))
  it('quarters', () => expect(_extractDurationProp(d, 'quarters')).toBe(4))
  it('weeks (floor days/7)', () => expect(_extractDurationProp(d, 'weeks')).toBe(0))
  it('monthsOfYear', () => expect(_extractDurationProp(d, 'monthsOfYear')).toBe(2))
  it('monthsOfQuarter', () => expect(_extractDurationProp(d, 'monthsOfQuarter')).toBe(2))
  it('quartersOfYear (calendar months 14 -> quarter 5 -> index 4)', () => expect(_extractDurationProp(d, 'quartersOfYear')).toBe(4))
  it('daysOfWeek', () => expect(_extractDurationProp('P10D', 'daysOfWeek')).toBe(3))
  it('nanoseconds', () => expect(_extractDurationProp(d, 'nanoseconds')).toBe(14706 * 1e9 + 500000000))
  it('returns null for malformed', () => expect(_extractDurationProp('not-a-duration', 'years')).toBeNull())
})

describe('_resolveNamedTimezone', () => {
  it('resolves a known IANA zone to offset + IANA suffix', () => {
    expect(_resolveNamedTimezone('Europe/London', 2020, 7, 1, 12, 0)).toBe('+01:00[Europe/London]')
  })
  it('returns the input unchanged for unknown zone', () => {
    expect(_resolveNamedTimezone('Not/AZone', 2020, 1, 1, 0, 0)).toBe('Not/AZone')
  })
})

describe('_formatTimezone', () => {
  it('passes through a bare IANA name unchanged', () => {
    expect(_formatTimezone('Europe/London')).toBe('Europe/London')
  })
  it('passes through a numeric offset', () => {
    expect(_formatTimezone('+05:30')).toBe('+05:30')
  })
})

describe('_tzLocalToUTC', () => {
  it('converts UTC to local Date for a numeric offset', () => {
    const d = _tzLocalToUTC('2020-01-01T00:00:00', '+02:00')
    expect(d).toBeInstanceOf(Date)
    expect(d!.getUTCHours()).toBe(22)
  })
  it('returns null for unparseable input', () => {
    expect(_tzLocalToUTC('garbage', '+02:00')).toBeNull()
  })
})

describe('ISO week helpers', () => {
  it('_isoYear', () => {
    expect(_isoYear(new Date(Date.UTC(2021, 0, 1)))).toBe(2020)
  })
  it('_isoWeek1Monday', () => {
    const d = _isoWeek1Monday(2021)
    expect(d.getUTCDay()).toBe(1)
  })
  it('_isoWeeksInYear (2020 has 53)', () => {
    expect(_isoWeeksInYear(2020)).toBe(53)
    expect(_isoWeeksInYear(2021)).toBe(52)
  })
  it('_isoWeekNumber', () => {
    expect(_isoWeekNumber(new Date(Date.UTC(2021, 0, 1)))).toBe(53)
  })
})

describe('_resolveDateFromMap', () => {
  it('builds a Date from year/month/day map', () => {
    const d = _resolveDateFromMap({ year: 2020, month: 2, day: 3 })
    expect(d.getUTCFullYear()).toBe(2020)
    expect(d.getUTCMonth()).toBe(1)
    expect(d.getUTCDate()).toBe(3)
  })
})

describe('duration arithmetic via _evaluateExpression', () => {
  it('duration() parses an ISO duration', () => {
    expect(_evaluateExpression("duration('P1DT2H')", {})).toBe('P1DT2H')
  })
  it('parses the Cypher date-format duration P2012-02-02T14:37:21', () => {
    const v = _evaluateExpression("duration('P2012-02-02T14:37:21')", {})
    expect(typeof v).toBe('string')
    expect((v as string).startsWith('P')).toBe(true)
  })
  it('adds two durations (days preserved, not folded to hours)', () => {
    expect(_evaluateExpression("duration('P1D') + duration('P2D')", {})).toBe('P3D')
  })
  it('subtracts durations', () => {
    expect(_evaluateExpression("duration('P3D') - duration('P1D')", {})).toBe('P2D')
  })
  it('unary minus on a duration is NaN (unsupported)', () => {
    expect(Number.isNaN(_evaluateExpression("-duration('P1D')", {}))).toBe(true)
  })
  it('hours component of a duration via dot access', () => {
    expect(_evaluateExpression("duration('P1DT2H').hours", {})).toBe(2)
  })
  it('normalizes a date with leading-zero month/day', () => {
    expect(_evaluateExpression("date('2020-01-05')", {})).toBe('2020-01-05')
  })
  it('extracts year from a date', () => {
    expect(_evaluateExpression("date('2020-03-05').year", {})).toBe(2020)
  })
})
