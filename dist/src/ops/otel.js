"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Telemetry = void 0;
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
const api_1 = require("@opentelemetry/api");
const sdk_node_1 = require("@opentelemetry/sdk-node");
const exporter_trace_otlp_grpc_1 = require("@opentelemetry/exporter-trace-otlp-grpc");
const exporter_metrics_otlp_grpc_1 = require("@opentelemetry/exporter-metrics-otlp-grpc");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const sdk_metrics_1 = require("@opentelemetry/sdk-metrics");
const logger_1 = require("./logger");
/**
 * Telemetry — OTel 可观测性单例
 *
 * 管理全局 Tracer 和 SDK 生命周期。
 * enabled 为 false 时，所有操作都是空操作（if guard 直接返回）。
 */
class Telemetry {
    static instance;
    tracer = null;
    sdk = null;
    _enabled = false;
    logger;
    constructor() {
        this.logger = new logger_1.Logger('Telemetry');
    }
    static getInstance() {
        if (!Telemetry.instance) {
            Telemetry.instance = new Telemetry();
        }
        return Telemetry.instance;
    }
    /** 是否已启用 */
    isEnabled() {
        return this._enabled;
    }
    /**
     * 初始化 OTel SDK
     *
     * @param serviceName  服务名称（默认 'agentiX-graphvec'）
     * @param otlpEndpoint OTLP gRPC 端点（默认 'http://localhost:4317'）
     */
    async init(serviceName, otlpEndpoint) {
        if (this._enabled)
            return;
        const name = serviceName ?? 'agentiX-graphvec';
        let endpoint = otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';
        if (!endpoint)
            endpoint = 'http://localhost:4317';
        // 开发环境开启诊断日志便于调试
        if (process.env.NODE_ENV !== 'production') {
            api_1.diag.setLogger(new api_1.DiagConsoleLogger(), api_1.DiagLogLevel.WARN);
        }
        const resource = (0, resources_1.resourceFromAttributes)({
            [semantic_conventions_1.ATTR_SERVICE_NAME]: name,
            [semantic_conventions_1.ATTR_SERVICE_VERSION]: '0.1.0',
        });
        try {
            // Trace exporter
            const traceExporter = new exporter_trace_otlp_grpc_1.OTLPTraceExporter({
                url: endpoint,
            });
            // Metric exporter with periodic export
            const metricExporter = new exporter_metrics_otlp_grpc_1.OTLPMetricExporter({
                url: endpoint,
            });
            const metricReader = new sdk_metrics_1.PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: 60000, // 每分钟导出一次
            });
            this.sdk = new sdk_node_1.NodeSDK({
                resource,
                traceExporter,
                metricReader,
                serviceName: name,
            });
            await this.sdk.start();
            this._enabled = true;
            this.tracer = api_1.trace.getTracer(name);
            this.logger.info(`OTel SDK initialized, exporting to ${endpoint}`);
        }
        catch (err) {
            this.logger.error('Failed to initialize OTel SDK:', err);
            // 初始化失败不阻止应用继续运行
            this._enabled = false;
        }
    }
    /** 关闭 OTel SDK（优雅退出时调用） */
    async shutdown() {
        if (!this._enabled || !this.sdk) {
            this._enabled = false;
            return;
        }
        try {
            await this.sdk.shutdown();
            this.logger.info('OTel SDK shut down');
        }
        catch (err) {
            this.logger.error('OTel SDK shutdown error:', err);
        }
        this._enabled = false;
        this.tracer = null;
    }
    /** 获取当前 Tracer */
    getTracer() {
        return this.tracer;
    }
    /**
     * 创建一个新的 span（仅 enabled 时有实际作用）
     *
     * @param name       span 名称
     * @param parentSpan 可选的父 span（用于构建 span 层次）
     */
    startSpan(name, parentSpan) {
        if (!this._enabled || !this.tracer)
            return null;
        if (parentSpan) {
            const ctx = api_1.trace.setSpan(api_1.context.active(), parentSpan);
            return this.tracer.startSpan(name, undefined, ctx);
        }
        return this.tracer.startSpan(name);
    }
    /**
     * 结束一个 span，设置状态码
     *
     * @param span 要结束的 span
     * @param error 可选的错误（设置 SpanStatusCode.ERROR）
     */
    endSpan(span, error) {
        if (!span)
            return;
        if (error) {
            span.setStatus({ code: api_1.SpanStatusCode.ERROR, message: error.message });
        }
        else {
            span.setStatus({ code: api_1.SpanStatusCode.OK });
        }
        span.end();
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
    async traceAsync(name, fn) {
        if (!this._enabled || !this.tracer) {
            return fn();
        }
        const span = this.tracer.startSpan(name);
        try {
            const ctx = api_1.trace.setSpan(api_1.context.active(), span);
            const result = await api_1.context.with(ctx, fn);
            span.setStatus({ code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (err) {
            span.setStatus({ code: api_1.SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            throw err;
        }
        finally {
            span.end();
        }
    }
}
exports.Telemetry = Telemetry;
//# sourceMappingURL=otel.js.map