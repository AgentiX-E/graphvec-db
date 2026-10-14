import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock the temporal-map override merging and truncation paths: a `time({time, ...})`
// map with hour/minute/second/nanosecond overrides must merge onto the base time
// component, a timezone override must shift the instant, and the `*.truncate`
// functions must floor to the requested field precision.

describe('temporal map override merging', () => {
  it('merges hour/minute/nanosecond overrides onto a base time', () => {
    expect(_evaluateExpression("time({time: '12:34:56.789', hour: 10, minute: 20, nanosecond: 123456})", {}))
      .toBe('10:20:56.000123456Z')
  })

  it('overrides only the seconds on a base time', () => {
    expect(_evaluateExpression("time({time: '12:34:56.789', second: 11})", {})).toBe('12:34:11.789Z')
  })

  it('overrides hour on a Z-suffixed base time', () => {
    expect(_evaluateExpression("time({time: '23:59:59Z', hour: 0})", {})).toBe('00:59:59Z')
  })

  it('shift the instant when a timezone override differs from the base offset', () => {
    expect(_evaluateExpression("time({time: '23:59:59+02:00', timezone: 'UTC'})", {}))
      .toBe('21:59:59+00:00[UTC]')
  })

  it('builds a datetime from a leap-day map', () => {
    expect(_evaluateExpression('datetime({year: 2024, month: 2, day: 29, hour: 23, minute: 59})', {}))
      .toBe('2024-02-29T23:59Z')
  })

  it('builds a datetime from date and time string parts', () => {
    expect(_evaluateExpression("datetime({date: '2024-01-01', time: '12:00:00Z'})", {}))
      .toBe('2024-01-01T12:00:00Z')
  })
})

describe('temporal truncation', () => {
  it('truncates localtime to the day', () => {
    expect(_evaluateExpression("localtime.truncate('day', datetime('2024-06-15T14:30:00Z'))", {})).toBe('00:00')
  })

  it('truncates a date to the month', () => {
    expect(_evaluateExpression("date.truncate('month', date('2024-06-15'))", {})).toBe('2024-06-01')
  })

  it('truncates a time to the minute', () => {
    expect(_evaluateExpression("time.truncate('minute', time('12:34:56Z'))", {})).toBe('12:34Z')
  })
})

describe('path property accessors', () => {
  it('nodes() extracts the node list from a path object', () => {
    const row = { p: { __path: [{ id: 1 }, { id: 2 }], __pathEdges: [{ _type: 'REL' }] } }
    expect(_evaluateExpression('nodes(p)', row)).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('relationships() extracts the edge list from a path object', () => {
    const row = { p: { __path: [{ id: 1 }, { id: 2 }], __pathEdges: [{ _type: 'REL' }] } }
    expect(_evaluateExpression('relationships(p)', row)).toEqual([{ _type: 'REL' }])
  })
})
