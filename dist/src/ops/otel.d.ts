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
import { Span, Tracer } from '@opentelemetry/api';
/**
 * Telemetry — OTel 可观测性单例
 *
 * 管理全局 Tracer 和 SDK 生命周期。
 * enabled 为 false 时，所有操作都是空操作（if guard 直接返回）。
 */
export declare class Telemetry {
    private static instance;
    private tracer;
    private sdk;
    private _enabled;
    private logger;
    private constructor();
    static getInstance(): Telemetry;
    /** 是否已启用 */
    isEnabled(): boolean;
    /**
     * 初始化 OTel SDK
     *
     * @param serviceName  服务名称（默认 'agentiX-graphvec'）
     * @param otlpEndpoint OTLP gRPC 端点（默认 'http://localhost:4317'）
     */
    init(serviceName?: string, otlpEndpoint?: string): Promise<void>;
    /** 关闭 OTel SDK（优雅退出时调用） */
    shutdown(): Promise<void>;
    /** 获取当前 Tracer */
    getTracer(): Tracer | null;
    /**
     * 创建一个新的 span（仅 enabled 时有实际作用）
     *
     * @param name       span 名称
     * @param parentSpan 可选的父 span（用于构建 span 层次）
     */
    startSpan(name: string, parentSpan?: Span): Span | null;
    /**
     * 结束一个 span，设置状态码
     *
     * @param span 要结束的 span
     * @param error 可选的错误（设置 SpanStatusCode.ERROR）
     */
    endSpan(span: Span | null, error?: Error): void;
    /**
     * 快捷包装异步操作，自动创建和结束 span
     *
     * 在 enabled 状态下，用 span 包裹 fn 的执行；
     * 在 disabled 状态下，直接调用 fn（零开销）。
     *
     * @param name span 名称
     * @param fn   要追踪的异步操作
     */
    traceAsync<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=otel.d.ts.map