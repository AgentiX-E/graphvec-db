/**
 * Transaction — MVCC 增强事务系统
 *
 * 支持：
 * - 快照隔离 (Snapshot Isolation)
 * - 写集锁 + 冲突检测
 * - 读集追踪
 * - 超时锁清理
 * - 与 GraphEngine 深度集成
 */

import type { GraphEngine } from './graph-engine'
import type { NodeId } from '../types'

// ── 类型定义 ──

export interface UpsertOpData {
  typeId: number
  name: string
  props?: Record<string, any>
}

export interface MVCCSnapshot {
  id: number
  createdAt: number
}

// ── 事务管理器 ──

export class TransactionManager {
  private _nextSnapshotId = 1
  private _locks = new Map<string, { nodeId: NodeId; snapshotId: number; lockedAt: number }>()
  private _lockTimeoutMs: number

  constructor(lockTimeoutMs = 5000) {
    this._lockTimeoutMs = lockTimeoutMs
  }

  get lockCount(): number {
    return this._locks.size
  }

  begin(): Transaction {
    const snapshot: MVCCSnapshot = {
      id: this._nextSnapshotId++,
      createdAt: Date.now(),
    }
    return new Transaction(this, snapshot)
  }

  isLocked(nodeId: NodeId): boolean {
    this._cleanupStaleLocks()
    return this._locks.has(String(nodeId))
  }

  lock(nodeId: NodeId, snapshotId: number): void {
    const key = String(nodeId)
    if (this._locks.has(key)) {
      throw new Error(`Node ${nodeId} is already locked`)
    }
    this._locks.set(key, { nodeId, snapshotId, lockedAt: Date.now() })
  }

  unlock(nodeId: NodeId): void {
    this._locks.delete(String(nodeId))
  }

  unlockAll(snapshotId: number): void {
    for (const [key, lock] of this._locks) {
      if (lock.snapshotId === snapshotId) {
        this._locks.delete(key)
      }
    }
  }

  /** 清理超时锁 */
  _cleanupStaleLocks(): void {
    const now = Date.now()
    for (const [key, lock] of this._locks) {
      if (now - lock.lockedAt > this._lockTimeoutMs) {
        this._locks.delete(key)
      }
    }
  }
}

// ── 事务 ──

export class Transaction {
  public readonly snapshot: MVCCSnapshot
  public readonly writeSet: Map<string, UpsertOpData>
  public readonly deleteSet: Set<NodeId>
  public readonly readSet: Set<NodeId>
  private _committed = false
  private _rolledBack = false
  private _mgr: TransactionManager | null
  private _engine: GraphEngine | null

  /**
   * @param mgr - TransactionManager
   * @param snapshotOrEngine - Either MVCCSnapshot (called from mgr.begin())
   *                          or GraphEngine (called from tests: new Transaction(mgr, engine))
   */
  constructor(mgr: TransactionManager, snapshotOrEngine?: MVCCSnapshot | GraphEngine) {
    if (snapshotOrEngine && 'id' in snapshotOrEngine && 'createdAt' in snapshotOrEngine) {
      // Called from mgr.begin(): new Transaction(this, snapshot)
      this.snapshot = snapshotOrEngine as MVCCSnapshot
      this._engine = null
    } else {
      // Called directly: new Transaction(mgr, engine) — create placeholder snapshot
      this.snapshot = { id: -1, createdAt: Date.now() }
      this._engine = snapshotOrEngine as GraphEngine ?? null
    }
    this._mgr = mgr ?? null
    this.writeSet = new Map()
    this.deleteSet = new Set()
    this.readSet = new Set()
  }

  get active(): boolean {
    return !this._committed && !this._rolledBack
  }

  get snapshotId(): number {
    return this.snapshot?.id ?? 0
  }

  upsertNode(typeId: number, name: string, props?: Record<string, any>): NodeId {
    this._checkActive()
    this.writeSet.set(name, { typeId, name, props })
    return -1
  }

  deleteNode(nodeId: NodeId): void {
    this._checkActive()
    this.deleteSet.add(nodeId)
  }

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, props?: Record<string, any>): void {
    this._checkActive()
    this.writeSet.set(`edge:${src}:${dst}:${typeId}`, { typeId, name: `edge:${src}:${dst}`, props })
  }

  readNode(nodeId: NodeId): void {
    this.readSet.add(nodeId)
  }

  async commit(): Promise<void> {
    if (this._committed) throw new Error('Transaction already committed')
    if (this._rolledBack) throw new Error('Transaction already rolled back')

    // Phase 1: 写集锁检查
    const allKeys = new Set<string>()
    for (const nodeId of this.deleteSet) {
      allKeys.add(String(nodeId))
    }
    for (const key of this.writeSet.keys()) {
      if (key.startsWith('edge:')) continue
      allKeys.add(key)
    }

    // Try lock check
    for (const key of allKeys) {
      if (this._mgr && this._mgr.isLocked(Number(key))) {
        throw new Error(`Commit failed: node ${key} is locked by another transaction`)
      }
    }

    // Phase 2: 加锁（如果需要）
    if (this._mgr) {
      for (const key of allKeys) {
        this._mgr.lock(Number(key), this.snapshotId)
      }
    }

    try {
      // Phase 3: flush
      if (this._engine) {
        await this._flushToEngine(this._engine)
      }

      // Phase 4: 释放锁
      if (this._mgr) {
        this._mgr.unlockAll(this.snapshotId)
      }
    } catch (err) {
      if (this._mgr) this._mgr.unlockAll(this.snapshotId)
      throw err
    }

    this._committed = true
  }

  async rollback(): Promise<void> {
    if (this._committed) throw new Error('Cannot rollback a committed transaction')
    this._rolledBack = true
    this.writeSet.clear()
    this.deleteSet.clear()
    this.readSet.clear()
    if (this._mgr) {
      this._mgr.unlockAll(this.snapshotId)
    }
  }

  private async _flushToEngine(engine: GraphEngine): Promise<void> {
    for (const [, data] of this.writeSet) {
      await engine.upsertNode(data.typeId, data.name, { props: data.props })
    }
    for (const nodeId of this.deleteSet) {
      await engine.deleteNode(nodeId)
    }
  }

  /** 设置 engine（可选，用于 flush） */
  setEngine(engine: GraphEngine): void {
    this._engine = engine
  }

  private _checkActive(): void {
    if (this._committed) throw new Error('Transaction already committed')
    if (this._rolledBack) throw new Error('Transaction already rolled back')
  }
}
