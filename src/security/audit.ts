import { AuditEntry, Role } from '../types'
import pino from 'pino'

/**
 * AuditLogger — 审计日志
 *
 * 所有操作被记录到 pino 结构化 JSON 日志
 * 格式符合 AuditEntry 接口
 * 日志文件可被 ELK / Loki 等工具索引
 */
export class AuditLogger {
  private logger: pino.Logger
  private entries: AuditEntry[] = []

  constructor(logger?: pino.Logger, logPath?: string) {
    this.logger = logger || (logPath
      ? pino(pino.destination(logPath))
      : pino({
          level: 'info',
          transport: process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        })
    )
  }

  /**
   * 记录操作审计日志
   */
  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    }

    this.entries.push(fullEntry)

    this.logger.info({
      type: 'audit',
      ...fullEntry,
    })
  }

  /**
   * 记录被拒绝的操作
   */
  logDenied(operation: string, user: string, role: Role, reason?: string): void {
    this.log({
      operation,
      user,
      role,
      resource: 'unknown',
      result: 'denied',
      details: reason,
    })
  }

  /**
   * 记录错误
   */
  logError(operation: string, user: string, role: Role, error: Error): void {
    this.log({
      operation,
      user,
      role,
      resource: 'unknown',
      result: 'error',
      details: error.message,
    })
  }

  /** 获取最近 N 条审计日志 */
  getRecent(count: number = 100): AuditEntry[] {
    return this.entries.slice(-count)
  }

  /** 获取所有审计日志 */
  getAll(): AuditEntry[] {
    return [...this.entries]
  }

  /** 清空内存中的审计日志 */
  clear(): void {
    this.entries = []
  }
}
