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

// ──────────────────────────────────────────
// RemoteAuditSink — HTTP POST 远程审计日志
// ──────────────────────────────────────────

/**
 * RemoteAuditSink 配置
 */
export interface RemoteAuditSinkOptions {
  /** 远程审计端点 URL */
  endpoint: string
  /** 请求超时（毫秒，默认 5000） */
  timeoutMs?: number
  /** 自定义 HTTP 头 */
  headers?: Record<string, string>
  /** 网络中断时本地缓存的最大条目数（默认 10000） */
  maxCached?: number
  /** 重试间隔（毫秒，默认 30000） */
  retryIntervalMs?: number
}

/**
 * RemoteAuditSink — 远程审计日志 Sink
 *
 * 将审计日志通过 HTTP POST 发送到远程端点。
 * 网络中断时自动缓存到内存中，恢复后重发。
 * 缓存达到上限时丢弃最旧的记录。
 */
export class RemoteAuditSink {
  private endpoint: string
  private timeoutMs: number
  private headers: Record<string, string>
  private maxCached: number
  private retryIntervalMs: number
  /** 本地缓存（网络中断时暂存） */
  private cache: AuditEntry[] = []
  /** 是否正在发送中 */
  private sending: boolean = false
  /** 重试定时器 */
  private retryTimer: ReturnType<typeof setInterval> | null = null
  /** 是否已关闭 */
  private _closed: boolean = false
  /** 日志计数器 */
  private sentCount: number = 0
  private failedCount: number = 0
  private cachedCount: number = 0

  constructor(options: RemoteAuditSinkOptions) {
    this.endpoint = options.endpoint
    this.timeoutMs = options.timeoutMs ?? 5000
    this.headers = { 'Content-Type': 'application/json', ...options.headers }
    this.maxCached = options.maxCached ?? 10000
    this.retryIntervalMs = options.retryIntervalMs ?? 30000

    // 启动重试定时器
    this.retryTimer = setInterval(() => {
      this._flushCache().catch(() => {})
    }, this.retryIntervalMs)

    if (this.retryTimer && typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) {
      (this.retryTimer as any).unref()
    }
  }

  /**
   * 发送审计日志条目
   * 如果网络不可用，缓存到内存
   */
  async send(entry: AuditEntry): Promise<void> {
    if (this._closed) return

    try {
      await this._postEntry(entry)
      this.sentCount++
      // 尝试顺便刷新缓存
      if (this.cache.length > 0) {
        this._flushCache().catch(() => {})
      }
    } catch {
      // 网络中断，缓存
      this._cacheEntry(entry)
      this.failedCount++
    }
  }

  /**
   * 批量发送审计日志
   */
  async sendBatch(entries: AuditEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry)
    }
  }

  /**
   * 获取统计信息
   */
  stats(): { sent: number; failed: number; cached: number } {
    return {
      sent: this.sentCount,
      failed: this.failedCount,
      cached: this.cache.length,
    }
  }

  /**
   * 关闭，停止重试定时器
   */
  close(): void {
    this._closed = true
    if (this.retryTimer) {
      clearInterval(this.retryTimer)
      this.retryTimer = null
    }
  }

  // ─── 内部方法 ──────────────────────

  /**
   * 向远程端点 POST 单条审计日志
   */
  private async _postEntry(entry: AuditEntry): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(entry),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 缓存审计日志条目
   * 超出 maxCached 时丢弃最旧记录
   */
  private _cacheEntry(entry: AuditEntry): void {
    this.cache.push(entry)
    this.cachedCount++
    if (this.cache.length > this.maxCached) {
      this.cache.shift() // 丢弃最旧的
    }
  }

  /**
   * 尝试刷新缓存中的所有条目
   */
  private async _flushCache(): Promise<void> {
    if (this.sending || this.cache.length === 0 || this._closed) return

    this.sending = true
    const batch = [...this.cache]
    this.cache = []

    try {
      // 批量发送缓存条目
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs * 2)

      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ batch: true, entries: batch }),
          signal: controller.signal,
        })

        if (response.ok) {
          this.sentCount += batch.length
        } else {
          // 发送失败，重新缓存
          this.cache.push(...batch)
        }
      } finally {
        clearTimeout(timeoutId)
      }
    } catch {
      // 再次失败，重新缓存
      this.cache.push(...batch)
    } finally {
      this.sending = false
    }
  }
}

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

  /**
   * 查询审计日志（按条件过滤）
   *
   * @param filters 过滤条件
   * @returns 过滤后的审计条目列表
   */
  query(filters: {
    user?: string
    operation?: string
    result?: string
    resource?: string
    since?: string
    until?: string
    limit?: number
  }): AuditEntry[] {
    let result = [...this.entries]

    if (filters.user !== undefined) {
      result = result.filter(e => e.user === filters.user)
    }
    if (filters.operation !== undefined) {
      result = result.filter(e => e.operation === filters.operation)
    }
    if (filters.result !== undefined) {
      result = result.filter(e => e.result === filters.result)
    }
    if (filters.resource !== undefined) {
      result = result.filter(e => e.resource === filters.resource)
    }
    if (filters.since !== undefined) {
      const sinceTime = new Date(filters.since).getTime()
      if (!isNaN(sinceTime)) {
        result = result.filter(e => new Date(e.timestamp).getTime() >= sinceTime)
      }
    }
    if (filters.until !== undefined) {
      const untilTime = new Date(filters.until).getTime()
      if (!isNaN(untilTime)) {
        result = result.filter(e => new Date(e.timestamp).getTime() <= untilTime)
      }
    }
    if (filters.limit !== undefined && filters.limit > 0) {
      result = result.slice(0, filters.limit)
    }

    return result
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
