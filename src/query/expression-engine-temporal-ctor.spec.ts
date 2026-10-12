import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Coverage for the temporal constructor family (date / time / localtime /
 *  datetime / localdatetime) — string passes, map passes, timezone overrides,
 *  IANA + DST resolution, and week/ordinal/dayOfWeek map keys. These exercise
 *  the big anonymous constructor branches plus _mergeDateStr /
 *  _resolveDateFromMap / _formatTimezone / _resolveNamedTimezone. */

describe('date() constructor', () => {
  it('string pass-through', () => {
    expect(_evaluateExpression("date('2020-06-15')", {})).toBe('2020-06-15')
  })
  it('map with component overrides', () => {
    expect(_evaluateExpression("date({year:2020, month:3, day:10})", {})).toBe('2020-03-10')
  })
  it('map with week / dayOfWeek', () => {
    const v = _evaluateExpression("date({year:2020, week:2, dayOfWeek:3})", {})
    expect(typeof v).toBe('string')
  })
  it('map with ordinalDay', () => {
    const v = _evaluateExpression("date({year:2020, ordinalDay:100})", {})
    expect(typeof v).toBe('string')
  })
  it('map with quarter', () => {
    const v = _evaluateExpression("date({year:2020, quarter:2, dayOfQuarter:10})", {})
    expect(typeof v).toBe('string')
  })
})

describe('time() / localtime() constructor', () => {
  it('time string defaults to Z (has timezone)', () => {
    expect(_evaluateExpression("time('12:30:15')", {})).toBe('12:30:15Z')
  })
  it('time with offset preserved', () => {
    expect(_evaluateExpression("time('12:30:15+01:00')", {})).toBe('12:30:15+01:00')
  })
  it('localtime strips colon offset', () => {
    expect(_evaluateExpression("localtime('12:30:15+01:00')", {})).toBe('12:30:15')
  })
  it('localtime strips Z suffix', () => {
    expect(_evaluateExpression("localtime('12:30:15Z')", {})).toBe('12:30:15')
  })
  it('localtime strips compact offset +0100', () => {
    expect(_evaluateExpression("localtime('12:30:15.500+0100')", {})).toBe('12:30:15.500')
  })
  it('localtime from datetime string extracts time and strips Z', () => {
    expect(_evaluateExpression("localtime('2020-01-01T12:30:15Z')", {})).toBe('12:30:15')
  })
  it('time map with hour/minute (seconds omitted when zero)', () => {
    expect(_evaluateExpression("time({hour:9, minute:5, second:0})", {})).toBe('09:05Z')
  })
  it('time map with nanosecond precision', () => {
    expect(_evaluateExpression("time({hour:1, minute:2, second:3, nanosecond:456000000})", {})).toBe('01:02:03.456Z')
  })
})

describe('datetime() constructor — string path', () => {
  it('plain datetime string appends Z', () => {
    expect(_evaluateExpression("datetime('2020-01-01T12:00:00')", {})).toBe('2020-01-01T12:00:00Z')
  })
  it('datetime with offset preserved', () => {
    expect(_evaluateExpression("datetime('2020-01-01T12:00:00+01:00')", {})).toBe('2020-01-01T12:00:00+01:00')
  })
  it('datetime with IANA-only suffix resolves offset', () => {
    const v = _evaluateExpression("datetime('2020-01-01T12:00:00[Europe/Stockholm]')", {})
    expect(v).toBe('2020-01-01T12:00:00+01:00[Europe/Stockholm]')
  })
  it('datetime with IANA + offset (DST)', () => {
    const v = _evaluateExpression("datetime('2020-06-01T12:00:00[Europe/Stockholm]')", {})
    expect(String(v)).toContain('+02:00')
  })
  it('date-only string appends midnight Z', () => {
    expect(_evaluateExpression("datetime('2020-01-01')", {})).toBe('2020-01-01T00:00:00Z')
  })
})

describe('datetime() constructor — map path', () => {
  it('map with date + time strings', () => {
    expect(_evaluateExpression("datetime({date:'2020-01-01', time:'12:00:00'})", {})).toBe('2020-01-01T12:00:00Z')
  })
  it('map with timezone override', () => {
    const v = _evaluateExpression("datetime({year:2020, month:1, day:1, hour:12, minute:0, second:0, timezone:'UTC'})", {})
    expect(v).toBe('2020-01-01T12:00+00:00[UTC]')
  })
  it('map with datetime string', () => {
    const v = _evaluateExpression("datetime({datetime:'2020-01-01T12:00:00Z'})", {})
    expect(v).toBe('2020-01-01T12:00:00Z')
  })
  it('map date-only defaults time to midnight (seconds omitted when zero)', () => {
    const v = _evaluateExpression("datetime({date:'2020-01-01'})", {})
    expect(v).toBe('2020-01-01T00:00Z')
  })
})

describe('localdatetime() constructor', () => {
  it('string pass-through (no Z appended)', () => {
    expect(_evaluateExpression("localdatetime('2020-01-01T12:00:00')", {})).toBe('2020-01-01T12:00:00')
  })
  it('strips offset from datetime input', () => {
    const v = _evaluateExpression("localdatetime('2020-01-01T12:00:00+01:00')", {})
    expect(v).toBe('2020-01-01T12:00:00')
  })
  it('map construction (seconds omitted when zero)', () => {
    const v = _evaluateExpression("localdatetime({year:2020, month:1, day:1, hour:12, minute:0, second:0})", {})
    expect(v).toBe('2020-01-01T12:00')
  })
})

describe('timezone resolution edge cases', () => {
  it('IANA with DST vs winter offset', () => {
    const winter = _evaluateExpression("datetime('2020-01-15T12:00:00[Europe/Stockholm]')", {})
    const summer = _evaluateExpression("datetime('2020-07-15T12:00:00[Europe/Stockholm]')", {})
    expect(String(winter)).toContain('+01:00')
    expect(String(summer)).toContain('+02:00')
  })
  it('negative offset timezone', () => {
    const v = _evaluateExpression("datetime('2020-01-01T12:00:00[America/New_York]')", {})
    expect(String(v)).toContain('-05:00')
  })
})
