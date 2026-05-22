/**
 * otel.ts — OpenTelemetry 可观测性核心模块
 *
 * 提供分布式追踪（tracing）和指标（metrics）采集的基础设施。
 *
 * 设计原则：
 * 1. OTel 是可选依赖：Telemetry.enabled === false 时所有埋点操作零开销
 * 2. 默认不启用：需要显式 Telemetry.getInstance().init() 才激活
 * 3. SDK 初始化在应用启动时调用，不在构造函数中自动初始化
 * 4. 埋点只添加，不修改原有行为逻辑
 */
import { trace, context, Span, SpanStatusCode, Tracer, DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api'
import { NodeSDK, NodeSDKConfiguration } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { Logger } from './logger'

/**
 * Telemetry — OTel 可观测性单例
 *
 * 管理全局 Tracer 和 SDK 生命周期。
 * enabled 为 false 时，所有操作都是空操作（if guard 直接返回）。
 */
export class Telemetry {
  private static instance: Telemetry
  private tracer: Tracer | null = null
  private sdk: NodeSDK | null = null
  private _enabled: boolean = false
  private logger: Logger

  private constructor() {
    this.logger = new Logger('Telemetry')
  }

  static getInstance(): Telemetry {
    if (!Telemetry.instance) {
      Telemetry.instance = new Telemetry()
    }
    return Telemetry.instance
  }

  /** 是否已启用 */
  isEnabled(): boolean {
    return this._enabled
  }

  /**
   * 初始化 OTel SDK
   *
   * @param serviceName  服务名称（默认 'agentiX-graphvec'）
   * @param otlpEndpoint OTLP gRPC 端点（默认 'http://localhost:4317'）
   */
  async init(serviceName?: string, otlpEndpoint?: string): Promise<void> {
    if (this._enabled) return

    const name = serviceName ?? 'agentiX-graphvec'
    let endpoint = otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317'
    if (!endpoint) endpoint = 'http://localhost:4317'

    // 开发环境开启诊断日志便于调试
    if (process.env.NODE_ENV !== 'production') {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)
    }

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: name,
      [ATTR_SERVICE_VERSION]: '0.1.0',
    })

    try {
      // Trace exporter
      const traceExporter = new OTLPTraceExporter({
        url: endpoint,
      })

      // Metric exporter with periodic export
      const metricExporter = new OTLPMetricExporter({
        url: endpoint,
      })
      const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60000, // 每分钟导出一次
      })

      this.sdk = new NodeSDK({
        resource,
        traceExporter,
        metricReader,
        serviceName: name,
      } as Partial<NodeSDKConfiguration> as NodeSDKConfiguration)

      await this.sdk.start()
      this._enabled = true
      this.tracer = trace.getTracer(name)
      this.logger.info(`OTel SDK initialized, exporting to ${endpoint}`)
    } catch (err) {
      this.logger.error('Failed to initialize OTel SDK:', err as Error)
      // 初始化失败不阻止应用继续运行
      this._enabled = false
    }
  }

  /** 关闭 OTel SDK（优雅退出时调用） */
  async shutdown(): Promise<void> {
    if (!this._enabled || !this.sdk) {
      this._enabled = false
      return
    }
    try {
      await this.sdk.shutdown()
      this.logger.info('OTel SDK shut down')
    } catch (err) {
      this.logger.error('OTel SDK shutdown error:', err as Error)
    }
    this._enabled = false
    this.tracer = null
  }

  /** 获取当前 Tracer */
  getTracer(): Tracer | null {
    return this.tracer
  }

  /**
   * 创建一个新的 span（仅 enabled 时有实际作用）
   *
   * @param name       span 名称
   * @param parentSpan 可选的父 span（用于构建 span 层次）
   */
  startSpan(name: string, parentSpan?: Span): Span | null {
    if (!this._enabled || !this.tracer) return null

    if (parentSpan) {
      const ctx = trace.setSpan(context.active(), parentSpan)
      return this.tracer.startSpan(name, undefined, ctx)
    }
    return this.tracer.startSpan(name)
  }

  /**
   * 结束一个 span，设置状态码
   *
   * @param span 要结束的 span
   * @param error 可选的错误（设置 SpanStatusCode.ERROR）
   */
  endSpan(span: Span | null, error?: Error): void {
    if (!span) return
    if (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end()
  }

  /**
   * 快捷包装异步操作，自动创建和结束 span
   *
   * 在 enabled 状态下，用 span 包裹 fn 的执行；
   * 在 disabled 状态下，直接调用 fn（零开销）。
   *
   * @param name span 名称
   * @param fn   要追踪的异步操作
   */
  async traceAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this._enabled || !this.tracer) {
      return fn()
    }

    const span = this.tracer.startSpan(name)
    try {
      const ctx = trace.setSpan(context.active(), span)
      const result = await context.with(ctx, fn)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
      span.recordException(err as Error)
      throw err
    } finally {
      span.end()
    }
  }
}
