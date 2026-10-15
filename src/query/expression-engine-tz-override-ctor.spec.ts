import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock timezone-override construction (the `_adjustTz` cross-day path) and the
// date/localtime map-constructor branches. `time`/`datetime` constructors with a
// `timezone` override must shift the clock across midnight correctly for both
// numeric offsets and IANA zone names (DST-aware).

describe('timezone override construction (cross-day)', () => {
  it('time shifts east offset to IANA west zone across midnight', () => {
    expect(_evaluateExpression("time({time: '23:30:00+08:00', timezone: 'America/New_York'})", {}))
      .toBe('10:30-04:00[America/New_York]')
  })

  it('time shifts numeric offset to UTC', () => {
    expect(_evaluateExpression("time({time: '23:30:00+08:00', timezone: 'UTC'})", {}))
      .toBe('15:30+00:00[UTC]')
  })

  it('time shifts UTC to IANA southern-hemisphere DST zone forward', () => {
    expect(_evaluateExpression("time({time: '01:30:00+00:00', timezone: 'Australia/Sydney'})", {}))
      .toBe('12:30+11:00[Australia/Sydney]')
  })

  it('time shifts negative offset to positive offset across midnight', () => {
    expect(_evaluateExpression("time({time: '23:30:00-05:00', timezone: '+02:00'})", {}))
      .toBe('06:30+02:00')
  })

  it('time from Z to IANA west zone', () => {
    expect(_evaluateExpression("time({time: '22:30:00Z', timezone: 'America/New_York'})", {}))
      .toBe('17:30-04:00[America/New_York]')
  })

  it('datetime timezone override keeps date and shifts clock', () => {
    expect(_evaluateExpression("datetime({time: '23:30:00+08:00', timezone: 'America/New_York'})", {}))
      .toBe('2000-01-01T10:30-05:00[America/New_York]')
  })
})

describe('date map-constructor branches', () => {
  it('date from datetime string truncates to date part', () => {
    expect(_evaluateExpression("date('1984-10-11T12:00:00')", {})).toBe('1984-10-11')
  })

  it('date map with date string + ordinal day routes through resolveDateFromMap', () => {
    expect(_evaluateExpression("date({date: '2024-01-01', ordinalDay: 100})", {})).toBe('2024-04-09')
  })

  it('date map with year only defaults month/day to 1', () => {
    expect(_evaluateExpression("date({year: 2024})", {})).toBe('2024-01-01')
  })
})

describe('localtime map-constructor branches', () => {
  it('localtime strips IANA and offset suffix from a time string', () => {
    expect(_evaluateExpression("localtime('12:31:14.645876123+02:00')", {})).toBe('12:31:14.645876123')
  })

  it('localtime with time + override fields applies them', () => {
    expect(_evaluateExpression("localtime({time: '12:31:14.645', second: 42, nanosecond: 123})", {}))
      .toBe('12:31:42.000000123')
  })
})
