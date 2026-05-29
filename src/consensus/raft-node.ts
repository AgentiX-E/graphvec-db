import { RaftCore } from './raft-core'
import { MockTransport, Transport } from './transport'
import { GraphEngine } from '../core/graph-engine'
import { HlcClock } from '../replication/hlc-clock'
import { RaftNodeConfig, RaftOperation, RaftStatus } from '../types'
import { v4 as uuid } from 'uuid'
import { Logger } from '../ops/logger'
import { TimerProvider } from './mock-timer'
import { Telemetry } from '../ops/otel'
import { MetricsCollector } from '../ops/otel-metrics'

/**
 * RaftNode — 固定的 Raft 共识节点
 *
 * 没有 mode 概念，没有环境变量，没有插件化
 * 使用 RaftCore 作为固化共识实现
 * 默认使用 MockTransport（进程内测试），通过 transport 参数传入生产级实现切换
 */
export class RaftNode {
  private raft: RaftCore
  private engine: GraphEngine
  private clock: HlcClock
  private _started = false
  private logger: Logger
  private applyResolvers: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }> = new Map()
  private telemetry: Telemetry
  private metrics: MetricsCollector

  constructor(
    config: RaftNodeConfig,
    engine: GraphEngine,
    clock: HlcClock,
    timerProvider?: TimerProvider,
    /** 传入已有 transport 实例用于测试；默认创建 MockTransport */
    transport?: Transport,
  ) {
    this.engine = engine
    this.clock = clock
    this.logger = new Logger('RaftNode')
    this.telemetry = Telemetry.getInstance()
    this.metrics = MetricsCollector.getInstance()

    // 确定 transport：默认 MockTransport（进程内测试），由外部注入生产级实现
    const actualTransport = transport ?? new MockTransport(config.nodeId)

    // 创建 WAL 路径
    const walPath = `${config.storagePath}/wal-${config.nodeId}.bin`

    // 创建 RaftCore
    this.raft = new RaftCore(
      {
        nodeId: config.nodeId,
        peers: config.peers.map(p => p.id),
        walPath,
        electionTimeoutMs: config.electionTimeoutMinMs ?? 150,
        heartbeatIntervalMs: config.heartbeatIntervalMs ?? 50,
      },
      actualTransport,
      timerProvider,
    )

    // 设置 state machine apply 回调
    this.raft.setApply(async (data: Uint8Array) => {
      await this._applyToStateMachine(data)
    })
  }

  get engine_(): GraphEngine {
    return this.engine
  }

  get isStarted(): boolean {
    return this._started
  }

  /** 启动 */
  async start(): Promise<void> {
    this.engine.open()
    await this.raft.start()
    this._started = true
  }

  /** 停止 */
  async stop(): Promise<void> {
    if (!this._started) return
    await this.raft.stop()
    this.engine.close()
    this._started = false
  }

  /** 通过 Raft 共识写入 */
  async write(operation: Omit<RaftOperation, 'id'>): Promise<unknown> {
    return this.telemetry.traceAsync('raft.write', async () => {
      const op: RaftOperation = {
        ...operation,
        id: uuid(),
        hlcTimestamp: this.clock.now().toBytes(),
      }

      const data = Buffer.from(JSON.stringify(op))

      // Capture the current term as the "epoch" for this write
      const epoch = this.raft.getTerm()

      // 先注册 promise，再 propose — 避免竞态
      const promise = new Promise<unknown>((resolve, reject) => {
        this.applyResolvers.set(op.id, { resolve, reject })
      })

      const result = await this.raft.propose(data)
      if (!result.ok) {
        this.applyResolvers.delete(op.id)
        throw new Error('Raft proposal failed')
      }

      // Validate epoch hasn't changed — prevents stale leader writes
      this._assertEpoch(epoch)

      this.metrics.incrementCounter('graph.ops.writes')
      this.metrics.incrementCounter('graph.raft.proposals')

      return promise
    })
  }

  /** 线性一致读 */
  async read<T>(reader: (engine: GraphEngine) => T): Promise<T> {
    return this.telemetry.traceAsync('raft.read', async () => {
      const epoch = this.raft.getTerm()
      await this.raft.readIndex()
      this._assertEpoch(epoch)
      const result = reader(this.engine)
      this.metrics.incrementCounter('graph.ops.reads')
      return result
    })
  }

  /** Barrier — validates epoch before and after */
  async barrier(): Promise<void> {
    const epoch = this.raft.getTerm()
    await this.write({ type: 'admin', payload: { command: 'barrier' } })
    this._assertEpoch(epoch)
  }
  getStatus(): RaftStatus {
    return {
      role: this.raft.getRole(),
      leaderId: this.raft.getLeaderId(),
      term: this.raft.getTerm(),
      committed: 0,
      applied: 0,
      lastIndex: 0,
      snapshotIndex: 0,
    }
  }

  /**
   * Assert that the current Raft term matches the expected epoch.
   * Throws if terms differ — indicates leader/term changed during
   * the operation, which means we should not proceed.
   *
   * This consolidates the "ensure current epoch" pattern used in
   * various operations to prevent stale-leader writes.
   */
  private _assertEpoch(expectedEpoch: number): void {
    const currentTerm = this.raft.getTerm()
    if (currentTerm !== expectedEpoch) {
      throw new Error(
        `Epoch mismatch: current term ${currentTerm} !== expected ${expectedEpoch}. ` +
        `Leader may have changed.`
      )
    }
  }

  /** 等待成为 Leader */
  async waitForLeader(timeoutMs?: number): Promise<void> {
    await this.raft.waitForLeader(timeoutMs)
  }

  /**
   * 校验并规范化 op 的 payload
   * 确保 payload 不为 null/undefined，并有必要的字段
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

      // 通过 op.id 解析到对应的 write() promise
      if (op.id && this.applyResolvers.has(op.id)) {
        this.applyResolvers.get(op.id)!.resolve(result)
        this.applyResolvers.delete(op.id)
      }
    } catch (err) {
      if (op.id && this.applyResolvers.has(op.id)) {
        this.applyResolvers.get(op.id)!.reject(err as Error)
        this.applyResolvers.delete(op.id)
      }
      this.logger.error('[RaftNode] State machine apply error:', err as Error)
    }
  }
}
