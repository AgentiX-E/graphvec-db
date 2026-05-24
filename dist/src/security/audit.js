"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogger = void 0;
const pino_1 = __importDefault(require("pino"));
/**
 * AuditLogger — 审计日志
 *
 * 所有操作被记录到 pino 结构化 JSON 日志
 * 格式符合 AuditEntry 接口
 * 日志文件可被 ELK / Loki 等工具索引
 */
class AuditLogger {
    logger;
    entries = [];
    constructor(logger, logPath) {
        this.logger = logger || (logPath
            ? (0, pino_1.default)(pino_1.default.destination(logPath))
            : (0, pino_1.default)({
                level: 'info',
                transport: process.env.NODE_ENV !== 'production'
                    ? { target: 'pino-pretty', options: { colorize: true } }
                    : undefined,
            }));
    }
    /**
     * 记录操作审计日志
     */
    log(entry) {
        const fullEntry = {
            ...entry,
            timestamp: new Date().toISOString(),
        };
        this.entries.push(fullEntry);
        this.logger.info({
            type: 'audit',
            ...fullEntry,
        });
    }
    /**
     * 记录被拒绝的操作
     */
    logDenied(operation, user, role, reason) {
        this.log({
            operation,
            user,
            role,
            resource: 'unknown',
            result: 'denied',
            details: reason,
        });
    }
    /**
     * 记录错误
     */
    logError(operation, user, role, error) {
        this.log({
            operation,
            user,
            role,
            resource: 'unknown',
            result: 'error',
            details: error.message,
        });
    }
    /** 获取最近 N 条审计日志 */
    getRecent(count = 100) {
        return this.entries.slice(-count);
    }
    /** 获取所有审计日志 */
    getAll() {
        return [...this.entries];
    }
    /** 清空内存中的审计日志 */
    clear() {
        this.entries = [];
    }
}
exports.AuditLogger = AuditLogger;
//# sourceMappingURL=audit.js.map