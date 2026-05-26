/**
 * outbox-replication.ts — EventBus Outbox: PerPeerWorker 池
 *
 * 每个 peer 一个独立的 PerPeerWorker（setTimeout loop），互不阻塞。
 * 三级 pending 优先级队列：Critical（重试≥3次/超时）→ Normal → Stale（兜底）。
 * ackTracker 超时重传 + LinearBackoff + recoverDealerFn 重建 DEALER。
 *
 * 设计文档 docs/EventBus_WorkerPool_设计方案.md
 */

import { open, type RootDatabase } from 'lmdb'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { Logger } from '../ops/logger'
import { EventBus, parsePubFilename } from './event-bus'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  seq: number
  msgId: string
  targetNodeId: string
  type: string
  payload: string
  createdAt: number
  delivered: boolean
  deliveredAt: number
}

export interface OutboxPeerConfig {
  nodeId: string
  addr: string
}

/** PerPeerWorker 的 pending 消息队列条目 */
interface PendingItem {
  entry: OutboxEntry
  retryCount: number
  insertedAt: number
}

/** PerPeerWorker 配置 */
interface PerPeerConfig {
  peerId: string
  tickMs: number
  maxBackoffMs: number
  ackTimeoutMs: number
  batchSize?: number
  curveDir: string
  sendFn: (msgId: string, payload: Buffer) => Promise<void>
  batchSendFn?: (items: Array<{ msgId: string; payload: Buffer }>) => Promise<void>
  /**
   * 优化的批量发送接口：items 中携带预序列化的 buffer（TransportMessage JSON Buffer）。
   * 当 serializedCache 命中时使用此接口，跳过 JSON.parse → 重构 → JSON.stringify 的重复开销。
   * fallback到 batchSendFn 或 sendFn。
   */
  batchSendSerializedFn?: (items: Array<{ msgId: string; buffer: Buffer }>) => Promise<void>
  recoverDealerFn: () => Promise<void>
  logger?: Logger
}

export interface OutboxConfig {
  nodeId: string
  peers: OutboxPeerConfig[]
  curveDir: string
  dbPath?: string
  tickMs?: number
  maxBackoffSeconds?: number
  entryTTLDays?: number
  housekeepingIntervalMs?: number
  curveKeyPair?: { publicKey: string; secretKey: string }
  sendFn: (peerId: string, msgId: string, payload: Buffer) => Promise<void>
  recoverDealerFn: (peerId: string) => Promise<void>
  logger?: Logger
}

export interface OutboxReplicationConfig {
  nodeId: string
  peers: Array<{ nodeId: string; addr: string }>
  curveDir: string
  dbPath?: string
  tickMs?: number
  maxBackoffSeconds?: number
  batchSize?: number
  entryTTLDays?: number
  housekeepingIntervalMs?: number
  /** 启用 per-peer 分库（OutboxV2）。WorkerPool 多进程架构时零锁竞争。 */
  usePerPeerDb?: boolean
  eventBus: {
    send: (nodeId: string, msg: any) => Promise<void>
    batchSend?: (nodeId: string, msgs: any[]) => Promise<void>
    _recoverDealerByNodeId?: (nodeId: string) => Promise<void>
    _handleDealerSendError?: (nodeId: string, err: Error) => void
  }
  logger?: Logger
}

// ---------------------------------------------------------------------------
// OutboxIndex — LMDB 前缀索引
//
// 解决 fetchPendingByPeer/getPendingCountForPeer 全表扫描（O(N)）问题。
// 使用 LMDB 前缀范围扫描（O(K)，K=该 peer 的 pending 数）。
//
// 索引键格式：
//   pending:<peerId>:<pad10(seq)> → 1
//   delivered:<peerId>:<pad10(seq)> → 1     (用于清理索引)
//   seqToPeer:<seq> → peerId                 (seq → peer 反向查找)
// ---------------------------------------------------------------------------

class OutboxIndex {
  private db: RootDatabase

  constructor(db: RootDatabase) {
    this.db = db
  }

  addPending(peerId: string, seq: number): void {
    this.db.putSync(this._pendingKey(peerId, seq), 1)
    this.db.putSync(`seqToPeer:${seq}`, peerId)
  }

  markDelivered(peerId: string, seq: number): void {
    this.db.removeSync(this._pendingKey(peerId, seq))
    this.db.putSync(this._deliveredKey(peerId, seq), 1)
    this.db.removeSync(`seqToPeer:${seq}`)
  }

  markPending(peerId: string, seq: number): void {
    this.db.removeSync(this._deliveredKey(peerId, seq))
    this.db.putSync(this._pendingKey(peerId, seq), 1)
    this.db.putSync(`seqToPeer:${seq}`, peerId)
  }

  /** 按 peer 查询 pending seq 列表（LMDB 前缀扫描，O(K)） */
  fetchPendingSeqs(peerId: string): number[] {
    const seqs: number[] = []
    const prefix = this._pendingKey(peerId, 0).slice(0, -10) // 不含 seq 部分
    try {
      this.db.getRange({ start: prefix, end: prefix + '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff' })
        .forEach((entry: any) => {
          const key = typeof entry.key === 'string' ? entry.key : entry.key.toString()
          const seq = parseInt(key.slice(key.lastIndexOf(':') + 1), 10)
          if (!isNaN(seq)) seqs.push(seq)
        })
    } catch {
      // LMDB getRange 可能抛异常
    }
    return seqs // 天然按 seq 排序（前缀顺序）
  }

  /** 统计指定 peer 的 pending 数（O(K)） */
  countPending(peerId: string): number {
    let count = 0
    const prefix = this._pendingKey(peerId, 0).slice(0, -10)
    try {
      this.db.getRange({ start: prefix, end: prefix + '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff' })
        .forEach(() => { count++ })
    } catch {
      // ignore
    }
    return count
  }

  /** 获取最早待发送的 seq */
  oldestPending(peerId: string): number | null {
    const prefix = this._pendingKey(peerId, 0).slice(0, -10)
    try {
      let first: number | null = null
      this.db.getRange({ start: prefix, end: prefix + '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff', limit: 1 })
        .forEach((entry: any) => {
          const key = typeof entry.key === 'string' ? entry.key : entry.key.toString()
          first = parseInt(key.slice(key.lastIndexOf(':') + 1), 10)
        })
      return first
    } catch {
      return null
    }
  }

  /** 启动时从主 Outbox DB 重建索引 */
  rebuildFromScratch(mainDb: RootDatabase): void {
    let count = 0
    mainDb.getRange({ start: 1 }).forEach((entry: any) => {
      const e = entry.value as OutboxEntry
      if (!e.delivered) {
        this.db.putSync(this._pendingKey(e.targetNodeId, e.seq), 1)
        this.db.putSync(`seqToPeer:${e.seq}`, e.targetNodeId)
      } else {
        this.db.putSync(this._deliveredKey(e.targetNodeId, e.seq), 1)
      }
      count++
    })
  }

  /** 清理已送达的索引记录（housekeeping） */
  cleanDeliveredBefore(cutoffMs: number, mainDb: RootDatabase): number {
    let count = 0
    try {
      this.db.getRange({ start: 'delivered:' }).forEach((entry: any) => {
        const key = typeof entry.key === 'string' ? entry.key : entry.key.toString()
        // key: delivered:<peerId>:<pad10(seq)>
        const seq = parseInt(key.slice(key.lastIndexOf(':') + 1), 10)
        if (isNaN(seq)) return

        const outboxEntry = mainDb.get(seq) as OutboxEntry | undefined
        if (outboxEntry && outboxEntry.delivered && outboxEntry.deliveredAt < cutoffMs) {
          this.db.removeSync(key)
          // 同时清理 acked 标记（保持 indexDb 整洁）
          try { this.db.removeSync(`acked:${seq}`) } catch {}
          count++
        }
      })
    } catch {
      // ignore
    }
    return count
  }

  private _pendingKey(peerId: string, seq: number): string {
    return `pending:${peerId}:${String(seq).padStart(10, '0')}`
  }

  private _deliveredKey(peerId: string, seq: number): string {
    return `delivered:${peerId}:${String(seq).padStart(10, '0')}`
  }
}

export class Outbox implements IOutbox {
  private db: RootDatabase
  private seqDb: RootDatabase
  private indexDb: RootDatabase
  private index: OutboxIndex

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath)
    fs.mkdirSync(dir, { recursive: true })
    this.db = open({ path: dbPath, compression: true })
    this.seqDb = open({ path: dbPath + '-seq', compression: true })
    this.indexDb = open({ path: dbPath + '-index', compression: true })
    this.index = new OutboxIndex(this.indexDb)

    // 启动时重建索引（如果索引 DB 为空）
    this._ensureIndex()
  }

  close(): void {
    this.db.close()
    this.seqDb.close()
    this.indexDb.close()
  }

  add(entry: Omit<OutboxEntry, 'seq'>): number {
    const seq = (this.seqDb.get('seq') as number ?? 0) + 1
    this.seqDb.putSync('seq', seq)
    const full: OutboxEntry = { ...entry, seq }
    this.db.putSync(seq, full)
    this.index.addPending(entry.targetNodeId, seq)
    return seq
  }

  markDeliveredBatch(seqs: number[]): void {
    const now = Date.now()
    for (const seq of seqs) {
      const entry = this.db.get(seq) as OutboxEntry | undefined
      if (entry && !entry.delivered) {
        entry.delivered = true
        entry.deliveredAt = now
        this.db.putSync(seq, entry)
        this.index.markDelivered(entry.targetNodeId, seq)
      }
    }
  }

  /**
   * 标记 ACK 已到达（多进程场景：主进程直接写入 LMDB mmap，Worker 立即可见）。
   * 单进程场景 ACK 直接回调到 PerPeerWorker 的 ackTracker，不需要此方法。
   * 但统一接口保证迁移到多进程时零代码改动。
   */
  markAcked(seq: number): void {
    const entry = this.db.get(seq) as OutboxEntry | undefined
    if (!entry) return
    if (!entry.delivered) {
      // ACK 到达但尚未标记 delivered —— 少见但合法
      entry.delivered = true
      entry.deliveredAt = Date.now()
      this.db.putSync(seq, entry)
      this.index.markDelivered(entry.targetNodeId, seq)
    }
    // 在索引中标记 ack 状态（用于多进程 mmap 共享）
    this.indexDb.putSync(`acked:${seq}`, 1)
  }

  /**
   * 查询指定 seq 的 ACK 是否已到达（多进程场景：Worker 子进程通过 LMDB mmap 读到主进程写入的 ACK）。
   * O(1) 查询——前缀键定位。
   */
  isAcked(seq: number): boolean {
    try {
      const val = this.indexDb.get(`acked:${seq}`)
      return val === 1
    } catch {
      return false
    }
  }

  // 罕见：用于重发 / 回退
  markPending(seq: number): void {
    const entry = this.db.get(seq) as OutboxEntry | undefined
    if (entry) {
      entry.delivered = false
      entry.deliveredAt = 0
      this.db.putSync(seq, entry)
      this.index.markPending(entry.targetNodeId, seq)
    }
  }

  fetchOldestPending(peerId: string): OutboxEntry | null {
    // 先查索引拿到最早的 seq
    const oldestSeq = this.index.oldestPending(peerId)
    if (oldestSeq === null) return null
    const entry = this.db.get(oldestSeq) as OutboxEntry | undefined
    return entry ?? null
  }

  /** 取指定 peer 的所有 pending 消息（按 seq 升序）— 使用索引，O(K) */
  fetchPendingByPeer(peerId: string): OutboxEntry[] {
    // 1. 从索引获取 seq 列表
    const seqs = this.index.fetchPendingSeqs(peerId)
    if (seqs.length === 0) return []

    // 2. 批量从主 DB 读取
    return seqs
      .map(seq => this.db.get(seq) as OutboxEntry | undefined)
      .filter((e): e is OutboxEntry => e !== undefined && !e.delivered)
  }

  getPendingCountForPeer(peerId: string): number {
    return this.index.countPending(peerId)
  }

  cleanDeliveredBefore(cutoffMs: number): number {
    let count = 0
    this.db.getRange({ start: 1 }).forEach((entry: any) => {
      const e = entry.value as OutboxEntry
      if (e.delivered && e.deliveredAt < cutoffMs) {
        // 清理 mainDb 中的条目
        this.db.removeSync(entry.key)
        // 清理 indexDb 中的 acked 标记
        this.indexDb.removeSync(`acked:${entry.key}`)
        count++
      }
    })
    // 同时清理索引
    this.index.cleanDeliveredBefore(cutoffMs, this.db)
    return count
  }

  getPendingCount(): number {
    let count = 0
    this.db.getRange({ start: 1 }).forEach((entry: any) => {
      if (!(entry.value as OutboxEntry).delivered) count++
    })
    return count
  }

  /** 确保索引已建立 */
  private _ensureIndex(): void {
    try {
      // 快速检查索引是否为空
      const hasIndex = this.index.countPending('__probe__') >= 0
      // 检查主 DB 是否有数据
      let hasData = false
      this.db.getRange({ start: 1, limit: 1 }).forEach(() => { hasData = true })

      if (hasData) {
        // 检查索引是否有内容：读一个非 pending 的 key 来检测
        let indexHasData = false
        try {
          this.indexDb.getRange({ start: 'pending:', limit: 1 }).forEach(() => { indexHasData = true })
        } catch { /* ignore */ }

        if (!indexHasData) {
          this.index.rebuildFromScratch(this.db)
        }
      }
    } catch {
      // 索引异常时重建（慢启动）
      try { this.index.rebuildFromScratch(this.db) } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// OutboxV2 — Per-Peer LMDB 分库
//
// 每个 peer 拥有独立的 LMDB 环境，WorkerPool 多进程时零锁竞争。
//
// 存储结构：
//   data/outbox-v2/
//     peer-1.lmdb/       # peer-1 的出站消息 + 序列 + 索引
//     peer-2.lmdb/       # peer-2 的出站消息 + 序列 + 索引
//     ...
//     _seq-counter.lmdb/ # 全局唯一序列计数器
//
// 每个 peer LMDB 内部使用 prefix-key：
//   msg:${seq}      → OutboxEntry
//   seq             → lastSeq（全局唯一序列）
//   pending         → 当前 pending 列表（"," 分隔的 seq）
//   delivered       → 已发送列表（"," 分隔的 seq）
//   acked:${seq}    → 1（ACK 状态）
// ---------------------------------------------------------------------------

export class OutboxV2 implements IOutbox {
  private basePath: string
  /** peerId → LMDB 环境 */
  private peerDbs = new Map<string, RootDatabase>()
  /** 全局序列计数器 DB */
  private seqCounterDb: RootDatabase
  /** 已打开的 LMDB 路径集合，共 close */
  private allDbs: RootDatabase[] = []

  constructor(dbPath: string) {
    this.basePath = dbPath
    fs.mkdirSync(dbPath, { recursive: true })
    const seqCounterPath = path.join(dbPath, '_seq-counter.lmdb')
    this.seqCounterDb = open({ path: seqCounterPath, compression: true })
    this.allDbs.push(this.seqCounterDb)
  }

  close(): void {
    for (const peerDb of this.peerDbs.values()) {
      try { peerDb.close() } catch { /* best-effort */ }
    }
    this.peerDbs.clear()
    for (const db of this.allDbs) {
      try { db.close() } catch { /* best-effort */ }
    }
    this.allDbs = []
  }

  /** 获取或创建 peer 对应的 LMDB 环境 */
  private _getOrOpenPeerDb(peerId: string): RootDatabase {
    let db = this.peerDbs.get(peerId)
    if (db) return db
    const peerDbPath = this.getPeerDbPath(peerId)
    db = open({
      path: peerDbPath,
      compression: true,
      mapSize: 64 * 1024 * 1024, // 64MB per peer
    })
    this.peerDbs.set(peerId, db)
    this.allDbs.push(db)
    return db
  }

  /** 返回 peer LMDB 目录路径 */
  getPeerDbPath(peerId: string): string {
    return path.join(this.basePath, `${peerId}.lmdb`)
  }

  /**
   * 通过 seq 找到 peer LMDB → 用于 markDelivered/markAcked 等操作。
   * 遍历所有 peer LMDB 查找（peer 数量有限，O(P) 可接受）。
   * 如果频繁调用可加 peer→seq 缓存，但当前场景不需要。
   */
  private _findPeerDbBySeq(seq: number): RootDatabase | null {
    for (const [peerId, db] of this.peerDbs) {
      try {
        const entry = db.get(`msg:${seq}`) as OutboxEntry | undefined
        if (entry) return db
      } catch {
        // try next
      }
    }
    // 未缓存 peer DB，遍历文件系统
    if (!fs.existsSync(this.basePath)) return null
    const entries: string[] = []
    try {
      const dirs = fs.readdirSync(this.basePath)
      for (const d of dirs) {
        if (!d.endsWith('.lmdb') || d === '_seq-counter.lmdb') continue
        const peerId = d.slice(0, -5) // remove '.lmdb'
        const db = this._getOrOpenPeerDb(peerId)
        try {
          const entry = db.get(`msg:${seq}`) as OutboxEntry | undefined
          if (entry) return db
        } catch {
          // try next
        }
      }
    } catch { /* ignore dir read errors */ }
    return null
  }

  /** 生成全局唯一递增 seq */
  private _nextSeq(): number {
    // 使用 seqCounterDb 确保原子递增
    let seq: number
    try {
      // LMDB 事务保证 append 的原子性
      this.seqCounterDb.transactionSync(() => {
        const current = (this.seqCounterDb.get('seq') as number) ?? 0
        seq = current + 1
        this.seqCounterDb.putSync('seq', seq)
      })
    } catch (err) {
      // 如果事务失败（罕见），回退到 Date.now() 方案
      seq = Date.now()
    }
    return seq!
  }

  add(entry: Omit<OutboxEntry, 'seq'>): number {
    const seq = this._nextSeq()
    const full: OutboxEntry = { ...entry, seq }
    const peerDb = this._getOrOpenPeerDb(entry.targetNodeId)
    peerDb.putSync(`msg:${seq}`, full)

    // 更新 pending 列表
    const pendingStr = (peerDb.get('pending') as string) ?? ''
    const pendingSeqs = pendingStr ? pendingStr.split(',').map(Number) : []
    pendingSeqs.push(seq)
    peerDb.putSync('pending', pendingSeqs.join(','))

    return seq
  }

  markDeliveredBatch(seqs: number[]): void {
    const now = Date.now()
    // 按 peer 分组 seqs 以批量操作
    const seqByPeer = new Map<string, number[]>()
    for (const seq of seqs) {
      const db = this._findPeerDbBySeq(seq)
      if (!db) continue
      // 找到该 db 所属 peer
      let peerId: string | null = null
      for (const [pid, pdb] of this.peerDbs) {
        if (pdb === db) { peerId = pid; break }
      }
      if (!peerId) continue
      let list = seqByPeer.get(peerId)
      if (!list) { list = []; seqByPeer.set(peerId, list) }
      list.push(seq)
    }

    for (const [peerId, peerSeqs] of seqByPeer) {
      const peerDb = this._getOrOpenPeerDb(peerId)
      for (const seq of peerSeqs) {
        const entry = peerDb.get(`msg:${seq}`) as OutboxEntry | undefined
        if (entry && !entry.delivered) {
          entry.delivered = true
          entry.deliveredAt = now
          peerDb.putSync(`msg:${seq}`, entry)
        }
      }
      // 从 pending 列表移除这些 seq
      const pendingStr = (peerDb.get('pending') as string) ?? ''
      const pendingSeqs = pendingStr ? pendingStr.split(',').map(Number) : []
      const deliveredSet = new Set(peerSeqs)
      const remaining = pendingSeqs.filter(s => !deliveredSet.has(s))
      peerDb.putSync('pending', remaining.join(','))

      // 加入 delivered 列表
      const deliveredStr = (peerDb.get('delivered') as string) ?? ''
      const deliveredSeqs = deliveredStr ? deliveredStr.split(',').map(Number) : []
      deliveredSeqs.push(...peerSeqs)
      peerDb.putSync('delivered', deliveredSeqs.join(','))
    }
  }

  fetchPendingByPeer(peerId: string): OutboxEntry[] {
    const peerDb = this._getOrOpenPeerDb(peerId)
    const pendingStr = (peerDb.get('pending') as string) ?? ''
    if (!pendingStr) return []
    const seqs = pendingStr.split(',').map(Number)
    return seqs
      .map(seq => peerDb.get(`msg:${seq}`) as OutboxEntry | undefined)
      .filter((e): e is OutboxEntry => e !== undefined && !e.delivered)
  }

  fetchOldestPending(peerId: string): OutboxEntry | null {
    const entries = this.fetchPendingByPeer(peerId)
    return entries.length > 0 ? entries[0] : null
  }

  getPendingCountForPeer(peerId: string): number {
    const peerDb = this._getOrOpenPeerDb(peerId)
    const pendingStr = (peerDb.get('pending') as string) ?? ''
    return pendingStr ? pendingStr.split(',').length : 0
  }

  markAcked(seq: number): void {
    const db = this._findPeerDbBySeq(seq)
    if (!db) return
    db.putSync(`acked:${seq}`, 1)

    // 同时从 delivered 移除
    let peerId: string | null = null
    for (const [pid, pdb] of this.peerDbs) {
      if (pdb === db) { peerId = pid; break }
    }
    if (!peerId) return

    const deliveredStr = (db.get('delivered') as string) ?? ''
    const deliveredSeqs = deliveredStr ? deliveredStr.split(',').map(Number) : []
    const remaining = deliveredSeqs.filter(s => s !== seq)
    db.putSync('delivered', remaining.join(','))
  }

  isAcked(seq: number): boolean {
    const db = this._findPeerDbBySeq(seq)
    if (!db) return false
    try {
      const val = db.get(`acked:${seq}`)
      return val === 1
    } catch {
      return false
    }
  }

  markPending(seq: number): void {
    const db = this._findPeerDbBySeq(seq)
    if (!db) return
    const entry = db.get(`msg:${seq}`) as OutboxEntry | undefined
    if (!entry) return
    entry.delivered = false
    entry.deliveredAt = 0
    db.putSync(`msg:${seq}`, entry)

    // 重新加入 pending
    const pendingStr = (db.get('pending') as string) ?? ''
    const pendingSeqs = pendingStr ? pendingStr.split(',').map(Number) : []
    if (!pendingSeqs.includes(seq)) {
      pendingSeqs.push(seq)
      db.putSync('pending', pendingSeqs.join(','))
    }

    // 从 delivered 移除
    const deliveredStr = (db.get('delivered') as string) ?? ''
    const deliveredSeqs = deliveredStr ? deliveredStr.split(',').map(Number) : []
    const remaining = deliveredSeqs.filter(s => s !== seq)
    db.putSync('delivered', remaining.join(','))
  }

  cleanDeliveredBefore(cutoffMs: number): number {
    let count = 0
    for (const [peerId, peerDb] of this.peerDbs) {
      const deliveredStr = (peerDb.get('delivered') as string) ?? ''
      if (!deliveredStr) continue
      const deliveredSeqs = deliveredStr.split(',').map(Number)
      const remaining: number[] = []
      const now = Date.now()
      for (const seq of deliveredSeqs) {
        const entry = peerDb.get(`msg:${seq}`) as OutboxEntry | undefined
        if (entry && entry.delivered && entry.deliveredAt < cutoffMs) {
          // 清理 msg + acked
          peerDb.removeSync(`msg:${seq}`)
          try { peerDb.removeSync(`acked:${seq}`) } catch { /* */ }
          count++
        } else {
          remaining.push(seq)
        }
      }
      peerDb.putSync('delivered', remaining.join(','))
    }
    return count
  }

  getPendingCount(): number {
    let count = 0
    for (const [, peerDb] of this.peerDbs) {
      const pendingStr = (peerDb.get('pending') as string) ?? ''
      if (pendingStr) count += pendingStr.split(',').length
    }
    return count
  }
}

// ---------------------------------------------------------------------------
// IOutbox — Outbox / OutboxV2 的公共接口
// ---------------------------------------------------------------------------

export interface IOutbox {
  add(entry: Omit<OutboxEntry, 'seq'>): number
  markDeliveredBatch(seqs: number[]): void
  fetchPendingByPeer(peerId: string): OutboxEntry[]
  fetchOldestPending(peerId: string): OutboxEntry | null
  getPendingCountForPeer(peerId: string): number
  markAcked(seq: number): void
  isAcked(seq: number): boolean
  markPending(seq: number): void
  cleanDeliveredBefore(cutoffMs: number): number
  getPendingCount(): number
  close(): void
}

// ---------------------------------------------------------------------------
// PerPeerWorker — 每个 peer 独立的 Worker
// ---------------------------------------------------------------------------

export class PerPeerWorker {
  private peerId: string
  private config: PerPeerConfig
  private outbox: IOutbox
  private running = false
  private workerTimer: ReturnType<typeof setTimeout> | null = null

  /** pending 消息队列：优先级分级 */
  private criticalQueue: PendingItem[] = []
  private normalQueue: PendingItem[] = []

  /** ack 追踪：msgId → sentAt */
  private ackTracker = new Map<string, number>()

  /** 上次发送时间（退避用） */
  private lastSendMs = 0
  /** 当前退避状态 */
  private inBackoff = false

  /**
   * 序列化缓存：msgId → Buffer（预序列化的 TransportMessage）。
   * 在 Phase 2 加载 pending 时构建，Phase 5 发送后清除。
   * 避免每条消息在每个 peer 上分别 JSON.parse → 重构 → JSON.stringify 的重复开销。
   */
  private serializedCache = new Map<string, Buffer>()

  private log: Logger

  constructor(peerId: string, config: PerPeerConfig, outbox: IOutbox) {
    this.peerId = peerId
    this.config = config
    this.outbox = outbox
    this.log = config.logger ?? new Logger(`ppw-${peerId}`)
  }

  /** 热加载 getter */
  private get _tickMs(): number { return this.config.tickMs }
  private get _maxBackoffMs(): number { return this.config.maxBackoffMs }
  private get _ackTimeoutMs(): number { return this.config.ackTimeoutMs }
  /** 每批最多发送条数（默认 100，可热加载） */
  private get _batchSize(): number { return this.config.batchSize ?? 100 }

  start(): void {
    this.running = true
    const loop = async () => {
      try {
        await this._tick()
      } catch (err: any) {
        this.log.warn(`Tick error: ${err.message}`)
      }
      if (this.running) {
        this.workerTimer = setTimeout(loop, this._tickMs)
      }
    }
    this.workerTimer = setTimeout(loop, this._tickMs)
  }

  stop(): void {
    this.running = false
    if (this.workerTimer) {
      clearTimeout(this.workerTimer)
      this.workerTimer = null
    }
    this.criticalQueue = []
    this.normalQueue = []
    this.ackTracker.clear()
  }

  /** 外部通知该 peer 已连接可用 */
  notifyConnected(): void {
    this.inBackoff = false
    this.lastSendMs = 0
  }

  /**
   * 外部通知收到该 peer 的 ACK（同进程/单进程场景）。
   * 多进程场景下 ACK 通过 LMDB mmap 共享（markAcked/isAcked），
   * 不经过此回调——但统一维护保证向后兼容。
   */
  notifyAcked(msgId: string): void {
    this.ackTracker.delete(msgId)
    if (this.ackTracker.size === 0) {
      // 所有待 ACK 都收到 → 退出退避
      this.inBackoff = false
      this.lastSendMs = 0
    }
  }

  /** 推送一条哨兵消息触发重试（deliveryCheck 使用） */
  pushSentinel(): void {
    // 如果 tracker 非空且无 pending 消息，说明消息可能丢了
    if (this.ackTracker.size > 0 && this.criticalQueue.length === 0 && this.normalQueue.length === 0) {
      this.inBackoff = false
    }
  }

  /** 获取当前 pending 数量 */
  getPendingCount(): number {
    return this.criticalQueue.length + this.normalQueue.length
  }

  /** Worker 是否正在运行 */
  get isRunning(): boolean {
    return this.running
  }

  private async _tick(): Promise<void> {
    // ── Phase 0: 检查 ACK 超时 + LMDB mmap ACK 穿透 ──
    if (!this.running) return
    const now = Date.now()
    for (const [msgId, sentAt] of this.ackTracker) {
      if (now - sentAt > this._ackTimeoutMs) {
        // 先尝试通过 LMDB mmap 检查 ACK（多进程场景：主进程已写入 ACK 状态）
        // 在 PerPeerWorker 中可以查到 ackTracker 中没有但 LMDB markAcked 已写入的记录。
        // 这对单进程透明——不产生任何性能影响。
        const loaded = this.outbox.fetchPendingByPeer(this.peerId)
        const found = loaded.find(e => e.msgId === msgId)
        if (found && this.outbox.isAcked(found.seq)) {
          // ACK 已通过 LMDB mmap 到达——删除 ackTracker 条目即可
          this.log.info(`ack for ${msgId} found via LMDB mmap, clearing tracker`)
          this.ackTracker.delete(msgId)
          continue
        }
        this.log.info(`ack timeout for ${msgId}, reverting to pending`)
        this.ackTracker.delete(msgId)
        this.inBackoff = false
        // 重新从 LMDB 加载消息到 normal queue
        const entries = this.outbox.fetchPendingByPeer(this.peerId)
        this.normalQueue = entries.map(e => ({ entry: e, retryCount: 0, insertedAt: now }))
        this.normalQueue.sort((a, b) => a.entry.seq - b.entry.seq)
        break // 一轮最多处理一个 timeout
      }
    }

    // ── Phase 1: 检查退避 ──
    if (!this.running) return
    if (this.inBackoff && this.lastSendMs > 0) {
      if (now - this.lastSendMs < this._maxBackoffMs) {
        return // 退避中，跳过发送
      }
      // 退避超时 → 重建 DEALER
      try {
        const pubKey = this._readPeerPubKey()
        if (!pubKey) {
          // .pub 尚未出现，跳过退避恢复
          this.lastSendMs = now
          return
        }
        await this.config.recoverDealerFn()
        this.inBackoff = false
        this.lastSendMs = 0
      } catch (err: any) {
        this.log.warn(`recover dealer failed: ${err.message}`)
        this.lastSendMs = now // 更新避免每 tick 都试
        return
      }
    }

    // ── Phase 2: 从 LMDB 加载 pending 消息填充队列 ──
    if (!this.running) return
    if (this.normalQueue.length === 0) {
      const entries = this.outbox.fetchPendingByPeer(this.peerId)
      this.normalQueue = entries.map(e => ({ entry: e, retryCount: 0, insertedAt: now }))
      this.normalQueue.sort((a, b) => a.entry.seq - b.entry.seq)
      // Phase 2a: 预序列化——构建 TransportMessage Buffer，缓存后 batchSendFn 直接复用
      for (const item of this.normalQueue) {
        if (this.serializedCache.has(item.entry.msgId)) continue
        try {
          const parsed = JSON.parse(item.entry.payload)
          const streamMsg = {
            msgId: item.entry.msgId,
            seq: 0,
            nodeId: this.config.peerId,
            timestamp: now,
            type: parsed.type ?? 'unknown',
            data: parsed,
          }
          const transport: any = {
            msgId: item.entry.msgId,
            type: 'data',
            srcNodeId: this.config.peerId,
            data: { __es_msg: streamMsg },
          }
          this.serializedCache.set(item.entry.msgId, Buffer.from(JSON.stringify(transport)))
        } catch {
          // payload 解析失败，不缓存，退回到 sendFn 中实时解析
        }
      }
    }

    // ── Phase 3: 检查 peer 是否在线 ──
    if (!this.running) return
    const pubKey = this._readPeerPubKey()
    if (!pubKey) {
      // .pub 文件尚未出现（顺序启动场景），跳过本次 tick，等下一次
      this.log.info(`.pub not yet available for ${this.peerId}, deferring`)
      return
    }

    // ── Phase 4: 收集 batch ──
    const batch: PendingItem[] = []
    while (batch.length < this._batchSize) {
      const item = this.criticalQueue.shift() ?? this.normalQueue.shift()
      if (!item) break
      batch.push(item)
    }

    if (batch.length === 0) return // 无 pending 消息

    // ── Phase 5: 发送 batch ──
    const entriesToDeliver: number[] = []
    const sendItems: Array<{ msgId: string; payload: Buffer }> = []
    const serializedItems: Array<{ msgId: string; buffer: Buffer }> = []
    let allSerialized = true
    for (const item of batch) {
      entriesToDeliver.push(item.entry.seq)
      const cached = this.serializedCache.get(item.entry.msgId)
      if (cached) {
        serializedItems.push({ msgId: item.entry.msgId, buffer: cached })
      } else {
        allSerialized = false
        sendItems.push({
          msgId: item.entry.msgId,
          payload: Buffer.from(item.entry.payload),
        })
      }
    }

    try {
      if (allSerialized && this.config.batchSendSerializedFn && serializedItems.length > 1) {
        // 缓存命中：直接发送预序列化的 Buffer，跳过 JSON.parse → 重构 → JSON.stringify
        await this.config.batchSendSerializedFn(serializedItems)
      } else if (this.config.batchSendFn && sendItems.length > 1) {
        // 批量发送（单次 ZMQ send，multi-part 消息）
        await this.config.batchSendFn(sendItems)
      } else {
        // 兜底：逐条发送（兼容旧 sendFn）
        for (const si of sendItems) {
          await this.config.sendFn(si.msgId, si.payload)
        }
      }

      // 清理缓存：已发送的消息从缓存中移除
      for (const item of batch) {
        this.serializedCache.delete(item.entry.msgId)
      }

      // 成功：标记 delivered + 加入 ack 追踪
      this.outbox.markDeliveredBatch(entriesToDeliver)
      for (const item of batch) {
        this.ackTracker.set(item.entry.msgId, Date.now())
      }
    } catch (err: any) {
      this.log.warn(`batch send failed (${batch.length} msgs): ${err.message}`)
      // 发送失败：全部放回队列，升级 retryCount
      for (const item of batch) {
        const newRetry = item.retryCount + 1
        if (newRetry >= 3) {
          this.criticalQueue.push({ ...item, retryCount: newRetry, insertedAt: now })
        } else {
          this.normalQueue.push({ ...item, retryCount: newRetry, insertedAt: now })
        }
      }
      // 进入退避
      this.inBackoff = true
      this.lastSendMs = now
    }
  }

  private _readPeerPubKey(): string | null {
    try {
      const entries = fs.readdirSync(this.config.curveDir)
      for (const entry of entries) {
        if (!entry.endsWith('.pub')) continue
        const parsed = parsePubFilename(entry)
        if (parsed && parsed.nodeId === this.peerId) {
          const key = fs.readFileSync(path.join(this.config.curveDir, entry), 'utf-8').trim()
          if (key.length > 0) return key
        }
      }
    } catch { /* ignore */ }
    return null
  }

  /** 获取当前状态统计（用于 reportConfig） */
  getStats(): { critical: number; normal: number; ackPending: number; inBackoff: boolean } {
    return {
      critical: this.criticalQueue.length,
      normal: this.normalQueue.length,
      ackPending: this.ackTracker.size,
      inBackoff: this.inBackoff,
    }
  }
}

// ---------------------------------------------------------------------------
// OutboxReplicationManager — 管理 Worker 池 + Housekeeping + DeliveryCheck
// ---------------------------------------------------------------------------

export class OutboxReplicationManager {
  private config: OutboxReplicationConfig
  private outbox: IOutbox
  /** peerId → PerPeerWorker */
  private workerMap = new Map<string, PerPeerWorker>()
  private housekeepingTimer: ReturnType<typeof setInterval> | null = null
  private deliveryCheckTimer: ReturnType<typeof setInterval> | null = null
  private reloadTimer: ReturnType<typeof setInterval> | null = null
  private configFilePath: string | null = null
  private log: Logger
  /** NAS curve 目录路径（用于 Worker 动态发现） */
  private curveDir: string | null

  constructor(config: OutboxReplicationConfig) {
    this.config = config
    const dbPath = config.dbPath ?? path.join(process.cwd(), 'data', 'outbox')
    // 根据 usePerPeerDb 选择 OutboxV2 或 Outbox
    if (config.usePerPeerDb) {
      // OutboxV2 使用目录（含 _seq-counter.lmdb + 各 peer LMDB）
      const v2Dir = dbPath.endsWith('.lmdb') ? dbPath.replace(/\.lmdb$/, '') : dbPath
      this.outbox = new OutboxV2(v2Dir)
    } else {
      this.outbox = new Outbox(dbPath)
    }
    this.log = config.logger ?? new Logger('outbox-mgr')
    this.curveDir = config.curveDir || null

    const envPath = process.env.ML_CONFIG_PATH
    if (envPath) {
      this.configFilePath = path.resolve(envPath)
    }
  }

  get dbPath(): string { return this.config.dbPath ?? path.join(process.cwd(), 'data', 'outbox') }
  get configFile(): string | null { return this.configFilePath }

  loadConfigFile(): void {
    if (!this.configFilePath) return
    try {
      const content = fs.readFileSync(this.configFilePath, 'utf-8')
      const parsed = JSON.parse(content)
      const partial: Partial<OutboxReplicationConfig> = {}
      const fields = ['tickMs', 'maxBackoffSeconds', 'housekeepingIntervalMs', 'entryTTLDays'] as const
      let changed = false
      for (const field of fields) {
        if (parsed[field] !== undefined && typeof parsed[field] === 'number' && parsed[field] > 0) {
          partial[field] = parsed[field]
          changed = true
        }
      }
      if (changed) {
        Object.assign(this.config, partial)
        this.log.info(`[Outbox] loaded config from ${this.configFilePath}: ${JSON.stringify(partial)}`)
        if (partial.housekeepingIntervalMs !== undefined) this._restartHousekeeping()
      } else {
        this.log.debug(`[Outbox] config file ${this.configFilePath}: no valid fields`)
      }
    } catch (err: any) {
      this.log.warn(`[Outbox] failed to load config file ${this.configFilePath}: ${err.message}`)
    }
  }

  saveConfigFile(): void {
    if (!this.configFilePath) {
      this.log.warn('[Outbox] no ML_CONFIG_PATH set, cannot save config')
      return
    }
    try {
      const dir = path.dirname(this.configFilePath)
      fs.mkdirSync(dir, { recursive: true })
      const data = {
        tickMs: this.config.tickMs ?? 500,
        maxBackoffSeconds: this.config.maxBackoffSeconds ?? 60,
        housekeepingIntervalMs: this.config.housekeepingIntervalMs ?? 86400000,
        entryTTLDays: this.config.entryTTLDays ?? 14,
      }
      fs.writeFileSync(this.configFilePath, JSON.stringify(data, null, 2), 'utf-8')
      this.log.info(`[Outbox] config saved to ${this.configFilePath}`)
    } catch (err: any) {
      this.log.warn(`[Outbox] failed to save config file: ${err.message}`)
    }
  }

  getConfig(): Readonly<OutboxReplicationConfig> {
    return { ...this.config }
  }

  updateConfig(partial: Partial<Pick<OutboxReplicationConfig, 'tickMs' | 'maxBackoffSeconds' | 'housekeepingIntervalMs' | 'entryTTLDays'>>): void {
    Object.assign(this.config, partial)
    this.log.info(`[Outbox] config updated: ${JSON.stringify(partial)}`)
    this.saveConfigFile()
    if (partial.housekeepingIntervalMs !== undefined) {
      this._restartHousekeeping()
    }
  }

  private _restartHousekeeping(): void {
    if (this.housekeepingTimer) {
      clearInterval(this.housekeepingTimer)
      this.housekeepingTimer = null
    }
    const hkInterval = this.config.housekeepingIntervalMs ?? 86400000
    this.housekeepingTimer = setInterval(() => {
      const cutoff = Date.now() - (this.config.entryTTLDays ?? 14) * 86400000
      const count = this.outbox.cleanDeliveredBefore(cutoff)
      if (count > 0) this.log.info(`[Outbox] housekeeping: removed ${count} old entries`)
    }, hkInterval)
  }

  addMessage(type: string, data: Record<string, unknown>): void {
    const createdAt = Date.now()
    const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId)
    for (const peer of remotePeers) {
      this.outbox.add({
        msgId: data['msgId'] as string ?? `${createdAt}-${crypto.randomUUID()}`,
        targetNodeId: peer.nodeId,
        type,
        payload: JSON.stringify({ type, data }),
        createdAt,
        delivered: false,
        deliveredAt: 0,
      })
    }
  }

  /** 创建/重建指定 peer 的 PerPeerWorker */
  private _ensureWorker(peerId: string): PerPeerWorker {
    let worker = this.workerMap.get(peerId)
    if (worker) return worker

    const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId)
    const peerCfg = remotePeers.find(p => p.nodeId === peerId)
    if (!peerCfg) {
      throw new Error(`peer ${peerId} not found in config`)
    }

    worker = new PerPeerWorker(peerId, {
      peerId,
      tickMs: this.config.tickMs ?? 500,
      maxBackoffMs: (this.config.maxBackoffSeconds ?? 60) * 1000,
      ackTimeoutMs: (this.config.tickMs ?? 500) * 3,
      batchSize: this.config.batchSize ?? 100,
      curveDir: this.config.curveDir,
      sendFn: async (msgId: string, payload: Buffer) => {
        const parsed = JSON.parse(payload.toString('utf-8'))
        const streamMsg = {
          msgId,
          seq: 0,
          nodeId: this.config.nodeId,
          timestamp: Date.now(),
          type: parsed.type ?? 'unknown',
          data: parsed,
        }
        const msg: any = {
          msgId,
          type: 'data',
          srcNodeId: this.config.nodeId,
          data: { __es_msg: streamMsg },
        }
        await this.config.eventBus.send(peerId, msg)
      },
      batchSendSerializedFn: async (items) => {
        // 预序列化批量发送：buffer 已经是序列化的 TransportMessage JSON Buffer
        // 直接 JSON.parse 后传给 eventBus.batchSend，跳过原始 payload 的 JSON.parse → 重构 → JSON.stringify
        if (this.config.eventBus.batchSend) {
          const parsed = items.map(({ msgId, buffer }) => {
            return JSON.parse(buffer.toString('utf-8'))
          })
          await this.config.eventBus.batchSend(peerId, parsed)
        } else {
          // 退化：逐条通过 eventBus.send（但 Buffer 已序列化，直接 parse 后传）
          for (const { msgId, buffer } of items) {
            const msg = JSON.parse(buffer.toString('utf-8'))
            await this.config.eventBus.send(peerId, msg)
          }
        }
      },
      batchSendFn: async (items) => {
        // 批量发送：将多个消息合并为一次 ZMQ send
        // eventBus.send 一次只能发送一条，所以这里还是调用多次但利用 ZMQ 的缓冲能力
        // 实际批量优化在 ZMQ 层面：在 EventBus 中实现 batchSend
        if (this.config.eventBus.batchSend) {
          const batched = items.map(({ msgId, payload }) => {
            const parsed = JSON.parse(payload.toString('utf-8'))
            const streamMsg = {
              msgId,
              seq: 0,
              nodeId: this.config.nodeId,
              timestamp: Date.now(),
              type: parsed.type ?? 'unknown',
              data: parsed,
            }
            return {
              msgId,
              type: 'data' as const,
              srcNodeId: this.config.nodeId,
              data: { __es_msg: streamMsg },
            }
          })
          await this.config.eventBus.batchSend(peerId, batched)
        } else {
          // 兜底：逐条调用 send（但 batchSize 聚合减小了 Node.js 事件循环开销）
          for (const { msgId, payload } of items) {
            const parsed = JSON.parse(payload.toString('utf-8'))
            const streamMsg = {
              msgId,
              seq: 0,
              nodeId: this.config.nodeId,
              timestamp: Date.now(),
              type: parsed.type ?? 'unknown',
              data: parsed,
            }
            const msg: any = {
              msgId,
              type: 'data',
              srcNodeId: this.config.nodeId,
              data: { __es_msg: streamMsg },
            }
            await this.config.eventBus.send(peerId, msg)
          }
        }
      },
      recoverDealerFn: async () => {
        if (this.config.eventBus._recoverDealerByNodeId) {
          await this.config.eventBus._recoverDealerByNodeId(peerId)
        } else {
          throw new Error('_recoverDealerByNodeId not available on eventBus')
        }
      },
      logger: this.log,
    }, this.outbox)

    this.workerMap.set(peerId, worker)
    this.log.info(`[Outbox] PerPeerWorker created for ${peerId}`)
    return worker
  }

  start(): void {
    this.loadConfigFile()

    // 为每个 remote peer 创建 PerPeerWorker
    const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId)
    for (const peer of remotePeers) {
      const worker = this._ensureWorker(peer.nodeId)
      worker.start()
    }

    // Housekeeping
    this._restartHousekeeping()

    // DeliveryCheck：定时扫描所有 peer 的 backlog，对卡住的推送哨兵
    this.deliveryCheckTimer = setInterval(() => {
      this._deliveryCheckPeers()
    }, (this.config.tickMs ?? 500) * 10)

    // 配置文件定时重载
    if (this.configFilePath) {
      this.reloadTimer = setInterval(() => {
        this.loadConfigFile()
      }, 60000)
    }
  }

  stop(): void {
    for (const [peerId, worker] of this.workerMap) {
      worker.stop()
    }
    this.workerMap.clear()

    if (this.housekeepingTimer) {
      clearInterval(this.housekeepingTimer)
      this.housekeepingTimer = null
    }
    if (this.deliveryCheckTimer) {
      clearInterval(this.deliveryCheckTimer)
      this.deliveryCheckTimer = null
    }
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer)
      this.reloadTimer = null
    }
    this._deleteMyPubKey()
    this.outbox.close()
  }

  private _deleteMyPubKey(): void {
    try {
      const nodeId = this.config.nodeId
      const entries = fs.readdirSync(this.config.curveDir)
      for (const entry of entries) {
        if (!entry.endsWith('.pub')) continue
        const parsed = parsePubFilename(entry)
        if (parsed && parsed.nodeId === nodeId) {
          const filePath = path.join(this.config.curveDir, entry)
          fs.unlinkSync(filePath)
          this.log.info(`[Outbox] deleted my pub key: ${entry}`)
          break
        }
      }
    } catch (err: any) {
      this.log.warn(`[Outbox] failed to delete pub key: ${err.message}`)
    }
  }

  registerShutdownHook(): void {
    const cleanup = () => {
      this.log.info('[Outbox] shutdown hook triggered, cleaning up...')
      this.stop()
      process.exit(0)
    }
    process.on('SIGTERM', cleanup)
    process.on('SIGINT', cleanup)
    process.on('exit', () => {
      try { this._deleteMyPubKey() } catch { /* best-effort */ }
    })
  }

  /** DeliveryCheck：定时检查所有 peer 的 pending 状态，推送哨兵消息 */
  private _deliveryCheckPeers(): void {
    // 先执行 Worker 动态发现
    this.discoverPeers()

    const now = Date.now()
    for (const [peerId, worker] of this.workerMap) {
      // 如果 worker 的 ackTracker 有未 ack 的消息，但 pending 队列为空 → 可能是 ack 丢失
      const stats = worker.getStats()
      if (stats.ackPending > 0 && stats.critical === 0 && stats.normal === 0) {
        worker.pushSentinel()
      }
      // 如果 worker 完全停止，但有 pending 数据 → 重启 worker
      if (!this._isWorkerRunning(peerId)) {
        const pendingCount = this.outbox.getPendingCountForPeer(peerId)
        if (pendingCount > 0) {
          this.log.info(`[DeliveryCheck] ${peerId} has ${pendingCount} pending but not running — restarting`)
          this._restartWorker(peerId)
        }
      }
    }
  }

  /**
   * Worker 动态发现：扫描 curveDir 中的 *.pub 文件，
   * 为新增 peer 创建 Worker，清理已消失 peer 的 Worker 记录。
   */
  discoverPeers(): void {
    if (!this.curveDir) return

    try {
      // 扫描 curveDir 获取所有 peer nodeId
      const allPeers = EventBus.readAllPeerKeys(this.curveDir)
      const newPeers = allPeers
        .filter(p => p.nodeId !== this.config.nodeId)
        .map(p => p.nodeId)

      // 为新增 peer 创建 Worker
      for (const peerId of newPeers) {
        const existing = this.workerMap.get(peerId)
        if (!existing) {
          this.log.info(`[discoverPeers] new peer ${peerId}, creating worker`)
          this._ensureWorker(peerId).start()
        } else if (!existing.isRunning) {
          // Worker 已停止（可能因 peer pub key 尚未出现），重新启动
          this.log.info(`[discoverPeers] restarting stopped worker for ${peerId}`)
          existing.start()
        }
      }

      // 清理已消失 peer 的 Worker（pub 删除 → Worker 已 self-stop）
      for (const [peerId, worker] of this.workerMap) {
        if (!newPeers.includes(peerId) && !worker.isRunning) {
          this.log.info(`[discoverPeers] peer ${peerId} gone, removing worker`)
          this.workerMap.delete(peerId)
        }
      }
    } catch (err: any) {
      this.log.warn(`[discoverPeers] error: ${err.message}`)
    }
  }

  private _isWorkerRunning(peerId: string): boolean {
    // 检查 worker 是否存在（running 状态只能通过 getStats 间接判断）
    // 如果 worker 遇到 .pub 消失会 self-stop（设置 running=false）
    return this.workerMap.has(peerId)
  }

  private _restartWorker(peerId: string): void {
    const old = this.workerMap.get(peerId)
    if (old) old.stop()
    this.workerMap.delete(peerId)
    const worker = this._ensureWorker(peerId)
    worker.start()
  }

  /** 通知指定 peer 的 Worker 已连接 */
  notifyConnected(peerId: string): void {
    const worker = this.workerMap.get(peerId)
    if (worker) worker.notifyConnected()
  }

  /** 通知指定 peer 的 Worker 收到 ACK */
  notifyAcked(peerId: string): void {
    const worker = this.workerMap.get(peerId)
    if (worker) worker.notifyConnected()
  }

  getStats(): { sendTrack: number; backoffTrack: number; pending: number } {
    return {
      sendTrack: this.workerMap.size,
      backoffTrack: 0,
      pending: this.outbox.getPendingCount(),
    }
  }

  /** 获取每个 peer 的详细报告（reportConfig 回调用） */
  getPeerReports(): Array<{ peerId: string; stats: ReturnType<PerPeerWorker['getStats']> | null }> {
    const reports: Array<{ peerId: string; stats: ReturnType<PerPeerWorker['getStats']> | null }> = []
    for (const [peerId, worker] of this.workerMap) {
      reports.push({ peerId, stats: worker.getStats() })
    }
    return reports
  }
}
