import { StandaloneConsensus } from '../consensus/standalone-consensus'
import { ConsensusProvider } from '../consensus/consensus-provider'
import { GraphEngine } from '../core/graph-engine'
import { HlcClock } from '../replication/hlc-clock'
import { RangeConfig, RaftOperation } from '../types'
import { v4 as uuid } from 'uuid'
import { Logger } from '../ops/logger'
import { Telemetry } from '../ops/otel'
import { MetricsCollector } from '../ops/otel-metrics'

/**
 * RangeInstance — 单个分片的完整封装
 *
 * 一个 RangeInstance = 一个 Raft 组 + 一个 OverGraph 实例
 * 数据独立性通过 OverGraph 的独立文件目录保证
 *
 * 使用 raft-logic（tikv/raft-rs WASM）作为生产级共识引擎。
 *
 * draining:
 * - 在 rebalancing 迁移期间将源 Range 标记为 draining
 * - draining 期间新的写入将被拒绝（返回错误），确保"先写后删"安全
 * - 读取不受影响
 */
export class RangeInstance {
  readonly config: RangeConfig
  readonly engine: GraphEngine
  /** 共识引擎（raft-logic ConsensusProvider） */
  private consensus: any
  private clock: HlcClock
  private _draining = false
  private _started = false
  /** 最近一次成功 ping/read/write 的时间戳（ms），用于心跳检测 */
  private _lastSeenMs = 0
  /** 乐观锁版本存储：resourceKey → version */
  private _versionStore = new Map<string, number>()
  /** 2PC prepare log 存储: txId → PrepareLogEntry */
  private _prepareLog = new Map<string, { txId: string; operations: any[]; status: 'prepared' | 'committed' | 'rolled_back'; createdAt: number }>()
  private logger: Logger
  private telemetry: Telemetry
  private metrics: MetricsCollector
  private applyResolvers: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }> = new Map()

  constructor(config: RangeConfig, clock: HlcClock, consensus?: ConsensusProvider) {
    this.config = config
    this.clock = clock
    this.logger = new Logger(`RangeInstance[${config.rangeId}]`)
    this.telemetry = Telemetry.getInstance()
    this.metrics = MetricsCollector.getInstance()
    this.engine = new GraphEngine(config.overgraphConfig)

    // 共识引擎：传了就注入，否则用 StandaloneConsensus（单节点/测试默认）
    // ⚠️ WARN: 生产部署必须提供 ConsensusProvider（如 raft-logic）
    //         StandaloneConsensus 仅限单节点开发/测试，多节点时数据完全不一致
    if (!consensus) {
      this.logger.warn(
        'No ConsensusProvider provided — falling back to StandaloneConsensus. ' +
        'This is SAFE for single-node development but DANGEROUS for multi-node production. ' +
        'Provide a ConsensusProvider (raft-logic or simulated-raft) for multi-node deployments.'
      )
    }
    const cp = consensus ?? new StandaloneConsensus({
      nodeId: config.raftConfig.nodeId,
      mode: 'standalone',
    })
    cp.setApply!(async (data: Uint8Array) => {
      try {
        await this._applyToStateMachine(data)
      } catch (err) {
        this.logger.error('[RangeInstance] State machine apply fatal:', err as Error)
      }
    })
    this.consensus = cp
  }

  /** 记录活跃时间戳 */
  private _touch(): void {
    this._lastSeenMs = Date.now()
  }

  /**
   * ping — 心跳探活，只更新时间戳，不做实质性操作
   * 用于 ShardManager 定时健康检查
   */
  ping(): void {
    this._touch()
  }

  /** 获取最近活跃时间戳 */
  get lastSeenMs(): number {
    return this._lastSeenMs
  }

  get isStarted(): boolean {
    return this._started
  }

  async start(): Promise<void> {
    this.engine.open()
    await this.consensus.start()
    this._started = true
  }

  async stop(): Promise<void> {
    if (!this._started) return
    await this.consensus.stop()
    this.engine.close()
    this._started = false
  }

  /** 检查是否在 draining 状态 */
  isDraining(): boolean {
    return this._draining
  }

  /** 设置 draining 标记（true = 拒绝新写入） */
  setDraining(draining: boolean): void {
    this._draining = draining
  }

  /** 通过共识写入 — draining 状态拒绝写入 */
  async write(op: Omit<RaftOperation, 'id'>): Promise<unknown> {
    this._touch()
    if (this._draining) {
      throw new Error(`Range ${this.config.rangeId} is draining: write rejected`)
    }
    return this.telemetry.traceAsync('raft.write', async () => {
      const operation: RaftOperation = {
        ...op,
        id: uuid(),
        hlcTimestamp: this.clock.now().toBytes(),
      }

      const data = Buffer.from(JSON.stringify(operation))

      // 先注册 promise，再 propose — 避免竞态
      const promise = new Promise<unknown>((resolve, reject) => {
        this.applyResolvers.set(operation.id, { resolve, reject })
      })

      const result = await this.consensus.propose(data)
      if (!result.ok) {
        this.applyResolvers.delete(operation.id)
        throw new Error('Raft proposal failed')
      }

      this.metrics.incrementCounter('graph.ops.writes')
      this.metrics.incrementCounter('graph.raft.proposals')

      return promise
    })
  }

  /**
   * 乐观锁写入 — 带版本校验的 update 操作
   *
   * 工作原理：
   * 1. 客户端通过 read() 获取当前版本（通过 getVersion() 辅助方法）
   * 2. 客户端构造带 expectedVersion 的 RaftOperation
   * 3. Raft proposal 通过后，在 _applyToStateMachine 中校验版本
   * 4. 如果版本不匹配，promise 被 reject（OptimisticLockError）
   *
   * @returns 返回更新的版本号
   * @throws {Error} 如果 draining 或 proposal 失败
   * @throws {OptimisticLockError} 如果版本冲突
   */
  async writeWithOptimisticLock(
    resourceKey: string,
    op: Omit<RaftOperation, 'id' | 'type'>,
  ): Promise<number> {
    // 获取当前已知的最大版本
    const currentVersion = this._versionStore.get(resourceKey) ?? 0
    // 将 resourceKey 注入 payload，供 _applyToStateMachine 使用
    const payload = (op.payload ?? {}) as Record<string, unknown>
    const proposalOp: RaftOperation = {
      ...op,
      payload: { ...payload, __optimisticResourceKey: resourceKey },
      type: 'optimistic_upsert_node',
      id: uuid(),
      hlcTimestamp: this.clock.now().toBytes(),
      expectedVersion: currentVersion,
    }

    return this.telemetry.traceAsync('raft.optimistic_write', async () => {
      // 在 propose 前注册 promise
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const promise = new Promise<number>((resolve, reject) => {
        this.applyResolvers.set(proposalOp.id, {
          resolve: (val: any) => {
            resolve(val as number)
          },
          reject: (err: any) => reject(err),
        })
      })

      const data = Buffer.from(JSON.stringify(proposalOp))
      const result = await this.consensus.propose(data)
      if (!result.ok) {
        this.applyResolvers.delete(proposalOp.id)
        throw new Error('Raft proposal failed')
      }

      // 等待 state machine apply 的结果
      // resolve: 返回新版本号
      // reject: 如果版本冲突则抛 OptimisticLockError
      return promise
    })
  }

  /**
   * 获取指定资源的当前版本号
   * 用于客户端在 writeWithOptimisticLock 前拿到版本
   */
  getVersion(resourceKey: string): number {
    return this._versionStore.get(resourceKey) ?? 0
  }

  /** OptimisticLockError — 当乐观锁版本冲突时抛出 */
  static OptimisticLockError = class OptimisticLockError extends Error {
    constructor(resourceKey: string, expected: number, actual: number) {
      super(`Optimistic lock conflict on "${resourceKey}": expected version ${expected}, actual ${actual}`)
      this.name = 'OptimisticLockError'
    }
  }

  /** 线性一致读 — draining 不影响读取 */
  async read<T>(reader: (engine: GraphEngine) => T): Promise<T> {
    this._touch()
    return this.telemetry.traceAsync('raft.read', async () => {
      await this.consensus.readIndex()
      const result = reader(this.engine)
      this.metrics.incrementCounter('graph.ops.reads')
      return result
    })
  }

  /**
   * 线性一致读（barrier 模式）
   *
   * 使用 barrier() 代替 readIndex()，提供更强的线性一致保证：
   * barrier 返回后，barrier 前的所有写入都已 apply。
   *
   * 适用场景：
   * - 客户端先写入后，后续读必须看到该写入
   * - 分布式锁判定等对一致性有严格要求的操作
   *
   * @param reader - 读取回调
   * @param options.useConsistentFlow - 是否使用 barrier 语义（默认 false，保持向后兼容）
   */
  async readWithBarrier<T>(
    reader: (engine: GraphEngine) => T,
    options?: { useConsistentFlow?: boolean },
  ): Promise<T> {
    const useConsistentFlow = options?.useConsistentFlow ?? false
    this._touch()
    return this.telemetry.traceAsync('raft.read_with_barrier', async () => {
      if (useConsistentFlow && typeof (this.consensus as any).barrier === 'function') {
        await (this.consensus as any).barrier()
      } else {
        // 向后兼容：使用标准 readIndex
        await this.consensus.readIndex()
      }
      const result = reader(this.engine)
      this.metrics.incrementCounter('graph.ops.reads')
      return result
    })
  }

  /** 等待共识引擎就绪（leader 选举完成） */
  async waitForLeader(timeoutMs?: number): Promise<void> {
    await this.consensus.waitForLeader(timeoutMs)
  }

  /** 获取状态 */
  getStatus() {
    return {
      raft: {
        role: this.consensus.getRole?.(),
        leaderId: this.consensus.getLeaderId?.(),
        term: this.consensus.getTerm?.(),
      },
      storage: this.engine.stats(),
    }
  }

  /** 检查范围是否健康 */
  isHealthy(): boolean {
    return !this._draining && this._started && this.engine.isOpen
  }

  /**
   * 2PC: Prepare — 记录 prepare log，为后续 commit/rollback 做准备
   * 幂等: 同一个 txId 再次调用返回相同的状态
   *
   * @param txId 事务 ID
   * @param operations prepare 关联的操作列表（当前未使用，为未来 WAL 预留）
   * @returns true 表示 prepare 成功，false 表示拒绝
   */
  async prepareTx(txId: string, operations: any[]): Promise<boolean> {
    // 幂等: 如果已 prepare，直接返回 true
    if (this._prepareLog.has(txId)) {
      const existing = this._prepareLog.get(txId)!
      return existing.status === 'prepared' || existing.status === 'committed'
    }

    this._prepareLog.set(txId, {
      txId,
      operations,
      status: 'prepared',
      createdAt: Date.now(),
    })

    return true
  }

  /**
   * 2PC: Commit — 提交事务，执行实际写入
   * 幂等: 多次调用不会报错
   */
  async commitTx(txId: string): Promise<void> {
    const entry = this._prepareLog.get(txId)

    if (!entry) {
      // 未知 txId — 可能是协调者重启后的重试，幂等返回
      return
    }

    // 幂等保护
    if (entry.status === 'committed') {
      return
    }

    entry.status = 'committed'
  }

  /**
   * 2PC: Rollback — 回滚事务，清理 prepare log
   * 幂等: 多次调用不会报错
   */
  async rollbackTx(txId: string): Promise<void> {
    const entry = this._prepareLog.get(txId)

    if (!entry) {
      return
    }

    // 幂等保护
    if (entry.status === 'rolled_back' || entry.status === 'committed') {
      return
    }

    entry.status = 'rolled_back'
  }

  /** 检查指定 txId 是否有活跃的 prepare log */
  hasPrepareLog(txId: string): boolean {
    return this._prepareLog.has(txId)
  }

  /** 获取 prepare log 状态 */
  getPrepareLogStatus(txId: string): string | undefined {
    return this._prepareLog.get(txId)?.status
  }

  /**
   * 校验并规范化 op 的 payload
   */
  private _validatePayload(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`Invalid RaftOperation payload: expected object, got ${typeof payload}`)
    }
    return payload as Record<string, unknown>
  }

  /** 将共识提案应用到图引擎状态机 */
  private async _applyToStateMachine(data: Uint8Array): Promise<void> {
    const text = Buffer.from(data).toString()
    let op: RaftOperation
    try {
      op = JSON.parse(text)
    } catch {
      return
    }

    if (op.hlcTimestamp) {
      this.clock.update(op.hlcTimestamp)
    }

    try {
      let result: unknown = undefined
      switch (op.type) {
        case 'upsert_node': {
          const p = this._validatePayload(op.payload)
          result = this.engine.upsertNode(p.typeId as number, p.name as string, p.opts as any)
          break
        }
        case 'upsert_edge': {
          const p = this._validatePayload(op.payload)
          this.engine.upsertEdge(p.src as number, p.dst as number, p.typeId as number, p.opts as any)
          break
        }
        case 'delete_node': {
          const p = this._validatePayload(op.payload)
          this.engine.deleteNode(p.id as number, false, (p as any).cascade === true)
          break
        }
        case 'delete_edge': {
          const p = this._validatePayload(op.payload)
          this.engine.deleteEdge(p.src as number, p.dst as number, p.typeId as number)
          break
        }
        case 'batch_upsert': {
          const p = this._validatePayload(op.payload)
          result = this.engine.batchUpsertNodes(p.inputs as any)
          break
        }
        case 'batch_edge': {
          const p = this._validatePayload(op.payload)
          const inputs = p.inputs as Array<{ src: number; dst: number; typeId: number; opts?: any }>
          for (const input of inputs) {
            this.engine.upsertEdge(input.src, input.dst, input.typeId, input.opts)
          }
          break
        }
        case 'admin': {
          const p = this._validatePayload(op.payload)
          if (p.command === 'compact') this.engine.compact()
          break
        }

        // ── 乐观锁操作 ──────────────────────────
        case 'optimistic_upsert_node': {
          const p = this._validatePayload(op.payload)
          const resourceKey = (p.__optimisticResourceKey ?? p.name) as string
          const expected = op.expectedVersion as number ?? 0
          const actual = this._versionStore.get(resourceKey) ?? 0

          if (expected !== actual) {
            throw new RangeInstance.OptimisticLockError(resourceKey, expected, actual)
          }

          // 版本匹配，执行写入
          result = this.engine.upsertNode(p.typeId as number, p.name as string, p.opts as any)
          // 更新版本号
          const newVersion = actual + 1
          this._versionStore.set(resourceKey, newVersion)
          result = newVersion
          break
        }
        case 'optimistic_upsert_edge': {
          const p = this._validatePayload(op.payload)
          // 使用注入的 resourceKey（优先），否则 fallback
          const resourceKey = (p.__optimisticResourceKey ?? `${p.src}:${p.dst}:${p.typeId}`) as string
          const expected = op.expectedVersion as number ?? 0
          const actual = this._versionStore.get(resourceKey) ?? 0

          if (expected !== actual) {
            throw new RangeInstance.OptimisticLockError(resourceKey, expected, actual)
          }

          // 版本匹配，执行写入
          this.engine.upsertEdge(p.src as number, p.dst as number, p.typeId as number, p.opts as any)
          const newVersion = actual + 1
          this._versionStore.set(resourceKey, newVersion)
          result = newVersion
          break
        }

        // ── Snapshot 批量导入 ──────────────────────
        case 'install_snapshot': {
          const p = this._validatePayload(op.payload)
          const snapshotBase64 = p.snapshotData as string
          if (!snapshotBase64) {
            throw new Error('install_snapshot: missing snapshotData in payload')
          }
          const snapshotBuffer = Buffer.from(snapshotBase64, 'base64')
          this.engine.importSnapshot(snapshotBuffer)
          break
        }
      }

      if (op.id && this.applyResolvers.has(op.id)) {
        this.applyResolvers.get(op.id)!.resolve(result)
        this.applyResolvers.delete(op.id)
      }
    } catch (err) {
      if (op.id && this.applyResolvers.has(op.id)) {
        this.applyResolvers.get(op.id)!.reject(err as Error)
        this.applyResolvers.delete(op.id)
      }
      this.logger.error('[RangeInstance] State machine apply error:', err as Error)
    }
  }
}
