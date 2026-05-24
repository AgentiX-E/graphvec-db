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
    const cp = consensus ?? new (require('../consensus/standalone-consensus').StandaloneConsensus)({
      nodeId: config.raftConfig.nodeId,
      mode: 'standalone',
    })
    cp.setApply!(async (data: Uint8Array) => {
      await this._applyToStateMachine(data)
    })
    this.consensus = cp
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

  /** 线性一致读 — draining 不影响读取 */
  async read<T>(reader: (engine: GraphEngine) => T): Promise<T> {
    return this.telemetry.traceAsync('raft.read', async () => {
      await this.consensus.readIndex()
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
        case 'delete_node':
          this.engine.deleteNode(this._validatePayload(op.payload).id as number)
          break
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
