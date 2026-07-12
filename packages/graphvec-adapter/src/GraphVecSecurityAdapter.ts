/**
 * GraphVecSecurityAdapter — Implements ISecurityCompliance for the graphvec-db engine.
 *
 * Wraps the src/ops/SecurityAuditor class and maps its native SecurityCheck
 * types to the canonical db-operations ISecurityCompliance interface.
 */

import type { ISecurityCompliance } from '@agentix-e/db-operations-security';
import type { SecurityCheck as CanonicalSecurityCheck } from '@agentix-e/db-operations-core/types';
import { SecurityAuditor } from 'graphvec-db/ops/security-audit';
import type { SecurityCheck as NativeSecurityCheck } from 'graphvec-db/ops/security-audit';

/**
 * Map native severity to canonical.
 */
function toCanonicalSeverity(
  severity: 'PASS' | 'WARN' | 'FAIL',
): 'PASS' | 'WARN' | 'FAIL' {
  return severity;
}

/**
 * GraphVecSecurityAdapter — adapts the graphvec-db SecurityAuditor to ISecurityCompliance.
 *
 * The graphvec-db `SecurityAuditor` provides:
 * - Config baseline checks (TLS, mTLS, encryption, identities, audit, RBAC, backup)
 * - Runtime threat detection (auth failures, bulk exports, bulk deletes)
 * - CIS-style compliance report generation
 *
 * @example
 * ```ts
 * const adapter = new GraphVecSecurityAdapter();
 * const checks = await adapter.runChecks();
 * const score = adapter.getScore();
 * ```
 */
export class GraphVecSecurityAdapter implements ISecurityCompliance {
  private auditor: SecurityAuditor;
  private lastChecks: Map<string, NativeSecurityCheck> = new Map();

  constructor(config?: {
    tlsEnabled?: boolean;
    mtlsCertExpiry?: number;
    curveEncryptionKey?: string | null;
    identitiesFilePath?: string | null;
    auditLoggingEnabled?: boolean;
    rbacRolesConfigured?: boolean;
    backupScheduleConfigured?: boolean;
  }) {
    this.auditor = new SecurityAuditor(config);
  }

  /**
   * Get the underlying SecurityAuditor instance for native interop.
   */
  get nativeAuditor(): SecurityAuditor {
    return this.auditor;
  }

  // ── ISecurityCompliance implementation ──

  async runChecks(): Promise<CanonicalSecurityCheck[]> {
    const checks = this.auditor.checkConfigBaseline();
    this._cacheChecks(checks);

    return checks.map(c => ({
      id: c.id,
      category: c.category,
      description: c.description,
      severity: c.severity,
      message: c.message,
      remediation: this._getRemediation(c.id),
      timestamp: new Date(c.timestamp).toISOString(),
    }));
  }

  async runCategory(category: string): Promise<CanonicalSecurityCheck[]> {
    const all = await this.runChecks();
    return all.filter(c => c.category.toLowerCase() === category.toLowerCase());
  }

  getScore(): number {
    if (this.lastChecks.size === 0) return 100; // Default to perfect if no checks run

    // Score: PASS = 100, WARN = 50, FAIL = 0
    let total = 0;
    let count = 0;

    for (const check of this.lastChecks.values()) {
      switch (check.severity) {
        case 'PASS': total += 100; break;
        case 'WARN': total += 50; break;
        case 'FAIL': total += 0; break;
      }
      count++;
    }

    return count > 0 ? Math.round(total / count) : 100;
  }

  /**
   * Run runtime threat detection and return alerts.
   */
  async checkRuntimeThreats(): Promise<string[]> {
    const threatReport = this.auditor.checkRuntimeThreats();
    return threatReport.alerts;
  }

  /**
   * Record an authentication failure event.
   */
  onAuthFailure(nodeId: string): void {
    this.auditor.onAuthFailure(nodeId);
  }

  /**
   * Record a bulk export event.
   */
  onExport(bytes: number): void {
    this.auditor.onExport(bytes);
  }

  /**
   * Record a bulk delete event.
   */
  onBulkDelete(count: number): void {
    this.auditor.onBulkDelete(count);
  }

  /**
   * Reset all threat counters (for testing or after incident response).
   */
  resetThreatCounters(): void {
    this.auditor.resetThreatCounters();
  }

  // ── Private helpers ──

  private _cacheChecks(checks: NativeSecurityCheck[]): void {
    for (const check of checks) {
      this.lastChecks.set(check.id, check);
    }
  }

  private _getRemediation(checkId: string): string {
    const remediationMap: Record<string, string> = {
      'CFG-001': 'Enable TLS 1.3 by configuring tls.enabled=true in graphvec.yaml',
      'CFG-002': 'Renew mTLS certificates or check that cert path is valid',
      'CFG-003': 'Set a CURVE/ZMQ encryption key in the security config',
      'CFG-004': 'Create identities file at /etc/graphvec/identities.json',
      'CFG-005': 'Set auditLogging.enabled=true in the config',
      'CFG-006': 'Configure RBAC roles (reader, writer, admin) in auth config',
      'CFG-007': 'Configure a backup schedule in the backup section of graphvec.yaml',
    };
    return remediationMap[checkId] || 'Contact your system administrator';
  }
}
