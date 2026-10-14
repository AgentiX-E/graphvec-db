import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock `datetime(<string>)` IANA timezone resolution. A bracketed IANA zone
// name is normalized to its real UTC offset for the given instant, honoring
// daylight-saving-time transitions (northern vs southern hemisphere, fixed
// `Etc/GMT+X` sign inversion), while preserving explicit numeric offsets.

function dt(s: string): string {
  return _evaluateExpression(`datetime('${s}')`, {}) as string
}

describe('datetime(string) resolves IANA timezone names to offsets', () => {
  it('resolves America/New_York to standard time in January', () => {
    expect(dt('2024-01-01T12:00:00[America/New_York]')).toBe('2024-01-01T12:00:00-05:00[America/New_York]')
  })

  it('resolves America/New_York to daylight time in July', () => {
    expect(dt('2024-07-01T12:00:00[America/New_York]')).toBe('2024-07-01T12:00:00-04:00[America/New_York]')
  })

  it('resolves Australia/Sydney to its winter offset in July', () => {
    expect(dt('2024-07-01T12:00:00[Australia/Sydney]')).toBe('2024-07-01T12:00:00+10:00[Australia/Sydney]')
  })

  it('resolves a fixed Etc/GMT+X zone with POSIX-sign inversion', () => {
    expect(dt('2024-01-01T12:00:00[Etc/GMT+8]')).toBe('2024-01-01T12:00:00-08:00[Etc/GMT+8]')
  })

  it('resolves a lowercase/sub-area IANA name', () => {
    expect(dt('2024-01-01T12:00:00[America/Argentina/Buenos_Aires]')).toBe('2024-01-01T12:00:00-03:00[America/Argentina/Buenos_Aires]')
  })

  it('keeps an explicit numeric offset unchanged', () => {
    expect(dt('2024-01-01T12:00:00+05:30')).toBe('2024-01-01T12:00:00+05:30')
  })

  it('resolves [IANA]Z to the actual offset rather than hard-coded Z', () => {
    expect(dt('2024-01-01T12:00:00[America/New_York]Z')).toBe('2024-01-01T12:00:00-05:00[America/New_York]')
  })
})
