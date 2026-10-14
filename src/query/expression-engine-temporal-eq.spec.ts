import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock offset-bearing temporal equality/semantics (BUG-14). `datetime`/`time`
// values with different offset suffixes but the same UTC instant must compare
// equal, and `=`, `<>`, `<`, `>`, `<=`, `>=` must agree with one another. Before
// the fix, `=` compared the raw offset strings, so `10:00:00+08:00` and
// `02:00:00Z` compared unequal even though both denote 02:00 UTC.

function ev(s: string): unknown {
  return _evaluateExpression(s, {})
}

describe('offset-bearing datetime equality normalizes to the same UTC instant', () => {
  it('equates two datetimes with different offsets but the same instant', () => {
    expect(ev("datetime('2024-01-01T10:00:00+08:00') = datetime('2024-01-01T02:00:00Z')")).toBe(true)
  })

  it('negates equality for the same pair via <>', () => {
    expect(ev("datetime('2024-01-01T10:00:00+08:00') <> datetime('2024-01-01T02:00:00Z')")).toBe(false)
  })

  it('distinguishes datetimes with the same local wall-clock but different offsets', () => {
    expect(ev("datetime('2024-01-01T10:00:00+08:00') = datetime('2024-01-01T10:00:00Z')")).toBe(false)
    expect(ev("datetime('2024-01-01T10:00:00+08:00') < datetime('2024-01-01T10:00:00Z')")).toBe(true)
  })

  it('equates offset time with its UTC equivalent', () => {
    expect(ev("time('10:35-08:00') = time('18:35:00Z')")).toBe(true)
    expect(ev("time('10:35-08:00') <> time('18:35:00Z')")).toBe(false)
  })

  it('preserves nanosecond precision across a non-zero offset', () => {
    expect(ev("datetime('2024-01-01T10:00:00.123-03:30') = datetime('2024-01-01T13:30:00.123Z')")).toBe(true)
    expect(ev("datetime('2024-01-01T10:00:00.123-03:30') = datetime('2024-01-01T13:30:00.124Z')")).toBe(false)
  })

  it('orders a negative-offset datetime before a later UTC instant', () => {
    expect(ev("datetime('2024-01-01T00:00:00-08:00') < datetime('2024-01-01T09:00:00Z')")).toBe(true)
    expect(ev("datetime('2024-01-01T00:00:00-08:00') >= datetime('2024-01-01T09:00:00Z')")).toBe(false)
  })
})
