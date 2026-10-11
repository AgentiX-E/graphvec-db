import { describe, it, expect } from 'vitest'
import { _evaluateExpression, _extractDateProp, _extractTimeProp, _extractDurationProp } from './expression-engine'

/** Coverage for _evalAtom's property-access tail and the temporal accessor
 *  helpers it delegates to (_extractDateProp / _extractTimeProp /
 *  _extractDurationProp). These are the date.year / time.hour / datetime.epoch
 *  / duration.days style accesses reachable through the `.<prop>` path. */

describe('date accessors (_extractDateProp)', () => {
  it('basic calendar fields', () => {
    expect(_extractDateProp('2020-06-15', 'year')).toBe(2020)
    expect(_extractDateProp('2020-06-15', 'month')).toBe(6)
    expect(_extractDateProp('2020-06-15', 'day')).toBe(15)
  })
  it('quarter and dayOfQuarter', () => {
    expect(_extractDateProp('2020-06-15', 'quarter')).toBe(2)
    // Q2 spans Apr 1 .. Jun 30; Jun 15 is the 76th day of the quarter
    expect(_extractDateProp('2020-06-15', 'dayOfQuarter')).toBe(76)
  })
  it('ordinalDay and weekDay', () => {
    // 2020-01-01 is a Wednesday (ISO weekDay 3)
    expect(_extractDateProp('2020-01-01', 'ordinalDay')).toBe(1)
    expect(_extractDateProp('2020-01-01', 'weekDay')).toBe(3)
  })
  it('week and weekYear within year', () => {
    expect(_extractDateProp('2020-06-15', 'week')).toBeGreaterThanOrEqual(24)
    expect(_extractDateProp('2020-06-15', 'weekYear')).toBe(2020)
  })
  it('week year boundary: a date near Jan 1 rolling into prev-weekYear', () => {
    // 2021-01-01 is a Friday; ISO week of 2021-01-01 belongs to 2020's final week
    expect(_extractDateProp('2021-01-01', 'weekYear')).toBe(2020)
  })
  it('datetime string truncates to date part', () => {
    expect(_extractDateProp('2020-06-15T12:00:00Z', 'month')).toBe(6)
  })
  it('unknown prop returns undefined', () => {
    expect(_extractDateProp('2020-06-15', 'nope')).toBeUndefined()
  })
  it('non-date string returns undefined', () => {
    expect(_extractDateProp('hello', 'year')).toBeUndefined()
  })
})

describe('time accessors (_extractTimeProp)', () => {
  it('basic fields', () => {
    expect(_extractTimeProp('12:34:56.789', 'hour')).toBe(12)
    expect(_extractTimeProp('12:34:56.789', 'minute')).toBe(34)
    expect(_extractTimeProp('12:34:56.789', 'second')).toBe(56)
    expect(_extractTimeProp('12:34:56.789', 'nanosecond')).toBe(789000000)
  })
  it('sub-second decomposition', () => {
    expect(_extractTimeProp('12:34:56.789', 'millisecond')).toBe(789)
    expect(_extractTimeProp('12:34:56.789', 'microsecond')).toBe(789000)
  })
  it('offset fields', () => {
    expect(_extractTimeProp('12:34:56+05:30', 'offset')).toBe('+05:30')
    expect(_extractTimeProp('12:34:56+05:30', 'offsetMinutes')).toBe(330)
    expect(_extractTimeProp('12:34:56+05:30', 'offsetSeconds')).toBe(19800)
  })
  it('Z timezone', () => {
    expect(_extractTimeProp('12:34:56Z', 'timezone')).toBe('+00:00')
    expect(_extractTimeProp('12:34:56Z', 'offset')).toBe('+00:00')
  })
  it('IANA named timezone', () => {
    expect(_extractTimeProp('12:34:56+01:00[Europe/Stockholm]', 'timezone')).toBe('Europe/Stockholm')
  })
  it('no timezone returns null for offset', () => {
    expect(_extractTimeProp('12:34:56', 'offset')).toBeNull()
    expect(_extractTimeProp('12:34:56', 'timezone')).toBeNull()
  })
  it('unknown prop returns undefined', () => {
    expect(_extractTimeProp('12:34:56', 'nope')).toBeUndefined()
  })
})

describe('duration accessors (_extractDurationProp)', () => {
  it('calendar component fields', () => {
    expect(_extractDurationProp('P1Y2M', 'years')).toBe(1)
    expect(_extractDurationProp('P1Y2M', 'months')).toBe(14) // cumulative
  })
  it('day-time component fields', () => {
    expect(_extractDurationProp('P1DT2H', 'days')).toBe(1)
    expect(_extractDurationProp('P1DT2H', 'hours')).toBe(2)
  })
  it('cumulative minutes/seconds', () => {
    expect(_extractDurationProp('PT1H30M', 'minutes')).toBe(90)
    expect(_extractDurationProp('PT2H', 'seconds')).toBe(7200)
  })
  it('sub-second fields with nanos', () => {
    expect(_extractDurationProp('PT0.5S', 'nanoseconds')).toBe(500000000)
    expect(_extractDurationProp('PT0.5S', 'milliseconds')).toBe(500)
    expect(_extractDurationProp('PT0.5S', 'nanosecondsOfSecond')).toBe(500000000)
  })
  it('quarters/months-of helpers', () => {
    expect(_extractDurationProp('P14M', 'quarters')).toBe(4)
    expect(_extractDurationProp('P14M', 'monthsOfYear')).toBe(2)
  })
  it('negative duration sign propagates', () => {
    expect(_extractDurationProp('P-2D', 'days')).toBe(-2)
  })
  it('invalid string returns null', () => {
    expect(_extractDurationProp('not-a-duration', 'days')).toBeNull()
  })
})

describe('_evalAtom property access', () => {
  it('map property', () => {
    expect(_evaluateExpression('m.name', { m: { name: 'Alice' } })).toBe('Alice')
  })
  it('chained property path a.b.c', () => {
    expect(_evaluateExpression('a.b.c', { a: { b: { c: 42 } } })).toBe(42)
  })
  it('chained path short-circuits on missing mid-segment', () => {
    expect(_evaluateExpression('a.x.c', { a: { b: { c: 42 } } })).toBeNull()
  })
  it('backtick property name', () => {
    expect(_evaluateExpression('m.`weird name`', { m: { 'weird name': 7 } })).toBe(7)
  })
  it('null.prop returns null', () => {
    expect(_evaluateExpression('n.name', {})).toBeNull()
  })
  it('date string .year via _evalAtom', () => {
    expect(_evaluateExpression("date('2020-06-15').year", {})).toBe(2020)
  })
  it('datetime string .epochSeconds', () => {
    expect(_evaluateExpression("datetime('1970-01-01T00:00:01Z').epochSeconds", {})).toBe(1)
  })
  it('duration string .days via _evalAtom', () => {
    expect(_evaluateExpression("duration('P1DT2H').days", {})).toBe(1)
  })
  it('non-map scalar property access throws TypeError', () => {
    expect(() => _evaluateExpression('x.name', { x: 42 })).toThrow(/non-map/)
  })
})
