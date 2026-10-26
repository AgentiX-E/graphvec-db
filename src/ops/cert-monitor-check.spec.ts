/**
 * cert-monitor-check.spec.ts — unit tests for CertMonitor.checkNow() branch
 * logic (valid / warning / critical / expired) and its callback dispatch.
 *
 * The existing cert-monitor.spec.ts runs in the slow serial suite and exercises
 * real openssl-generated certificates. This spec instead stubs crypto.X509Certificate
 * and fs so the pure decision logic of checkNow() is covered in the default suite
 * without depending on openssl or the filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CertMonitorConfig } from './cert-monitor'

// A mutable holder so each test can point X509Certificate.validTo at a
// different wall-clock offset.
let validToIso = new Date().toISOString()
let certIssuer = 'CN=Test CA'
let certSubject = 'CN=example.com'

vi.mock('node:crypto', () => {
  return {
    X509Certificate: class {
      constructor(_pem: string) {
        /* no-op */
      }
      get validTo(): string {
        return validToIso
      }
      get issuer(): string {
        return certIssuer
      }
      get subject(): string {
        return certSubject
      }
    },
  }
})

vi.mock('node:fs', () => {
  return {
    readFileSync: () => 'MOCK PEM',
  }
})

// Import after the mocks are registered.
import { CertMonitor } from './cert-monitor'

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function makeMonitor(overrides?: Partial<CertMonitorConfig>): {
  monitor: CertMonitor
  onWarning: ReturnType<typeof vi.fn>
  onCritical: ReturnType<typeof vi.fn>
  onExpired: ReturnType<typeof vi.fn>
} {
  const onWarning = vi.fn()
  const onCritical = vi.fn()
  const onExpired = vi.fn()
  const monitor = new CertMonitor({
    certPath: '/tmp/mock-cert.pem',
    onWarning,
    onCritical,
    onExpired,
    ...overrides,
  })
  return { monitor, onWarning, onCritical, onExpired }
}

describe('CertMonitor.checkNow() decision logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'))
    certIssuer = 'CN=Test CA'
    certSubject = 'CN=example.com'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports valid with daysUntilExpiry when far from expiry', () => {
    validToIso = daysFromNow(60)
    const { monitor, onWarning, onCritical, onExpired } = makeMonitor()

    const result = monitor.checkNow()

    expect(result.isValid).toBe(true)
    expect(result.daysUntilExpiry).toBe(60)
    expect(result.issuer).toBe('CN=Test CA')
    expect(result.subject).toBe('CN=example.com')
    expect(onWarning).not.toHaveBeenCalled()
    expect(onCritical).not.toHaveBeenCalled()
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('triggers onWarning when within warnDays but above criticalDays', () => {
    validToIso = daysFromNow(15) // warn=30, critical=7 → 15 is in warning range
    const { monitor, onWarning, onCritical, onExpired } = makeMonitor()

    const result = monitor.checkNow()

    expect(result.isValid).toBe(true)
    expect(onWarning).toHaveBeenCalledWith(15)
    expect(onCritical).not.toHaveBeenCalled()
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('triggers onCritical when within criticalDays', () => {
    validToIso = daysFromNow(3) // critical=7 → 3 is critical
    const { monitor, onWarning, onCritical, onExpired } = makeMonitor()

    const result = monitor.checkNow()

    expect(result.isValid).toBe(true)
    expect(result.daysUntilExpiry).toBe(3)
    expect(onCritical).toHaveBeenCalledWith(3)
    expect(onWarning).not.toHaveBeenCalled()
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('reports invalid and triggers onExpired when the certificate is expired', () => {
    validToIso = daysFromNow(-1) // one day in the past
    const { monitor, onWarning, onCritical, onExpired } = makeMonitor()

    const result = monitor.checkNow()

    expect(result.isValid).toBe(false)
    expect(result.daysUntilExpiry).toBeLessThanOrEqual(0)
    expect(onExpired).toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
    expect(onCritical).not.toHaveBeenCalled()
  })

  it('treats a certificate expiring exactly at criticalDays boundary as critical', () => {
    validToIso = daysFromNow(7) // exactly the critical threshold
    const { monitor, onCritical, onExpired } = makeMonitor()
    const result = monitor.checkNow()
    expect(result.isValid).toBe(true)
    expect(onCritical).toHaveBeenCalledWith(7)
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('handles custom warn/critical thresholds', () => {
    validToIso = daysFromNow(20)
    // warn=10, critical=5 → 20 days is valid (above both)
    const { monitor, onWarning } = makeMonitor({ warnDays: 10, criticalDays: 5 })
    const result = monitor.checkNow()
    expect(result.isValid).toBe(true)
    expect(onWarning).not.toHaveBeenCalled()
  })
})
