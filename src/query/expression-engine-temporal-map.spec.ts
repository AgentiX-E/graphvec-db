import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Coverage for temporal map construction (_resolveDateFromMap / _mergeDateStr / _fmtUtcDate)
 *  and date.truncate unit matrix (_truncateDateStr). */

describe('date() map construction', () => {
  it('year/month/day', () => expect(_evaluateExpression('date({year:1984, month:10, day:11})', {})).toBe('1984-10-11'))
  it('defaults when missing fields', () => expect(_evaluateExpression('date({year:1984})', {})).toBe('1984-01-01'))
  it('year only default', () => expect(_evaluateExpression('date({year:2000})', {})).toBe('2000-01-01'))
  it('year 1 pads to 0001', () => expect(_evaluateExpression('date({year:1})', {})).toBe('0001-01-01'))
  it('quarter', () => expect(_evaluateExpression('date({year:1984, quarter:3})', {})).toBe('1984-07-01'))
  it('quarter + dayOfQuarter', () => expect(_evaluateExpression('date({year:1984, quarter:3, dayOfQuarter:5})', {})).toBe('1984-07-05'))
  it('ordinalDay', () => expect(_evaluateExpression('date({year:1984, ordinalDay:100})', {})).toBe('1984-04-09'))
  it('week + dayOfWeek', () => expect(_evaluateExpression('date({year:1984, week:10, dayOfWeek:5})', {})).toBe('1984-03-09'))
  it('date string passthrough', () => expect(_evaluateExpression("date('1984-10-11')", {})).toBe('1984-10-11'))
  it('date string with override', () => expect(_evaluateExpression("date({date:'1984-10-11', year:1985})", {})).toBe('1985-10-11'))
})

describe('date.truncate unit matrix', () => {
  it('millennium', () => expect(_evaluateExpression("date.truncate('millennium', date('1984-10-11'))", {})).toBe('1000-01-01'))
  it('century', () => expect(_evaluateExpression("date.truncate('century', date('1984-10-11'))", {})).toBe('1900-01-01'))
  it('decade', () => expect(_evaluateExpression("date.truncate('decade', date('1984-10-11'))", {})).toBe('1980-01-01'))
  it('year', () => expect(_evaluateExpression("date.truncate('year', date('1984-10-11'))", {})).toBe('1984-01-01'))
  it('quarter', () => expect(_evaluateExpression("date.truncate('quarter', date('1984-10-11'))", {})).toBe('1984-10-01'))
  it('month', () => expect(_evaluateExpression("date.truncate('month', date('1984-10-11'))", {})).toBe('1984-10-01'))
  it('week', () => expect(_evaluateExpression("date.truncate('week', date('1984-10-11'))", {})).toBe('1984-10-08'))
  it('day', () => expect(_evaluateExpression("date.truncate('day', date('1984-10-11'))", {})).toBe('1984-10-11'))
})

describe('datetime.truncate', () => {
  it('hour', () => expect(_evaluateExpression("datetime.truncate('hour', datetime('1984-10-11T12:31:14Z'))", {})).toBe('1984-10-11T12:00Z'))
  it('minute', () => expect(_evaluateExpression("datetime.truncate('minute', datetime('1984-10-11T12:31:14Z'))", {})).toBe('1984-10-11T12:31Z'))
  it('second drops fractional', () => expect(_evaluateExpression("datetime.truncate('second', datetime('1984-10-11T12:31:14.645Z'))", {})).toBe('1984-10-11T12:31:14Z'))
  it('millisecond', () => expect(_evaluateExpression("datetime.truncate('millisecond', datetime('1984-10-11T12:31:14.645876123Z'))", {})).toBe('1984-10-11T12:31:14.645Z'))
  it('microsecond', () => expect(_evaluateExpression("datetime.truncate('microsecond', datetime('1984-10-11T12:31:14.645876123Z'))", {})).toBe('1984-10-11T12:31:14.645876Z'))
  it('nanosecond is unchanged', () => expect(_evaluateExpression("datetime.truncate('nanosecond', datetime('1984-10-11T12:31:14.645876123Z'))", {})).toBe('1984-10-11T12:31:14.645876123Z'))
})

describe('localdatetime.truncate (no tz)', () => {
  it('year keeps no Z', () => expect(_evaluateExpression("localdatetime.truncate('year', localdatetime('1984-10-11T12:31:14'))", {})).toBe('1984-01-01T00:00'))
  it('day', () => expect(_evaluateExpression("localdatetime.truncate('day', localdatetime('1984-10-11T12:31:14'))", {})).toBe('1984-10-11T00:00'))
})
