/**
 * expression-engine-temporal.spec.ts — Tests for temporal expression functions
 */
import {
  _extractTimeProp, _extractDurationProp, _extractDateProp,
  _formatTimezone, _isoWeekNumber,
} from './expression-engine'

describe('temporal helpers', () => {
  describe('_extractTimeProp', () => {
    it('extracts hour/minute/second', () => {
      expect(_extractTimeProp('14:30:45', 'hour')).toBe(14)
      expect(_extractTimeProp('14:30:45', 'minute')).toBe(30)
      expect(_extractTimeProp('14:30:45', 'second')).toBe(45)
    })
    it('extracts nanosecond from fraction', () => {
      expect(_extractTimeProp('14:30:45.123456789', 'nanosecond')).toBe(123456789)
    })
    it('extracts millisecond and microsecond', () => {
      expect(_extractTimeProp('14:30:45.500', 'millisecond')).toBe(500)
      expect(_extractTimeProp('14:30:45.001002', 'microsecond')).toBe(1002)
    })
    it('handles timezone offset +02:00', () => {
      expect(_extractTimeProp('14:30:45+02:00', 'timezone')).toBe('+02:00')
      expect(_extractTimeProp('14:30:45+02:00', 'offsetMinutes')).toBe(120)
      expect(_extractTimeProp('14:30:45+02:00', 'offsetSeconds')).toBe(7200)
    })
    it('handles Z timezone', () => {
      expect(_extractTimeProp('14:30:45Z', 'timezone')).toBe('+00:00')
    })
    it('handles IANA timezone', () => {
      expect(_extractTimeProp('14:30:45[Europe/Berlin]', 'timezone')).toBe('Europe/Berlin')
    })
    it('returns undefined for invalid format', () => {
      expect(_extractTimeProp('not-a-time', 'hour')).toBeUndefined()
    })
    it('handles time without seconds', () => {
      expect(_extractTimeProp('14:30', 'hour')).toBe(14)
    })
    it('handles plural milliseconds/microseconds/nanoseconds', () => {
      expect(_extractTimeProp('14:30:45.001002003', 'milliseconds')).toBe(1)
      expect(_extractTimeProp('14:30:45.001002003', 'microseconds')).toBe(1002)
    })
  })

  describe('_extractDurationProp', () => {
    it('extracts years', () => {
      expect(_extractDurationProp('P2Y3M', 'years')).toBe(2)
    })
    it('computes months total', () => {
      expect(_extractDurationProp('P2Y3M', 'months')).toBe(27)
    })
    it('extracts days and hours', () => {
      expect(_extractDurationProp('P1DT12H', 'days')).toBe(1)
      expect(_extractDurationProp('PT12H30M', 'hours')).toBe(12)
    })
    it('computes minutes and seconds totals', () => {
      expect(_extractDurationProp('PT1H30M', 'minutes')).toBe(90)
      expect(_extractDurationProp('PT1H1M1S', 'seconds')).toBe(3661)
    })
    it('extracts nanoseconds', () => {
      expect(_extractDurationProp('PT0.000000001S', 'nanoseconds')).toBe(1)
    })
    it('computes weeks from days', () => {
      expect(_extractDurationProp('P14D', 'weeks')).toBe(2)
    })
    it('handles negative duration', () => {
      expect(_extractDurationProp('-P1D', 'days')).toBe(-1)
    })
    it('returns null for invalid format', () => {
      expect(_extractDurationProp('garbage', 'days')).toBeNull()
    })
    it('extracts sub-components', () => {
      expect(_extractDurationProp('P6M', 'quartersOfYear')).toBe(2)
      expect(_extractDurationProp('P18M', 'monthsOfYear')).toBe(6)
      expect(_extractDurationProp('PT2H15M', 'minutesOfHour')).toBe(15)
      expect(_extractDurationProp('PT1.5S', 'millisecondsOfSecond')).toBe(500)
    })
  })

  describe('_extractDateProp', () => {
    it('extracts year/month/day', () => {
      expect(_extractDateProp('2026-05-15', 'year')).toBe(2026)
      expect(_extractDateProp('2026-05-15', 'month')).toBe(5)
      expect(_extractDateProp('2026-05-15', 'day')).toBe(15)
    })
  })

  describe('_formatTimezone', () => {
    it('formats various offsets', () => {
      expect(_formatTimezone('+05:30')).toBe('+05:30')
      expect(_formatTimezone('-08:00')).toBe('-08:00')
      expect(_formatTimezone('+00:00')).toBe('+00:00')
    })
  })

  describe('_isoWeekNumber', () => {
    it('computes valid ISO week', () => {
      const d = new Date(Date.UTC(2026, 0, 1))
      const w = _isoWeekNumber(d)
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThanOrEqual(53)
    })
    it('is deterministic', () => {
      const d = new Date(Date.UTC(2026, 5, 15))
      expect(_isoWeekNumber(d)).toBe(_isoWeekNumber(d))
    })
  })
})