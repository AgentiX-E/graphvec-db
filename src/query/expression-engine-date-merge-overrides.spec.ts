import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock the `_mergeDateStr` override branches reachable when a `date` (or
// datetime) is constructed from an explicit date STRING plus week/dayOfWeek/
// quarter/dayOfQuarter/ordinalDay overrides. These route through the string
// merge path (as opposed to `date({year, month, ...})` which uses
// `_resolveDateFromMap`), and must compute ISO week / day-of-week / quarter /
// ordinal-day offsets correctly.

describe('date string override merge', () => {
  it('moves dayOfWeek within the current week', () => {
    // 2024-01-01 is Monday (dayOfWeek 1); dayOfWeek 3 is Wednesday.
    expect(_evaluateExpression("date({date: '2024-01-01', dayOfWeek: 3})", {})).toBe('2024-01-03')
  })

  it('computes an ISO week + dayOfWeek combination', () => {
    // ISO week 5 of 2024 starts Monday 2024-01-29; dayOfWeek 3 -> 2024-01-31.
    expect(_evaluateExpression("date({date: '2024-01-01', week: 5, dayOfWeek: 3})", {})).toBe('2024-01-31')
  })

  it('computes a quarter start', () => {
    expect(_evaluateExpression("date({date: '2024-01-01', quarter: 2})", {})).toBe('2024-04-01')
  })

  it('computes a quarter + dayOfQuarter', () => {
    expect(_evaluateExpression("date({date: '2024-01-01', quarter: 2, dayOfQuarter: 10})", {})).toBe('2024-04-10')
  })

  it('computes an ordinal day', () => {
    expect(_evaluateExpression("date({date: '2024-01-01', ordinalDay: 100})", {})).toBe('2024-04-09')
  })
})
