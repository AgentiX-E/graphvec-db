// ============================================================
// AuditLog — 生产级审计日志 + 文件轮转
// ============================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { type AuditEntry } from '../types'
import { createStream } from 'rotating-file-stream'

// ---------------------------------------------------------------------------
// 类型导出（便于外部使用）
// ---------------------------------------------------------------------------
export type AuditLogResult = AuditEntry['result']

export interface AuditLogOptions {
  /** 日志目录（默认 ./logs/audit） */
  logDir?: string
  /** 单文件最大大小（默认 10M） */
  maxFileSize?: string
  /** 轮转间隔（默认 1d） */
  interval?: string
  /** 保留的最大文件数（默认 10） */
  maxFiles?: number
}

export interface AuditLogQuery {
  operation?: string
  user?: string
  result?: AuditLogResult
  startTime?: number
  endTime?: number
  limit?: number
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

export class AuditLog {
  private entries: AuditEntry[] = []
  private stream: ReturnType<typeof createStream> | null = null

  constructor(opts?: AuditLogOptions) {
    const logDir = opts?.logDir || './logs/audit'

    fs.mkdirSync(logDir, { recursive: true })

    // 仅在需要文件输出时才创建轮转流
    if (opts?.maxFileSize || opts?.interval || opts?.maxFiles) {
      this.stream = createStream('audit.log', {
        path: logDir,
        size: opts?.maxFileSize || '10M',
        interval: opts?.interval || '1d',
        maxFiles: opts?.maxFiles ?? 10,
      })
    }
  }

  /**
   * 写入一条审计条目
   */
  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    }

    this.entries.push(fullEntry)

    if (this.stream) {
      this.stream.write(JSON.stringify(fullEntry) + '\n')
    }
  }

  /**
   * 查询审计条目（支持按 operation / user / result 过滤以及时间范围过滤）
   */
  query(opts?: AuditLogQuery): AuditEntry[] {
    let results = [...this.entries]

    if (opts?.operation) {
      results = results.filter(e => e.operation === opts.operation!)
    }
    if (opts?.user) {
      results = results.filter(e => e.user === opts.user!)
    }
    if (opts?.result) {
      results = results.filter(e => e.result === opts.result!)
    }
    if (opts?.startTime) {
      results = results.filter(e => new Date(e.timestamp).getTime() >= opts.startTime!)
    }
    if (opts?.endTime) {
      results = results.filter(e => new Date(e.timestamp).getTime() <= opts.endTime!)
    }
    if (opts?.limit && opts.limit > 0) {
      results = results.slice(-opts.limit)
    }

    return results
  }

  /** 清空内存中的审计条目 */
  clear(): void {
    this.entries = []
  }

  /** 返回当前条目数 */
  size(): number {
    return this.entries.length
  }

  /** 关闭轮转文件流（释放资源） */
  close(): void {
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }
}
