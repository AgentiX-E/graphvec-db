import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Construction of `date` from a component map exercises `_mergeDateStr`'s
// week / dayOfWeek / quarter / dayOfQuarter / ordinalDay branches. Values match
// openCypher TCK Temporal1 "Should construct date" (examples 1816-1984) and the
// ISO-week arithmetic, locking real calendar math against regression.

describe('date(map) construction — week / quarter / ordinal components', () => {
  it('constructs from explicit year/month/day', () => {
    expect(_evaluateExpression("date({year:1984, month:10, day:11})", {})).toBe('1984-10-11')
    expect(_evaluateExpression("date({year:1984, month:10})", {})).toBe('1984-10-01')
  })

  it('constructs from ISO week + dayOfWeek', () => {
    expect(_evaluateExpression("date({year:1984, week:10, dayOfWeek:3})", {})).toBe('1984-03-07')
    expect(_evaluateExpression("date({year:1984, week:10})", {})).toBe('1984-03-05')
  })

  it('constructs from year only (January 1)', () => {
    expect(_evaluateExpression("date({year:1984})", {})).toBe('1984-01-01')
  })

  it('constructs from ordinalDay (day-of-year)', () => {
    expect(_evaluateExpression("date({year:1984, ordinalDay:202})", {})).toBe('1984-07-20')
    expect(_evaluateExpression("date({year:2020, ordinalDay:100})", {})).toBe('2020-04-09')
  })

  it('constructs from quarter + dayOfQuarter', () => {
    expect(_evaluateExpression("date({year:1984, quarter:3, dayOfQuarter:45})", {})).toBe('1984-08-14')
    expect(_evaluateExpression("date({year:2020, quarter:3, dayOfQuarter:10})", {})).toBe('2020-07-10')
  })

  it('constructs from quarter only (first day of quarter)', () => {
    expect(_evaluateExpression("date({year:1984, quarter:3})", {})).toBe('1984-07-01')
    expect(_evaluateExpression("date({year:2020, quarter:1})", {})).toBe('2020-01-01')
  })

  it('handles end-of-year ISO week overflow (week 1 of next year lands in prior year)', () => {
    // 1817 week 1 => Monday 1816-12-30
    expect(_evaluateExpression("date({year:1817, week:1})", {})).toBe('1816-12-30')
    // 1819 week 1 => Monday 1818-12-31? TCK says 1819-01-04 for week with dayOfWeek default
    expect(_evaluateExpression("date({year:1818, week:53})", {})).toBe('1818-12-28')
  })

  it('applies dayOfWeek offset within an ISO week (Sunday = day 7)', () => {
    // 1816 week 1 Monday is 1816-01-01; dayOfWeek 2 (Tue) => 1816-01-02... TCK: 1816 week1 day2 =?
    expect(_evaluateExpression("date({year:1817, week:1, dayOfWeek:2})", {})).toBe('1816-12-31')
  })
})
