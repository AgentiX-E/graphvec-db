import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/** Coverage for duration() construction / normalization and duration
 *  arithmetic, targeting the reachable _formatDuration branches (component
 *  carry, negative-day preservation, fractional days). Complements the
 *  duration.between / inDays / inMonths / inSeconds coverage in
 *  expression-engine-duration.spec.ts. */

describe('duration() string construction & normalization', () => {
  it('basic full', () => {
    expect(_evaluateExpression("duration('P1Y2M3DT4H5M6.5S')", {})).toBe('P1Y2M3DT4H5M6.5S')
  })
  it('weeks to days', () => {
    expect(_evaluateExpression("duration('P1W')", {})).toBe('P7D')
  })
  it('hour overflow to day', () => {
    expect(_evaluateExpression("duration('PT25H')", {})).toBe('P1DT1H')
  })
  it('exact 24h to 1 day', () => {
    expect(_evaluateExpression("duration('PT24H')", {})).toBe('P1D')
  })
  it('minute overflow to hour', () => {
    expect(_evaluateExpression("duration('PT90M')", {})).toBe('PT1H30M')
  })
  it('second overflow to minute', () => {
    expect(_evaluateExpression("duration('PT90S')", {})).toBe('PT1M30S')
  })
  it('fractional day to hours', () => {
    expect(_evaluateExpression("duration('P1.5D')", {})).toBe('P1DT12H')
  })
  it('negative day preserved', () => {
    expect(_evaluateExpression("duration('-P2D')", {})).toBe('P-2D')
  })
  it('week in day arithmetic', () => {
    expect(_evaluateExpression("duration('P2W')", {})).toBe('P14D')
  })
})

describe('duration() map construction', () => {
  it('year/month/day/hours', () => {
    expect(_evaluateExpression('duration({years:1, months:2, days:3, hours:4})', {})).toBe('P1Y2M3DT4H')
  })
  it('weeks converted', () => {
    expect(_evaluateExpression('duration({weeks:2})', {})).toBe('P14D')
  })
})

describe('duration arithmetic', () => {
  it('add', () => {
    expect(_evaluateExpression("duration('P1D') + duration('PT12H')", {})).toBe('P1DT12H')
  })
  it('subtract', () => {
    expect(_evaluateExpression("duration('P2D') - duration('P1D')", {})).toBe('P1D')
  })
  it('multiply', () => {
    expect(_evaluateExpression("duration('PT2H') * 3", {})).toBe('PT6H')
  })
  it('divide', () => {
    expect(_evaluateExpression("duration('PT6H') / 2", {})).toBe('PT3H')
  })
})
