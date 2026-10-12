import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Regression coverage for the duration() constructor and duration.inSeconds on
 * signed (leading `-` or per-component `-`) and fractional-second inputs.
 *
 * These lock in two real bugs:
 *   1. duration('-PT30S') used to return "PT0S" (the leading sign was moved
 *      onto `P`, producing the malformed `P-T30S` that _parseDuration rejects;
 *      a pure-time duration has no calendar slot to carry the sign).
 *   2. duration.inSeconds on a negative duration used to drop the sign and the
 *      fractional second (absNsBig was negated, and the fractional nanosecond
 *      part ignored once it went negative).
 */

describe('duration() constructor — leading sign normalization', () => {
  it('negative pure-time duration keeps the sign on the first time component', () => {
    expect(_evaluateExpression("duration('-PT30S')", {})).toBe('PT-30S')
  })
  it('negative pure-time duration with H and S', () => {
    expect(_evaluateExpression("duration('-PT1H30S')", {})).toBe('PT-1H30S')
  })
  it('negative calendar duration', () => {
    expect(_evaluateExpression("duration('-P2D')", {})).toBe('P-2D')
  })
  it('negative calendar + time duration', () => {
    expect(_evaluateExpression("duration('-P1DT2H')", {})).toBe('P-1DT2H')
  })
  it('negative calendar with year+month', () => {
    expect(_evaluateExpression("duration('-P1Y2M')", {})).toBe('P-1Y2M')
  })
  it('positive duration unchanged', () => {
    expect(_evaluateExpression("duration('PT30S')", {})).toBe('PT30S')
  })
  it('already per-component negative unchanged', () => {
    expect(_evaluateExpression("duration('P-2D')", {})).toBe('P-2D')
  })
})

describe('duration.inSeconds single-arg sign handling', () => {
  it('negative whole-second duration', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-PT30S'))", {})).toBe('PT-30S')
  })
  it('negative H+S duration split across components', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-PT1H30S'))", {})).toBe('PT-1H-30S')
  })
  it('negative calendar duration normalizes to total seconds', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-P2D'))", {})).toBe('PT-48H')
  })
  it('negative calendar+time duration', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-P1DT2H'))", {})).toBe('PT-26H')
  })
  it('positive duration with fractional seconds', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('PT45.5S'))", {})).toBe('PT45.5S')
  })
  it('negative duration keeps fractional seconds', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-PT45.5S'))", {})).toBe('PT-45.5S')
  })
  it('negative H+S with fractional seconds', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('-PT1H30.5S'))", {})).toBe('PT-1H-30.5S')
  })
  it('complex calendar+time duration', () => {
    expect(_evaluateExpression("duration.inSeconds(duration('P1Y2M3DT4H5M6.7S'))", {})).toBe('PT10302H5M6.7S')
  })
})

describe('duration.inSeconds two-arg (between) diff', () => {
  it('equal values yield PT0S', () => {
    expect(_evaluateExpression("duration.inSeconds(date('2020-01-01'), date('2020-01-01'))", {})).toBe('PT0S')
  })
  it('one-day forward date diff', () => {
    expect(_evaluateExpression("duration.inSeconds(date('2020-01-01'), date('2020-01-02'))", {})).toBe('PT24H')
  })
  it('one-day backward date diff', () => {
    expect(_evaluateExpression("duration.inSeconds(date('2020-01-02'), date('2020-01-01'))", {})).toBe('PT-24H')
  })
  it('datetime diff with minutes', () => {
    expect(_evaluateExpression("duration.inSeconds(datetime('2020-01-01T00:00:00Z'), datetime('2020-01-01T01:30:00Z'))", {})).toBe('PT1H30M')
  })
  it('time diff', () => {
    expect(_evaluateExpression("duration.inSeconds(localtime('20:40:32'), localtime('21:40:32'))", {})).toBe('PT1H')
  })
  it('date + time combo', () => {
    expect(_evaluateExpression("duration.inSeconds(date('2020-01-01'), localtime('12:30:00'))", {})).toBe('PT12H30M')
  })
  it('IANA daylight-saving diff accounts for the skipped hour', () => {
    expect(_evaluateExpression("duration.inSeconds(datetime('2020-03-29T00:00:00[Europe/Stockholm]'), datetime('2020-03-29T12:00:00[Europe/Stockholm]'))", {})).toBe('PT11H')
  })
  it('large-year date diff', () => {
    expect(_evaluateExpression("duration.inSeconds(date('+12020-01-01'), date('+12020-01-02'))", {})).toBe('PT24H')
  })
})
