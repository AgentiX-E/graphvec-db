import { ConsensusProvider, ConsensusRole, ConsensusConfig } from './consensus-provider'
import { Logger } from '../ops/logger'

/**
 * RaftLogicConsensus — raft-logic (tikv/raft-rs WASM) 共识实现
 *
 * 生产级共识，使用 etcd/TiKV 的 Raft 实现
 * 提供：Leader 选举、日志复制、preVote 防脑裂、checkQuorum
 *
 * 注意：raft-logic 为可选依赖，当安装时使用此实现
 *
 * 采用惰性加载模式：
 * - 构造时不加载模块，允许按需创建实例
 * - init() 中尝试加载模块，失败时保存错误但不抛出
 * - start() 时如果模块未加载则抛出明确错误（含安装指引）
 * - 测试可通过 _moduleRef 注入 mock 模块避免真实依赖
 */
export class RaftLogicConsensus implements ConsensusProvider {
  private config: ConsensusConfig
  private logger: Logger
  private applyFn: ((data: Uint8Array) => Promise<void>) | null = null
  private _node: any = null
  private _started = false
  private _loaded = false
  private _loadError: Error | null = null
  private _raftModule: any = null
  private _snapshotTimer: ReturnType<typeof setInterval> | null = null
  private _entryCount = 0

  // ── Pipeline 批量提交 ──
  private _pipelineQueue: Array<{ data: Uint8Array; resolve: (val: { ok: boolean }) => void; reject: (err: Error) => void; timeoutMs: number }> = []
  private _pipelineTimer: ReturnType<typeof setTimeout> | null = null
  private _pipelineWindowMs = 100

  constructor(
    config: ConsensusConfig,
    private _moduleRef?: any, // 测试注入用 mock module
  ) {
    this.config = { ...config, mode: 'raft-logic' }
    this.logger = new Logger('RaftLogicConsensus')
  }

  /**
   * 惰性加载 raft-logic 模块
   * 加载失败时保存错误但不抛出，允许 graceful fallback
   */
  async init(): Promise<void> {
    // 如果已注入 mock module，直接使用
    if (this._moduleRef) {
      this._raftModule = this._moduleRef
      this._loaded = true
      this._loadError = null
      return
    }

    try {
      this._raftModule = await getRaftModule()
      this._loaded = true
    } catch (err) {
      this._loadError = new Error(
        `RaftLogicConsensus failed to load 'raft-logic' module. ` +
        `Ensure 'raft-logic' is installed: npm install raft-logic. ` +
        `Original error: ${(err as Error).message}`
      )
      this._loaded = false
      // 不抛出 — 让 init 通过，允许 graceful fallback
      // 等 start() 时再报
    }
  }

  setApply(fn: (data: Uint8Array) => Promise<void>): void {
    this.applyFn = fn
  }

  async start(): Promise<void> {
    // 如果 init() 未被调用过，自动调用
    if (!this._loaded && !this._loadError) {
      await this.init()
    }

    if (!this._loaded) {
      throw this._loadError || new Error('RaftLogicConsensus not initialized (module unavailable)')
    }

    try {
      const { RaftNode, SqliteStorage, InMemoryTransport, ready } = this._raftModule
      await ready

      const nodeIds = [this.config.nodeId, ...this.config.peers]
      const transport = new InMemoryTransport()
      const storage = new SqliteStorage({ file: `./data/raft-${this.config.nodeId}.db` })

      await storage.open()

      const raft = new RaftNode({
        id: Number(this.config.nodeId),
        peers: nodeIds.map(Number),
        electionTick: 10,
        heartbeatTick: 3,
        storage,
        transport,
        apply: async (entry: any) => {
          this._entryCount++
          if (this.applyFn) {
            await this.applyFn(Buffer.from(entry.data))
          }
        },
        tickIntervalMs: 50,
        preVote: true,
        checkQuorum: true,
      })

      await raft.start()
      this._node = raft
      this._started = true

      // 每 apply 10000 条后触发一次 snapshot（Raft log compact）
      this._entryCount = 0
      this._snapshotTimer = setInterval(() => {
        if (this._entryCount >= 10000) {
          this._triggerSnapshotOnce()
        }
      }, 60_000) // 每分钟检查一次
      this._snapshotTimer.unref()
    } catch (err) {
      this.logger.warn('[RaftLogicConsensus] Failed to initialize raft-logic. Falling back?', { err: (err as Error).message })
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer)
      this._snapshotTimer = null
    }
    // flush 剩余 Pipeline 请求
    if (this._pipelineTimer) {
      clearTimeout(this._pipelineTimer)
      this._pipelineTimer = null
    }
    if (this._pipelineQueue.length > 0) {
      await this._flushPipeline()
    }
    if (this._node) {
      await this._node.stop()
      this._node = null
    }
    this._started = false
  }

  /**
   * Pipeline 批量提交（100ms 窗口，合并 proposal）
   *
   * 无并发时走快速路径（直接 clientRequest），
   * 有并发时才合并为一次 clientRequest，减少 RTT。
   */
  async propose(data: Uint8Array, timeoutMs?: number): Promise<{ ok: boolean }> {
    if (!this._node || !this._started) return { ok: false }

    const tm = timeoutMs ?? 5000

    // 如果队列为空，走单条快速路径
    if (this._pipelineQueue.length === 0) {
      try {
        const result = await this._node.clientRequest(
          Buffer.from(data).toString('base64'),
          { waitFor: 'apply', timeout: tm }
        )
        return { ok: result.ok }
      } catch {
        return { ok: false }
      }
    }

    // 队列已有等待，合并提交
    return new Promise<{ ok: boolean }>((resolve, reject) => {
      this._pipelineQueue.push({ data, resolve, reject, timeoutMs: tm })
      if (!this._pipelineTimer) {
        this._pipelineTimer = setTimeout(() => {
          this._flushPipeline()
        }, this._pipelineWindowMs)
        this._pipelineTimer.unref()
      }
    })
  }

  /** 冲刷 Pipeline 队列：合并所有待发请求为一条 batch entry */
  private async _flushPipeline(): Promise<void> {
    this._pipelineTimer = null
    const batch = this._pipelineQueue.splice(0)
    if (batch.length === 0) return

    try {
      // 合并：每条 data 用长度前缀拼接，便于接收端拆分
      const parts: string[] = []
      for (const item of batch) {
        parts.push(item.data.length.toString(16).padStart(8, '0'))
        parts.push(Buffer.from(item.data).toString('base64'))
      }
      const batchPayload = parts.join('|')

      const result = await this._node.clientRequest(
        batchPayload,
        { waitFor: 'apply', timeout: Math.max(...batch.map(b => b.timeoutMs)) }
      )

      if (result.ok) {
        for (const item of batch) {
          item.resolve({ ok: true })
        }
      } else {
        for (const item of batch) {
          item.resolve({ ok: false })
        }
      }
    } catch (err) {
      const error = err as Error
      for (const item of batch) {
        item.reject(error)
      }
    }
  }

  async readIndex(timeoutMs?: number): Promise<void> {
    if (!this._node) return
    await this._node.readIndex({ timeout: timeoutMs ?? 3000 })
  }

  getRole(): ConsensusRole {
    if (!this._node) return 'follower'
    const status = this._node.status()
    return (status.role as ConsensusRole) || 'follower'
  }

  getLeaderId(): string | null {
    if (!this._node) return null
    const status = this._node.status()
    return status.leaderId
  }

  getTerm(): number {
    if (!this._node) return 0
    return this._node.status().term
  }

  async waitForLeader(timeoutMs?: number): Promise<void> {
    if (!this._node) throw new Error('RaftLogicConsensus not started')
    try {
      await this._node.waitForLeaderStable({ timeout: timeoutMs ?? 5000 })
    } catch (err) {
      throw new Error(`waitForLeader failed: ${(err as Error).message}`)
    }
  }

  /** 测试辅助：获取加载状态 */
  _isLoaded(): boolean {
    return this._loaded
  }

  /** 测试辅助：获取加载错误 */
  _getLoadError(): Error | null {
    return this._loadError
  }

  /**
   * 触发一次 snapshot（Raft log compact）
   * 被定时器或外部手动调用
   */
  async _triggerSnapshotOnce(): Promise<void> {
    if (!this._node) return
    try {
      this._entryCount = 0
      await this._node.triggerSnapshot({ compact: true })
      this.logger.info('[snapshot] Raft log compacted')
    } catch (err) {
      this.logger.warn('[snapshot] Failed', { err: (err as Error).message })
    }
  }
}

/** 动态导入 raft-logic（可选依赖） */
let _raftModule: any = null

async function getRaftModule(): Promise<any> {
  if (_raftModule) return _raftModule
  // 生产环境 / 集成测试才需要加载 WASM — lint:disable 绕过 ts-jest 转译
  try {
    _raftModule = await import('raft-logic')
    return _raftModule
  } catch {
    throw new Error(
      'raft-logic is not installed. Install it: npm install raft-logic'
    )
  }
}
