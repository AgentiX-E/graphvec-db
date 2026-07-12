/**
 * GraphVecAlertAdapter — Implements IAlertRuleManager for the graphvec-db engine.
 *
 * Wraps the src/ops/AlertRuleManager class and maps its native alert rule
 * types to the canonical db-operations IAlertRuleManager interface.
 */

import type { IAlertRuleManager, AlertRule, TriggeredAlert } from '@agentix-e/db-operations-monitor';
import { AlertRuleManager as NativeAlertRuleManager } from 'graphvec-db/ops/alert-rules';
import type { AlertRule as NativeAlertRule } from 'graphvec-db/ops/alert-rules';

/**
 * Map native severity to canonical.
 */
function toCanonicalSeverity(severity: string): 'info' | 'warning' | 'critical' {
  switch (severity) {
    case 'info': return 'info';
    case 'warning': return 'warning';
    case 'critical': return 'critical';
    default: return 'warning';
  }
}

/**
 * Map canonical condition to string description.
 */
function conditionToString(
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte',
  threshold: number,
): string {
  const ops: Record<string, string> = {
    'gt': '>',
    'lt': '<',
    'eq': '==',
    'gte': '>=',
    'lte': '<=',
  };
  return `${ops[condition] || '>'} ${threshold}`;
}

/**
 * Convert a canonical AlertRule to a native AlertRule for the graphvec-db manager.
 */
function canonicalToNative(rule: AlertRule): NativeAlertRule {
  const nativeExpr = `${rule.metric} ${conditionToString(rule.condition, rule.threshold)}`;
  return {
    name: rule.name,
    expr: nativeExpr,
    for: `${rule.durationMs}ms`,
    severity: toCanonicalSeverity(rule.severity),
    enabled: rule.enabled,
    threshold: rule.threshold,
  };
}

/**
 * GraphVecAlertAdapter — adapts the graphvec-db AlertRuleManager to IAlertRuleManager.
 *
 * The graphvec-db `AlertRuleManager` manages Prometheus-compatible alerting rules,
 * evaluates them at runtime, and can generate Prometheus YAML. This adapter
 * wraps it with the canonical IAlertRuleManager interface.
 *
 * @example
 * ```ts
 * const adapter = new GraphVecAlertAdapter();
 * const id = await adapter.createRule({
 *   name: 'HighLatency',
 *   metric: 'graphvec_node_op_duration_ms',
 *   condition: 'gt',
 *   threshold: 1000,
 *   durationMs: 60_000,
 *   severity: 'warning',
 *   enabled: true,
 * });
 * ```
 */
export class GraphVecAlertAdapter implements IAlertRuleManager {
  private nativeManager: NativeAlertRuleManager;

  constructor() {
    this.nativeManager = new NativeAlertRuleManager();
  }

  /**
   * Get the underlying AlertRuleManager for native interop.
   */
  get nativeAlertManager(): NativeAlertRuleManager {
    return this.nativeManager;
  }

  // ── IAlertRuleManager implementation ──

  async createRule(rule: AlertRule): Promise<string> {
    const name = rule.name || `rule-${Date.now()}`;
    const nativeRule = canonicalToNative({ ...rule, name });
    this.nativeManager.addRule(nativeRule);
    return name;
  }

  async updateRule(id: string, rule: Partial<AlertRule>): Promise<void> {
    // Check if the rule exists by reading all rules
    const allRules = this.nativeManager.listAllRules();
    const existing = allRules.find(r => r.name === id);
    if (!existing) {
      throw new Error(`Alert rule '${id}' not found`);
    }

    // Apply updates
    if (rule.name !== undefined && rule.name !== id) {
      // Rename by adding new and disabling old
      const fullRule: AlertRule = {
        name: rule.name,
        metric: rule.metric || existing.expr,
        condition: rule.condition || 'gt',
        threshold: rule.threshold ?? existing.threshold ?? 0,
        durationMs: rule.durationMs || this._parseDuration(existing.for),
        severity: rule.severity || toCanonicalSeverity(existing.severity),
        enabled: rule.enabled ?? existing.enabled,
      };
      await this.createRule(fullRule);
      this.nativeManager.setRuleEnabled(id, false);
    } else {
      // Update in place
      this.nativeManager.setThreshold(id, rule.threshold ?? existing.threshold ?? 0);
      if (rule.enabled !== undefined) {
        this.nativeManager.setRuleEnabled(id, rule.enabled);
      }
    }
  }

  async deleteRule(id: string): Promise<void> {
    const success = this.nativeManager.removeRule(id);
    if (!success) {
      throw new Error(`Alert rule '${id}' not found or is a preset rule (use silenceRule to disable)`);
    }
  }

  async evaluate(): Promise<TriggeredAlert[]> {
    const results = this.nativeManager.evaluateRules();
    const now = new Date();

    return results
      .filter(r => r.triggered)
      .map(r => ({
        ruleId: r.name,
        ruleName: r.name,
        severity: toCanonicalSeverity(r.severity),
        value: r.value ?? 0,
        threshold: r.threshold ?? 0,
        triggeredAt: now,
        message: r.message,
      }));
  }

  async silenceRule(id: string, durationMs: number): Promise<void> {
    // Disable the rule and schedule re-enable after durationMs
    this.nativeManager.setRuleEnabled(id, false);

    if (durationMs > 0) {
      setTimeout(() => {
        try {
          this.nativeManager.setRuleEnabled(id, true);
        } catch {
          // Rule may have been deleted — ignore
        }
      }, durationMs).unref();
    }
  }

  // ── Helpers ──

  /**
   * Parse a duration string like '1m' or '5000ms' to milliseconds.
   */
  private _parseDuration(durationStr: string): number {
    const match = durationStr.match(/^(\d+)(ms|s|m|h)?$/);
    if (!match) return 60_000; // Default to 1 minute

    const value = parseInt(match[1], 10);
    const unit = match[2] || 'ms';

    switch (unit) {
      case 'ms': return value;
      case 's': return value * 1000;
      case 'm': return value * 60_000;
      case 'h': return value * 3_600_000;
      default: return value;
    }
  }
}
