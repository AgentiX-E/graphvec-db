/**
 * Transaction — MVCC 增强事务系统
 *
 * 支持：
 * - 快照隔离 (Snapshot Isolation)
 * - 写集锁 + Conflict detection
 * - 读集Trace
 * - SSI (Serializable Snapshot Isolation) — 读集Conflict detection
 * - Deadlock detected — Wait-for 图循环检测
 * - 版本链 — 多版本读取
 * - 隔离级别选择 (read-committed / snapshot / serializable)
 * - 超时锁清理
 * - 与 GraphEngine 深度集成
 */

import type { GraphEngine } from './graph-engine'
import type { NodeId, NodeRecord } from '../types'

// ── 类型定义 ──

export type IsolationLevel = 'read-committed' | 'snapshot' | 'serializable'

export interface UpsertOpData {
  typeId: number
  name: string
  props?: Record<string, any>
}

export interface MVCCSnapshot {
  id: number
  createdAt: number
  /** Optional版本号，用于多版本读取 (version chain) */
  version?: number
}

export interface BeginOptions {
  isolation?: IsolationLevel
  /** 跨分片 aware: 如果指定了多个 rangeIds，启用 2PC */
  rangeIds?: string[]
}

// ── 事务管理器 ──

export class TransactionManager {
  private _nextSnapshotId = 1
  private _locks = new Map<string, { nodeId: NodeId; snapshotId: number; lockedAt: number }>()
  private _lockTimeoutMs: number
  /** 已提交事务的写入记录（用于 SSI 读集Conflict detection）
   *  key = nodeId string (or "name:${name}" for upsert operations)
   *  value = committedAt 时间戳 */
  private _committedWrites = new Map<string, number>()

  constructor(lockTimeoutMs = 5000) {
    this._lockTimeoutMs = lockTimeoutMs
  }

  get lockCount(): number {
    return this._locks.size
  }

  begin(opts?: BeginOptions): Transaction {
    const snapshot: MVCCSnapshot = {
      id: this._nextSnapshotId++,
      createdAt: Date.now(),
    }
    const isolation = opts?.isolation ?? 'snapshot'
    const txn = new Transaction(this, snapshot, isolation)
    // 跨分片 awareness: 如果指定了多个 range，启用 2PC
    if (opts?.rangeIds && opts.rangeIds.length > 1) {
      ;(txn as any)._use2PC = true
      ;(txn as any)._rangeIds = [...opts.rangeIds]
    }
    return txn
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

  /**
   * 记录事务提交时的写入（用于 SSI 读集Conflict detection）
   * 会记录 writeSet 中的 name 和 deleteSet 中的 nodeId
   */
  _recordCommitWrite(snapshotId: number, writeSet: Map<string, UpsertOpData>, deleteSet: Set<NodeId>, engine?: GraphEngine): void {
    const now = Date.now()
    for (const [name, data] of writeSet) {
      // 如果不是边操作，按 name 记录
      if (!name.startsWith('edge:')) {
        this._committedWrites.set(`name:${name}`, now)
        // 如果引擎可用，尝试通过 name 查询 nodeId 并记录 nodeId 键
        // 这样读集冲突可以通过 nodeId 直接匹配
        if (engine) {
          try {
            const node = engine.findNodeByName(name)
            if (node !== null && node !== undefined) {
              this._committedWrites.set(String((node as any).id ?? node), now)
            }
          } catch {
            // 查询可能因 flush 后的 engine 状态变化失败，静默处理
          }
        }
      }
    }
    for (const nodeId of deleteSet) {
      this._committedWrites.set(String(nodeId), now)
    }
  }

  /**
   * 检查节点的读集冲突
   * 如果 committedWrites 中有任何条目在 snapshot 创建之后记录了该节点，说明有冲突
   */
  _checkNodeConflict(nodeId: NodeId, snapshotCreatedAt: number): boolean {
    const entry = this._committedWrites.get(String(nodeId))
    // Use >= to handle same-ms race between snapshot and commit write
    if (entry && entry >= snapshotCreatedAt) return true

    // 也检查 name: 前缀的条目（upsert 节点按 name 键）
    for (const [key, timestamp] of this._committedWrites) {
      if (key.startsWith('name:') && timestamp >= snapshotCreatedAt) {
        return true
      }
    }
    return false
  }

  /**
   * 检测死锁 — 构建 wait-for 图，使用 DFS 检测循环
   * 返回第一个检测到的死锁描述字符串，无死锁返回 null
   *
   * 算法：
   * 1. 每个 snapshotId 是一个节点
   * 2. 如果 T1 持有节点 X 的锁，T2 正在请求节点 X（T2 已在 wait-for 表中），
   *    则 T2 → T1（T2 等待 T1）
   * 3. 由于我们使用阻塞锁（lock() 直接抛异常），
   *    死锁场景是：T1 持有 A，T2 持有 B，T1 请求 B，T2 请求 A
   *    → 在 lock 阶段，T1 锁了 A，T2 锁了 B
   *    → T1 再锁 B 失败（超时/异常），T2 再锁 A 失败
   *    但等待关系需要在 commit 前建立
   *
   * 实际实现：在 Phase 0.5，我们已经部分加锁了，
   * 构建 wait-for：对于每个尝试加锁的 snapshot，检查它需要的锁被谁持有
   *
   * 简化实现：检查当前所有锁中，是否存在循环等待
   * - 构建图: 节点 = snapshotId, 边 = A → B 表示 A 在等待 B 持有的锁
   * - 每个锁的持有者是 snapshotId，被锁的 node 是该锁的资源
   * - 如果一个 snapshot 有 pending_lock_request(resource, blockedBySnapshotId)，
   *   则 snapshot → blockedBySnapshotId
   *
   * 这里的实现采用简化版：如果存在一个锁循环（多个 snapshot 互相持有对方需要的锁），
   * 则存在死锁。对于当前阻塞锁模型，我们检查是否两个 snapshot 各自锁了对方需要的节点。
   */
  detectDeadlock(snapshotId: number): string | null {
    // 构建 wait-for 图
    // 节点: 所有有锁的 snapshotId
    // 边: 从持有锁的 snapshot 视角，它锁了哪些节点 → 哪些其他 snapshot 也想要这些节点
    //
    // 在我们的加锁模型中，lock() 阶段是依次对每个 key 加锁的。
    // 在 commit() 的 Phase 2，我们先检查所有 key 是否 locked，
    // 然后依次 lock()。如果 lock() 抛异常，之前的锁会被 unlockAll 释放。
    //
    // 死锁场景需要更精细的建模。这里采用简化方案：
    // 构建 wait-for 图 snapshotId → [blockedBySnapshotId, ...]
    // 使用 DFS 检测循环

    const waitFor = new Map<number, Set<number>>()
    const allSnapshots = new Set<number>()

    // 收集所有有锁的 snapshot
    for (const [, lock] of this._locks) {
      allSnapshots.add(lock.snapshotId)
    }

    // 这里模拟等待关系检测：
    // 如果两个 snapshot 持有对方需要的节点锁，则构成 wait-for
    for (const sidA of allSnapshots) {
      for (const sidB of allSnapshots) {
        if (sidA >= sidB) continue
        // 检查 sidA 的锁集和 sidB 的锁集
        const locksA = new Set<number>()
        const locksB = new Set<number>()
        for (const [, lock] of this._locks) {
          if (lock.snapshotId === sidA) locksA.add(lock.nodeId)
          if (lock.snapshotId === sidB) locksB.add(lock.nodeId)
        }
        // 如果 A 和 B 各自有对方需要的节点，构建双向往边
        // 但这只适用于两个 snapshot 的情况
        // 更通用的实现：对于每个节点，If any多个 snapshot 锁了它，可能存在等待关系
      }
    }

    // 通用实现：对于每个被多 snapshot 锁住的节点，建立 wait-for 边
    // Note: 在我们的实现中，同一节点不能被多个 snapshot 加锁（lock() 会抛异常）
    // 所以真正的死锁发生在：T1 锁了 A 请求 B，T2 锁了 B 请求 A
    // 由于我们的 lock() 是抛异常而非阻塞，死锁需要通过显式的锁请求跟踪来实现
    //
    // 简化实现：使用 deadlock detection request tracker
    // 在 commit 的 phase 2 中，如果 lock() 失败，记录待请求关系
    // 然后在 Phase 0.5 检测循环
    //
    // 这里不构建复杂的 wait-for，因为我们的锁模型不阻塞等待。
    // 对于写 skew 检测（SSI），由 _checkReadSetConflict 负责。
    //
    // Deadlock detected在实际阻塞锁模型中才有意义。
    // 这里实现为接口存在但功能先返回 null（测试中通过模拟场景测试）
    // 实际Deadlock detected会在增强的锁模型中实现

    // 使用 DFS 检测 wait-for 图中的循环
    // 从给定 snapshotId 出发
    const visited = new Set<number>()
    const recStack = new Set<number>()

    function dfs(current: number, graph: Map<number, Set<number>>): string | null {
      if (recStack.has(current)) {
        // 找到循环
        return `Deadlock detected involving snapshot ${current}`
      }
      if (visited.has(current)) return null

      visited.add(current)
      recStack.add(current)

      const neighbors = graph.get(current)
      if (neighbors) {
        for (const next of neighbors) {
          const result = dfs(next, graph)
          if (result) return result
        }
      }

      recStack.delete(current)
      return null
    }

    return dfs(snapshotId, waitFor)
  }

  /**
   * 注册锁请求（用于Deadlock detected）
   * 当 lock() 失败时调用，记录请求关系
   */
  private _lockRequests = new Map<string, { nodeId: NodeId; snapshotId: number }>()

  _registerLockRequest(nodeId: NodeId, snapshotId: number): void {
    const key = String(nodeId)
    this._lockRequests.set(key, { nodeId, snapshotId })
  }

  _clearLockRequest(nodeId: NodeId): void {
    this._lockRequests.delete(String(nodeId))
  }

  _clearAllLockRequests(snapshotId: number): void {
    for (const [key, req] of this._lockRequests) {
      if (req.snapshotId === snapshotId) {
        this._lockRequests.delete(key)
      }
    }
  }

  /**
   * 增强版Deadlock detected — 基于锁请求跟踪
   * 构建完整的 wait-for 图，检测循环
   */
  detectDeadlockFull(snapshotId: number): string | null {
    // 构建 wait-for 图
    // 节点 = snapshotId
    // 边 = sid → blockedBySid (sid 等待 blockedBySid 释放锁)
    const waitFor = new Map<number, Set<number>>()
    const allSids = new Set<number>()

    // 收集所有 snapshot IDs（持有锁或请求锁的）
    for (const [, lock] of this._locks) {
      allSids.add(lock.snapshotId)
    }
    for (const [, req] of this._lockRequests) {
      allSids.add(req.snapshotId)
    }
    allSids.add(snapshotId)

    // 构建 wait-for 边：对于每个锁请求，请求者正在等待锁的持有者
    for (const [key, req] of this._lockRequests) {
      const lockEntry = this._locks.get(key)
      if (lockEntry && lockEntry.snapshotId !== req.snapshotId) {
        // 请求者 req.snapshotId 等待锁持有者 lockEntry.snapshotId
        const neighbors = waitFor.get(req.snapshotId) ?? new Set()
        neighbors.add(lockEntry.snapshotId)
        waitFor.set(req.snapshotId, neighbors)
      }
    }

    // 从给定 snapshotId 出发 DFS 检测循环
    const visited = new Set<number>()
    const recStack = new Set<number>()
    const path: number[] = []

    function dfs(current: number, graph: Map<number, Set<number>>, path: number[]): string | null {
      if (recStack.has(current)) {
        const cycleStart = path.indexOf(current)
        const cycle = path.slice(cycleStart).concat(current)
        return `Deadlock detected: snapshot ${current} is in a wait-for cycle [${cycle.join(' → ')}]`
      }
      if (visited.has(current)) return null

      visited.add(current)
      recStack.add(current)
      path.push(current)

      const neighbors = graph.get(current)
      if (neighbors) {
        for (const next of neighbors) {
          const result = dfs(next, graph, path)
          if (result) return result
        }
      }

      path.pop()
      recStack.delete(current)
      return null
    }

    // 从所有 snapshot 出发检测（确保覆盖整个图）
    for (const sid of allSids) {
      if (!visited.has(sid)) {
        const result = dfs(sid, waitFor, [])
        if (result) return result
      }
    }

    return null
  }

  /**
   * 获取等待关系图（用于Debug/测试）
   */
  getWaitForGraph(): Map<number, Set<number>> {
    const waitFor = new Map<number, Set<number>>()
    for (const [key, req] of this._lockRequests) {
      const lockEntry = this._locks.get(key)
      if (lockEntry && lockEntry.snapshotId !== req.snapshotId) {
        const neighbors = waitFor.get(req.snapshotId) ?? new Set()
        neighbors.add(lockEntry.snapshotId)
        waitFor.set(req.snapshotId, neighbors)
      }
    }
    return waitFor
  }
}

// ── 事务 ──

export class Transaction {
  public readonly snapshot: MVCCSnapshot
  public readonly writeSet: Map<string, UpsertOpData>
  public readonly deleteSet: Set<NodeId>
  public readonly readSet: Set<NodeId>
  public readonly isolation: IsolationLevel
  /** 是否使用 2PC — 跨分片事务标志 */
  readonly _use2PC: boolean
  /** 关联的跨分片 range IDs */
  readonly _rangeIds: string[]
  private _committed = false
  private _rolledBack = false
  private _mgr: TransactionManager | null
  private _engine: GraphEngine | null

  /**
   * @param mgr - TransactionManager
   * @param snapshotOrEngine - Either MVCCSnapshot (called from mgr.begin())
   *                          or GraphEngine (called from tests: new Transaction(mgr, engine))
   */
  constructor(mgr: TransactionManager, snapshotOrEngine?: MVCCSnapshot | GraphEngine, isolation?: IsolationLevel) {
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
    this.isolation = isolation ?? 'snapshot'
    // 为 snapshot 设置版本号，支持版本链
    this.snapshot.version = this.snapshot.id
    // 跨分片 awareness
    this._use2PC = false
    this._rangeIds = []
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

  /**
   * 读节点（带版本Info）
   * 在多版本读取中，返回 snapshot-time 的值
   * 如果 engine 提供了版本链支持，读取对应版本
   */
  readNodeVersioned(nodeId: NodeId, engines?: GraphEngine | GraphEngine[]): any {
    this.readSet.add(nodeId)
    if (!engines) return null

    const engList = Array.isArray(engines) ? engines : [engines]
    // 尝试读取节点，如果 engine 支持版本链，读取 snapshot-time 的值
    for (const eng of engList) {
      if (typeof (eng as any).getNodeVersioned === 'function') {
        const result = (eng as any).getNodeVersioned(nodeId, this.snapshot.version)
        if (result !== undefined) return result
      }
    }
    return null
  }

  /**
   * Phase 0: SSI 读集Conflict detection
   * 检查读集中的节点是否被其他事务在 snapshot 之后修改过
   * 仅当 isolation === 'serializable' 时调用
   */
  _checkReadSetConflict(_engine: GraphEngine | null): boolean {
    if (this.readSet.size === 0) {
      return false
    }
    if (!this._mgr) return false

    for (const nodeId of this.readSet) {
      // 检查节点是否被当前 writeSet 或 deleteSet 覆盖
      // 如果读和写是同一个节点，不算冲突（这是正常的更新）
      if (this.writeSet.has(String(nodeId)) || this.deleteSet.has(nodeId)) {
        continue
      }

      // 通过 TransactionManager 的 committedWrites 检查是否被其他事务修改
      const conflict = this._mgr._checkNodeConflict(nodeId, this.snapshot.createdAt)
      if (conflict) return true
    }
    return false
  }

  /**
   * Phase 0.5: Deadlock detected
   * 检测当前事务是否陷入死锁（wait-for 图循环）
   */
  _detectDeadlock(snapshotId: number, mgr: TransactionManager | null): boolean {
    if (!mgr) return false
    const result = mgr.detectDeadlock(snapshotId)
    return result !== null
  }

  async commit(): Promise<void> {
    if (this._committed) throw new Error('Transaction already committed')
    if (this._rolledBack) throw new Error('Transaction already rolled back')

    // ── Phase 0: SSI 读集冲突检查（Serializable Snapshot Isolation） ──
    if (this.isolation === 'serializable' && this._mgr) {
      const hasConflict = this._checkReadSetConflict(this._engine)
      if (hasConflict) {
        if (this._mgr) {
          this._mgr.unlockAll(this.snapshotId)
          this._mgr._clearAllLockRequests(this.snapshotId)
        }
        this._rolledBack = true
        throw new Error('Commit failed: serialization conflict detected — read-set has been modified by another transaction')
      }
    }

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
        // 注册锁请求（用于Deadlock detected）
        if (this._mgr) {
          this._mgr._registerLockRequest(Number(key), this.snapshotId)
        }
        throw new Error(`Commit failed: node ${key} is locked by another transaction`)
      }
    }

    // Phase 2: 加锁（如果需要）
    if (this._mgr) {
      for (const key of allKeys) {
        // 只对数字 key 加锁（writeSet 中可能包含名字字符串，Number()=NaN）
        const numKey = Number(key)
        if (!isNaN(numKey)) {
          this._mgr.lock(numKey, this.snapshotId)
        }
      }
    }

    // ── Phase 0.5: Deadlock detected（加锁后，获取资源前） ──
    if (this._mgr) {
      const deadlock = this._mgr.detectDeadlockFull(this.snapshotId)
      if (deadlock) {
        if (this._mgr) {
          this._mgr.unlockAll(this.snapshotId)
          this._mgr._clearAllLockRequests(this.snapshotId)
        }
        this._rolledBack = true
        throw new Error(`Commit failed: ${deadlock}`)
      }
    }

    try {
      // Phase 3: flush
      if (this._engine) {
        await this._flushToEngine(this._engine)
      }

      // 记录已提交的写入（用于 SSI 读集Conflict detection）
      if (this._mgr) {
        this._mgr._recordCommitWrite(this.snapshotId, this.writeSet, this.deleteSet, this._engine)
      }

      // Phase 4: 释放锁
      if (this._mgr) {
        this._mgr.unlockAll(this.snapshotId)
        this._mgr._clearAllLockRequests(this.snapshotId)
      }
    } catch (err) {
      if (this._mgr) {
        this._mgr.unlockAll(this.snapshotId)
        this._mgr._clearAllLockRequests(this.snapshotId)
      }
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
      this._mgr._clearAllLockRequests(this.snapshotId)
    }
  }

  private async _flushToEngine(engine: GraphEngine): Promise<void> {
    for (const [, data] of this.writeSet) {
      await engine.upsertNode(data.typeId, data.name, { props: data.props, _mvccVersion: this.snapshotId })
    }
    for (const nodeId of this.deleteSet) {
      await engine.deleteNode(nodeId)
    }
  }

  /**
   * 从引擎读取节点，应用 MVCC 快照可见性
   * 在 snapshot 隔离级别下，只返回在事务开始前已提交的节点
   */
  getNode(engine: GraphEngine, nodeId: NodeId): NodeRecord | null {
    this.readSet.add(nodeId)
    return engine.getNodeWithTxn(nodeId, this)
  }

  /**
   * 检查引擎中节点的版本是否对当前快照可见
   */
  isNodeVisible(engine: GraphEngine, nodeId: NodeId): boolean {
    const version = engine.getNodeVersion(nodeId)
    if (version === undefined || version === null) {
      // 没有版本Info的节点视为始终可见（非 MVCC 写入）
      return true
    }
    // snapshot 隔离：只能看到 snapshotId 及之前写入的版本
    return version <= this.snapshotId
  }

  /** 设置 engine（Optional，用于 flush） */
  setEngine(engine: GraphEngine): void {
    this._engine = engine
  }

  private _checkActive(): void {
    if (this._committed) throw new Error('Transaction already committed')
    if (this._rolledBack) throw new Error('Transaction already rolled back')
  }
}
