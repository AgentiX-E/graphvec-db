/**
 * otel-metrics.ts — OTel 指标收集器
 *
 * 提供计数器、直方图和仪表盘（Gauge）的便捷封装。
 * 所有操作在 Telemetry 未启用时是空操作。
 */
import { metrics, Meter, Counter, Histogram, Gauge } from '@opentelemetry/api'
import { Telemetry } from './otel'

/**
 * MetricsCollector — OTel 指标收集器
 *
 * 提供三种指标类型的便捷方法：
 * - incrementCounter: 计数器（累计值）
 * - recordHistogram: 直方图（延迟等分布数据）
 * - setGauge: 仪表盘（瞬时值）
 *
 * 所有方法在 Telemetry 未启用时直接返回，零开销。
 */
export class MetricsCollector {
  private static instance: MetricsCollector
  private meter: Meter | null = null
  private counters: Map<string, Counter> = new Map()
  private histograms: Map<string, Histogram> = new Map()
  private gauges: Map<string, Gauge> = new Map()
  private telemetry: Telemetry
  private _enabled: boolean = false

  private constructor() {
    this.telemetry = Telemetry.getInstance()
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector()
    }
    return MetricsCollector.instance
  }

  /**
   * 初始化（绑定到 OTel meter）
   * 当 Telemetry 启用后调用
   */
  init(meterName?: string): void {
    if (!this.telemetry.isEnabled()) return
    if (this._enabled) return

    this.meter = metrics.getMeter(meterName ?? 'agentiX-graphvec')
    this._enabled = true
  }

  /** 是否已启用 */
  isEnabled(): boolean {
    return this._enabled && this.telemetry.isEnabled()
  }

  /**
   * 增加计数器
   *
   * @param name  指标名称
   * @param value 增量（默认 1）
   */
  incrementCounter(name: string, value?: number): void {
    if (!this.isEnabled() || !this.meter) return

    let counter = this.counters.get(name)
    if (!counter) {
      counter = this.meter.createCounter(name, {
        description: `Counter: ${name}`,
      })
      this.counters.set(name, counter)
    }
    counter.add(value ?? 1)
  }

  /**
   * 记录直方图样本
   *
   * @param name  指标名称
   * @param value 样本值（如延迟毫秒数）
   */
  recordHistogram(name: string, value: number): void {
    if (!this.isEnabled() || !this.meter) return

    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = this.meter.createHistogram(name, {
        description: `Histogram: ${name}`,
        unit: 'ms',
      })
      this.histograms.set(name, histogram)
    }
    histogram.record(value)
  }

  /**
   * 设置仪表盘值
   *
   * @param name  指标名称
   * @param value 瞬时值
   */
  setGauge(name: string, value: number): void {
    if (!this.isEnabled() || !this.meter) return

    let gauge = this.gauges.get(name)
    if (!gauge) {
      gauge = this.meter.createGauge(name, {
        description: `Gauge: ${name}`,
      })
      this.gauges.set(name, gauge)
    }
    gauge.record(value)
  }
}
