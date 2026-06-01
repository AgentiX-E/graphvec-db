/**
 * Metrics — 指标收集器
 *
 * 统一指标收集接口，底层委托给 OTel MetricsCollector。
 * 兼容旧代码的 Metrics 使用方式，同时将指标路由到 OpenTelemetry。
 *
 * 所有操作在 Telemetry 未启用时是空操作。
 * 同时维护本地快照以支持立即获取 snapshot()。
 */

import { MetricsSnapshot } from '../types'
import { MetricsCollector } from './otel-metrics'

export class Metrics {
  private counters: Map<string, number> = new Map()
  private latencies: Map<string, number[]> = new Map()
  private startTime = Date.now()
  private otelCollector: MetricsCollector

  constructor() {
    this.otelCollector = MetricsCollector.getInstance()
  }

  /** 增加计数器（同时更新 OTel） */
  incrementCounter(name: string, delta: number = 1): void {
    // 更新本地计数器
    const current = this.counters.get(name) || 0
    this.counters.set(name, current + delta)

    // 委托给 OTel
    this.otelCollector.incrementCounter(name, delta)
  }

  /** 记录延迟样本（同时记录 OTel 直方图） */
  recordLatency(name: string, latencyMs: number): void {
    // 更新本地样本
    if (!this.latencies.has(name)) {
      this.latencies.set(name, [])
    }
    const samples = this.latencies.get(name)!
    samples.push(latencyMs)
    // 只保留最近 1000 个样本
    if (samples.length > 1000) {
      samples.shift()
    }

    // 委托给 OTel
    this.otelCollector.recordHistogram(name, latencyMs)
  }

  /** 获取当前快照 */
  snapshot(): MetricsSnapshot {
    const elapsed = (Date.now() - this.startTime) / 1000
    const ops = this.counters.get('ops') || 0

    return {
      timestamp: Date.now(),
      opsPerSecond: elapsed > 0 ? Math.round(ops / elapsed) : 0,
      readLatencyP50: this._percentile('read', 0.5),
      readLatencyP99: this._percentile('read', 0.99),
      writeLatencyP50: this._percentile('write', 0.5),
      writeLatencyP99: this._percentile('write', 0.99),
      raftCommitLatencyP99: this._percentile('raft_commit', 0.99),
      activeSessions: this.counters.get('active_sessions') || 0,
      shardCount: this.counters.get('shard_count') || 0,
    }
  }

  /** 获取计数器值 */
  getCounter(name: string): number {
    return this.counters.get(name) || 0
  }

  /** 重置指标 */
  reset(): void {
    this.counters.clear()
    this.latencies.clear()
    this.startTime = Date.now()
  }

  private _percentile(name: string, p: number): number {
    const samples = this.latencies.get(name)
    if (!samples || samples.length === 0) return 0

    const sorted = [...samples].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * p)
    return sorted[Math.min(idx, sorted.length - 1)]
  }
}
