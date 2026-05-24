"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
exports.withTraceContext = withTraceContext;
exports.getTraceContext = getTraceContext;
exports.getTraceId = getTraceId;
const pino_1 = __importDefault(require("pino"));
const async_hooks_1 = require("async_hooks");
// AsyncLocalStorage propagates trace context transparently across async
// boundaries without requiring explicit parameter passing.
const traceStorage = new async_hooks_1.AsyncLocalStorage();
/**
 * Execute `fn` within an async scope that carries the given `TraceContext`.
 * Any code (including downstream callbacks, promises, etc.) running inside
 * `fn` can retrieve the context via `getTraceContext()` / `getTraceId()`.
 */
function withTraceContext(ctx, fn) {
    return traceStorage.run(ctx, fn);
}
/**
 * Retrieve the current async-local `TraceContext`, if one has been set by an
 * enclosing `withTraceContext()` call.  Returns `undefined` when no context
 * is active.
 */
function getTraceContext() {
    return traceStorage.getStore();
}
/**
 * Convenience accessor that returns only the `traceId` portion of the current
 * async-local trace context.
 */
function getTraceId() {
    return traceStorage.getStore()?.traceId;
}
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
class Logger {
    traceId;
    logger;
    constructor(name = 'agentiX-graphvec', traceId) {
        this.traceId = traceId;
        this.logger = (0, pino_1.default)({
            name,
            level: process.env.LOG_LEVEL || 'info',
            transport: process.env.NODE_ENV !== 'production'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
        });
    }
    /** 合并 meta 数据：实例 traceId、AsyncLocalStorage traceId、入参 data */
    _mergeMeta(data) {
        const tid = this.traceId ?? getTraceId();
        if (tid) {
            return { traceId: tid, ...(data ?? {}) };
        }
        return data ?? {};
    }
    info(msg, data) {
        this.logger.info(this._mergeMeta(data), msg);
    }
    warn(msg, data) {
        this.logger.warn(this._mergeMeta(data), msg);
    }
    error(msg, err, data) {
        this.logger.error(this._mergeMeta({ err: err?.message, stack: err?.stack, ...data }), msg);
    }
    debug(msg, data) {
        this.logger.debug(this._mergeMeta(data), msg);
    }
    /** 获取底层 pino logger（用于传递给其他模块） */
    getPino() {
        return this.logger;
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map