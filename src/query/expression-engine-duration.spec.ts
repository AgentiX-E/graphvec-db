import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Coverage for the duration-between / duration.inDays / inMonths / inSeconds
 * family.  These are well-defined temporals with clear Cypher semantics; the
 * cases below target the cross-type (date/time/datetime), sign, and IANA/DST
 * branches that the broader TCK suite does not already exercise through the
 * pure-expression path.
 */

describe('duration.between', () => {
  it('two dates', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), date('2020-01-11'))", {})).toBe('P10D')
  })
  it('date vs datetime', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), datetime('2020-01-02T00:00:00Z'))", {})).toBe('P1D')
  })
  it('reverse order gives negative duration', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-11'), date('2020-01-01'))", {})).toBe('P-10D')
  })
  it('cross-type: date vs pure time', () => {
    const v = _evaluateExpression("duration.between(date('2020-01-01'), time('12:00:00'))", {})
    expect(typeof v).toBe('string')
    expect((v as string).startsWith('PT')).toBe(true)
  })
  it('two pure times (epoch baseline)', () => {
    expect(_evaluateExpression("duration.between(time('10:00:00'), time('12:00:00'))", {})).toBe('PT2H')
  })
  it('same instant -> PT0S', () => {
    expect(_evaluateExpression("duration.between(date('2020-01-01'), date('2020-01-01'))", {})).toBe('PT0S')
  })
})

describe('duration.inDays', () => {
  it('two-arg date difference in days', () => {
    expect(_evaluateExpression("duration.inDays(date('2020-01-01'), date('2020-01-11'))", {})).toBe('P10D')
  })
  it('two-arg pure-time short-circuits to PT0S', () => {
    expect(_evaluateExpression("duration.inDays(time('10:00:00'), time('12:00:00'))", {})).toBe('PT0S')
  })
  it('single-arg extracts days as a number', () => {
    expect(_evaluateExpression("duration.inDays(duration('P2DT12H'))", {})).toBe(2.5)
  })
  it('single-arg negative duration', () => {
    expect(_evaluateExpression("duration.inDays(duration('P-2D'))", {})).toBe(-2)
  })
})

describe('duration.inMonths', () => {
  it('two-arg delegates to between and extracts months', () => {
    expect(_evaluateExpression("duration.inMonths(date('2020-01-01'), date('2020-04-01'))", {})).toBe('P3M')
  })
  it('single-arg extracts months as a number', () => {
    expect(_evaluateExpression("duration.inMonths(duration('P1Y2M'))", {})).toBe(14)
  })
  it('negative single-arg', () => {
    expect(_evaluateExpression("duration.inMonths(duration('P-1Y'))", {})).toBe(-12)
  })
})

describe('duration.inSeconds', () => {
  it('two-arg with both timezones', () => {
    expect(_evaluateExpression("duration.inSeconds(datetime('2020-01-01T00:00:00Z'), datetime('2020-01-01T00:01:00Z'))", {})).toBe('PT1M')
  })
  it('single-arg normalizes a duration string', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('PT1M30S'))", {})).toBe('PT1M30S')
  })
  it('two-arg same value -> PT0S', () => {
    expect(_evaluateExpression("duration.inSeconds(date('2020-01-01'), date('2020-01-01'))", {})).toBe('PT0S')
  })
})
