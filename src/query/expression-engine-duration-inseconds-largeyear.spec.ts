import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// `duration.inSeconds` on years beyond the JS Date range (6+ digit years)
// routes through a BigInt decomposition (mean Gregorian year = 31556952 s).
// This path was previously untested; lock its behaviour. Large-year spans use
// the mean year length by design (exact leap-year counting across arbitrary
// 6+ digit years is out of scope), so the structural invariants — hours-only
// output for whole-day spans, exact sub-year deltas, and negation symmetry —
// are asserted explicitly.

function inSeconds(a: string, b: string): string {
  return _evaluateExpression(`duration.inSeconds(${a}, ${b})`, {}) as string
}

describe('duration.inSeconds — large-year BigInt path', () => {
  it('produces an hours-only result for a huge positive span', () => {
    // -999999999-01-01 .. +999999999-12-31 (whole-day span, no time-of-day)
    expect(inSeconds("date('-999999999-01-01')", "date('+999999999-12-31')"))
      .toBe('PT17531639991192H')
  })

  it('negates a huge span with a single leading sign', () => {
    expect(inSeconds("date('+999999999-12-31')", "date('-999999999-01-01')"))
      .toBe('PT-17531639991192H')
  })

  it('resolves a sub-year large-year span exactly to one day', () => {
    // +1000000-01-01 .. +1000000-01-02 is exactly one day regardless of the
    // mean-year coefficient, because the decomposition works on the day delta.
    expect(inSeconds("date('+1000000-01-01')", "date('+1000000-01-02')")).toBe('PT24H')
  })

  it('resolves a sub-day large-year span with an hour delta', () => {
    expect(inSeconds("datetime('+1000000-01-01T00:00:00')", "datetime('+1000000-01-01T01:00:00')"))
      .toBe('PT1H')
  })

  it('returns zero for equal large-year instants', () => {
    expect(inSeconds("date('+1234567-01-01')", "date('+1234567-01-01')")).toBe('PT0S')
  })

  it('negation symmetry holds for a large-year span with time components', () => {
    const a = "datetime('+1000001-01-01T01:02:03.5')"
    const b = "datetime('+1000000-01-01T00:00:00')"
    const fwd = inSeconds(a, b) // b - a  (negative)
    const rev = inSeconds(b, a) // a - b  (positive)
    // The positive and negative decompositions must be exact mirrors.
    expect(fwd).toBe('PT-8761H-2M-3.5S')
    expect(rev).toBe('PT8761H2M3.5S')
  })

  it('negation symmetry holds for a sub-second large-year span', () => {
    const a = "datetime('+1000000-01-01T00:00:01.5')"
    const b = "datetime('+1000000-01-01T00:00:00')"
    expect(inSeconds(a, b)).toBe('PT-1.5S')
    expect(inSeconds(b, a)).toBe('PT1.5S')
  })
})
