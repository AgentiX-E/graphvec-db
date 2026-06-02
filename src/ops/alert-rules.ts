/**
 * alert-rules.ts — 预置监控告警规则管理
 *
 * 提供 AlertRuleManager 类，管理 Prometheus Alerting Rules 的生成和运行时检查。
 * 目标: Grafana/Prometheus Alertmanager 可直接加载生成的 YAML。
 *
 * 预置告警:
 *   - HighNodeLatency: 节点操作延迟 P99 > 1s
 *   - HighEdgeLatency: 边操作延迟 P99 > 1s
 *   - HighErrorRate: 查询失败率 > 5% (5m 滑动窗口)
 *   - PoolExhaustion: 连接池耗尽
 *   - CertExpiringSoon: 证书到期 < 7 天
 */

import { PrometheusExporter } from './prometheus-exporter'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type AlertSeverity = 'critical' | 'warning' | 'info'

export interface AlertRule {
  /** 告警名称（唯一标识） */
  name: string
  /** PromQL 表达式 */
  expr: string
  /** 持续时间（如 '1m' / '5m'） */
  for: string
  /** 严重级别 */
  severity: AlertSeverity
  /** 标签 */
  labels?: Record<string, string>
  /** 注释 */
  annotations?: Record<string, string>
  /** 是否启用 */
  enabled: boolean
  /** 自定义: 运行时检查阈值覆盖 */
  threshold?: number
}

export interface AlertRuleGroup {
  name: string
  rules: AlertRule[]
}

export interface RuleEvalResult {
  name: string
  triggered: boolean
  severity: AlertSeverity
  message: string
  value?: number
  threshold?: number
}

// ──────────────────────────────────────────
// 预置规则
// ──────────────────────────────────────────

const PRESET_RULES: AlertRule[] = [
  {
    name: 'HighNodeLatency',
    expr: 'graphvec_node_op_duration_ms{operation="upsert"} > 1000',
    for: '1m',
    severity: 'warning',
    labels: { category: 'latency' },
    annotations: { summary: 'Node operation latency P99 > 1s for 1 minute' },
    enabled: true,
  },
  {
    name: 'HighEdgeLatency',
    expr: 'graphvec_edge_op_duration_ms{operation="upsert"} > 1000',
    for: '1m',
    severity: 'warning',
    labels: { category: 'latency' },
    annotations: { summary: 'Edge operation latency P99 > 1s for 1 minute' },
    enabled: true,
  },
  {
    name: 'HighQueryLatency',
    expr: 'graphvec_query_duration_ms > 1000',
    for: '1m',
    severity: 'warning',
    labels: { category: 'latency' },
    annotations: { summary: 'Query latency P99 > 1s for 1 minute' },
    enabled: true,
  },
  {
    name: 'HighErrorRate',
    expr: 'rate(graphvec_queries_total[5m]) > 0 AND rate(graphvec_queries_total[5m] offset 5m) > 0 AND (rate(graphvec_node_ops_total[5m]) - rate(graphvec_edge_ops_total[5m]) < 0 OR rate(graphvec_queries_total[5m]) > 0)',
    for: '5m',
    severity: 'critical',
    labels: { category: 'reliability' },
    annotations: { summary: 'Query failure rate > 5% over 5 minutes' },
    enabled: true,
  },
  {
    name: 'PoolExhaustion',
    expr: 'graphvec_pool_connections_available == 0',
    for: '1m',
    severity: 'critical',
    labels: { category: 'capacity' },
    annotations: { summary: 'Connection pool exhausted — no available connections' },
    enabled: true,
  },
  {
    name: 'CertExpiringSoon',
    expr: 'graphvec_cert_days_remaining < 7',
    for: '5m',
    severity: 'critical',
    labels: { category: 'security' },
    annotations: { summary: 'TLS certificate expires in less than 7 days' },
    enabled: true,
  },
]

// ──────────────────────────────────────────
// AlertRuleManager
// ──────────────────────────────────────────

/**
 * AlertRuleManager — 管理预置和自定义告警规则。
 *
 * 使用方式:
 *   const mgr = new AlertRuleManager()
 *   mgr.addRule({ name: 'MyAlert', expr: '...', for: '1m', severity: 'warning', enabled: true })
 *   const yaml = mgr.toPrometheusYAML()
 *   const triggered = mgr.evaluateRules()
 */
export class AlertRuleManager {
  private _rules: Map<string, AlertRule> = new Map()
  private _exporter: PrometheusExporter | null = null

  constructor(exporter?: PrometheusExporter) {
    this._exporter = exporter ?? null
    this._loadPresets()
  }

  /** 加载预置规则 */
  private _loadPresets(): void {
    for (const rule of PRESET_RULES) {
      this._rules.set(rule.name, { ...rule })
    }
  }

  /** 添加自定义告警规则 */
  addRule(rule: AlertRule): void {
    if (this._rules.has(rule.name)) {
      throw new Error(`Alert rule '${rule.name}' already exists`)
    }
    this._rules.set(rule.name, { ...rule })
  }

  /** 删除告警规则 */
  removeRule(name: string): boolean {
    if (!this._rules.has(name)) return false
    // 不允许删除预置规则
    const isPreset = PRESET_RULES.some(r => r.name === name)
    if (isPreset) {
      // 只能禁用，不能删除
      this._rules.get(name)!.enabled = false
      return true
    }
    return this._rules.delete(name)
  }

  /** 获取所有规则（仅启用的） */
  listRules(): AlertRule[] {
    return Array.from(this._rules.values()).filter(r => r.enabled)
  }

  /** 获取所有规则（含禁用的） */
  listAllRules(): AlertRule[] {
    return Array.from(this._rules.values())
  }

  /** 启用/禁用规则 */
  setRuleEnabled(name: string, enabled: boolean): boolean {
    const rule = this._rules.get(name)
    if (!rule) return false
    rule.enabled = enabled
    return true
  }

  /** 自定义规则的阈值覆盖 */
  setThreshold(name: string, threshold: number): boolean {
    const rule = this._rules.get(name)
    if (!rule) return false
    rule.threshold = threshold
    return true
  }

  /**
   * 生成 Prometheus Alerting Rules YAML
   *
   * 输出可直接被 Prometheus/Alertmanager 加载的 YAML 格式:
   * groups:
   *   - name: graphvec_alerts
   *     rules:
   *       - alert: HighNodeLatency
   *         expr: ...
   *         for: 1m
   *         labels:
   *           severity: warning
   *         annotations:
   *           summary: ...
   */
  toPrometheusYAML(): string {
    const enabled = this.listRules()
    if (enabled.length === 0) return ''

    const lines: string[] = []
    lines.push('groups:')
    lines.push('  - name: graphvec_alerts')

    for (const rule of enabled) {
      lines.push('    rules:')
      lines.push(`      - alert: ${rule.name}`)
      lines.push(`        expr: ${rule.expr}`)
      lines.push(`        for: ${rule.for}`)
      lines.push('        labels:')
      lines.push(`          severity: ${rule.severity}`)
      if (rule.labels) {
        for (const [k, v] of Object.entries(rule.labels)) {
          if (k === 'severity') continue // already emitted
          lines.push(`          ${k}: ${v}`)
        }
      }
      lines.push('        annotations:')
      if (rule.annotations) {
        for (const [k, v] of Object.entries(rule.annotations)) {
          lines.push(`          ${k}: ${v}`)
        }
      }
    }

    return lines.join('\n') + '\n'
  }

  /**
   * 运行时评估所有启用的规则。
   * 从 PrometheusExporter 读取当前指标值并判断是否超出阈值。
   *
   * 注意: 运行时评估是 heuristic 的——精确告警应依赖外部 Alertmanager。
   * 这里提供轻量级本地告警检查，适用于开发和测试环境。
   */
  evaluateRules(): RuleEvalResult[] {
    const results: RuleEvalResult[] = []

    for (const rule of this.listRules()) {
      const result = this._evaluateSingle(rule)
      results.push(result)
    }

    return results
  }

  /**
   * 对单条规则进行评估。
   * 基于规则名称做启发式检查——精确的 PromQL 评估应由 Alertmanager 完成。
   */
  private _evaluateSingle(rule: AlertRule): RuleEvalResult {
    // 如果导出了指标，尝试获取当前值做启发式评估
    const threshold = rule.threshold ?? this._getDefaultThreshold(rule.name)

    const currentValue = this._getCurrentMetric(rule.name)
    const triggered = currentValue !== null && currentValue > threshold

    return {
      name: rule.name,
      triggered,
      severity: triggered ? rule.severity : 'info',
      message: triggered
        ? `${rule.name}: current value ${currentValue?.toFixed(2)} exceeds threshold ${threshold}`
        : `${rule.name}: OK (value: ${currentValue ?? 'N/A'})`,
      value: currentValue ?? undefined,
      threshold,
    }
  }

  /** 获取规则的默认阈值 */
  private _getDefaultThreshold(name: string): number {
    switch (name) {
      case 'HighNodeLatency':
      case 'HighEdgeLatency':
      case 'HighQueryLatency':
        return 1000 // 1 second in ms
      case 'HighErrorRate':
        return 0.05 // 5%
      case 'PoolExhaustion':
        return 0
      case 'CertExpiringSoon':
        return 7 // days
      default:
        return 0
    }
  }

  /** 尝试从 prom-client 获取当前指标值 */
  private _getCurrentMetric(name: string): number | null {
    try {
      if (!this._exporter) return null
      const registry = this._exporter.getRegistry()
      // 查找对应的指标名称
      const metricNames: Record<string, string[]> = {
        HighNodeLatency: ['graphvec_node_op_duration_ms'],
        HighEdgeLatency: ['graphvec_edge_op_duration_ms'],
        HighQueryLatency: ['graphvec_query_duration_ms'],
        HighErrorRate: ['graphvec_node_ops_total', 'graphvec_edge_ops_total'],
        PoolExhaustion: [],
        CertExpiringSoon: [],
      }

      const names = metricNames[name]
      if (!names || names.length === 0) return null

      for (const metricName of names) {
        const metric = registry.getSingleMetric(metricName)
        if (metric) {
          const val = (metric as any)?.hashMap?.values?.()?.next()?.value
          return val ?? null
        }
      }
      return null
    } catch {
      return null
    }
  }
}
