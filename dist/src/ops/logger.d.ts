import pino from 'pino';
/**
 * Trace context propagated asynchronously through the call chain.
 */
export interface TraceContext {
    /** Unique identifier for the entire request chain */
    traceId: string;
    /** Unique identifier for the current span within the trace */
    spanId: string;
    /** Optional — the spanId of the parent span (used for hierarchy) */
    parentSpanId?: string;
}
/**
 * Execute `fn` within an async scope that carries the given `TraceContext`.
 * Any code (including downstream callbacks, promises, etc.) running inside
 * `fn` can retrieve the context via `getTraceContext()` / `getTraceId()`.
 */
export declare function withTraceContext<T>(ctx: TraceContext, fn: () => T): T;
/**
 * Retrieve the current async-local `TraceContext`, if one has been set by an
 * enclosing `withTraceContext()` call.  Returns `undefined` when no context
 * is active.
 */
export declare function getTraceContext(): TraceContext | undefined;
/**
 * Convenience accessor that returns only the `traceId` portion of the current
 * async-local trace context.
 */
export declare function getTraceId(): string | undefined;
/**
 * Logger — pino 结构化日志
 *
 * 日志格式为结构化 JSON，自带时间戳、级别、hlc 时间戳
 * 开发环境使用 pino-pretty 美化输出
 * 生产环境输出纯 JSON 供 Loki/ELK 收集
 *
 * 支持请求链路跟踪（trace ID propagation）：
 * - 可通过 `new Logger(module, traceId)` 绑定实例级 traceId
 * - 也可配合 `withTraceContext()` 实现异步调用链自动传播
 */
export declare class Logger {
    private traceId?;
    private logger;
    constructor(name?: string, traceId?: string | undefined);
    /** 合并 meta 数据：实例 traceId、AsyncLocalStorage traceId、入参 data */
    private _mergeMeta;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, err?: Error, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
    /** 获取底层 pino logger（用于传递给其他模块） */
    getPino(): pino.Logger;
}
//# sourceMappingURL=logger.d.ts.map