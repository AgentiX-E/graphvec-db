import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Coverage for duration arithmetic (`+`, `-`, `*`, `/`) and date/time +
 * duration arithmetic — the paths that exercise the otherwise-uncovered
 * _formatDuration (component normalization / borrow / fractional seconds)
 * and _mergeDateStr (map overrides / calendar overflow) helpers.
 */

describe('duration + duration (add)', () => {
  it('calendar days', () => {
    expect(_evaluateExpression("duration('P1D') + duration('P2D')", {})).toBe('P3D')
  })
  it('calendar + time', () => {
    expect(_evaluateExpression("duration('P1DT2H') + duration('PT30M')", {})).toBe('P1DT2H30M')
  })
  it('minutes overflow to hours', () => {
    expect(_evaluateExpression("duration('PT30M') + duration('PT45M')", {})).toBe('PT1H15M')
  })
  it('seconds overflow to minutes', () => {
    expect(_evaluateExpression("duration('PT90S') + duration('PT90S')", {})).toBe('PT3M')
  })
  it('year + month accumulate', () => {
    expect(_evaluateExpression("duration('P1Y') + duration('P6M')", {})).toBe('P1Y6M')
  })
})

describe('duration - duration (subtract)', () => {
  it('day minus hours borrows correctly', () => {
    expect(_evaluateExpression("duration('P1D') - duration('PT12H')", {})).toBe('PT12H')
  })
  it('day+12h minus 12h', () => {
    expect(_evaluateExpression("duration('P1DT12H') - duration('PT12H')", {})).toBe('P1D')
  })
  it('smaller minus larger yields negative', () => {
    expect(_evaluateExpression("duration('PT2H') - duration('PT3H')", {})).toBe('PT-1H')
  })
  it('hours minus a day yields negative', () => {
    expect(_evaluateExpression("duration('PT12H') - duration('P1D')", {})).toBe('PT-12H')
  })
})

describe('duration * number (scale)', () => {
  it('integer scale', () => {
    expect(_evaluateExpression("duration('P2D') * 3", {})).toBe('P6D')
  })
  it('negative scale', () => {
    expect(_evaluateExpression("duration('P1D') * -1", {})).toBe('P-1D')
  })
  it('fractional scale', () => {
    expect(_evaluateExpression("duration('P1D') * 0.5", {})).toBe('PT12H')
  })
})

describe('duration / number (scale inverse)', () => {
  it('divide by 2', () => {
    expect(_evaluateExpression("duration('PT30M') / 2", {})).toBe('PT15M')
  })
  it('divide by 0.5 doubles', () => {
    expect(_evaluateExpression("duration('PT30M') / 0.5", {})).toBe('PT1H')
  })
})

describe('date constructor map merge + overflow', () => {
  it('plain map', () => {
    expect(_evaluateExpression('date({year:2020, month:1, day:15})', {})).toBe('2020-01-15')
  })
  it('Feb 31 overflows to March', () => {
    expect(_evaluateExpression('date({year:2020, month:2, day:31})', {})).toBe('2020-03-02')
  })
  it('leap year Feb 29 valid', () => {
    expect(_evaluateExpression('date({year:2024, month:2, day:29})', {})).toBe('2024-02-29')
  })
})

describe('date + duration arithmetic', () => {
  it('add one day', () => {
    expect(_evaluateExpression("date('2020-01-15') + duration('P1D')", {})).toBe('2020-01-16')
  })
  it('subtract one month', () => {
    expect(_evaluateExpression("date('2020-01-15') - duration('P1M')", {})).toBe('2019-12-15')
  })
  it('Jan 31 + 1 month clamps to March', () => {
    expect(_evaluateExpression("date('2020-01-31') + duration('P1M')", {})).toBe('2020-03-02')
  })
})

describe('datetime map constructor', () => {
  it('full map with time', () => {
    expect(_evaluateExpression('datetime({year:2020, month:1, day:1, hour:12, minute:30, second:45})', {})).toBe('2020-01-01T12:30:45Z')
  })
})

describe('time arithmetic', () => {
  it('localtime + duration', () => {
    expect(_evaluateExpression("localtime('12:00:00') + duration('PT1H30M')", {})).toBe('13:30:00')
  })
  it('time with offset - duration', () => {
    expect(_evaluateExpression("time('12:00:00+01:00') - duration('PT30M')", {})).toBe('11:30:00+01:00')
  })
})
