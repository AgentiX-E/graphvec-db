import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Duration subtraction can yield a negative or mixed-sign result. This file
// locks the canonical per-component-sign normalization (ISO 8601 `P-1Y-8M`
// style: every non-zero component carries the same leading sign) that was
// previously broken — e.g. `PT30S - PT1M` wrongly produced `PT-1M30S`
// (a mixed-sign `-1 minute + 30 seconds`) instead of `PT-30S`.

function sub(a: string, b: string): string {
  return _evaluateExpression(`duration('${a}') - duration('${b}')`, {}) as string
}

describe('duration subtraction — negative result normalization', () => {
  it('collapses a sub-minute negative into a single negative seconds component', () => {
    expect(sub('PT30S', 'PT1M')).toBe('PT-30S')
    expect(sub('PT1M', 'PT1M30S')).toBe('PT-30S')
    expect(sub('PT1M30S', 'PT2M')).toBe('PT-30S')
    expect(sub('PT45S', 'PT1M')).toBe('PT-15S')
    expect(sub('PT1M45S', 'PT2M')).toBe('PT-15S')
  })

  it('normalizes negative fractional seconds without integer borrow', () => {
    expect(sub('PT1S', 'PT1.5S')).toBe('PT-0.5S')
    expect(sub('PT1.5S', 'PT2S')).toBe('PT-0.5S')
    expect(sub('PT0.5S', 'PT1S')).toBe('PT-0.5S')
  })

  it('normalizes negative minutes-and-seconds into per-component signs', () => {
    expect(sub('PT30S', 'PT2M')).toBe('PT-1M-30S')
  })

  it('normalizes negative minutes into per-component signs', () => {
    expect(sub('PT30M', 'PT2H')).toBe('PT-1H-30M')
    expect(sub('PT30M', 'PT1H')).toBe('PT-30M')
    expect(sub('PT1H', 'PT1H30M')).toBe('PT-30M')
    expect(sub('PT1H', 'PT2H30M')).toBe('PT-1H-30M')
  })

  it('normalizes negative whole hours', () => {
    expect(sub('PT2H', 'PT3H')).toBe('PT-1H')
  })

  it('preserves positive subtraction results', () => {
    expect(sub('P1D', 'PT12H')).toBe('PT12H')
    expect(sub('P1D', 'PT0.5S')).toBe('PT23H59M59.5S')
    expect(sub('PT1M', 'PT30S')).toBe('PT30S')
  })

  it('returns zero for equal operands', () => {
    expect(sub('PT1M', 'PT1M')).toBe('PT0S')
    expect(sub('PT1.5S', 'PT1.5S')).toBe('PT0S')
  })
})
