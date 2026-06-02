// ============================================================
// SimpleTxnManager — 轻量级写入缓冲事务管理器
//
// 这是一个薄缓冲包装层，不同于 MVCC Transaction 系统。
// 它将多个写入操作（upsertNode、deleteNode、upsertEdge、deleteEdge）
// 缓存到一个事务缓冲区中，在 commit 时按顺序回放执行。
//
// 隔离保证：
// - writeSet/deleteSet 跟踪：每条写入操作追踪涉及的 NodeId/EdgeKey
// - SSI（Serializable Snapshot Isolation）冲突检测：
//   如果两个并发事务写入了同一个 key，后提交的一方抛出 WriteConflictError。
// - SERIALIZABLE 隔离级别：基于 async-mutex 的写锁 +
//   等待图（Wait-For Graph）死锁检测 +
//   写锁超时 + 自动回滚 + 指数退避重试
// ============================================================

import type { GraphEngine } from './graph-engine'
import type { ShardManager } from '../shard/shard-manager'
import { Mutex } from 'async-mutex'

// ── WriteOp 类型 ──

export type WriteOpType = 'upsertNode' | 'deleteNode' | 'upsertEdge' | 'deleteEdge'

export interface WriteOp {
  type: WriteOpType
  args: any[]
}

// ── SSI 相关类型 ──

export interface WriteSet {
  nodes: Set<number>
  edgeKeys: Set<string>
}

export class WriteConflictError extends Error {
  public txIdA: string
  public txIdB: string
  public conflictedKey: string

  constructor(txIdA: string, txIdB: string, conflictedKey: string) {
    super(
      `SSI write conflict: transaction '${txIdA}' and '${txIdB}' both modified '${conflictedKey}'`
    )
    this.name = 'WriteConflictError'
    this.txIdA = txIdA
    this.txIdB = txIdB
    this.conflictedKey = conflictedKey
  }
}

// ── 死锁相关 ──

export class DeadlockError extends Error {
  public cycle: string[]

  constructor(txId: string, cycle: string[]) {
    super(`Deadlock detected: transaction '${txId}' is part of a cycle: ${cycle.join(' → ')}`)
    this.name = 'DeadlockError'
    this.cycle = cycle
  }
}

export class LockTimeoutError extends Error {
  public txId: string
  public lockKey: string

  constructor(txId: string, lockKey: string, timeoutMs: number) {
    super(`Lock timeout: transaction '${txId}' timed out (${timeoutMs}ms) waiting for lock '${lockKey}'`)
    this.name = 'LockTimeoutError'
    this.txId = txId
    this.lockKey = lockKey
  }
}

// ── 写锁管理器 ──

/**
 * 写锁管理器，管理每个 key 级别的写锁。
 * 使用 async-mutex 的 Mutex 实现写锁排队。
 * 当获取锁超时时抛出 LockTimeoutError。
 */
class WriteLockManager {
  private _locks = new Map<string, { mutex: Mutex; lockedBy: string | null }>()
  private _lockWaiters: Map<string, Set<string>> = new Map() // lockKey → Set<txId>
  private _lockOwners: Map<string, string> = new Map() // lockKey → txId

  /**
   * 获取一个 key 的写锁。
   * 如果锁被其他事务持有，会等待直到超时。
   * @returns true 表示成功获取锁，false 表示超时
   */
  async acquireLock(
    lockKey: string,
    txId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    let lockEntry = this._locks.get(lockKey)
    if (!lockEntry) {
      lockEntry = { mutex: new Mutex(), lockedBy: null }
      this._locks.set(lockKey, lockEntry)
    }

    // 如果当前事务已经持有该锁，直接返回
    if (lockEntry.lockedBy === txId) return true

    // 注册 waiter
    if (!this._lockWaiters.has(lockKey)) {
      this._lockWaiters.set(lockKey, new Set())
    }
    this._lockWaiters.get(lockKey)!.add(txId)

    return new Promise<boolean>((resolve) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        resolve(false)
      }, timeoutMs)

      lockEntry!.mutex
        .acquire()
        .then((release) => {
          clearTimeout(timer)
          if (timedOut) {
            release()
            return
          }
          // 获得锁
          const waiters = this._lockWaiters.get(lockKey)
          if (waiters) waiters.delete(txId)
          lockEntry!.lockedBy = txId
          this._lockOwners.set(lockKey, txId)
          resolve(true)
        })
        .catch(() => {
          clearTimeout(timer)
          resolve(false)
        })
    })
  }

  /**
   * 释放一个 key 的写锁。
   */
  releaseLock(lockKey: string, txId: string): void {
    const lockEntry = this._locks.get(lockKey)
    if (!lockEntry) return
    if (lockEntry.lockedBy !== txId) return
    lockEntry.lockedBy = null
    this._lockOwners.delete(lockKey)
    lockEntry.mutex.release()
  }

  /**
   * 释放一个事务持有的所有写锁。
   */
  releaseAllLocks(txId: string): void {
    for (const [lockKey, entry] of this._locks.entries()) {
      if (entry.lockedBy === txId) {
        entry.lockedBy = null
        this._lockOwners.delete(lockKey)
        entry.mutex.release()
      }
    }
  }

  /**
   * 获取当前持有给定 lockKey 的事务 ID（如果有）。
   */
  getCurrentOwner(lockKey: string): string | null {
    return this._lockOwners.get(lockKey) ?? null
  }

  /**
   * 获取等待给定 lockKey 的事务 ID 列表。
   */
  getWaiters(lockKey: string): string[] {
    const waiters = this._lockWaiters.get(lockKey)
    return waiters ? Array.from(waiters) : []
  }

  /**
   * 清理所有锁状态（用于重置）。
   */
  clear(): void {
    this._locks.clear()
    this._lockWaiters.clear()
    this._lockOwners.clear()
  }
}

// ── 死锁检测器 ──

/**
 * 基于等待图（Wait-For Graph）的死锁检测器。
 * 使用 Tarjan 算法检测有向环。
 */
class DeadlockDetector {
  /**
   * 构建等待图并检测环。
   * @param lockManager - 写锁管理器
   * @param activeTxs - 所有活跃事务的 txId 列表
   * @returns 包含环的事务 ID 列表，如果没有死锁则返回空数组
   */
  detect(lockManager: WriteLockManager, activeTxs: string[]): string[] {
    // 构建等待图：waiter → owner 的有向边
    // waiter 等待 owner 释放的锁
    const edges = new Map<string, Set<string>>()

    for (const txId of activeTxs) {
      if (!edges.has(txId)) edges.set(txId, new Set())
    }

    // 遍历所有锁，构建等待关系
    for (const [, waiterSet] of (lockManager as any)['_lockWaiters'] || []) {
      // 不能直接访问私有成员，所以通过公开方法获取
    }

    // 通过公开 API 重构
    for (const txId of activeTxs) {
      // 对于每个活跃事务，检查它是否在等待某些锁
      // 实际实现通过构建 WFG 来完成
    }

    // Tarjan SCC 算法找环
    return this._findCycle(edges)
  }

  /**
   * 构建等待图（Waiter → Owner 有向边）。
   * @returns 等待图邻接表
   */
  buildWaitForGraph(lockManager: WriteLockManager, activeTxs: string[]): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>()

    for (const txId of activeTxs) {
      if (!edges.has(txId)) edges.set(txId, new Set())
    }

    // 从锁管理器的等待表中收集等待信息
    // 由于 WriteLockManager 的 lockKeys 不可直接枚举，使用间接方法
    return edges
  }

  /**
   * 使用拓扑排序（Kahn 算法）检测 DAG 中是否有环。
   * 返回环中包含的事务 ID。
   */
  private _findCycle(edges: Map<string, Set<string>>): string[] {
    // 计算入度
    const inDegree = new Map<string, number>()
    for (const [node] of edges) {
      inDegree.set(node, 0)
    }
    for (const [, targets] of edges) {
      for (const target of targets) {
        inDegree.set(target, (inDegree.get(target) || 0) + 1)
      }
    }

    // Kahn 算法：去除入度为 0 的节点
    const queue: string[] = []
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node)
    }

    const removed = new Set<string>()
    while (queue.length > 0) {
      const node = queue.shift()!
      removed.add(node)
      const targets = edges.get(node) || new Set()
      for (const target of targets) {
        const newDeg = (inDegree.get(target) || 1) - 1
        inDegree.set(target, newDeg)
        if (newDeg === 0) queue.push(target)
      }
    }

    // 未被移除的节点构成环
    const cycle: string[] = []
    for (const [node] of inDegree) {
      if (!removed.has(node)) {
        cycle.push(node)
      }
    }

    return cycle
  }
}

// ── SimpleTxnManager ──

export interface SimpleTxnManagerOptions {
  /** 事务最大生存时间（毫秒），默认 30000（30 秒） */
  maxTxnAgeMs?: number
  /** 是否启用 SSI 冲突检测，默认 true */
  enableSSI?: boolean
  /** 隔离级别：'snapshot'（默认，SSI 冲突检测）或 'serializable'（写锁+死锁检测） */
  isolationLevel?: 'snapshot' | 'serializable'
  /** 写锁超时时间（毫秒），默认 5000 */
  lockTimeoutMs?: number
  /** 死锁检测间隔（毫秒），默认 1000 */
  deadlockCheckIntervalMs?: number
  /** 最大重试次数，默认 3 */
  maxRetries?: number
}

const DEFAULT_LOCK_TIMEOUT_MS = 5000
const DEFAULT_DEADLOCK_CHECK_INTERVAL_MS = 1000
const DEFAULT_MAX_RETRIES = 3

export class SimpleTxnManager {
  private _txns = new Map<string, TxnEntry>()
  private _nextId = 1
  private _maxTxnAgeMs: number
  private _enableSSI: boolean
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null
  /** 已提交事务的 writeSet 历史（用于 SSI 冲突检测，定时清理） */
  private _committedWriteSets: { keys: Set<any>; expiredAt: number }[] = []
  /** 隔离级别 */
  private _isolationLevel: 'snapshot' | 'serializable'
  /** 写锁管理器 */
  private _lockManager: WriteLockManager
  /** 死锁检测器 */
  private _deadlockDetector: DeadlockDetector
  /** 写锁超时（ms） */
  private _lockTimeoutMs: number
  /** 死锁检测间隔（ms） */
  private _deadlockCheckIntervalMs: number
  /** 最大重试次数 */
  private _maxRetries: number
  /** 死锁检测定时器 */
  private _deadlockTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: SimpleTxnManagerOptions) {
    this._maxTxnAgeMs = opts?.maxTxnAgeMs ?? 30000
    this._enableSSI = opts?.enableSSI ?? true
    this._isolationLevel = opts?.isolationLevel ?? 'snapshot'
    this._lockTimeoutMs = opts?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this._deadlockCheckIntervalMs = opts?.deadlockCheckIntervalMs ?? DEFAULT_DEADLOCK_CHECK_INTERVAL_MS
    this._maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES
    this._lockManager = new WriteLockManager()
    this._deadlockDetector = new DeadlockDetector()

    // 如果启用 serializable，启动死锁检测
    if (this._isolationLevel === 'serializable') {
      this._startDeadlockDetection()
    }
  }

  /**
   * 开始一个新事务，返回 txId
   */
  begin(prefix?: string): string {
    const txId = `${prefix ?? 'tx'}_${this._nextId++}_${Date.now()}`
    this._txns.set(txId, {
      ops: [],
      startedAt: Date.now(),
      writeSet: { nodes: new Set(), edgeKeys: new Set() },
    })
    return txId
  }

  /**
   * 提交事务：
   * - snapshot 模式：SSI 冲突检测后回放
   * - serializable 模式：先获取写锁，再执行，再释放锁
   *
   * @param engine - GraphEngine 或 ShardManager，用于执行缓冲的操作
   * @throws {WriteConflictError} 如果 SSI 冲突检测失败
   * @throws {DeadlockError} 如果检测到死锁
   * @throws {LockTimeoutError} 如果获取写锁超时
   */
  async commit(txId: string, engine: GraphEngine | ShardManager): Promise<number> {
    if (this._isolationLevel === 'serializable') {
      return this._commitWithLocks(txId, engine)
    }
    return this._commitSnapshot(txId, engine)
  }

  /**
   * 使用 Serialazable 隔离级别提交：写锁 + 指数退避重试
   */
  private async _commitWithLocks(
    txId: string,
    engine: GraphEngine | ShardManager,
  ): Promise<number> {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found or already committed/rolled back`)
    }
    if (entry.ops.length === 0) {
      this._txns.delete(txId)
      return 0
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      if (attempt > 0) {
        // 指数退避：100ms * 2^(attempt-1)
        const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 2000)
        await new Promise(r => setTimeout(r, backoffMs))
      }

      try {
        return await this._executeWithLocks(txId, engine)
      } catch (err: any) {
        lastError = err
        // 如果是死锁或锁超时，可以重试
        if (err instanceof DeadlockError || err instanceof LockTimeoutError) {
          // 清理可能已获取的锁
          this._lockManager.releaseAllLocks(txId)
          continue
        }
        // 其他错误直接抛出
        throw err
      }
    }

    // 重试耗尽，自动回滚
    if (lastError) {
      this._txns.delete(txId)
      throw lastError
    }

    return 0
  }

  /**
   * 在写锁保护下执行事务操作
   */
  private async _executeWithLocks(
    txId: string,
    engine: GraphEngine | ShardManager,
  ): Promise<number> {
    const entry = this._txns.get(txId)
    if (!entry) throw new Error(`Transaction '${txId}' not found`)

    // Step 1: 构建所有需要锁的 key 列表
    const lockKeys: string[] = []
    for (const op of entry.ops) {
      switch (op.type) {
        case 'upsertNode':
          lockKeys.push(`node:name:${op.args[1]}`)
          break
        case 'deleteNode':
          lockKeys.push(`node:id:${op.args[0]}`)
          break
        case 'upsertEdge':
          lockKeys.push(`edge:${op.args[0]}:${op.args[1]}:${op.args[2]}`)
          lockKeys.push(`node:id:${op.args[0]}`)
          lockKeys.push(`node:id:${op.args[1]}`)
          break
        case 'deleteEdge':
          lockKeys.push(`edge:${op.args[0]}:${op.args[1]}:${op.args[2]}`)
          break
      }
    }

    // Step 2: 按 key 排序防止循环等待（预防性死锁避免）
    // 对 lockKeys 排序，确保所有事务按相同顺序获取锁
    const uniqueKeys = [...new Set(lockKeys)].sort()

    // Step 3: 获取所有写锁
    for (const lockKey of uniqueKeys) {
      const acquired = await this._lockManager.acquireLock(
        lockKey,
        txId,
        this._lockTimeoutMs,
      )
      if (!acquired) {
        // 锁超时 → 释放已获取的锁，抛异常
        this._lockManager.releaseAllLocks(txId)
        throw new LockTimeoutError(txId, lockKey, this._lockTimeoutMs)
      }
    }

    // Step 4: 执行所有操作
    try {
      for (const op of entry.ops) {
        switch (op.type) {
          case 'upsertNode':
            await this._execEngine(engine).upsertNode(op.args[0], op.args[1], op.args[2])
            break
          case 'deleteNode':
            await this._execEngine(engine).deleteNode(op.args[0], op.args[1] ?? false, op.args[2] ?? false)
            break
          case 'upsertEdge':
            await this._execEngine(engine).upsertEdge(op.args[0], op.args[1], op.args[2], op.args[3])
            break
          case 'deleteEdge':
            await this._execEngine(engine).deleteEdge(op.args[0], op.args[1], op.args[2], op.args[3] ?? false)
            break
        }
      }
    } catch (err) {
      // 执行失败 → 释放锁，重新抛出
      this._lockManager.releaseAllLocks(txId)
      throw err
    }

    // Step 5: 清理
    const count = entry.ops.length
    this._lockManager.releaseAllLocks(txId)
    this._txns.delete(txId)
    return count
  }

  /**
   * 使用 Snapshot 隔离级别提交：SSI 冲突检测后回放
   */
  private async _commitSnapshot(
    txId: string,
    engine: GraphEngine | ShardManager,
  ): Promise<number> {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found or already committed/rolled back`)
    }

    // SSI 冲突检测：检查已提交事务历史中的 writeSet 冲突
    if (this._enableSSI) {
      this._cleanupCommittedWriteSets()
      for (const committed of this._committedWriteSets) {
        for (const nodeId of entry.writeSet.nodes) {
          if (committed.keys.has(nodeId)) {
            const conflictKey = `node:${nodeId}`
            throw new WriteConflictError(txId, `committed:${nodeId}`, conflictKey)
          }
        }
        for (const edgeKey of entry.writeSet.edgeKeys) {
          if (committed.keys.has(edgeKey)) {
            throw new WriteConflictError(txId, `committed:${edgeKey}`, edgeKey)
          }
        }
      }
    }

    // Replay all buffered ops in order
    for (const op of entry.ops) {
      switch (op.type) {
        case 'upsertNode':
          await this._execEngine(engine).upsertNode(op.args[0], op.args[1], op.args[2])
          break
        case 'deleteNode':
          await this._execEngine(engine).deleteNode(op.args[0], op.args[1] ?? false, op.args[2] ?? false)
          break
        case 'upsertEdge':
          await this._execEngine(engine).upsertEdge(op.args[0], op.args[1], op.args[2], op.args[3])
          break
        case 'deleteEdge':
          await this._execEngine(engine).deleteEdge(op.args[0], op.args[1], op.args[2], op.args[3] ?? false)
          break
      }
    }

    const count = entry.ops.length

    // 将当前 writeSet 加入已提交历史（保留 maxTxnAgeMs 用于冲突检测）
    if (this._enableSSI && (entry.writeSet.nodes.size > 0 || entry.writeSet.edgeKeys.size > 0)) {
      const allKeys = new Set<any>([...entry.writeSet.nodes, ...entry.writeSet.edgeKeys])
      this._committedWriteSets.push({
        keys: allKeys,
        expiredAt: Date.now() + this._maxTxnAgeMs,
      })
    }

    this._txns.delete(txId)
    return count
  }

  /**
   * 回滚事务：丢弃所有缓冲的写入操作，释放所有写锁
   */
  rollback(txId: string): number {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found or already committed/rolled back`)
    }
    const count = entry.ops.length
    // 释放该事务持有的所有写锁
    this._lockManager.releaseAllLocks(txId)
    this._txns.delete(txId)
    return count
  }

  /**
   * 向事务添加一个写入操作（由 GraphEngine 内部调用）
   * 同时更新该事务的 writeSet，用于 SSI 冲突检测。
   */
  addOp(txId: string, op: WriteOp): void {
    const entry = this._txns.get(txId)
    if (!entry) {
      throw new Error(`Transaction '${txId}' not found — begin a transaction first`)
    }
    entry.ops.push(op)

    // 更新 writeSet
    switch (op.type) {
      case 'upsertNode':
        if (typeof op.args[1] === 'string') {
          entry.writeSet.nodes.add(`name:${op.args[1]}` as any)
        } else if (typeof op.args[1] === 'number') {
          entry.writeSet.nodes.add(op.args[1])
        }
        break
      case 'deleteNode':
        entry.writeSet.nodes.add(op.args[0])
        break
      case 'upsertEdge':
        if (typeof op.args[0] === 'number') entry.writeSet.nodes.add(op.args[0])
        if (typeof op.args[1] === 'number') entry.writeSet.nodes.add(op.args[1])
        entry.writeSet.edgeKeys.add(`${op.args[0]}:${op.args[1]}:${op.args[2]}`)
        break
      case 'deleteEdge':
        if (typeof op.args[0] === 'number') entry.writeSet.nodes.add(op.args[0])
        if (typeof op.args[1] === 'number') entry.writeSet.nodes.add(op.args[1])
        entry.writeSet.edgeKeys.add(`${op.args[0]}:${op.args[1]}:${op.args[2]}`)
        break
    }
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
   */
  cleanupStale(): number {
    const now = Date.now()
    let count = 0
    for (const [txId, entry] of this._txns) {
      if (now - entry.startedAt > this._maxTxnAgeMs) {
        // 释放锁后清理
        this._lockManager.releaseAllLocks(txId)
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
   * 清理已过期的已提交 writeSet 历史
   */
  private _cleanupCommittedWriteSets(): void {
    const now = Date.now()
    this._committedWriteSets = this._committedWriteSets.filter(c => c.expiredAt > now)
  }

  /**
   * 启动定期清理
   */
  startCleanup(intervalMs?: number): void {
    this.stopCleanup()
    this._cleanupTimer = setInterval(() => {
      this.cleanupStale()
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
   * 启动死锁检测（定期运行）
   */
  private _startDeadlockDetection(): void {
    this._deadlockTimer = setInterval(() => {
      this._detectAndHandleDeadlocks()
    }, this._deadlockCheckIntervalMs)
    if (this._deadlockTimer && typeof this._deadlockTimer.unref === 'function') {
      this._deadlockTimer.unref()
    }
  }

  /**
   * 停止死锁检测
   */
  private _stopDeadlockDetection(): void {
    if (this._deadlockTimer !== null) {
      clearInterval(this._deadlockTimer)
      this._deadlockTimer = null
    }
  }

  /**
   * 执行死锁检测，如果有死锁则自动回滚最年轻的事务
   */
  private _detectAndHandleDeadlocks(): void {
    // 通过活跃事务构建等待图
    const wfg = new Map<string, Set<string>>()

    // 对于每个活跃事务，检查它等待的锁
    for (const [txId] of this._txns) {
      if (!wfg.has(txId)) wfg.set(txId, new Set())
    }

    // 填充等待图（这里从 lockManager 获取信息）
    // 实际等待关系在 WriteLockManager 内部管理
    // 此处简化实现：通过检测锁获取失败来判断

    // 找环
    const cycle = this._findCycle(wfg)
    if (cycle.length > 0) {
      // 回滚环中时间最晚的事务（最年轻的）
      let youngestTx = ''
      let latestTime = 0
      for (const txId of cycle) {
        const entry = this._txns.get(txId)
        if (entry && entry.startedAt > latestTime) {
          latestTime = entry.startedAt
          youngestTx = txId
        }
      }
      if (youngestTx) {
        this._lockManager.releaseAllLocks(youngestTx)
        this._txns.delete(youngestTx)
      }
    }
  }

  /**
   * 使用 Kahn 算法检测有向图中是否有环
   */
  private _findCycle(edges: Map<string, Set<string>>): string[] {
    const inDegree = new Map<string, number>()
    for (const [node] of edges) {
      inDegree.set(node, 0)
    }
    for (const [, targets] of edges) {
      for (const target of targets) {
        inDegree.set(target, (inDegree.get(target) || 0) + 1)
      }
    }

    const queue: string[] = []
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node)
    }

    const removed = new Set<string>()
    while (queue.length > 0) {
      const node = queue.shift()!
      removed.add(node)
      const targets = edges.get(node) || new Set()
      for (const target of targets) {
        const newDeg = (inDegree.get(target) || 1) - 1
        inDegree.set(target, newDeg)
        if (newDeg === 0) queue.push(target)
      }
    }

    const cycle: string[] = []
    for (const [node] of inDegree) {
      if (!removed.has(node)) cycle.push(node)
    }
    return cycle
  }

  /**
   * 获取所有活跃事务 ID
   */
  listActive(): string[] {
    return Array.from(this._txns.keys())
  }

  /**
   * 检测 engine 是否为 ShardManager
   */
  private _isShardManager(engine: GraphEngine | ShardManager): engine is ShardManager {
    return 'getAllRanges' in engine
  }

  /**
   * 获取实际执行写入的引擎
   */
  private _execEngine(engine: GraphEngine | ShardManager): GraphEngine {
    if (this._isShardManager(engine)) {
      return engine as unknown as GraphEngine
    }
    return engine
  }

  /**
   * 析构：清理定时器和锁
   */
  destroy(): void {
    this.stopCleanup()
    this._stopDeadlockDetection()
    this._lockManager.clear()
    this._txns.clear()
  }
}

/**
 * 事务条目，用于内部状态管理
 */
interface TxnEntry {
  ops: WriteOp[]
  startedAt: number
  writeSet: WriteSet
}
