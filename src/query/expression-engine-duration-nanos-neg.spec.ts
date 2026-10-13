import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock `duration(map)` negative-nanosecond normalization (`_normalizeDuration*`).
// Negative nanoseconds ≤ -1e9 must be carried into seconds via Math.ceil, not
// left as a raw value that mis-formats as a 10x-too-small fraction (BUG-13:
// `-1000000000ns` previously rendered `PT-0.1S` instead of `PT-1S`).

function d(map: string): string {
  return _evaluateExpression(`duration(${map})`, {}) as string
}

describe('duration(map) negative nanosecond normalization', () => {
  it('carries -1e9 nanoseconds into -1 second', () => {
    expect(d('{nanoseconds: -1000000000}')).toBe('PT-1S')
  })

  it('carries -1.5e9 nanoseconds into -1.5 seconds', () => {
    expect(d('{nanoseconds: -1500000000}')).toBe('PT-1.5S')
  })

  it('carries -2.5e9 nanoseconds into -2.5 seconds', () => {
    expect(d('{nanoseconds: -2500000000}')).toBe('PT-2.5S')
  })

  it('adds a whole negative second onto an explicit negative seconds component', () => {
    expect(d('{seconds: -2, nanoseconds: -1000000000}')).toBe('PT-3S')
  })

  it('preserves sub-second negative nanoseconds as -0.x', () => {
    expect(d('{nanoseconds: -500000000}')).toBe('PT-0.5S')
  })

  it('does not disturb positive nanosecond normalization', () => {
    expect(d('{nanoseconds: 1000000000}')).toBe('PT1S')
    expect(d('{nanoseconds: 1500000000}')).toBe('PT1.5S')
    expect(d('{nanoseconds: 2500000000}')).toBe('PT2.5S')
  })

  it('normalizes negative seconds and minutes with correct per-component signs', () => {
    expect(d('{seconds: -120}')).toBe('PT-2M')
    expect(d('{seconds: -90}')).toBe('PT-1M-30S')
    expect(d('{minutes: -90, seconds: 30}')).toBe('PT-1H-30M30S')
    expect(d('{hours: -30}')).toBe('P-1DT-6H')
  })
})
