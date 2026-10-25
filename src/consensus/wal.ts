/**
 * @deprecated 从 V14 起Deprecated，使用 `lmdb-wal.ts` (LmdbWal) 替代。
 * WAL 保留以向后兼容 RaftCore，
 * RaftCore 的 walPath 指向的是旧版 WAL 文件。
 * 后续应迁移 RaftCore 使用 LmdbWal。
 *
 * wal.ts — Write-Ahead Log 持久化
 *
 * 二进制格式的 WAL，用于 Raft 日志的持久化存储。
 * 每个条目格式：
 *   [4 bytes: index][4 bytes: term][4 bytes: data length][data bytes][4 bytes: CRC32]
 *
 * 所有整数字段采用 Big-Endian 编码。
 *
 * 安全保证：
 * - CRC32 校验：写入时计算 CRC 附加到 entry，读取时验证 CRC
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Logger } from '../ops/logger'

export interface LogEntry {
  index: number
  term: number
  data: Uint8Array
}

/**
 * CRC32 校验函数（使用内置 zlib.crc32，兼容 Node.js 标准库）
 * 不使用 npm crc 包，确保零依赖。
 */
function crc32(data: Uint8Array): number {
  // 使用 Node.js 内置的 Buffer 方式实现 CRC32
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320
      } else {
        crc = crc >>> 1
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** 条目头部大小: index(4) + term(4) + dataLen(4) = 12 */
const HEADER_SIZE = 12
/** CRC 尾部大小: 4 */
const CRC_SIZE = 4
/** 每条条目的固定开销 */
const PER_ENTRY_OVERHEAD = HEADER_SIZE + CRC_SIZE

export class WAL {
  private fd: number = -1
  private walPath: string
  private metaPath: string
  private entries: LogEntry[] = []
  private lastIndex: number = 0
  private lastTerm: number = 0
  private logger: Logger
  private _opened = false
  /** CRC 校验Error计数 */
  private _crcErrors: number = 0
  // ── Group Commit（B-03） ──
  /** 待提交的批量写入 */
  private _pendingBatch: Array<{ term: number; data: Uint8Array; resolve: (entry: LogEntry) => void }> = []
  /** 是否已有 flush 定时器 */
  private _batchTimer: ReturnType<typeof setTimeout> | null = null
  /** 是否启用 Group Commit（默认启用） */
  private _groupCommitEnabled = true

  constructor(path: string) {
    this.walPath = path
    this.metaPath = path + '.meta'
    this.logger = new Logger('WAL')
  }

  get isOpen(): boolean {
    return this._opened
  }

  /** CRC 校验Error数 */
  get crcErrors(): number {
    return this._crcErrors
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

  /** 启用或禁用 Group Commit */
  setGroupCommit(enabled: boolean): void {
    this._groupCommitEnabled = enabled
    if (!enabled) {
      this._flushBatchSync()
    }
  }

  /**
   * 追加一个日志条目到 WAL
   * 启用 Group Commit 时，条目会先加入 _pendingBatch，由定时器批量落盘
   * 禁用 Group Commit 时，立即写入并 fsync
   */
   // 格式：[4 bytes: index][4 bytes: term][4 bytes: data length][data bytes][4 bytes: CRC32]
   // 
   // CRC32 校验和覆盖 index, term, data 三个字段。
   // /
  async append(term: number, data: Uint8Array): Promise<LogEntry> {
    if (!this._opened) {
      throw new Error('WAL not opened')
    }

    if (this._groupCommitEnabled) {
      // Group Commit 路径：加入 pending 批次，由定时器批量落盘
      return new Promise<LogEntry>((resolve) => {
        this._pendingBatch.push({ term, data, resolve })
        this._scheduleBatchFlush()
      })
    }

    // 常规路径：立即写入
    return this._appendImmediate(term, data)
  }

  /**
   * 立即写入一个条目（不经过 batch）
   */
  private _appendImmediate(term: number, data: Uint8Array): LogEntry {
    const index = ++this.lastIndex
    this.lastTerm = term

    const entry: LogEntry = { index, term, data }

    // 计算 CRC32（覆盖 index, term, data）
    const crcInput = new Uint8Array(HEADER_SIZE + data.length)
    new DataView(crcInput.buffer).setUint32(0, index, false) // Big-Endian
    new DataView(crcInput.buffer).setUint32(4, term, false)  // Big-Endian
    new DataView(crcInput.buffer).setUint32(8, data.length, false)
    crcInput.set(data, HEADER_SIZE)
    const checksum = crc32(crcInput)

    const header = Buffer.alloc(HEADER_SIZE)
    header.writeUInt32BE(index, 0)
    header.writeUInt32BE(term, 4)
    header.writeUInt32BE(data.length, 8)

    const crcBuf = Buffer.alloc(CRC_SIZE)
    crcBuf.writeUInt32BE(checksum, 0)

    const buf = Buffer.concat([header, Buffer.from(data), crcBuf])
    fs.writeSync(this.fd, buf, 0, buf.length, null)

    // fsync：确保日志落盘后再返回
    fs.fsyncSync(this.fd)

    this.entries.push(entry)
    return entry
  }

  /**
   * 调度批量 flush
   * 使用 setTimeout(1ms) 等待同一事件循环中的多个 append 聚合
   */
  private _scheduleBatchFlush(): void {
    if (this._batchTimer !== null) return
    this._batchTimer = setTimeout(() => {
      this._batchTimer = null
      this._flushBatchSync()
    }, 1)
    this._batchTimer.unref()
  }

  /**
   * 同步批量落盘：将 _pendingBatch 中的条目一次写入并 fsync
   */
  private _flushBatchSync(): void {
    if (this._pendingBatch.length === 0) return

    const batch = this._pendingBatch.splice(0)
    const resolvedEntries: LogEntry[] = []

    // 计算所有条目
    for (const item of batch) {
      const index = ++this.lastIndex
      this.lastTerm = item.term
      const entry: LogEntry = { index, term: item.term, data: item.data }
      resolvedEntries.push(entry)
    }

    // 一次编码并写入所有条目
    const buffers: Buffer[] = []
    for (const entry of resolvedEntries) {
      const crcInput = new Uint8Array(HEADER_SIZE + entry.data.length)
      new DataView(crcInput.buffer).setUint32(0, entry.index, false)
      new DataView(crcInput.buffer).setUint32(4, entry.term, false)
      new DataView(crcInput.buffer).setUint32(8, entry.data.length, false)
      crcInput.set(entry.data, HEADER_SIZE)
      const checksum = crc32(crcInput)

      const header = Buffer.alloc(HEADER_SIZE)
      header.writeUInt32BE(entry.index, 0)
      header.writeUInt32BE(entry.term, 4)
      header.writeUInt32BE(entry.data.length, 8)

      const crcBuf = Buffer.alloc(CRC_SIZE)
      crcBuf.writeUInt32BE(checksum, 0)

      buffers.push(header, Buffer.from(entry.data), crcBuf)
    }

    // 一次系统调用写入所有条目
    const fullBuf = Buffer.concat(buffers)
    fs.writeSync(this.fd, fullBuf, 0, fullBuf.length, null)

    // 一次 fsync（核心优化点）
    fs.fsyncSync(this.fd)

    // 更新内存状态
    for (const entry of resolvedEntries) {
      this.entries.push(entry)
    }

    // 解析所有 promise
    for (let i = 0; i < resolvedEntries.length; i++) {
      try { batch[i].resolve(resolvedEntries[i]) } catch { /* ignore */ }
    }
  }

  /**
   * 截断到指定 index（用于 snapshot 后清理旧日志）
   * 如果 lastIndex >= this.entries.length 则 no-op
   */
  async truncate(lastIndex: number): Promise<void> {
    if (!this._opened) return
    if (lastIndex >= this.entries.length) return

    // 保留从 lastIndex+1 到末尾的条目（基于数组索引，非 entry index）
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

  /** 解析二进制 buffer 中的日志条目（含 CRC 校验） */
  private _parseBuffer(buf: Buffer): void {
    this.entries = []
    let offset = 0

    while (offset + HEADER_SIZE <= buf.length) {
      const index = buf.readUInt32BE(offset)
      const term = buf.readUInt32BE(offset + 4)
      const dataLen = buf.readUInt32BE(offset + 8)
      offset += HEADER_SIZE

      if (offset + dataLen + CRC_SIZE > buf.length) {
        this.logger.warn(`Incomplete entry at index ${index}, truncating`)
        break
      }

      const data = new Uint8Array(buf.subarray(offset, offset + dataLen))
      offset += dataLen

      // 读取 CRC32 校验和
      const storedCrc = buf.readUInt32BE(offset)
      offset += CRC_SIZE

      // 验证 CRC32
      const crcInput = new Uint8Array(HEADER_SIZE + dataLen)
      new DataView(crcInput.buffer).setUint32(0, index, false)
      new DataView(crcInput.buffer).setUint32(4, term, false)
      new DataView(crcInput.buffer).setUint32(8, dataLen, false)
      crcInput.set(data, HEADER_SIZE)
      const computedCrc = crc32(crcInput)

      if (storedCrc !== computedCrc) {
        this._crcErrors++
        this.logger.error(
          `CRC mismatch at entry index ${index}: stored=${storedCrc}, computed=${computedCrc}`,
        )
        // CRC Error：跳过该条目继续读取后续条目（不中断）
        continue
      }

      this.entries.push({ index, term, data })
    }

    if (this.entries.length > 0) {
      this.lastIndex = this.entries[this.entries.length - 1].index
      this.lastTerm = this.entries[this.entries.length - 1].term
    }
  }

  /** 将条目列表编码为二进制 buffer（含 CRC32） */
  private _encodeEntries(entries: LogEntry[]): Buffer {
    const buffers: Buffer[] = []
    for (const entry of entries) {
      const header = Buffer.alloc(HEADER_SIZE)
      header.writeUInt32BE(entry.index, 0)
      header.writeUInt32BE(entry.term, 4)
      header.writeUInt32BE(entry.data.length, 8)

      // 计算 CRC32
      const crcInput = new Uint8Array(HEADER_SIZE + entry.data.length)
      new DataView(crcInput.buffer).setUint32(0, entry.index, false)
      new DataView(crcInput.buffer).setUint32(4, entry.term, false)
      new DataView(crcInput.buffer).setUint32(8, entry.data.length, false)
      crcInput.set(entry.data, HEADER_SIZE)
      const checksum = crc32(crcInput)

      const crcBuf = Buffer.alloc(CRC_SIZE)
      crcBuf.writeUInt32BE(checksum, 0)

      buffers.push(header, Buffer.from(entry.data), crcBuf)
    }
    return Buffer.concat(buffers)
  }
}
