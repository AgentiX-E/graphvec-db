/**
 * wal.ts — Write-Ahead Log 持久化
 *
 * 二进制格式的 WAL，用于 Raft 日志的持久化存储。
 * 每个条目格式：
 *   [4 bytes: index][4 bytes: term][4 bytes: data length][data bytes]
 *
 * 所有整数字段采用 Big-Endian 编码。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Logger } from '../ops/logger'

export interface LogEntry {
  index: number
  term: number
  data: Uint8Array
}

export class WAL {
  private fd: number = -1
  private walPath: string
  private metaPath: string
  private entries: LogEntry[] = []
  private lastIndex: number = 0
  private lastTerm: number = 0
  private logger: Logger
  private _opened = false

  constructor(path: string) {
    this.walPath = path
    this.metaPath = path + '.meta'
    this.logger = new Logger('WAL')
  }

  get isOpen(): boolean {
    return this._opened
  }

  /**
   * 打开 WAL 文件
   * 如果文件存在，读取所有条目到 this.entries
   * 如果不存在，创建新文件
   */
  async open(): Promise<void> {
    if (this._opened) return

    return new Promise<void>((resolve, reject) => {
      try {
        // 确保目录存在
        const dir = this.walPath.substring(0, this.walPath.lastIndexOf('/'))
        if (dir && dir !== this.walPath) {
          fs.mkdirSync(dir, { recursive: true })
        }

        // 打开文件（读写模式）
        this.fd = fs.openSync(this.walPath, 'a+')

        // 读取已有内容
        const stat = fs.fstatSync(this.fd)
        if (stat.size > 0) {
          const buf = Buffer.alloc(stat.size)
          fs.readSync(this.fd, buf, 0, stat.size, 0)
          this._parseBuffer(buf)
        }

        this._opened = true
        this.logger.info(`WAL opened: ${this.walPath}, entries=${this.entries.length}, lastIndex=${this.lastIndex}`)
        resolve()
      } catch (err) {
        this.logger.error(`Failed to open WAL: ${this.walPath}`, err as Error)
        reject(err)
      }
    })
  }

  /**
   * 追加一个日志条目到 WAL
   * 格式：[4 bytes: index][4 bytes: term][4 bytes: data length][data bytes]
   */
  async append(term: number, data: Uint8Array): Promise<LogEntry> {
    if (!this._opened) {
      throw new Error('WAL not opened')
    }

    const index = ++this.lastIndex
    this.lastTerm = term

    const entry: LogEntry = { index, term, data }

    const header = Buffer.alloc(12)
    header.writeUInt32BE(index, 0)
    header.writeUInt32BE(term, 4)
    header.writeUInt32BE(data.length, 8)

    const buf = Buffer.concat([header, Buffer.from(data)])
    fs.writeSync(this.fd, buf, 0, buf.length, null)

    // fsync：确保日志落盘后再返回
    fs.fsyncSync(this.fd)

    this.entries.push(entry)
    return entry
  }

  /**
   * 截断到指定 index（用于 snapshot 后清理旧日志）
   * 如果 lastIndex >= this.entries.length 则 no-op
   */
  async truncate(lastIndex: number): Promise<void> {
    if (!this._opened) return
    if (lastIndex >= this.entries.length) return

    // 保留从 lastIndex+1 到末尾的条目
    const keepEntries = this.entries.slice(lastIndex + 1)
    const buf = this._encodeEntries(keepEntries)

    // 重建文件
    fs.ftruncateSync(this.fd, 0)
    fs.writeSync(this.fd, buf, 0, buf.length, 0)
    fs.fsyncSync(this.fd)

    this.entries = keepEntries
    this.lastIndex = keepEntries.length > 0
      ? keepEntries[keepEntries.length - 1].index
      : 0
    this.lastTerm = keepEntries.length > 0
      ? keepEntries[keepEntries.length - 1].term
      : 0
  }

  /** 返回当前条目数 */
  entriesCount(): number {
    return this.entries.length
  }

  /**
   * 清除所有 entry.index < index 的条目
   * 重写文件（保留的条目写入新内容，fsync）
   */
  async truncateBefore(index: number): Promise<void> {
    if (!this._opened || this.entries.length === 0) return

    // 找到第一个 entry.index >= index 的位置
    const keepEntries = this.entries.filter(e => e.index >= index)

    // 没有需要清理的
    if (keepEntries.length === this.entries.length) return

    const buf = this._encodeEntries(keepEntries)

    // 重建文件
    fs.ftruncateSync(this.fd, 0)
    fs.writeSync(this.fd, buf, 0, buf.length, 0)
    fs.fsyncSync(this.fd)

    this.entries = keepEntries
    this.lastIndex = keepEntries.length > 0
      ? keepEntries[keepEntries.length - 1].index
      : 0
    this.lastTerm = keepEntries.length > 0
      ? keepEntries[keepEntries.length - 1].term
      : 0
  }

  /** 返回所有缓存的条目 */
  readAll(): LogEntry[] {
    return [...this.entries]
  }

  /** 获取最后一条索引 */
  getLastIndex(): number {
    return this.lastIndex
  }

  /** 获取最后一条任期 */
  getLastTerm(): number {
    return this.lastTerm
  }

  /**
   * 获取指定索引的条目
   */
  getEntry(index: number): LogEntry | undefined {
    return this.entries.find(e => e.index === index)
  }

  /**
   * 获取指定起始索引后的所有条目
   */
  getEntriesFrom(startIndex: number): LogEntry[] {
    return this.entries.filter(e => e.index >= startIndex)
  }

  /** 关闭 WAL */
  async close(): Promise<void> {
    if (!this._opened) return
    try {
      fs.fsyncSync(this.fd)
      fs.closeSync(this.fd)
    } catch (err) {
      this._opened = false
      this.fd = -1
      this.logger.warn(`WAL close error (fd=${this.fd}): ${(err as Error).message}`)
      throw err
    }
    this._opened = false
    this.fd = -1
  }

  /** fs.fsync，确保所有写入已落盘 */
  async sync(): Promise<void> {
    if (!this._opened) return
    fs.fsyncSync(this.fd)
  }

  /** 删除 WAL 文件（测试辅助） */
  async destroy(): Promise<void> {
    await this.close()
    try {
      fs.unlinkSync(this.walPath)
    } catch {
      // ignore if file doesn't exist
    }
    try {
      fs.unlinkSync(this.metaPath)
    } catch {
      // ignore
    }
    this.entries = []
    this.lastIndex = 0
    this.lastTerm = 0
  }

  /**
   * 持久化 key-value meta 到独立的 meta 文件
   * 格式：每行 "key=value\n"
   * 用于持久化 currentTerm / votedFor 等选举状态
   */
  persistMeta(key: string, value: string): void {
    try {
      const meta: Record<string, string> = {}
      if (fs.existsSync(this.metaPath)) {
        const content = fs.readFileSync(this.metaPath, 'utf-8')
        for (const line of content.split('\n').filter(Boolean)) {
          const eqIdx = line.indexOf('=')
          if (eqIdx > 0) {
            meta[line.slice(0, eqIdx)] = line.slice(eqIdx + 1)
          }
        }
      }
      meta[key] = value
      const lines = Object.entries(meta).map(([k, v]) => `${k}=${v}`).join('\n')
      fs.writeFileSync(this.metaPath, lines + '\n', 'utf-8')
      const metaFd = fs.openSync(this.metaPath, 'r')
      fs.fsyncSync(metaFd)
      fs.closeSync(metaFd)
    } catch {
      // meta 写入失败不阻止主流程
    }
  }

  /** 加载 meta 文件中的指定 key */
  loadMeta(key: string): string | undefined {
    try {
      if (!fs.existsSync(this.metaPath)) return undefined
      const content = fs.readFileSync(this.metaPath, 'utf-8')
      for (const line of content.split('\n').filter(Boolean)) {
        const eqIdx = line.indexOf('=')
        if (eqIdx > 0 && line.slice(0, eqIdx) === key) {
          return line.slice(eqIdx + 1)
        }
      }
    } catch {
      // ignore
    }
    return undefined
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /** 解析二进制 buffer 中的日志条目 */
  private _parseBuffer(buf: Buffer): void {
    this.entries = []
    let offset = 0

    while (offset + 12 <= buf.length) {
      const index = buf.readUInt32BE(offset)
      const term = buf.readUInt32BE(offset + 4)
      const dataLen = buf.readUInt32BE(offset + 8)
      offset += 12

      if (offset + dataLen > buf.length) {
        // 不完整条目，忽略
        this.logger.warn(`Incomplete entry at index ${index}, truncating`)
        break
      }

      const data = new Uint8Array(buf.subarray(offset, offset + dataLen))
      offset += dataLen

      this.entries.push({ index, term, data })
    }

    if (this.entries.length > 0) {
      this.lastIndex = this.entries[this.entries.length - 1].index
      this.lastTerm = this.entries[this.entries.length - 1].term
    }
  }

  /** 将条目列表编码为二进制 buffer */
  private _encodeEntries(entries: LogEntry[]): Buffer {
    const buffers: Buffer[] = []
    for (const entry of entries) {
      const header = Buffer.alloc(12)
      header.writeUInt32BE(entry.index, 0)
      header.writeUInt32BE(entry.term, 4)
      header.writeUInt32BE(entry.data.length, 8)
      buffers.push(header, Buffer.from(entry.data))
    }
    return Buffer.concat(buffers)
  }
}
