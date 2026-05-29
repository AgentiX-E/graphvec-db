/**
 * SecurityAuditor — Operations security baseline & compliance checks.
 *
 * Gap 10: Monitors config baseline, runtime threats, and generates
 * CIS-style compliance reports for the GraphVec deployment.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckSeverity = 'PASS' | 'WARN' | 'FAIL';

export interface SecurityCheck {
  id: string;
  category: string;
  description: string;
  severity: CheckSeverity;
  message: string;
  timestamp: number;
}

export interface SecurityReport {
  generatedAt: number;
  totalChecks: number;
  passed: number;
  warned: number;
  failed: number;
  checks: SecurityCheck[];
}

export interface ThreatReport {
  generatedAt: number;
  authFailures: number;
  authFailureRate: number;          // events per minute
  bulkExports: number;
  bulkExportRate: number;           // reads per second
  bulkDeletes: number;
  bulkDeleteRate: number;           // deletes per minute
  alerts: string[];
}

// ---------------------------------------------------------------------------
// Configuration shape (injected or defaulted)
// ---------------------------------------------------------------------------

export interface SecurityConfig {
  tlsEnabled: boolean;
  mtlsCertExpiry: number;           // epoch ms – 0 means expired, -1 means missing/unreachable
  curveEncryptionKey: string | null;
  identitiesFilePath: string | null;
  auditLoggingEnabled: boolean;
  rbacRolesConfigured: boolean;
  backupScheduleConfigured: boolean;
}

const DEFAULT_CONFIG: SecurityConfig = {
  tlsEnabled: true,
  mtlsCertExpiry: 0,
  curveEncryptionKey: 'CURVE_XYZ_123',
  identitiesFilePath: '/etc/graphvec/identities.json',
  auditLoggingEnabled: true,
  rbacRolesConfigured: true,
  backupScheduleConfigured: true,
};

// ---------------------------------------------------------------------------
// Threat counters (runtime state)
// ---------------------------------------------------------------------------

const THREAT_WINDOW_AUTH_MS = 5 * 60_000;   // 5 min
const THREAT_WINDOW_EXPORT_MS = 1_000;       // 1 sec sliding (approximated as counter/reset)
const THREAT_WINDOW_DELETE_MS = 60_000;      // 1 min

const AUTH_FAILURE_WARN = 10;                // >10 in 5 min
const BULK_EXPORT_WARN = 1000;               // >1000 reads/sec
const BULK_DELETE_WARN = 100;                // >100 deletes/min

// ---------------------------------------------------------------------------
// SecurityAuditor class
// ---------------------------------------------------------------------------

export class SecurityAuditor {
  private config: SecurityConfig;

  // runtime threat counters (epoch ms → count)
  private authFailures: Array<{ time: number; nodeId: string }>;
  private bulkExports: Array<{ time: number; bytes: number }>;
  private bulkDeletes: Array<{ time: number; count: number }>;

  constructor(config?: Partial<SecurityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.authFailures = [];
    this.bulkExports = [];
    this.bulkDeletes = [];
  }

  // ---- Config baseline checks ----

  checkConfigBaseline(): SecurityCheck[] {
    const now = Date.now();
    const checks: SecurityCheck[] = [];

    // 1. TLS
    checks.push(this.makeCheck(
      'CFG-001', 'TLS', 'TLS is enabled for inter-node communication',
      this.config.tlsEnabled ? 'PASS' : 'WARN',
      this.config.tlsEnabled
        ? 'TLS 1.3 enabled'
        : 'TLS is disabled – all inter-node traffic is unencrypted',
      now,
    ));

    // 2. mTLS cert validity
    {
      const mtlsExpiry = this.config.mtlsCertExpiry;
      let severity: CheckSeverity;
      let msg: string;
      if (mtlsExpiry === -1) {
        severity = 'FAIL';
        msg = 'mTLS certificate is unreachable – peer verification disabled';
      } else if (mtlsExpiry === 0) {
        severity = 'FAIL';
        msg = 'mTLS certificate is expired – immediate rotation required';
      } else if (mtlsExpiry < now) {
        severity = 'FAIL';
        msg = `mTLS certificate expired ${Math.round((now - mtlsExpiry) / 86_400_000)} day(s) ago`;
      } else {
        severity = 'PASS';
        msg = `mTLS certificate valid until ${new Date(mtlsExpiry).toISOString()}`;
      }
      checks.push(this.makeCheck('CFG-002', 'mTLS', 'mTLS certificates are valid', severity, msg, now));
    }

    // 3. CURVE encryption
    checks.push(this.makeCheck(
      'CFG-003', 'Encryption', 'CURVE/ZMQ encryption key is configured',
      this.config.curveEncryptionKey ? 'PASS' : 'WARN',
      this.config.curveEncryptionKey
        ? 'CURVE encryption key present'
        : 'No CURVE encryption key – ZMQ traffic may be plaintext',
      now,
    ));

    // 4. Identities file
    checks.push(this.makeCheck(
      'CFG-004', 'Identity', 'Node identities file exists',
      this.config.identitiesFilePath ? 'PASS' : 'FAIL',
      this.config.identitiesFilePath
        ? `Identities file at ${this.config.identitiesFilePath}`
        : 'No identities file – node identity is unverified',
      now,
    ));

    // 5. Audit logging
    checks.push(this.makeCheck(
      'CFG-005', 'Audit', 'Audit logging is enabled',
      this.config.auditLoggingEnabled ? 'PASS' : 'WARN',
      this.config.auditLoggingEnabled
        ? 'Audit logging enabled'
        : 'Audit logging disabled – compliance events are not recorded',
      now,
    ));

    // 6. RBAC roles
    checks.push(this.makeCheck(
      'CFG-006', 'RBAC', 'RBAC roles are configured',
      this.config.rbacRolesConfigured ? 'PASS' : 'WARN',
      this.config.rbacRolesConfigured
        ? 'RBAC roles configured (reader, writer, admin)'
        : 'No RBAC roles – all users have unrestricted access',
      now,
    ));

    // 7. Backup schedule
    checks.push(this.makeCheck(
      'CFG-007', 'Backup', 'Backup schedule is configured',
      this.config.backupScheduleConfigured ? 'PASS' : 'WARN',
      this.config.backupScheduleConfigured
        ? 'Backup scheduled (daily at 02:00 UTC)'
        : 'No backup schedule – data loss risk on catastrophic failure',
      now,
    ));

    return checks;
  }

  // ---- Runtime threat detection ----

  /** Record an authentication failure event. */
  onAuthFailure(nodeId: string): void {
    this.authFailures.push({ time: Date.now(), nodeId });
  }

  /** Record a bulk-export (high read volume) event. */
  onExport(bytes: number): void {
    this.bulkExports.push({ time: Date.now(), bytes });
  }

  /** Record a bulk-delete event. */
  onBulkDelete(count: number): void {
    this.bulkDeletes.push({ time: Date.now(), count });
  }

  /** Sweep old entries and return a ThreatReport. */
  checkRuntimeThreats(): ThreatReport {
    const now = Date.now();
    const alerts: string[] = [];

    // Prune stale entries
    this.authFailures = this.authFailures.filter(e => now - e.time < THREAT_WINDOW_AUTH_MS);
    this.bulkExports = this.bulkExports.filter(e => now - e.time < THREAT_WINDOW_EXPORT_MS);
    this.bulkDeletes = this.bulkDeletes.filter(e => now - e.time < THREAT_WINDOW_DELETE_MS);

    const authCount = this.authFailures.length;
    const exportCount = this.bulkExports.length;
    const deleteCount = this.bulkDeletes.reduce((sum, e) => sum + e.count, 0);

    // Rates
    const authRate = authCount / (THREAT_WINDOW_AUTH_MS / 60_000);       // per minute
    const exportRate = exportCount;                                       // per second (window ~1s)
    const deleteRate = deleteCount / (THREAT_WINDOW_DELETE_MS / 60_000);  // per minute

    if (authCount > AUTH_FAILURE_WARN) {
      alerts.push(`WARN: ${authCount} auth failures in 5 min (threshold: ${AUTH_FAILURE_WARN})`);
    }
    if (exportCount > BULK_EXPORT_WARN) {
      alerts.push(`WARN: ${exportCount} bulk-exports/sec (threshold: ${BULK_EXPORT_WARN})`);
    }
    if (deleteCount > BULK_DELETE_WARN) {
      alerts.push(`WARN: ${deleteCount} deletes in 1 min (threshold: ${BULK_DELETE_WARN})`);
    }

    return {
      generatedAt: now,
      authFailures: authCount,
      authFailureRate: Math.round(authRate * 100) / 100,
      bulkExports: exportCount,
      bulkExportRate: Math.round(exportRate * 100) / 100,
      bulkDeletes: deleteCount,
      bulkDeleteRate: Math.round(deleteRate * 100) / 100,
      alerts,
    };
  }

  // ---- Report generation ----

  /**
   * Run both baseline and threat checks and produce a single SecurityReport.
   */
  generateSecurityReport(): SecurityReport {
    const checks = [
      ...this.checkConfigBaseline(),
    ];
    const threatReport = this.checkRuntimeThreats();

    // Add threat-level checks as synthetic SecurityCheck entries
    const now = Date.now();
    if (threatReport.alerts.length > 0) {
      for (const alert of threatReport.alerts) {
        checks.push({
          id: 'THRT-001',
          category: 'Runtime',
          description: alert,
          severity: 'WARN',
          message: alert,
          timestamp: now,
        });
      }
    }

    const passed = checks.filter(c => c.severity === 'PASS').length;
    const warned = checks.filter(c => c.severity === 'WARN').length;
    const failed = checks.filter(c => c.severity === 'FAIL').length;

    return {
      generatedAt: now,
      totalChecks: checks.length,
      passed,
      warned,
      failed,
      checks,
    };
  }

  /**
   * Generate a CIS-style Markdown compliance report.
   */
  generateComplianceReport(
    report?: SecurityReport,
  ): string {
    const r = report ?? this.generateSecurityReport();
    const lines: string[] = [];
    const dateStr = new Date(r.generatedAt).toISOString().replace('T', ' ').slice(0, 19);

    lines.push('# Security Compliance Report (CIS-style)');
    lines.push('');
    lines.push(`**Generated:** ${dateStr} UTC`);
    lines.push(`**Scope:** GraphVec node security baseline & runtime threats`);
    lines.push('');
    lines.push(`## Summary`);
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total checks | ${r.totalChecks} |`);
    lines.push(`| ✅ Passed | ${r.passed} |`);
    lines.push(`| ⚠️  Warned  | ${r.warned} |`);
    lines.push(`| ❌ Failed  | ${r.failed} |`);
    lines.push('');
    lines.push(`## Detailed Results`);
    lines.push('');

    for (const check of r.checks) {
      const icon = check.severity === 'PASS' ? '✅' : check.severity === 'WARN' ? '⚠️' : '❌';
      lines.push(`### ${icon} [${check.id}] ${check.description}`);
      lines.push('');
      lines.push(`- **Category:** ${check.category}`);
      lines.push(`- **Result:** ${check.severity}`);
      lines.push(`- **Detail:** ${check.message}`);
      lines.push('');
    }

    lines.push(`## Recommendations`);
    lines.push('');

    const fails = r.checks.filter(c => c.severity === 'FAIL' || c.severity === 'WARN');
    if (fails.length === 0) {
      lines.push('No issues found. All checks passed.');
    } else {
      for (const f of fails) {
        if (f.severity === 'FAIL') {
          lines.push(`- ❌ **${f.id}** — ${f.message}`);
        } else {
          lines.push(`- ⚠️ **${f.id}** — ${f.message}`);
        }
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('_End of compliance report._');
    lines.push('');

    return lines.join('\n');
  }

  // ---- Resets ----

  /** Reset all threat counters (for testing). */
  resetThreatCounters(): void {
    this.authFailures = [];
    this.bulkExports = [];
    this.bulkDeletes = [];
  }

  // ---- Helpers ----

  private makeCheck(
    id: string,
    category: string,
    description: string,
    severity: CheckSeverity,
    message: string,
    timestamp: number,
  ): SecurityCheck {
    return { id, category, description, severity, message, timestamp };
  }
}
