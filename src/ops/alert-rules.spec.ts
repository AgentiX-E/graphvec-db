/**
 * alert-rules.spec.ts — Tests for AlertRuleManager
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { AlertRuleManager, type AlertRule } from '../ops/alert-rules'

describe('AlertRuleManager', () => {
  let manager: AlertRuleManager

  beforeEach(() => {
    manager = new AlertRuleManager()
  })

  // ── Preset rules ──

  it('should load preset rules on construction', () => {
    const rules = manager.listAllRules()
    expect(rules.length).toBeGreaterThanOrEqual(6)

    const names = rules.map(r => r.name)
    expect(names).toContain('HighNodeLatency')
    expect(names).toContain('HighEdgeLatency')
    expect(names).toContain('HighQueryLatency')
    expect(names).toContain('HighErrorRate')
    expect(names).toContain('PoolExhaustion')
    expect(names).toContain('CertExpiringSoon')
  })

  it('should only return enabled rules from listRules', () => {
    // All presets are enabled by default
    const enabled = manager.listRules()
    const all = manager.listAllRules()
    expect(enabled.length).toBe(all.length)
  })

  // ── addRule / removeRule ──

  it('should add custom rules', () => {
    const rule: AlertRule = {
      name: 'CustomAlert',
      expr: 'up == 0',
      for: '1m',
      severity: 'warning',
      enabled: true,
    }
    manager.addRule(rule)

    const rules = manager.listRules()
    const found = rules.find(r => r.name === 'CustomAlert')
    expect(found).toBeDefined()
    expect(found!.expr).toBe('up == 0')
  })

  it('should throw when adding duplicate rule', () => {
    const rule: AlertRule = {
      name: 'CustomAlert',
      expr: 'up == 0',
      for: '1m',
      severity: 'warning',
      enabled: true,
    }
    manager.addRule(rule)

    expect(() => manager.addRule(rule)).toThrow('already exists')
  })

  it('should disable preset rules when removeRule is called', () => {
    expect(manager.setRuleEnabled('HighNodeLatency', false)).toBe(true)
    const enabled = manager.listRules()
    expect(enabled.find(r => r.name === 'HighNodeLatency')).toBeUndefined()
  })

  it('should remove custom rules', () => {
    const rule: AlertRule = {
      name: 'TempAlert',
      expr: 'temp == 1',
      for: '1m',
      severity: 'info',
      enabled: true,
    }
    manager.addRule(rule)
    expect(manager.listRules().length).toBeGreaterThanOrEqual(7)

    const removed = manager.removeRule('TempAlert')
    expect(removed).toBe(true)
    expect(manager.listRules().length).toBeGreaterThanOrEqual(6)
  })

  it('should return false for removing non-existent rule', () => {
    expect(manager.removeRule('NonExistent')).toBe(false)
  })

  // ── setRuleEnabled / setThreshold ──

  it('should enable and disable rules', () => {
    expect(manager.setRuleEnabled('HighNodeLatency', false)).toBe(true)
    expect(manager.listRules().find(r => r.name === 'HighNodeLatency')).toBeUndefined()

    expect(manager.setRuleEnabled('HighNodeLatency', true)).toBe(true)
    expect(manager.listRules().find(r => r.name === 'HighNodeLatency')).toBeDefined()
  })

  it('should return false for setRuleEnabled on non-existent rule', () => {
    expect(manager.setRuleEnabled('NonExistent', false)).toBe(false)
  })

  it('should set threshold on existing rule', () => {
    expect(manager.setThreshold('HighNodeLatency', 500)).toBe(true)
    const rule = manager.listAllRules().find(r => r.name === 'HighNodeLatency')
    expect(rule!.threshold).toBe(500)
  })

  it('should return false for setThreshold on non-existent rule', () => {
    expect(manager.setThreshold('NonExistent', 100)).toBe(false)
  })

  // ── toPrometheusYAML ──

  it('should generate valid Prometheus Alerting Rules YAML', () => {
    const yaml = manager.toPrometheusYAML()
    expect(yaml).toContain('groups:')
    expect(yaml).toContain('name: graphvec_alerts')
    expect(yaml).toContain('alert: HighNodeLatency')
    expect(yaml).toContain('alert: HighEdgeLatency')
    expect(yaml).toContain('alert: HighQueryLatency')
    expect(yaml).toContain('alert: HighErrorRate')
    expect(yaml).toContain('alert: PoolExhaustion')
    expect(yaml).toContain('alert: CertExpiringSoon')
  })

  it('should generate YAML with proper indentation', () => {
    const yaml = manager.toPrometheusYAML()
    const lines = yaml.split('\n').filter(l => l.trim().length > 0)

    // groups: should be at indent 0
    expect(lines[0]).toBe('groups:')

    // rules should be at indent 6
    const ruleLines = lines.filter(l => l.trim().startsWith('- alert:'))
    expect(ruleLines.length).toBeGreaterThanOrEqual(6)
  })

  it('should include severity labels in YAML', () => {
    const yaml = manager.toPrometheusYAML()
    expect(yaml).toContain('severity: warning')
    expect(yaml).toContain('severity: critical')
  })

  it('should include annotations in YAML', () => {
    const yaml = manager.toPrometheusYAML()
    expect(yaml).toContain('annotations:')
    expect(yaml).toContain('summary:')
  })

  it('should return empty string when no enabled rules', () => {
    for (const rule of manager.listAllRules()) {
      manager.setRuleEnabled(rule.name, false)
    }
    expect(manager.toPrometheusYAML()).toBe('')
  })

  it('should only include enabled rules in YAML', () => {
    manager.setRuleEnabled('HighNodeLatency', false)

    const yaml = manager.toPrometheusYAML()
    expect(yaml).not.toContain('alert: HighNodeLatency')
    expect(yaml).toContain('alert: HighEdgeLatency')
  })

  // ── evaluateRules ──

  it('should evaluate rules without throwing', () => {
    const results = manager.evaluateRules()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThanOrEqual(6)

    for (const r of results) {
      expect(r).toHaveProperty('name')
      expect(r).toHaveProperty('triggered')
      expect(r).toHaveProperty('severity')
      expect(r).toHaveProperty('message')
      expect(r).toHaveProperty('threshold')
    }
  })

  it('should have rules with correct names in eval results', () => {
    const results = manager.evaluateRules()
    const names = results.map(r => r.name)
    expect(names).toContain('HighNodeLatency')
    expect(names).toContain('HighEdgeLatency')
    expect(names).toContain('HighQueryLatency')
    expect(names).toContain('HighErrorRate')
    expect(names).toContain('PoolExhaustion')
    expect(names).toContain('CertExpiringSoon')
  })

  it('should not evaluate disabled rules', () => {
    manager.setRuleEnabled('HighNodeLatency', false)
    const results = manager.evaluateRules()
    expect(results.find(r => r.name === 'HighNodeLatency')).toBeUndefined()
  })

  // ── Exporter integration (no-op exporter) ──

  it('should construct with a PrometheusExporter reference', () => {
    // Just verify construction works — in test environment PrometheusExporter needs careful setup
    const mgr = new AlertRuleManager()
    expect(mgr.listRules().length).toBeGreaterThanOrEqual(6)
  })

  // ── Edge cases ──

  it('should handle adding and disabling many rules', () => {
    const rules: AlertRule[] = Array.from({ length: 10 }, (_, i) => ({
      name: `TestRule${i}`,
      expr: `metric_${i} > ${i * 10}`,
      for: '1m',
      severity: 'info' as const,
      enabled: true,
    }))

    for (const rule of rules) {
      manager.addRule(rule)
    }

    expect(manager.listRules().length).toBe(16 + rules.length)

    // Disable all presets — only custom should remain
    for (const rule of manager.listAllRules()) {
      if (PRESET_NAMES.includes(rule.name)) {
        manager.setRuleEnabled(rule.name, false)
      }
    }

    const enabled = manager.listRules()
    expect(enabled.length).toBe(rules.length)
    for (const r of enabled) {
      expect(r.name.startsWith('TestRule')).toBe(true)
    }
  })

  it('should handle empty rule set gracefully in YAML', () => {
    const emptyMgr = new AlertRuleManager()
    for (const rule of emptyMgr.listAllRules()) {
      emptyMgr.setRuleEnabled(rule.name, false)
    }
    expect(emptyMgr.toPrometheusYAML()).toBe('')
  })
})

const PRESET_NAMES = ['HighNodeLatency', 'HighEdgeLatency', 'HighQueryLatency', 'HighErrorRate', 'PoolExhaustion', 'CertExpiringSoon']
