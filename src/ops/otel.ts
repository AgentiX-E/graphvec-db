/**
 * otel.ts — OpenTelemetry 可观测性核心模块
 *
 * 提供分布式Trace（tracing）和指标（metrics）采集的基础设施。
 *
 * 设计原则：
 * 1. OTel 是Optional依赖：Telemetry.enabled === false 时所有埋点操作零开销
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
 * 导出配置，支持 OTLP gRPC/HTTP 及 Jaeger/Zipkin 兼容格式
 */
export interface TelemetryExportConfig {
  /** OTLP gRPC 端点（默认从 OTEL_EXPORTER_OTLP_ENDPOINT 读取，兜底 http://localhost:4317） */
  otlpGrpcEndpoint?: string
  /** OTLP HTTP 端点（若设置则同时注册 OTLP HTTP trace exporter） */
  otlpHttpEndpoint?: string
  /** Jaeger 兼容端点（使用 OTLP HTTP 格式发送到 Jaeger Collector） */
  jaegerEndpoint?: string
  /** Zipkin 端点（使用 OTLP HTTP JSON 格式发送到 Zipkin） */
  zipkinEndpoint?: string
}

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
   * 根据环境变量解析导出配置。
   * 优先级：环境变量 > 参数
   */
  private _resolveExportConfig(): TelemetryExportConfig {
    const config: TelemetryExportConfig = {}
    if (process.env.OTEL_EXPORTER_JAEGER_ENDPOINT) {
      config.jaegerEndpoint = process.env.OTEL_EXPORTER_JAEGER_ENDPOINT
    }
    if (process.env.OTEL_EXPORTER_ZIPKIN_ENDPOINT) {
      config.zipkinEndpoint = process.env.OTEL_EXPORTER_ZIPKIN_ENDPOINT
    }
    if (process.env.OTEL_EXPORTER_OTLP_HTTP_ENDPOINT) {
      config.otlpHttpEndpoint = process.env.OTEL_EXPORTER_OTLP_HTTP_ENDPOINT
    }
    return config
  }

  /**
   * 创建 trace exporter 列表（支持多 exporter 并行导出）。
   * 可用于同时输出到 OTLP + Jaeger + Zipkin。
   */
  private _createTraceExporters(config: TelemetryExportConfig): any[] {
    const exporters: any[] = []

    // 1. OTLP gRPC exporter — 默认主 exporter
    exporters.push(new OTLPTraceExporter({
      url: config.otlpGrpcEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317',
    }))

    // 2. OTLP HTTP exporter — 如果配置了 HTTP 端点
    if (config.otlpHttpEndpoint) {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
      const { OTLPTraceExporter: OTLPHttpExporter } = require('@opentelemetry/exporter-trace-otlp-http')
      exporters.push(new OTLPHttpExporter({
        url: config.otlpHttpEndpoint,
      }))
    }

    // 3. Jaeger 兼容导出（通过 OTLP HTTP 到 Jaeger Collector）
    if (config.jaegerEndpoint) {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
      const { OTLPTraceExporter: OTLPHttpExporter } = require('@opentelemetry/exporter-trace-otlp-http')
      exporters.push(new OTLPHttpExporter({
        url: config.jaegerEndpoint,
      }))
    }

    return exporters
  }

  /**
   * 初始化 OTel SDK
   *
   * @param serviceName  服务名称（默认 'agentiX-graphvec'）
   * @param otlpEndpoint OTLP gRPC 端点（默认 'http://localhost:4317'）
   * @param exportConfig Optional的多 exporter 配置（优先级低于环境变量）
   */
  async init(
    serviceName?: string,
    otlpEndpoint?: string,
    exportConfig?: TelemetryExportConfig,
  ): Promise<void> {
    if (this._enabled) return

    const name = serviceName ?? 'agentiX-graphvec'
    let endpoint = otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317'
    if (!endpoint) endpoint = 'http://localhost:4317'

    // 开发环境开启诊断日志便于Debug
    if (process.env.NODE_ENV !== 'production') {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)
    }

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: name,
      [ATTR_SERVICE_VERSION]: '0.1.0',
    })

    try {
      // 合并导出配置（环境变量优先）
      const resolvedExportConfig: TelemetryExportConfig = {
        otlpGrpcEndpoint: endpoint,
        ...this._resolveExportConfig(),
        ...exportConfig,
      }

      // 创建 trace exporters
      const traceExporters = this._createTraceExporters(resolvedExportConfig)
      // OTLP gRPC 是第一个 exporter，单独提取用于 SDK 构造
      const traceExporter = traceExporters[0]

      // Metric exporter with periodic export
      const metricExporter = new OTLPMetricExporter({
        url: endpoint,
      })
      const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60000, // 每分钟导出一次
      })

      const sdkConfig: any = {
        resource,
        traceExporter,
        metricReader,
        serviceName: name,
      }

      // If any其他 trace exporters（OTLP HTTP / Jaeger / Zipkin），通过 span processor 注册
      if (traceExporters.length > 1) {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
        const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base')
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
        const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
        const additionalProcessors = traceExporters.slice(1).map(
          (e: any) => new SimpleSpanProcessor(e),
        )
        sdkConfig.spanProcessors = additionalProcessors
      }

      this.sdk = new NodeSDK(sdkConfig)

      await this.sdk.start()
      this._enabled = true
      this.tracer = trace.getTracer(name)
      this.logger.info(`OTel SDK initialized, trace exporters: ${traceExporters.length}, endpoint: ${endpoint}`)
    } catch (err) {
      this.logger.error('Failed to initialize OTel SDK:', err as Error)
      // 初始化失败不阻止应用继续运行
      this._enabled = false
    }
  }

  /**
   * 注册自动 instrumentation。
   * 需要在 SDK start 之前调用或作为 init 的一部分传入。
   *
   * 通过 environment.config() 注册 instrumentations 有两种方式：
   * 1. 调用此方法手动注册（需要 SDK start 之前）
   * 2. 在 init() 中通过配置传入
   */
  registerInstrumentations(): void {
    if (this._enabled) return // 必须在 init 之前调用

    try {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
      const { registerInstrumentations } = require('@opentelemetry/instrumentation')
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
      const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
      const { FastifyInstrumentation } = require('@opentelemetry/instrumentation-fastify')

      registerInstrumentations({
        instrumentations: [
          new HttpInstrumentation({
            // HTTP 请求/响应自动Trace
            ignoreIncomingRequestHook: (req: any) => {
              // 忽略健康检查等内部端点
              if (req.url) {
                const url = req.url as string
                if (url === '/health' || url === '/live' || url === '/ready') return true
                if (url.startsWith('/metrics')) return true
              }
              return false
            },
          }),
          new FastifyInstrumentation({
            // Fastify 路由层次自动Trace
          }),
        ],
      })
      this.logger.info('OTel instrumentations registered: http, fastify')
    } catch (err) {
      this.logger.error('Failed to register instrumentations:', err as Error)
    }
  }

  /**
   * 便捷方法：初始化并同时注册自动 instrumentation。
   * 等价于先调用 registerInstrumentations()，再调用 init()。
   */
  async initWithInstrumentations(
    serviceName?: string,
    otlpEndpoint?: string,
    exportConfig?: TelemetryExportConfig,
  ): Promise<void> {
    this.registerInstrumentations()
    await this.init(serviceName, otlpEndpoint, exportConfig)
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
   * @param parentSpan Optional的父 span（用于构建 span 层次）
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
   * @param error Optional的Error（设置 SpanStatusCode.ERROR）
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
   * @param fn   要Trace的异步操作
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
