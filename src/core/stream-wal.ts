/**
 * stream-wal.ts — EventStream 消息持久化
 *
 * 二进制格式 WAL，用于可靠事件流的发送缓冲与消费位点记录。
 * 每条记录格式：
 *   [1  byte: flags]   0x00=PENDING, 0x01=ACKED, 0x02=CONSUMED
 *   [4  bytes: msgId length]  (Big-Endian)
 *   [N  bytes: msgId UTF-8]
 *   [4  bytes: data length]   (Big-Endian)
 *   [N  bytes: JSON-encoded StreamMessage]
 *
 * 所有整数字段 Big-Endian，与共识层的 WAL 风格一致但不共享实现。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Logger } from '../ops/logger'

export const FLAG_PENDING = 0x00
export const FLAG_ACKED = 0x01
export const FLAG_CONSUMED = 0x02

export interface StreamMessage {
  /** 全局唯一 ID: "{nodeId}-{seq}" */
  msgId: string
  /** 单调递增序号（本节点内） */
  seq: number
  /** 来源节点 ID */
  nodeId: string
  /** 事件时间戳 */
  timestamp: number
  /** 事件类型（不含特殊控制类型） */
  type: string
  /** 事件数据 */
  data: Record<string, unknown>
}

export interface StreamWalEntry {
  offset: number
  flags: number
  msgId: string
  message: StreamMessage
}

/**
 * StreamWal — 轻量级消息持久化队列
 *
 * 职责：
 * - append(message)：写入新的 PENDING 消息
 * - acknowledge(msgIds)：标记消息为 ACKED
 * - markConsumed(msgIds)：标记消息为 CONSUMED
 * - readPending(beforeTimestamp)：读取待重试的超时消息
 * - prune(olderThan)：清理已确认/消费的消息
 * - replay(fromSeq)：从指定序号开始回放（用于离线追赶）
 */
export class StreamWal {
  private fd: number
  private walPath: string
  private logger: Logger
  private _opened = false
  private _size = 0
  private _pruning = false

  constructor(walPath: string) {
    this.walPath = walPath
    this.logger = new Logger('StreamWal')
    this.fd = -1
  }

  get isOpen(): boolean { return this._opened }
  get size(): number { return this._size }

  open(): void {
    if (this._opened) return
    fs.mkdirSync(path.dirname(this.walPath), { recursive: true })
    this.fd = fs.openSync(this.walPath, 'a+')
    // 统计现有条目数量
    this._size = this._countEntries()
    this._opened = true
  }

  close(): void {
    if (!this._opened) return
    if (this.fd >= 0) {
      fs.closeSync(this.fd)
      this.fd = -1
    }
    this._opened = false
  }

  /**
   * 追加一条 PENDING 消息
   */
  append(msg: StreamMessage): void {
    const buf = this._encode(msg, FLAG_PENDING)
    fs.writeSync(this.fd, buf)
    this._size++
  }

  /**
   * 标记消息为 ACKED
   * 扫描文件找到对应 msgId 的条目，修改 flags 字节。
   * 为了性能，使用 in-place 覆盖写。（单条记录不跨文件块，flags 总是第 1 个字节）
   */
  acknowledge(msgIds: string[] | Set<string>): void {
    const set = msgIds instanceof Set ? msgIds : new Set(msgIds)
    if (set.size === 0) return

    // r+ 模式用于覆盖写；a+ 模式的 write(position) 在某些平台上不生效
    let fd = -1
    try {
      fd = fs.openSync(this.walPath, 'r+')
    } catch {
      return // 文件不存在或不可写
    }

    let pos = 0
    const buf = Buffer.alloc(1)

    try {
      while (true) {
        const n = fs.readSync(fd, buf, 0, 1, pos)
        if (n < 1) break
        const flags = buf[0]

        const lenBuf = Buffer.alloc(4)
        const ln = fs.readSync(fd, lenBuf, 0, 4, pos + 1)
        if (ln < 4) break
        const msgIdLen = lenBuf.readUInt32BE(0)

        const msgIdBuf = Buffer.alloc(msgIdLen)
        const mn = fs.readSync(fd, msgIdBuf, 0, msgIdLen, pos + 5)
        if (mn < msgIdLen) break
        const msgId = msgIdBuf.toString('utf-8')

        const dlBuf = Buffer.alloc(4)
        const dn = fs.readSync(fd, dlBuf, 0, 4, pos + 5 + msgIdLen)
        if (dn < 4) break
        const dataLen = dlBuf.readUInt32BE(0)
        const recordLen = 1 + 4 + msgIdLen + 4 + dataLen

        if (flags === FLAG_PENDING && set.has(msgId)) {
          const flagBuf = Buffer.alloc(1)
          flagBuf[0] = FLAG_ACKED
          fs.writeSync(fd, flagBuf, 0, 1, pos)
        }

        pos += recordLen
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * 标记消息为 CONSUMED（本地 SUB 侧已处理）
   */
  markConsumed(msgIds: string[] | Set<string>): void {
    const set = msgIds instanceof Set ? msgIds : new Set(msgIds)
    if (set.size === 0) return

    let fd = -1
    try {
      fd = fs.openSync(this.walPath, 'r+')
    } catch {
      return
    }

    let pos = 0
    const buf = Buffer.alloc(1)

    try {
      while (true) {
        const n = fs.readSync(fd, buf, 0, 1, pos)
        if (n < 1) break

        const lenBuf = Buffer.alloc(4)
        const ln = fs.readSync(fd, lenBuf, 0, 4, pos + 1)
        if (ln < 4) break
        const msgIdLen = lenBuf.readUInt32BE(0)

        const msgIdBuf = Buffer.alloc(msgIdLen)
        const mn = fs.readSync(fd, msgIdBuf, 0, msgIdLen, pos + 5)
        if (mn < msgIdLen) break
        const msgId = msgIdBuf.toString('utf-8')

        const dlBuf = Buffer.alloc(4)
        const dn = fs.readSync(fd, dlBuf, 0, 4, pos + 5 + msgIdLen)
        if (dn < 4) break
        const dataLen = dlBuf.readUInt32BE(0)
        const recordLen = 1 + 4 + msgIdLen + 4 + dataLen

        if (set.has(msgId)) {
          const flagBuf = Buffer.alloc(1)
          flagBuf[0] = FLAG_CONSUMED
          fs.writeSync(fd, flagBuf, 0, 1, pos)
        }

        pos += recordLen
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * 读取所有 PENDING 消息中超过超时时间的（用于重试）
   * @param beforeTimestamp  - 只返回 timestamp < beforeTimestamp 的消息（超时判断）
   * @returns PENDING 消息列表
   */
  readPending(beforeTimestamp: number): StreamMessage[] {
    const result: StreamMessage[] = []
    const fd = fs.openSync(this.walPath, 'r')
    let pos = 0

    try {
      while (true) {
        const rec = this._readRecordAt(fd, pos)
        if (!rec) break
        if (rec.flags === FLAG_PENDING && rec.message.timestamp < beforeTimestamp) {
          result.push(rec.message)
        }
        pos += rec._recordLen
      }
    } finally {
      fs.closeSync(fd)
    }

    return result
  }

  /**
   * 从指定 seq 开始回放所有消息（用于追赶）
   * @param fromSeq  - 起始序号（包含）
   * @returns 从 fromSeq 开始的消息列表
   */
  replay(fromSeq: number): StreamMessage[] {
    const result: StreamMessage[] = []
    const fd = fs.openSync(this.walPath, 'r')
    let pos = 0

    try {
      while (true) {
        const rec = this._readRecordAt(fd, pos)
        if (!rec) break
        // PENDING 或 ACKED 都回放；CONSUMED 跳过（本地已消费）
        if (rec.flags !== FLAG_CONSUMED && rec.message.seq >= fromSeq) {
          result.push(rec.message)
        }
        pos += rec._recordLen
      }
    } finally {
      fs.closeSync(fd)
    }

    return result
  }

  /**
   * 清理已完成的记录（ACKED + CONSUMED），只保留 PENDING。
   * 重写文件。
   */
  prune(): number {
    if (this._pruning) return 0
    this._pruning = true
    const pending: StreamMessage[] = []
    const fd = fs.openSync(this.walPath, 'r')
    let pos = 0

    try {
      while (true) {
        const rec = this._readRecordAt(fd, pos)
        if (!rec) break
        if (rec.flags === FLAG_PENDING) {
          pending.push(rec.message)
        }
        pos += rec._recordLen
      }
    } finally {
      fs.closeSync(fd)
    }

    // 重写文件
    const tmpPath = this.walPath + '.tmp'
    const newFd = fs.openSync(tmpPath, 'w')
    try {
      for (const msg of pending) {
        const buf = this._encode(msg, FLAG_PENDING)
        fs.writeSync(newFd, buf)
      }
    } finally {
      fs.closeSync(newFd)
    }

    // 替换
    fs.renameSync(tmpPath, this.walPath)
    this._size = pending.length
    this.fd = fs.openSync(this.walPath, 'a+')

    this._pruning = false
    return pending.length
  }

  /**
   * 清理所有早于某个时间戳的 ACKED/CONSUMED 记录
   */
  pruneByTimestamp(olderThan: number): number {
    if (this._pruning) return 0
    this._pruning = true
    const keep: StreamMessage[] = []
    const fd = fs.openSync(this.walPath, 'r')
    let pos = 0

    try {
      while (true) {
        const rec = this._readRecordAt(fd, pos)
        if (!rec) break
        if (rec.flags === FLAG_PENDING || rec.message.timestamp >= olderThan) {
          keep.push(rec.message)
        }
        pos += rec._recordLen
      }
    } finally {
      fs.closeSync(fd)
    }

    const tmpPath = this.walPath + '.tmp'
    const newFd = fs.openSync(tmpPath, 'w')
    try {
      for (const msg of keep) {
        const buf = this._encode(msg, FLAG_PENDING)
        fs.writeSync(newFd, buf)
      }
    } finally {
      fs.closeSync(newFd)
    }

    fs.renameSync(tmpPath, this.walPath)
    this._size = keep.length
    this.fd = fs.openSync(this.walPath, 'a+')

    this._pruning = false
    return keep.length
  }

  /**
   * 删除 WAL 文件
   */
  drop(): void {
    this.close()
    try { fs.unlinkSync(this.walPath) } catch { /* ignore */ }
  }

  // ── 内部 ─────────────────────────

  private _encode(msg: StreamMessage, flags: number): Buffer {
    const data = JSON.stringify({ type: msg.type, nodeId: msg.nodeId, timestamp: msg.timestamp, data: msg.data, msgId: msg.msgId, seq: msg.seq })
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

  private _readRecordAt(fd: number, pos: number): (StreamWalEntry & { _recordLen: number }) | null {
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

    const recordLen = 1 + 4 + msgIdLen + 4 + dataLen

    return {
      offset: pos,
      flags,
      msgId,
      message,
      _recordLen: recordLen,
    }
  }

  private _countEntries(): number {
    let count = 0
    let pos = 0
    let fd: number | undefined
    try {
      fd = fs.openSync(this.walPath, 'r')
      while (true) {
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
    } catch {
      return 0
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    return count
  }
}
