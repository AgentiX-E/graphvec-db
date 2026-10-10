import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Coverage for the truncate cluster: date.truncate / datetime.truncate /
 * localdatetime.truncate / time.truncate / localtime.truncate across all
 * supported units, plus the config-map override path (_applyTruncateConfig).
 */

describe('datetime.truncate — date units', () => {
  it('year', () => expect(_evaluateExpression("datetime.truncate('year', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2023-01-01T00:00Z'))
  it('month', () => expect(_evaluateExpression("datetime.truncate('month', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2023-05-01T00:00Z'))
  it('day', () => expect(_evaluateExpression("datetime.truncate('day', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2023-05-17T00:00Z'))
  it('week (monday)', () => expect(_evaluateExpression("datetime.truncate('week', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2023-05-15T00:00Z'))
  it('quarter', () => expect(_evaluateExpression("datetime.truncate('quarter', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2023-04-01T00:00Z'))
  it('decade', () => expect(_evaluateExpression("datetime.truncate('decade', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2020-01-01T00:00Z'))
  it('century', () => expect(_evaluateExpression("datetime.truncate('century', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2000-01-01T00:00Z'))
  it('millennium', () => expect(_evaluateExpression("datetime.truncate('millennium', datetime('2023-05-17T12:00:00Z'))", {})).toBe('2000-01-01T00:00Z'))
})

describe('datetime.truncate — time units', () => {
  it('hour', () => expect(_evaluateExpression("datetime.truncate('hour', datetime('2023-05-17T12:34:56.789Z'))", {})).toBe('2023-05-17T12:00Z'))
  it('minute', () => expect(_evaluateExpression("datetime.truncate('minute', datetime('2023-05-17T12:34:56.789Z'))", {})).toBe('2023-05-17T12:34Z'))
  it('second', () => expect(_evaluateExpression("datetime.truncate('second', datetime('2023-05-17T12:34:56.789Z'))", {})).toBe('2023-05-17T12:34:56Z'))
  it('millisecond', () => expect(_evaluateExpression("datetime.truncate('millisecond', datetime('2023-05-17T12:34:56.789123Z'))", {})).toBe('2023-05-17T12:34:56.789Z'))
  it('microsecond', () => expect(_evaluateExpression("datetime.truncate('microsecond', datetime('2023-05-17T12:34:56.789123456Z'))", {})).toBe('2023-05-17T12:34:56.789123Z'))
  it('nanosecond', () => expect(_evaluateExpression("datetime.truncate('nanosecond', datetime('2023-05-17T12:34:56.789123456Z'))", {})).toBe('2023-05-17T12:34:56.789123456Z'))
})

describe('date.truncate — date-only', () => {
  it('year', () => expect(_evaluateExpression("date.truncate('year', date('2023-05-17'))", {})).toBe('2023-01-01'))
  it('month', () => expect(_evaluateExpression("date.truncate('month', date('2023-05-17'))", {})).toBe('2023-05-01'))
  it('day', () => expect(_evaluateExpression("date.truncate('day', date('2023-05-17'))", {})).toBe('2023-05-17'))
})

describe('time.truncate — time units', () => {
  it('day -> 00:00', () => expect(_evaluateExpression("time.truncate('day', time('12:34:56.789'))", {})).toBe('00:00Z'))
  it('hour', () => expect(_evaluateExpression("time.truncate('hour', time('12:34:56.789'))", {})).toBe('12:00Z'))
  it('minute', () => expect(_evaluateExpression("time.truncate('minute', time('12:34:56.789'))", {})).toBe('12:34Z'))
  it('second', () => expect(_evaluateExpression("time.truncate('second', time('12:34:56.789'))", {})).toBe('12:34:56Z'))
  it('millisecond', () => expect(_evaluateExpression("time.truncate('millisecond', time('12:34:56.789'))", {})).toBe('12:34:56.789Z'))
  it('microsecond', () => expect(_evaluateExpression("time.truncate('microsecond', time('12:34:56.789'))", {})).toBe('12:34:56.789Z'))
  it('nanosecond keeps input precision', () => expect(_evaluateExpression("time.truncate('nanosecond', time('12:34:56.789'))", {})).toBe('12:34:56.789Z'))
})

describe('truncate + config map overrides (_applyTruncateConfig)', () => {
  it('date.truncate with day override', () => expect(_evaluateExpression("date.truncate('month', date('2023-05-17'), {day: 15})", {})).toBe('2023-05-15'))
  it('datetime.truncate with hour override', () => expect(_evaluateExpression("datetime.truncate('day', datetime('2023-05-17T12:34:56Z'), {hour: 8})", {})).toBe('2023-05-17T08:00:00Z'))
  it('datetime.truncate with millisecond override', () => expect(_evaluateExpression("datetime.truncate('day', datetime('2023-05-17T12:34:56Z'), {millisecond: 500})", {})).toBe('2023-05-17T00:00:00.5Z'))
  it('time.truncate with minute override', () => expect(_evaluateExpression("time.truncate('hour', time('12:34:56.789'), {minute: 30})", {})).toBe('12:30:00Z'))
  it('datetime.truncate with named timezone override', () => expect(_evaluateExpression("datetime.truncate('day', datetime('2023-05-17T12:34:56Z'), {timezone: 'America/New_York'})", {})).toBe('2023-05-17T00:00-04:00[America/New_York]'))
  it('time.truncate with timezone override on pure time', () => expect(_evaluateExpression("time.truncate('hour', time('12:34:56+01:00'), {timezone: 'America/New_York'})", {})).toBe('12:00-04:00[America/New_York]'))
})

describe('truncate — unknown unit returns original value', () => {
  it('datetime.truncate bogus unit passthrough', () => expect(_evaluateExpression("datetime.truncate('frobnicate', datetime('2023-05-17T12:34:56Z'))", {})).toBe('2023-05-17T12:34:56Z'))
})
