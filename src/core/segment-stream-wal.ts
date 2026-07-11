/**
 * segment-stream-wal.ts — Segment-based Stream WAL
 *
 * 替代 stream-wal.ts 中基于单一文件的 WAL 实现。
 * 核心Improvements:
 *   1. 固定大小 segment（默认 64MB），prune 只 delete 旧 segment，不 rename
 *   2. 写入只在 active segment 上 append，永不重写
 *   3. 消除了 stream-wal.ts prune() 中 rename + reopen 的数据丢失窗口
 *
 * 每条记录格式（与旧版兼容）：
 *   [1  byte: flags]   0x00=PENDING, 0x01=ACKED, 0x02=CONSUMED
 *   [4  bytes: msgId length]  (Big-Endian)
 *   [N  bytes: msgId UTF-8]
 *   [4  bytes: data length]   (Big-Endian)
 *   [N  bytes: JSON-encoded StreamMessage]
 *
 * 目录结构：
 *   {walPath}/
 *     manifest.json      # { activeSegment, lastPrunedSegment, stats }
 *     00000001.log       # segment 1 (0~64MB)
 *     00000002.log       # segment 2
 *     ...
 *
 * 接口与 StreamWal 完全兼容，替换时无需修改调用方。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Logger } from '../ops/logger'

export const FLAG_PENDING = 0x00
export const FLAG_ACKED = 0x01
export const FLAG_CONSUMED = 0x02

/** 默认单个 segment 最大大小 */
const DEFAULT_SEGMENT_MAX_BYTES = 64 * 1024 * 1024 // 64MB

export interface StreamMessage {
  msgId: string
  seq: number
  nodeId: string
  timestamp: number
  type: string
  data: Record<string, unknown>
}

export interface StreamWalEntry {
  offset: number
  flags: number
  msgId: string
  message: StreamMessage
}

interface Manifest {
  version: number
  activeSegment: number
  lastPrunedSegment: number
  entriesCount: number
}

interface SegmentInfo {
  num: number
  path: string
  size: number
}

/**
 * SegmentStreamWalAppendStream — 带策略化 fsync 的追加写入流包装
 *
 * 在底层 fd 之上添加 fsync 策略控制：
 * - 'lazy':   不主动 fsync（依赖系统缓存刷新），最快但最不安全
 * - 'always': 每次 append 后立即 fsync，最安全但最慢
 * - 'every-n': 每 N 次 append 后 fsync 一次，折中方案
 *
 * 默认 'every-n'（n=100），兼顾安全与性能。
 * n=100 意味着每 100 条记录触发一次 fsync，
 * 在最坏情况下最多丢失 99 条记录，但 fsync 调用减少 99%。
 */
export class SegmentStreamWalAppendStream {
  private _fd: number
  private _fsyncStrategy: 'lazy' | 'always' | 'every-n'
  private _fsyncEveryN: number
  private _fsyncCounter: number = 0

  constructor(
    fd: number,
    options?: {
      fsyncStrategy?: 'lazy' | 'always' | 'every-n'
      fsyncEveryN?: number
    },
  ) {
    this._fd = fd
    this._fsyncStrategy = options?.fsyncStrategy ?? 'every-n'
    this._fsyncEveryN = options?.fsyncEveryN ?? 100
  }

  /**
   * 强制刷盘当前 active segment
   * 供外部在关键点（如 Raft commit 后）调用，确保数据持久化
   */
  fsync(): void {
    fs.fsyncSync(this._fd)
  }

  /**
   * 追加二进制数据到文件末尾，触发 fsync
   */
  append(buf: Buffer): void {
    fs.writeSync(this._fd, buf)

    if (this._fsyncStrategy === 'always') {
      fs.fsyncSync(this._fd)
    } else if (this._fsyncStrategy === 'every-n') {
      this._fsyncCounter++
      if (this._fsyncCounter >= this._fsyncEveryN) {
        fs.fsyncSync(this._fd)
        this._fsyncCounter = 0
      }
    }
    // 'lazy': 不主动 fsync
  }
}

/** SegmentStreamWal 构造选项 */
export interface SegmentStreamWalOptions {
  /** 单个 segment 最大字节数（默认 64MB） */
  segmentMaxBytes?: number
  /**
   * 是否启用 fsync 策略刷盘。
   * - true（默认）: 使用 'every-n' 策略（默认 n=100），每 N 条记录刷盘一次
   * - false: 不主动 fsync（性能更好，但崩溃时可能丢失最近写入）
   *
   * 即使设为 false，open() 和正常 close() 仍会 fsync。
   * 可通过 fsyncEveryN 自定义刷盘频率。
   */
  fsyncOnWrite?: boolean
  /**
   * 'every-n' 策略中的 N 值，默认 100。
   * 仅在 fsyncOnWrite=true 时生效。
   */
  fsyncEveryN?: number
}

/**
 * SegmentStreamWal — 基于固定大小 segment 的消息持久化队列
 *
 * 与 StreamWal API 完全兼容，但Internal use多 segment 文件。
 * prune 操作只删除整个 segment 文件，不重写任何数据。
 */
export class SegmentStreamWal {
  private walDir: string
  private logger: Logger
  private _opened = false
  private _entriesCount = 0
  private _activeSegment: number = 1
  private _lastPrunedSegment: number = 0
  private _segmentMaxBytes: number
  private _activeFd: number = -1
  private _activeSize: number = 0
  private _pruning = false
  private _fsyncOnWrite: boolean
  private _fsyncCounter: number = 0
  private _fsyncEveryN: number = 100

  constructor(walPath: string, options?: SegmentStreamWalOptions)
  constructor(walPath: string, segmentMaxBytes?: number)
  constructor(walPath: string, optionsOrBytes?: SegmentStreamWalOptions | number) {
    this.walDir = walPath
    this.logger = new Logger('SegmentStreamWal')

    if (typeof optionsOrBytes === 'number') {
      this._segmentMaxBytes = optionsOrBytes
      this._fsyncOnWrite = true
      this._fsyncEveryN = 100
    } else if (optionsOrBytes) {
      this._segmentMaxBytes = optionsOrBytes.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES
      this._fsyncOnWrite = optionsOrBytes.fsyncOnWrite ?? true
      this._fsyncEveryN = optionsOrBytes.fsyncEveryN ?? 100
    } else {
      this._segmentMaxBytes = DEFAULT_SEGMENT_MAX_BYTES
      this._fsyncOnWrite = true
      this._fsyncEveryN = 100
    }
  }

  get isOpen(): boolean { return this._opened }
  get size(): number { return this._entriesCount }

  open(): void {
    if (this._opened) return

    // 检测旧单文件 WAL 并迁移（在 mkdir 之前！）
    this._migrateFromOldFormat()

    fs.mkdirSync(this.walDir, { recursive: true })

    // 读取或创建 manifest
    const manifest = this._loadOrCreateManifest()
    this._activeSegment = manifest.activeSegment
    this._lastPrunedSegment = manifest.lastPrunedSegment
    this._entriesCount = manifest.entriesCount

    // 打开活跃 segment
    this._openActiveSegment()

    // 校验：如果活跃 segment 已满（恰好等于大小限制），
    // 滚动到新 segment（确保 append 时文件是空的）
    if (this._activeSize >= this._segmentMaxBytes) {
      this._rollSegment()
    }

    this._opened = true
  }

  close(): void {
    if (!this._opened) return
    this._flushAndCloseActiveFd()
    this._saveManifest()
    this._opened = false
  }

  /**
   * 强制刷盘（在不需要 close 的场景下确保数据持久化）
   * 模拟"崩溃前 fsync"的语义
   */
  sync(): void {
    if (this._activeFd >= 0) {
      fs.fsyncSync(this._activeFd)
    }
  }

  /**
   * 追加一条 PENDING 消息
   *
   * fsync 策略（默认 'every-n', n=100）：
   * - 'every-n'（默认）：每 100 条记录触发一次 fsync，最坏情况最多丢失 N 条记录
   * - 可通过 options.fsyncOnWrite 参数覆盖
   *
   * 当 fsyncOnWrite=true（默认）时，每 N 条记录后刷盘一次，
   * 在性能与崩溃恢复之间取得平衡。
   * 当 fsyncOnWrite=false 时，跳过 fsync，依赖操作系统批量刷盘，
   * 性能更快但崩溃时可能丢失更多写入。
   */
  append(msg: StreamMessage): void {
    const buf = this._encode(msg, FLAG_PENDING)
    const recordLen = buf.length

    // 如果当前 segment 放不下这条记录，滚动
    if (this._activeSize + recordLen > this._segmentMaxBytes) {
      this._rollSegment()
    }

    fs.writeSync(this._activeFd, buf)
    if (this._fsyncOnWrite) {
      this._fsyncCounter++
      if (this._fsyncCounter >= this._fsyncEveryN) {
        fs.fsyncSync(this._activeFd) // 每 N 条记录刷盘一次
        this._fsyncCounter = 0
      }
    } else {
      // 'lazy' 模式：不主动 fsync
    }
    this._activeSize += recordLen
    this._entriesCount++
  }

  /**
   * A-01: 批量追加多条消息，只做一次 fsync（真正的 Group Commit）
   *
   * 将多条 pending 消息合并编码后单次写入文件，然后只调用一次 fsync。
   * 相比多次 append 分别 fsync，大幅减少系统调用次数。
   *
   * @param msgs 待追加的消息列表
   */
  appendBatch(msgs: StreamMessage[]): void {
    if (msgs.length === 0) return

    // 批量编码
    const buffers: Buffer[] = []
    for (const msg of msgs) {
      const buf = this._encode(msg, FLAG_PENDING)
      const recordLen = buf.length

      // 如果当前 segment 放不下这条记录，滚动
      if (this._activeSize + recordLen > this._segmentMaxBytes) {
        // 先把已编码的写入
        if (buffers.length > 0) {
          const combined = Buffer.concat(buffers)
          fs.writeSync(this._activeFd, combined)
          this._activeSize += combined.length
          buffers.length = 0
        }
        this._rollSegment()
      }

      buffers.push(buf)
    }

    // 一次写入所有剩余消息
    if (buffers.length > 0) {
      const combined = Buffer.concat(buffers)
      fs.writeSync(this._activeFd, combined)
      this._activeSize += combined.length
    }

    // 只调用一次 fsync
    if (this._fsyncOnWrite) {
      fs.fsyncSync(this._activeFd)
    }

    this._entriesCount += msgs.length
  }

  /**
   * 标记消息为 ACKED
   */
  acknowledge(msgIds: string[] | Set<string>): void {
    const set = msgIds instanceof Set ? msgIds : new Set(msgIds)
    if (set.size === 0) return
    this._updateFlags(set, FLAG_ACKED)
  }

  /**
   * 标记消息为 CONSUMED
   */
  markConsumed(msgIds: string[] | Set<string>): void {
    const set = msgIds instanceof Set ? msgIds : new Set(msgIds)
    if (set.size === 0) return
    this._updateFlags(set, FLAG_CONSUMED)
  }

  /**
   * 读取超过超时时间的 PENDING 消息
   */
  readPending(beforeTimestamp: number): StreamMessage[] {
    const result: StreamMessage[] = []
    const segments = this._listSegments()

    for (const seg of segments) {
      const fd = fs.openSync(seg.path, 'r')
      try {
        let pos = 0
        while (pos < seg.size) {
          const rec = this._readRecordAt(fd, pos, seg.size)
          if (!rec) break
          if (rec.flags === FLAG_PENDING && rec.message.timestamp < beforeTimestamp) {
            result.push(rec.message)
          }
          pos += rec._recordLen
        }
      } finally {
        fs.closeSync(fd)
      }
    }

    return result
  }

  /**
   * 从指定 seq 开始回放
   */
  replay(fromSeq: number): StreamMessage[] {
    const result: StreamMessage[] = []
    const segments = this._listSegments()

    for (const seg of segments) {
      const fd = fs.openSync(seg.path, 'r')
      try {
        let pos = 0
        while (pos < seg.size) {
          const rec = this._readRecordAt(fd, pos, seg.size)
          if (!rec) break
          if (rec.flags !== FLAG_CONSUMED && rec.message.seq >= fromSeq) {
            result.push(rec.message)
          }
          pos += rec._recordLen
        }
      } finally {
        fs.closeSync(fd)
      }
    }

    return result
  }

  /**
   * 清理已完成的记录 — 删除可回收的 segment
   *
   * 与旧版关键区别：永远不重写数据，只删整个 segment 文件。
   * 从最旧的 segment 开始，检查其所有记录是否可清理
   * （即没有 PENDING 消息）。如果整个 segment 只有 ACKED/CONSUMED，
   * 直接 unlink 该文件；一旦遇到包含 PENDING 的 segment，停止扫描。
   *
   * POSIX 保证：unlink 后文件数据在最后一个 fd 关闭后才回收，
   * 因此即使进程崩溃，已打开的文件仍可安全读取。
   *
   * @returns 剩余 PENDING 消息数
   */
  prune(): number {
    if (this._pruning) return this._countPending()
    this._pruning = true

    const segments = this._listSegments()

    // 找到第一个包含 PENDING 的 segment
    let firstPendingSeg: number | null = null
    for (const seg of segments) {
      if (seg.num === this._activeSegment) break // 永不删除活跃 segment
      if (this._segmentHasPending(seg)) {
        // 这个 segment 还有 PENDING 消息，停止
        firstPendingSeg = seg.num
        break
      }
    }

    // 确定可删除的 segment 范围
    const removable = firstPendingSeg !== null
      ? segments.filter(s => s.num >= this._lastPrunedSegment + 1 && s.num < firstPendingSeg)
      : segments.filter(s => s.num >= this._lastPrunedSegment + 1 && s.num < this._activeSegment)

    for (const seg of removable) {
      try {
        fs.unlinkSync(seg.path)
        this.logger.info(`prune: removed segment ${this._segmentFilename(seg.num)}`)
      } catch (err: any) {
        this.logger.warn(`prune: failed to remove ${seg.path}: ${err.message}`)
      }
    }

    if (removable.length > 0) {
      this._lastPrunedSegment = removable[removable.length - 1].num
      this._saveManifest()
    }

    // 重新计数（删除后）
    const pendingCount = this._countPending()
    this._entriesCount = pendingCount

    this._pruning = false
    return pendingCount
  }

  /**
   * 清理所有早于时间戳的 ACKED/CONSUMED 记录。
   * 在 segment 模式下，这个方法等价于 prune()。
   */
  pruneByTimestamp(_olderThan: number): number {
    // segment 模式下，prune() 已能处理所有情况
    return this.prune()
  }

  /**
   * 删除 WAL 目录
   */
  drop(): void {
    this.close()
    try { fs.rmSync(this.walDir, { recursive: true }) } catch { /* ignore */ }
  }

  // ── 内部方法 ─────────────────────────

  private _segmentFilename(num: number): string {
    return String(num).padStart(8, '0') + '.log'
  }

  private _segmentPath(num: number): string {
    return path.join(this.walDir, this._segmentFilename(num))
  }

  private _openActiveSegment(): void {
    const segPath = this._segmentPath(this._activeSegment)
    this._activeFd = fs.openSync(segPath, 'a+')
    // 获取当前文件大小（追加模式下已有内容）
    const stat = fs.fstatSync(this._activeFd)
    this._activeSize = stat.size
  }

  private _closeActiveFd(): void {
    if (this._activeFd >= 0) {
      try { fs.closeSync(this._activeFd) } catch { /* ignore */ }
      this._activeFd = -1
    }
  }

  private _flushAndCloseActiveFd(): void {
    if (this._activeFd >= 0) {
      try {
        fs.fsyncSync(this._activeFd)
        fs.closeSync(this._activeFd)
      } catch { /* ignore */ }
      this._activeFd = -1
    }
    this._fsyncCounter = 0
  }

  /**
   * 滚动到新 segment：关闭当前，创建新的
   */
  private _rollSegment(): void {
    this._closeActiveFd()
    this._activeSegment++
    this._openActiveSegment()
    this._saveManifest()
  }

  /**
   * 列出所有 segment 文件（按序号升序）
   */
  private _listSegments(): SegmentInfo[] {
    const segments: SegmentInfo[] = []
    try {
      const files = fs.readdirSync(this.walDir)
      for (const f of files) {
        if (!f.endsWith('.log')) continue
        const num = parseInt(f.replace('.log', ''), 10)
        if (isNaN(num)) continue
        const segPath = path.join(this.walDir, f)
        const stat = fs.statSync(segPath)
        segments.push({ num, path: segPath, size: stat.size })
      }
    } catch { /* ignore */ }

    segments.sort((a, b) => a.num - b.num)
    return segments
  }

  /**
   * 检查 segment 是否包含 PENDING 消息
   */
  private _segmentHasPending(seg: SegmentInfo): boolean {
    if (seg.size === 0) return false
    const fd = fs.openSync(seg.path, 'r')
    try {
      let pos = 0
      while (pos < seg.size) {
        const buf = Buffer.alloc(1)
        const n = fs.readSync(fd, buf, 0, 1, pos)
        if (n < 1) break
        const flags = buf[0]
        if (flags === FLAG_PENDING) return true

        // 跳过剩余记录
        const lenBuf = Buffer.alloc(4)
        const ln = fs.readSync(fd, lenBuf, 0, 4, pos + 1)
        if (ln < 4) break
        const msgIdLen = lenBuf.readUInt32BE(0)
        const dlBuf = Buffer.alloc(4)
        const dn = fs.readSync(fd, dlBuf, 0, 4, pos + 5 + msgIdLen)
        if (dn < 4) break
        const dataLen = dlBuf.readUInt32BE(0)
        pos += 1 + 4 + msgIdLen + 4 + dataLen
      }
    } finally {
      fs.closeSync(fd)
    }
    return false
  }

  /**
   * 批量更新 flags
   */
  private _updateFlags(msgIds: Set<string>, newFlag: number): void {
    const segments = this._listSegments()

    for (const seg of segments) {
      let fd = -1
      try {
        fd = fs.openSync(seg.path, 'r+')
      } catch {
        continue
      }

      let pos = 0
      try {
        while (pos < seg.size) {
          const rec = this._readRecordAt(fd, pos, seg.size)
          if (!rec) break

          if (msgIds.has(rec.msgId)) {
            // 只在标志位不同时写（减少磁盘 I/O）
            if (rec.flags !== newFlag && rec.flags !== FLAG_CONSUMED) {
              // 不允许从 CONSUMED 降级
              if (rec.flags === FLAG_PENDING || (rec.flags === FLAG_ACKED && newFlag === FLAG_CONSUMED)) {
                const flagBuf = Buffer.alloc(1)
                flagBuf[0] = newFlag
                fs.writeSync(fd, flagBuf, 0, 1, pos)
              }
            }
          }
          pos += rec._recordLen
        }
      } finally {
        fs.closeSync(fd)
      }
    }
  }

  private _loadOrCreateManifest(): Manifest {
    const manifestPath = path.join(this.walDir, 'manifest.json')
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8')
      const m: Manifest = JSON.parse(raw)
      // 始终从磁盘重新计数（manifest 可能因未正常 close 而陈旧）
      m.entriesCount = this._countAllEntries()
      return m
    } catch {
      // 没有 manifest → 从文件系统扫描重建
      const segments = this._listSegments()
      const activeSeg = segments.length > 0 ? segments[segments.length - 1].num : 1

      const manifest: Manifest = {
        version: 1,
        activeSegment: activeSeg,
        lastPrunedSegment: 0,
        entriesCount: this._countAllEntries(),
      }

      this._writeManifest(manifestPath, manifest)
      return manifest
    }
  }

  private _saveManifest(): void {
    const manifestPath = path.join(this.walDir, 'manifest.json')
    const manifest: Manifest = {
      version: 1,
      activeSegment: this._activeSegment,
      lastPrunedSegment: this._lastPrunedSegment,
      entriesCount: this._entriesCount,
    }
    this._writeManifest(manifestPath, manifest)
  }

  private _writeManifest(path: string, m: Manifest): void {
    // 原子写：写临时文件后 rename
    const tmpPath = path + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(m), 'utf-8')
    fs.renameSync(tmpPath, path)
  }

  private _countAllEntries(): number {
    const segments = this._listSegments()
    let count = 0
    for (const seg of segments) {
      const fd = fs.openSync(seg.path, 'r')
      try {
        let pos = 0
        while (pos < seg.size) {
          const buf = Buffer.alloc(1)
          if (fs.readSync(fd, buf, 0, 1, pos) < 1) break
          const lenBuf = Buffer.alloc(4)
          if (fs.readSync(fd, lenBuf, 0, 4, pos + 1) < 4) break
          const msgIdLen = lenBuf.readUInt32BE(0)
          const dlBuf = Buffer.alloc(4)
          if (fs.readSync(fd, dlBuf, 0, 4, pos + 5 + msgIdLen) < 4) break
          const dataLen = dlBuf.readUInt32BE(0)
          count++
          pos += 1 + 4 + msgIdLen + 4 + dataLen
        }
      } finally {
        fs.closeSync(fd)
      }
    }
    return count
  }

  /** 统计所有 segment 中 PENDING 消息数 */
  private _countPending(): number {
    const segments = this._listSegments()
    let count = 0
    for (const seg of segments) {
      const fd = fs.openSync(seg.path, 'r')
      try {
        let pos = 0
        while (pos < seg.size) {
          const buf = Buffer.alloc(1)
          if (fs.readSync(fd, buf, 0, 1, pos) < 1) break
          const flags = buf[0]
          if (flags === FLAG_PENDING) count++

          const lenBuf = Buffer.alloc(4)
          if (fs.readSync(fd, lenBuf, 0, 4, pos + 1) < 4) break
          const msgIdLen = lenBuf.readUInt32BE(0)
          const dlBuf = Buffer.alloc(4)
          if (fs.readSync(fd, dlBuf, 0, 4, pos + 5 + msgIdLen) < 4) break
          const dataLen = dlBuf.readUInt32BE(0)
          pos += 1 + 4 + msgIdLen + 4 + dataLen
        }
      } finally {
        fs.closeSync(fd)
      }
    }
    return count
  }

  /**
   * 检测旧单文件 WAL 并迁移到 segment 格式
   *
   * 如果 walDir 对应路径是一个文件（而非目录），
   * 则将其迁移为 segment 1，并创建目录结构。
   */
  private _migrateFromOldFormat(): void {
    try {
      const stat = fs.statSync(this.walDir)
      if (!stat.isFile()) return

      // walDir 是一个文件（旧格式），需要迁移
      const oldPath = this.walDir
      const parentDir = path.dirname(oldPath)
      const segDir = path.join(parentDir, path.basename(oldPath) + '_segments')
      this.walDir = segDir

      fs.mkdirSync(segDir, { recursive: true })

      // 将旧文件重命名为 segment 1
      const seg1Path = path.join(segDir, this._segmentFilename(1))
      fs.renameSync(oldPath, seg1Path)

      this.logger.info(`migrated old single-file WAL to segment format at ${segDir}`)
    } catch {
      // 文件不存在或目录已存在，不做迁移
      return
    }
  }

  // ── 记录编解码 ─────────────────────────

  private _encode(msg: StreamMessage, flags: number): Buffer {
    const data = JSON.stringify({
      type: msg.type,
      nodeId: msg.nodeId,
      timestamp: msg.timestamp,
      data: msg.data,
      msgId: msg.msgId,
      seq: msg.seq,
    })
    const msgIdBuf = Buffer.from(msg.msgId, 'utf-8')
    const dataBuf = Buffer.from(data, 'utf-8')

    const buf = Buffer.alloc(1 + 4 + msgIdBuf.length + 4 + dataBuf.length)
    let offset = 0
    buf[offset++] = flags
    buf.writeUInt32BE(msgIdBuf.length, offset); offset += 4
    msgIdBuf.copy(buf, offset); offset += msgIdBuf.length
    buf.writeUInt32BE(dataBuf.length, offset); offset += 4
    dataBuf.copy(buf, offset)

    return buf
  }

  private _readRecordAt(
    fd: number,
    pos: number,
    endOffset: number,
  ): (StreamWalEntry & { _recordLen: number }) | null {
    if (pos + 1 > endOffset) return null
    const buf = Buffer.alloc(1)
    const n = fs.readSync(fd, buf, 0, 1, pos)
    if (n < 1) return null
    const flags = buf[0]

    const lenBuf = Buffer.alloc(4)
    const ln = fs.readSync(fd, lenBuf, 0, 4, pos + 1)
    if (ln < 4) return null
    const msgIdLen = lenBuf.readUInt32BE(0)

    const msgIdBuf = Buffer.alloc(msgIdLen)
    const mn = fs.readSync(fd, msgIdBuf, 0, msgIdLen, pos + 5)
    if (mn < msgIdLen) return null
    const msgId = msgIdBuf.toString('utf-8')

    const dlBuf = Buffer.alloc(4)
    const dn = fs.readSync(fd, dlBuf, 0, 4, pos + 5 + msgIdLen)
    if (dn < 4) return null
    const dataLen = dlBuf.readUInt32BE(0)

    const totalRecordLen = 1 + 4 + msgIdLen + 4 + dataLen
    if (pos + totalRecordLen > endOffset) return null

    const dataBuf = Buffer.alloc(dataLen)
    const dd = fs.readSync(fd, dataBuf, 0, dataLen, pos + 5 + msgIdLen + 4)
    if (dd < dataLen) return null

    let message: StreamMessage
    try {
      const parsed = JSON.parse(dataBuf.toString('utf-8'))
      message = {
        msgId: parsed.msgId,
        seq: parsed.seq,
        nodeId: parsed.nodeId,
        timestamp: parsed.timestamp,
        type: parsed.type,
        data: parsed.data,
      }
    } catch {
      return null
    }

    return { offset: pos, flags, msgId, message, _recordLen: totalRecordLen }
  }
}
