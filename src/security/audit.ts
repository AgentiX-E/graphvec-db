// ============================================================
// AuditLogger — 审计日志 + 持久化支持
//
// 所有操作被记录到 pino 结构化 JSON 日志 + NDJSON 文件。
// 文件持久化:
//  - 每 1000 条或每 60s 自动刷盘
//  - 文件格式: <storagePath>/audit-log.ndjson (每行一个 JSON)
//  - 启动时从文件恢复历史日志
// ============================================================

import { AuditEntry, Role } from '../types'
import pino from 'pino'
import * as fs from 'fs'
import * as path from 'path'

/** NDJSON 文件工具: append / read */
const NDJSON = {
  append(filePath: string, entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n'
    fs.appendFileSync(filePath, line, 'utf-8')
  },

  readAll(filePath: string): AuditEntry[] {
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf-8')
    const entries: AuditEntry[] = []
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }
    return entries
  },
}

/**
 * AuditLogger — 审计日志
 *
 * 所有操作被记录到 pino 结构化 JSON 日志
 * 同时持久化到 NDJSON 文件，支持恢复
 */
export class AuditLogger {
  private logger: pino.Logger
  private entries: AuditEntry[] = []
  private storagePath: string | null = null
  private ndjsonPath: string | null = null
  private _unsavedCount = 0
  private _flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly AUTO_FLUSH_THRESHOLD = 1000
  private readonly AUTO_FLUSH_INTERVAL_MS = 60000

  constructor(logger?: pino.Logger, logPath?: string, storagePath?: string) {
    this.logger = logger || (logPath
      ? pino(pino.destination(logPath))
      : pino({
          level: 'info',
          transport: process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        })
    )

    // 初始化 NDJSON 持久化
    if (storagePath) {
      this.storagePath = storagePath
      this.ndjsonPath = path.join(storagePath, 'audit-log.ndjson')

      // 确保目录存在
      fs.mkdirSync(storagePath, { recursive: true })

      // 从文件恢复（同步）
      this._loadSync()

      // 启动定时刷盘
      this._flushTimer = setInterval(() => {
        this.flush().catch(() => {})
      }, this.AUTO_FLUSH_INTERVAL_MS)
      if (this._flushTimer && typeof this._flushTimer === 'object' && 'unref' in (this._flushTimer as any)) {
        (this._flushTimer as any).unref()
      }
    }
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
    this._unsavedCount++

    this.logger.info({
      type: 'audit',
      ...fullEntry,
    })

    // 自动刷盘
    if (this._unsavedCount >= this.AUTO_FLUSH_THRESHOLD) {
      this.flush().catch(() => {})
    }
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

  /**
   * 刷盘: 将未持久化的日志写入 NDJSON 文件
   */
  async flush(): Promise<void> {
    if (!this.ndjsonPath || this._unsavedCount === 0) return

    const unsaved = this.entries.slice(-this._unsavedCount)
    for (const entry of unsaved) {
      NDJSON.append(this.ndjsonPath, entry)
    }
    this._unsavedCount = 0
  }

  /**
   * 保存单条日志到文件（同步刷盘）
   */
  save(): void {
    if (!this.ndjsonPath) return
    fs.writeFileSync(this.ndjsonPath, '')
    for (const entry of this.entries) {
      NDJSON.append(this.ndjsonPath, entry)
    }
    this._unsavedCount = 0
  }

  /**
   * 获取最近 N 条审计日志
   */
  getRecent(count: number = 100): AuditEntry[] {
    return this.entries.slice(-count)
  }

  /**
   * 获取所有审计日志（内存 + 文件）
   */
  getAll(): AuditEntry[] {
    return [...this.entries]
  }

  /** 清空内存中的审计日志 */
  clear(): void {
    this.entries = []
    this._unsavedCount = 0
  }

  /**
   * 关闭审计日志，刷盘后停止定时器
   */
  async close(): Promise<void> {
    if (this._flushTimer) {
      clearInterval(this._flushTimer)
      this._flushTimer = null
    }
    await this.flush()
  }

  /** 已持久化的条目数 */
  get entryCount(): number {
    return this.entries.length
  }

  /** 获取存储路径 */
  getStoragePath(): string | null {
    return this.storagePath
  }

  // ─── 内部方法 ──────────────────────────────

  /**
   * 从 NDJSON 文件加载历史审计日志（同步）
   */
  private _loadSync(): void {
    if (!this.ndjsonPath) return
    try {
      const loaded = NDJSON.readAll(this.ndjsonPath)
      if (loaded.length > 0) {
        this.entries = loaded
        this._unsavedCount = 0
        this.logger.info({ msg: `Loaded ${loaded.length} audit entries from disk` })
      }
    } catch (err) {
      this.logger.warn({ msg: 'Failed to load audit log from disk', err: (err as Error).message })
    }
  }
}
