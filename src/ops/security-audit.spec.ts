/**
 * SecurityAuditor — unit tests.
 *
 * CRITICAL: every test() / test.each() MUST be inside a describe() block.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SecurityAuditor } from './security-audit';
import type { SecurityConfig } from './security-audit';

// ---------------------------------------------------------------------------
// Describe: constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('should create a SecurityAuditor with defaults', () => {
    const auditor = new SecurityAuditor();
    expect(auditor).toBeInstanceOf(SecurityAuditor);
  });

  it('should merge provided config with defaults', () => {
    const auditor = new SecurityAuditor({ tlsEnabled: false });
    const checks = auditor.checkConfigBaseline();
    const tlsCheck = checks.find(c => c.id === 'CFG-001');
    expect(tlsCheck?.severity).toBe('WARN');
  });
});

// ---------------------------------------------------------------------------
// Describe: checkConfigBaseline
// ---------------------------------------------------------------------------

describe('checkConfigBaseline', () => {
  let auditor: SecurityAuditor;

  beforeEach(() => {
    // Full-pass config
    const config: Partial<SecurityConfig> = {
      tlsEnabled: true,
      mtlsCertExpiry: Date.now() + 365 * 86_400_000,  // 1 year ahead
      curveEncryptionKey: 'CURVE_XYZ_123',
      identitiesFilePath: '/etc/graphvec/identities.json',
      auditLoggingEnabled: true,
      rbacRolesConfigured: true,
      backupScheduleConfigured: true,
    };
    auditor = new SecurityAuditor(config);
  });

  it('should return PASS for a fully compliant config', () => {
    const checks = auditor.checkConfigBaseline();
    const fails = checks.filter(c => c.severity !== 'PASS');
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(fails.length).toBe(0);
  });

  it('should WARN when TLS is disabled', () => {
    const a = new SecurityAuditor({ tlsEnabled: false });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-001')?.severity).toBe('WARN');
  });

  it('should FAIL when mTLS cert is expired (expiry=0)', () => {
    const a = new SecurityAuditor({ mtlsCertExpiry: 0 });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-002')?.severity).toBe('FAIL');
  });

  it('should FAIL when mTLS cert is unreachable (expiry=-1)', () => {
    const a = new SecurityAuditor({ mtlsCertExpiry: -1 });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-002')?.severity).toBe('FAIL');
  });

  it('should WARN when CURVE encryption key is missing', () => {
    const a = new SecurityAuditor({ curveEncryptionKey: null });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-003')?.severity).toBe('WARN');
  });

  it('should FAIL when identities file is missing', () => {
    const a = new SecurityAuditor({ identitiesFilePath: null });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-004')?.severity).toBe('FAIL');
  });

  it('should WARN when audit logging is disabled', () => {
    const a = new SecurityAuditor({ auditLoggingEnabled: false });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-005')?.severity).toBe('WARN');
  });

  it('should WARN when RBAC roles are not configured', () => {
    const a = new SecurityAuditor({ rbacRolesConfigured: false });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-006')?.severity).toBe('WARN');
  });

  it('should WARN when backup schedule is missing', () => {
    const a = new SecurityAuditor({ backupScheduleConfigured: false });
    const checks = a.checkConfigBaseline();
    expect(checks.find(c => c.id === 'CFG-007')?.severity).toBe('WARN');
  });
});

// ---------------------------------------------------------------------------
// Describe: checkRuntimeThreats
// ---------------------------------------------------------------------------

describe('checkRuntimeThreats', () => {
  it('should return no alerts under low auth failures', () => {
    const auditor = new SecurityAuditor();
    auditor.resetThreatCounters();
    for (let i = 0; i < 3; i++) {
      auditor.onAuthFailure(`node-${i}`);
    }
    const report = auditor.checkRuntimeThreats();
    expect(report.authFailures).toBe(3);
    expect(report.alerts).toHaveLength(0);
  });

  it('should WARN when auth failures exceed threshold', () => {
    const auditor = new SecurityAuditor();
    auditor.resetThreatCounters();
    for (let i = 0; i < 15; i++) {
      auditor.onAuthFailure(`node-${i}`);
    }
    const report = auditor.checkRuntimeThreats();
    expect(report.authFailures).toBe(15);
    expect(report.alerts.length).toBeGreaterThanOrEqual(1);
    expect(report.alerts[0]).toContain('auth failures');
  });

  it('should WARN when bulk exports exceed threshold', () => {
    const auditor = new SecurityAuditor();
    auditor.resetThreatCounters();
    for (let i = 0; i < 1500; i++) {
      auditor.onExport(1024);
    }
    const report = auditor.checkRuntimeThreats();
    expect(report.bulkExports).toBe(1500);
    expect(report.alerts.some(a => a.includes('bulk-exports'))).toBe(true);
  });

  it('should WARN when bulk deletes exceed threshold', () => {
    const auditor = new SecurityAuditor();
    auditor.resetThreatCounters();
    auditor.onBulkDelete(50);   // below threshold (50 <= 100) → no warn
    let report = auditor.checkRuntimeThreats();
    expect(report.bulkDeletes).toBe(50);
    expect(report.alerts.some(a => a.includes('deletes'))).toBe(false);

    auditor.onBulkDelete(60);   // total = 110 > 100 → warn
    report = auditor.checkRuntimeThreats();
    expect(report.bulkDeletes).toBe(110);
    expect(report.alerts.some(a => a.includes('deletes'))).toBe(true);
  });

  it('should sweep stale entries older than the window', () => {
    vi.useFakeTimers();
    const auditor = new SecurityAuditor();
    auditor.resetThreatCounters();

    // Add entries under current fake time
    for (let i = 0; i < 20; i++) {
      auditor.onAuthFailure('old-node');
    }

    // Advance time past the 5-minute auth window
    vi.advanceTimersByTime(6 * 60_000); // 6 min

    const report = auditor.checkRuntimeThreats();
    // The stale entries should have been pruned
    expect(report.authFailures).toBe(0);
    expect(report.alerts).toHaveLength(0);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Describe: resetThreatCounters
// ---------------------------------------------------------------------------

describe('resetThreatCounters', () => {
  it('should clear all threat counters', () => {
    const auditor = new SecurityAuditor();
    auditor.onAuthFailure('node-1');
    auditor.onExport(2048);
    auditor.onBulkDelete(10);

    auditor.resetThreatCounters();
    const report = auditor.checkRuntimeThreats();
    expect(report.authFailures).toBe(0);
    expect(report.bulkExports).toBe(0);
    expect(report.bulkDeletes).toBe(0);
    expect(report.alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Describe: generateSecurityReport
// ---------------------------------------------------------------------------

describe('generateSecurityReport', () => {
  it('should produce a combined SecurityReport', () => {
    const auditor = new SecurityAuditor({ tlsEnabled: false, mtlsCertExpiry: 0 });
    const report = auditor.generateSecurityReport();
    expect(report.totalChecks).toBeGreaterThanOrEqual(7);
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(report.warned).toBeGreaterThanOrEqual(1);
    expect(report.passed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Describe: generateComplianceReport
// ---------------------------------------------------------------------------

describe('generateComplianceReport', () => {
  it('should produce a Markdown compliance report', () => {
    const auditor = new SecurityAuditor({ tlsEnabled: false, mtlsCertExpiry: 0 });
    const md = auditor.generateComplianceReport();
    expect(md).toContain('# Security Compliance Report');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Detailed Results');
    expect(md).toContain('## Recommendations');
    expect(md).toContain('CFG-001');
    expect(md).toContain('CFG-002');
  });
});
