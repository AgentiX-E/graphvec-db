import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock `time(<string>)` IANA-timezone resolution (BUG-15). A bare IANA timezone
// tag (no numeric offset) was silently dropped to UTC (`Z`) instead of being
// resolved to its actual offset. `datetime` already resolved IANA names; `time`
// now does too, using the fixed 1984-07-01 reference date for DST (times carry
// no date, so a northern-hemisphere summer offset is the documented default).

function t(s: string): string {
  return _evaluateExpression(`time('${s}')`, {}) as string
}

describe('time(string) resolves IANA timezone names to an offset', () => {
  it('resolves America/New_York to its summer offset', () => {
    expect(t('12:00:00[America/New_York]')).toBe('12:00:00-04:00[America/New_York]')
  })

  it('resolves Asia/Shanghai to +08:00', () => {
    expect(t('12:00:00[Asia/Shanghai]')).toBe('12:00:00+08:00[Asia/Shanghai]')
  })

  it('resolves Europe/Paris to its summer offset', () => {
    expect(t('12:00:00[Europe/Paris]')).toBe('12:00:00+02:00[Europe/Paris]')
  })

  it('resolves Australia/Sydney to its summer offset', () => {
    expect(t('12:00:00[Australia/Sydney]')).toBe('12:00:00+11:00[Australia/Sydney]')
  })

  it('leaves an explicit numeric offset unchanged', () => {
    expect(t('12:00:00+08:00')).toBe('12:00:00+08:00')
    expect(t('12:00:00Z')).toBe('12:00:00Z')
  })
})
