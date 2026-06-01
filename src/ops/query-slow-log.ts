/**
 * QuerySlowLog — 慢查询拦截器
 *
 * 记录所有耗时超过阈值的查询。
 * 支持 rotating-file-stream 持久化到磁盘，重启后历史日志不丢失。
 *
 * 阈值默认 100ms
 */

import { createRequire } from 'module'

const _require = createRequire(typeof __filename !== 'undefined' ? __filename : '/')

interface SlowLogEntry {
  op: string
  duration: number
  timestamp: number
  user?: string
}

export class QuerySlowLog {
  private thresholdMs: number
  private logs: SlowLogEntry[] = []
  private maxEntries: number
  private rotateStream: import('stream').Writable | null = null
  private logFilePath: string
  private _useSyncWrite: boolean

  constructor(
    thresholdMs: number = 100,
    maxEntries: number = 1000,
    logFilePath?: string,
  ) {
    this.thresholdMs = thresholdMs
    this.maxEntries = maxEntries
    this.logFilePath = logFilePath || './logs/slow-queries.log'
    this._useSyncWrite = !!logFilePath

    // 如果启用了文件输出，创建 rotating-file-stream
    if (process.env.SLOW_LOG_FILE === '1' || logFilePath) {
      this._initRotateStream()
      // 启动时从文件恢复已有慢查询记录（仅限最近条目）
      this._recoverFromFile()
    }
  }

  /**
   * 执行查询并记录慢查询
   * @returns 查询结果
   */
  async track<T>(name: string, fn: () => Promise<T>, user?: string): Promise<T> {
    const start = Date.now()
    try {
      return await fn()
    } finally {
      const duration = Date.now() - start
      if (duration >= this.thresholdMs) {
        this._log(name, duration, user)
      }
    }
  }

  /** 获取慢查询列表 */
  getSlowQueries(): SlowLogEntry[] {
    return [...this.logs]
  }

  /** 获取最近慢查询数 */
  get count(): number {
    return this.logs.length
  }

  setThreshold(ms: number): void {
    this.thresholdMs = ms
  }

  clear(): void {
    this.logs = []
  }

  /**
   * 关闭文件流（用于优雅关闭）
   */
  close(): void {
    if (this.rotateStream) {
      try { this.rotateStream.end() } catch { /* ignore */ }
      this.rotateStream = null
    }
  }

  /**
   * 强制将缓冲数据写入磁盘（用于测试或优雅关闭）
   */
  async flush(): Promise<void> {
    if (this.rotateStream && typeof this.rotateStream._writableState !== 'undefined') {
      return new Promise(resolve => {
        this.rotateStream!.on('drain', () => resolve())
        this.rotateStream!.on('finish', () => resolve())
        // If already drained, resolve immediately
        if (this.rotateStream!.writableLength === 0) {
          resolve()
        }
      })
    }
  }

  // ── 内部方法 ──

  private _initRotateStream(): void {
    const fs = require('fs')
    try {
      // Try rotating-file-stream first
      const rfs = _require('rotating-file-stream')
      this.rotateStream = rfs.createStream(
        // 文件名格式: slow-queries.log, slow-queries.2026-06-01.log (rotate 后)
        (time: Date | null) => {
          if (!time) return 'slow-queries.log'
          const dateStr = time.toISOString().slice(0, 10)
          return `slow-queries.${dateStr}.log`
        },
        {
          path: require('path').dirname(this.logFilePath),
          maxFiles: 30,
          maxSize: '10M',
          interval: '1d',
          compress: 'gzip',
        },
      )
    } catch {
      // rotating-file-stream not available, fall back to regular file write
      try {
        // Ensure directory exists
        const dir = require('path').dirname(this.logFilePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        this.rotateStream = fs.createWriteStream(this.logFilePath, { flags: 'a' })
      } catch {
        // No file output available, just keep in-memory
      }
    }
  }

  private _recoverFromFile(): void {
    try {
      const fs = require('fs')
      if (!fs.existsSync(this.logFilePath)) return
      const content = fs.readFileSync(this.logFilePath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      // 只恢复最近 N 条记录，避免内存耗尽
      const maxRecover = Math.min(lines.length, this.maxEntries)
      const startIdx = lines.length - maxRecover
      for (let i = startIdx; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]) as SlowLogEntry
          this.logs.push(entry)
        } catch { /* skip unparseable lines */ }
      }
    } catch {
      // File not available, skip recovery
    }
  }

  private _log(op: string, duration: number, user?: string): void {
    const entry: SlowLogEntry = { op, duration, timestamp: Date.now(), user }
    this.logs.push(entry)
    if (this.logs.length > this.maxEntries) {
      this.logs.shift()
    }

    // 写入文件流（非阻塞）
    if (this.rotateStream) {
      try {
        const line = JSON.stringify(entry) + '\n'
        this.rotateStream.write(line)
      } catch {
        // File write failure is non-critical for slow query logging
      }
    }

    // 同步写入（确保数据立即落盘，对可靠性要求高的场景）
    if (this._useSyncWrite) {
      try {
        const fs = require('fs')
        const dir = require('path').dirname(this.logFilePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n')
      } catch {
        // Sync write failure is non-critical for slow query logging
      }
    }
  }
}
