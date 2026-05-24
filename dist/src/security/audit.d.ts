import { AuditEntry, Role } from '../types';
import pino from 'pino';
/**
 * AuditLogger — 审计日志
 *
 * 所有操作被记录到 pino 结构化 JSON 日志
 * 格式符合 AuditEntry 接口
 * 日志文件可被 ELK / Loki 等工具索引
 */
export declare class AuditLogger {
    private logger;
    private entries;
    constructor(logger?: pino.Logger, logPath?: string);
    /**
     * 记录操作审计日志
     */
    log(entry: Omit<AuditEntry, 'timestamp'>): void;
    /**
     * 记录被拒绝的操作
     */
    logDenied(operation: string, user: string, role: Role, reason?: string): void;
    /**
     * 记录错误
     */
    logError(operation: string, user: string, role: Role, error: Error): void;
    /** 获取最近 N 条审计日志 */
    getRecent(count?: number): AuditEntry[];
    /** 获取所有审计日志 */
    getAll(): AuditEntry[];
    /** 清空内存中的审计日志 */
    clear(): void;
}
//# sourceMappingURL=audit.d.ts.map