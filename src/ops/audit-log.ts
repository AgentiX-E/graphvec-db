// ============================================================
// AuditLog — 生产级审计日志 + 文件轮转
// ============================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
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
  private lastHash: string | undefined

  private serializeEntry(entry: AuditEntry): string {
    const { prevHash: _, ...rest } = entry
    return JSON.stringify(rest, Object.keys(rest).sort())
  }

  private hashEntry(entry: AuditEntry): string {
    return createHash('sha256').update(this.serializeEntry(entry)).digest('hex')
  }

  verifyChain(): boolean {
    let prevHash: string | undefined
    for (const entry of this.entries) {
      if (entry.prevHash !== prevHash) return false
      prevHash = this.hashEntry(entry)
    }
    return true
  }

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
   * 写入一条审计条目（含哈希链完整性校验）
   */
  log(entry: Omit<AuditEntry, 'timestamp' | 'prevHash'>): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      prevHash: this.lastHash,
    }

    this.lastHash = this.hashEntry(fullEntry)
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

  /**
   * 加密审计日志（AES-256-GCM）
   * @param plaintext JSON 序列化的日志条目
   * @param key 256-bit key (32 bytes Buffer)
   * @returns 加密数据 { encrypted: Buffer, iv: Buffer, tag: Buffer }
   */
  static encryptEntry(
    plaintext: string,
    key: Buffer,
  ): { encrypted: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return { encrypted, iv, tag }
  }

  /**
   * 解密切审计日志（AES-256-GCM）
   * @returns 明文 JSON 字符串
   */
  static decryptEntry(
    encrypted: Buffer,
    iv: Buffer,
    tag: Buffer,
    key: Buffer,
  ): string {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return decrypted.toString('utf-8')
  }
}
