// ============================================================
// SimpleTxnManager — 轻量级写入缓冲事务管理器
//
// 这是一个薄缓冲包装层，不同于 MVCC Transaction 系统。
// 它将多个写入操作（upsertNode、deleteNode、upsertEdge、deleteEdge）
// 缓存到一个事务缓冲区中，在 commit 时按顺序回放执行。
// 不支持 MVCC、快照隔离或冲突检测。
//
// Use case: REST API 用户希望将多个写入操作组合为一个原子单元。
// ============================================================

import type { GraphEngine } from './graph-engine'
import type { ShardManager } from '../shard/shard-manager'

// ── WriteOp 类型 ──

export type WriteOpType = 'upsertNode' | 'deleteNode' | 'upsertEdge' | 'deleteEdge'

export interface WriteOp {
  type: WriteOpType
  args: any[]
}

// ── 事务条目 ──

interface TxnEntry {
  ops: WriteOp[]
  startedAt: number
}

// ── SimpleTxnManager ──

export interface SimpleTxnManagerOptions {
  /** 事务最大生存时间（毫秒），默认 30000（30 秒） */
  maxTxnAgeMs?: number
}

export class SimpleTxnManager {
  private _txns = new Map<string, TxnEntry>()
  private _nextId = 1
  private _maxTxnAgeMs: number
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: SimpleTxnManagerOptions) {
    this._maxTxnAgeMs = opts?.maxTxnAgeMs ?? 30000
  }

  /**
   * 开始一个新事务，返回 txId
   */
  begin(prefix?: string): string {
    const txId = `${prefix ?? 'tx'}_${this._nextId++}_${Date.now()}`
    this._txns.set(txId, { ops: [], startedAt: Date.now() })
    return txId
  }

  /**
   * 提交事务：按顺序回放所有缓冲的写入操作
   *
   * @param engine - GraphEngine 或 ShardManager，用于执行缓冲的操作
   */
  async commit(txId: string, engine: GraphEngine | ShardManager): Promise<number> {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found or already committed/rolled back`)
    }

    // Replay all buffered ops in order
    for (const op of entry.ops) {
      switch (op.type) {
        case 'upsertNode':
          // [typeId, name, opts]
          await this._execEngine(engine).upsertNode(op.args[0], op.args[1], op.args[2])
          break
        case 'deleteNode':
          // [id, skipReplication, cascade]
          await this._execEngine(engine).deleteNode(op.args[0], op.args[1] ?? false, op.args[2] ?? false)
          break
        case 'upsertEdge':
          // [src, dst, typeId, opts]
          await this._execEngine(engine).upsertEdge(op.args[0], op.args[1], op.args[2], op.args[3])
          break
        case 'deleteEdge':
          // [src, dst, typeId, skipReplication]
          await this._execEngine(engine).deleteEdge(op.args[0], op.args[1], op.args[2], op.args[3] ?? false)
          break
      }
    }

    const count = entry.ops.length
    this._txns.delete(txId)
    return count
  }

  /**
   * 回滚事务：丢弃所有缓冲的写入操作
   */
  rollback(txId: string): number {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found or already committed/rolled back`)
    }
    const count = entry.ops.length
    this._txns.delete(txId)
    return count
  }

  /**
   * 向事务添加一个写入操作（由 GraphEngine 内部调用）
   */
  addOp(txId: string, op: WriteOp): void {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found — begin a transaction first`)
    }
    entry.ops.push(op)
  }

  /**
   * 获取事务中待处理的写入操作列表
   */
  pendingOps(txId: string): WriteOp[] {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found`)
    }
    return [...entry.ops]
  }

  /**
   * 获取事务详情
   */
  getTxn(txId: string): { txId: string; ops: WriteOp[]; startedAt: number } | null {
    const entry = this._txns.get(txId)
    if (!entry) return null
    return { txId, ops: [...entry.ops], startedAt: entry.startedAt }
  }

  /**
   * 检查事务是否存在
   */
  hasTxn(txId: string): boolean {
    return this._txns.has(txId)
  }

  /**
   * 清理过期事务（超时自动回滚）
   * @returns 已清理的事务数量
   */
  cleanupStale(): number {
    const now = Date.now()
    let count = 0
    for (const [txId, entry] of this._txns) {
      if (now - entry.startedAt > this._maxTxnAgeMs) {
        this._txns.delete(txId)
        count++
      }
    }
    return count
  }

  /**
   * 获取当前活跃事务数量
   */
  get activeCount(): number {
    return this._txns.size
  }

  /**
   * 启动定期清理（可选，适合长时间运行的服务器）
   */
  startCleanup(intervalMs?: number): void {
    this.stopCleanup()
    this._cleanupTimer = setInterval(() => {
      const cleaned = this.cleanupStale()
      if (cleaned > 0) {
        // Log silently — stale transactions are auto-rolled back
      }
    }, intervalMs ?? 15000)
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref()
    }
  }

  /**
   * 停止定期清理
   */
  stopCleanup(): void {
    if (this._cleanupTimer !== null) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
  }

  /**
   * 获取所有活跃事务 ID
   */
  listActive(): string[] {
    return Array.from(this._txns.keys())
  }

  /**
   * 检测 engine 是否为 ShardManager，获取 upsertNode 兼容的接口。
   * ShardManager 有 upsertNode/deleteNode/upsertEdge/deleteEdge 方法，类型与 GraphEngine 一致。
   */
  private _isShardManager(engine: GraphEngine | ShardManager): engine is ShardManager {
    return 'getAllRanges' in engine
  }

  /**
   * 获取实际执行写入的引擎（ShardManager 或 GraphEngine）
   */
  private _execEngine(engine: GraphEngine | ShardManager): GraphEngine {
    if (this._isShardManager(engine)) {
      // ShardManager 本身也有 upsertNode/deleteNode/upsertEdge/deleteEdge
      return engine as unknown as GraphEngine
    }
    return engine
  }
}
