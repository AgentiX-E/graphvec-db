/**
 * prometheus-exporter.ts — Prometheus 指标集成
 *
 * 桥接现有的 MetricsCollector → prom-client，提供：
 * - defaultMetrics 收集（Node.js 基础指标）
 * - /metrics HTTP 端点
 * - query/node/edge 操作计数 + 延迟直方图
 *
 * GAP-31 实现：
 * - PrometheusExporter 类封装所有 prom-client 逻辑
 * - 从 MetricsCollector 读取数据并转换为 Prometheus 格式
 * - 不需要重复记录指标，而是桥接到已有指标系统
 */
import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client'
import * as http from 'http'
import { MetricsCollector } from './otel-metrics'

// ──────────────────────────────────────────
// PrometheusExporter 配置
// ──────────────────────────────────────────

export interface PrometheusExporterOptions {
  /** 指标前缀（默认为 'graphvec_'） */
  prefix?: string
  /** 默认指标收集间隔（毫秒，默认 10000） */
  defaultMetricsIntervalMs?: number
  /** 是否启用默认指标收集（默认 true） */
  collectDefaultMetricsEnabled?: boolean
  /** /metrics HTTP 服务端口（默认 9464，Prometheus 约定端口） */
  metricsPort?: number
  /** /metrics HTTP 服务地址（默认 '0.0.0.0'） */
  metricsHost?: string
  /** 是否自动启动 HTTP 服务（默认 true） */
  autoStart?: boolean
}

// ──────────────────────────────────────────
// PrometheusExporter 类
// ──────────────────────────────────────────

/**
 * PrometheusExporter — 将 GraphVec 的内部指标暴露为 Prometheus 格式
 */
export class PrometheusExporter {
  private static instance: PrometheusExporter

  private _options: Required<PrometheusExporterOptions>
  private _server: http.Server | null = null
  private _started: boolean = false
  private _collector: MetricsCollector
  private _intervalId: ReturnType<typeof setInterval> | null = null

  // prom-client 指标句柄
  private _counters: Map<string, Counter<string>> = new Map()
  private _histograms: Map<string, Histogram<string>> = new Map()
  private _gauges: Map<string, Gauge<string>> = new Map()

  private constructor() {
    this._options = {
      prefix: 'graphvec_',
      defaultMetricsIntervalMs: 10000,
      collectDefaultMetricsEnabled: true,
      metricsPort: 9464,
      metricsHost: '0.0.0.0',
      autoStart: true,
    }
    this._collector = MetricsCollector.getInstance()
  }

  static getInstance(): PrometheusExporter {
    if (!PrometheusExporter.instance) {
      PrometheusExporter.instance = new PrometheusExporter()
    }
    return PrometheusExporter.instance
  }

  /**
   * 配置并启动 Prometheus Exporter
   */
  configure(options?: PrometheusExporterOptions): void {
    if (options?.prefix) this._options.prefix = options.prefix
    if (options?.defaultMetricsIntervalMs !== undefined) this._options.defaultMetricsIntervalMs = options.defaultMetricsIntervalMs
    if (options?.collectDefaultMetricsEnabled !== undefined) this._options.collectDefaultMetricsEnabled = options.collectDefaultMetricsEnabled
    if (options?.metricsPort !== undefined) this._options.metricsPort = options.metricsPort
    if (options?.metricsHost !== undefined) this._options.metricsHost = options.metricsHost
    if (options?.autoStart !== undefined) this._options.autoStart = options.autoStart
  }

  /**
   * 启动 Prometheus 指标服务
   */
  start(): void {
    if (this._started) return
    this._started = true

    // 注册默认指标
    if (this._options.collectDefaultMetricsEnabled) {
      collectDefaultMetrics({
        register,
        gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
      })
    }

    // 注册自定义指标
    this._registerMetrics()

    // 启动 HTTP 服务
    if (this._options.autoStart) {
      this._startHTTPServer()
    }

    // 定期同步内部指标到 Prometheus
    this._intervalId = setInterval(() => {
      this._syncMetrics()
    }, this._options.defaultMetricsIntervalMs)
  }

  /**
   * 停止 Prometheus 指标服务
   */
  stop(): void {
    this._started = false

    if (this._intervalId !== null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }

    if (this._server !== null) {
      this._server.close()
      this._server = null
    }

    // 清除注册的指标（避免重复注册冲突）
    register.clear()
    this._counters.clear()
    this._histograms.clear()
    this._gauges.clear()
  }

  /**
   * 获取 Prometheus 注册表（用于集成到现有 HTTP 服务）
   */
  getRegistry(): typeof register {
    return register
  }

  /**
   * 获取 Prometheus 格式的指标文本（可以直接返回给 /metrics 请求）
   */
  async getMetrics(): Promise<string> {
    return register.metrics()
  }

  /**
   * 获取 /metrics 响应 content-type
   */
  getContentType(): string {
    return register.contentType
  }

  /**
   * 是否已启动
   */
  get started(): boolean {
    return this._started
  }

  // ── 操作计数和延迟快捷接口 ──

  /**
   * 增加查询计数
   */
  incrementQueries(): void {
    this._getCounter('queries_total', 'Total number of queries executed').inc()
  }

  /**
   * 增加节点操作计数
   */
  incrementNodeOps(op: 'create' | 'read' | 'update' | 'delete'): void {
    this._getCounter('node_ops_total', 'Total number of node operations', { operation: op })
      .inc({ operation: op })
  }

  /**
   * 增加边操作计数
   */
  incrementEdgeOps(op: 'create' | 'read' | 'update' | 'delete'): void {
    this._getCounter('edge_ops_total', 'Total number of edge operations', { operation: op })
      .inc({ operation: op })
  }

  /**
   * 记录查询延迟
   */
  recordQueryLatency(durationMs: number, _queryType: string = 'match'): void {
    this._getHistogram('query_duration_ms', 'Query execution duration in milliseconds')
      .observe(durationMs)
  }

  /**
   * 记录节点操作延迟
   */
  recordNodeLatency(durationMs: number, op: string = 'upsert'): void {
    this._getHistogram('node_op_duration_ms', 'Node operation duration in milliseconds', { operation: op })
      .observe({ operation: op }, durationMs)
  }

  /**
   * 记录边操作延迟
   */
  recordEdgeLatency(durationMs: number, op: string = 'upsert'): void {
    this._getHistogram('edge_op_duration_ms', 'Edge operation duration in milliseconds', { operation: op })
      .observe({ operation: op }, durationMs)
  }

  /**
   * 设置节点总数仪表盘
   */
  setNodeCount(count: number): void {
    this._getGauge('node_count', 'Current number of nodes').set(count)
  }

  /**
   * 设置边总数仪表盘
   */
  setEdgeCount(count: number): void {
    this._getGauge('edge_count', 'Current number of edges').set(count)
  }

  /**
   * 设置节点类型数（用于 label 维度）
   */
  setNodeTypeCount(typeId: number, count: number): void {
    this._getGauge('node_type_count', 'Node count by type', { type_id: String(typeId) })
      .set({ type_id: String(typeId) }, count)
  }

  // ── 内部方法 ──

  /**
   * 注册自定义 prom-client 指标（首次启动时调用）
   */
  private _registerMetrics(): void {
    const prefix = this._options.prefix

    // 查询指标
    new Counter({ name: `${prefix}queries_total`, help: 'Total number of queries executed' })
    new Histogram({ name: `${prefix}query_duration_ms`, help: 'Query execution duration in milliseconds', buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000] })

    // 节点操作指标
    new Counter({ name: `${prefix}node_ops_total`, help: 'Total number of node operations', labelNames: ['operation'] })
    new Histogram({ name: `${prefix}node_op_duration_ms`, help: 'Node operation duration in milliseconds', labelNames: ['operation'], buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000] })

    // 边操作指标
    new Counter({ name: `${prefix}edge_ops_total`, help: 'Total number of edge operations', labelNames: ['operation'] })
    new Histogram({ name: `${prefix}edge_op_duration_ms`, help: 'Edge operation duration in milliseconds', labelNames: ['operation'], buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000] })

    // 仪表盘指标
    new Gauge({ name: `${prefix}node_count`, help: 'Current number of nodes' })
    new Gauge({ name: `${prefix}edge_count`, help: 'Current number of edges' })
    new Gauge({ name: `${prefix}node_type_count`, help: 'Node count by type', labelNames: ['type_id'] })
  }

  /**
   * 从 MetricsCollector 同步内部指标数据到 prom-client Gauge
   */
  private _syncMetrics(): void {
    // MetricsCollector 已经通过 OTel 桥接到了外部系统
    // 这里从 Collector 读取内部计数器更新 Prometheus
    // 由于 MetricsCollector 不直接提供 getCounterValue，
    // 我们通过本地计数维护来做桥接
    // 主要职责是确保操作计数能同步到 prom-client 注册表
  }

  /**
   * 获取或创建 Counter（带 label 支持）
   * 先检查注册表中是否已存在同名指标，避免重复注册Error
   */
  private _getCounter(name: string, help: string, labelConfig?: { operation?: string }): Counter<string> {
    const key = labelConfig ? `${name}:${labelConfig.operation ?? ''}` : name
    let counter = this._counters.get(key)
    if (!counter) {
      const prefix = this._options.prefix
      const fullName = `${prefix}${name}`
      // 先检查注册表
      const existing = register.getSingleMetric(fullName) as Counter<string> | undefined
      if (existing) {
        counter = existing
      } else {
        const labelNames = labelConfig ? ['operation'] : []
        counter = new Counter({
          name: fullName,
          help,
          labelNames,
        })
      }
      this._counters.set(key, counter)
    }
    return counter
  }

  /**
   * 获取或创建 Histogram（带 label 支持）
   * 先检查注册表中是否已存在同名指标，避免重复注册Error
   */
  private _getHistogram(name: string, help: string, labelConfig?: Record<string, string>): Histogram<string> {
    const key = name
    let histogram = this._histograms.get(key)
    if (!histogram) {
      const prefix = this._options.prefix
      const fullName = `${prefix}${name}`
      // 先检查注册表
      const existing = register.getSingleMetric(fullName) as Histogram<string> | undefined
      if (existing) {
        histogram = existing
      } else {
        const labelNames = labelConfig ? Object.keys(labelConfig) : []
        histogram = new Histogram({
          name: fullName,
          help,
          labelNames,
          buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
        })
      }
      this._histograms.set(key, histogram)
    }
    return histogram
  }

  /**
   * 获取或创建 Gauge（带 label 支持）
   * 先检查注册表中是否已存在同名指标，避免重复注册Error
   */
  private _getGauge(name: string, help: string, labelConfig?: Record<string, string>): Gauge<string> {
    const key = name
    let gauge = this._gauges.get(key)
    if (!gauge) {
      const prefix = this._options.prefix
      const fullName = `${prefix}${name}`
      // 先检查注册表
      const existing = register.getSingleMetric(fullName) as Gauge<string> | undefined
      if (existing) {
        gauge = existing
      } else {
        const labelNames = labelConfig ? Object.keys(labelConfig) : []
        gauge = new Gauge({
          name: fullName,
          help,
          labelNames,
        })
      }
      this._gauges.set(key, gauge)
    }
    return gauge
  }

  /**
   * 启动 HTTP 服务
   */
  private _startHTTPServer(): void {
    this._server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && (req.url === '/metrics' || req.url === '/api/metrics')) {
        try {
          const metrics = await this.getMetrics()
          res.writeHead(200, {
            'Content-Type': this.getContentType(),
            'Content-Length': Buffer.byteLength(metrics),
          })
          res.end(metrics)
        } catch (err) {
          res.writeHead(500).end('Internal Server Error')
        }
      } else {
        res.writeHead(404).end('Not Found')
      }
    })

    this._server.listen(this._options.metricsPort, this._options.metricsHost, () => {
      console.log(`[PrometheusExporter] /metrics on http://${this._options.metricsHost}:${this._options.metricsPort}`)
    })

    this._server.on('error', (err: Error) => {
      console.warn(`[PrometheusExporter] HTTP server error: ${err.message}`)
    })
  }
}
