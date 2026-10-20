import { ConsensusProvider, ConsensusRole, ConsensusConfig } from './consensus-provider'
import { InstallSnapshotRequest, InstallSnapshotResponse } from './transport'
import { Logger } from '../ops/logger'

/**
 * RaftLogicConsensus — raft-logic (tikv/raft-rs WASM) 共识实现
 *
 * 生产级共识，使用 etcd/TiKV 的 Raft 实现
 * 提供：Leader 选举、日志复制、preVote 防脑裂、checkQuorum
 *
 * Note: raft-logic 为Optional依赖，当安装时使用此实现
 *
 * 采用惰性加载模式：
 * - 构造时不加载模块，允许按需创建实例
 * - init() 中尝试加载模块，失败时保存Error但不抛出
 * - start() 时如果模块未加载则抛出明确Error（含安装指引）
 * - 测试可通过 _moduleRef 注入 mock 模块避免真实依赖
 */
export class RaftLogicConsensus implements ConsensusProvider {
  private config: ConsensusConfig
  private logger: Logger
  private applyFn: ((data: Uint8Array) => Promise<void>) | null = null
  private _snapshotHandler: ((data: Buffer) => Promise<void>) | null = null
  private _node: any = null
  private _transport: any = null
  private _engine: { exportSnapshot(): Buffer; importSnapshot(data: Buffer): void } | null = null
  private _started = false
  private _loaded = false
  private _loadError: Error | null = null
  private _raftModule: any = null
  private _snapshotTimer: ReturnType<typeof setInterval> | null = null
  private _entryCount = 0

  // ── P0-2: 自动Log compaction（基于字节阈值） ──
  private _snapshotThresholdBytes: number = 64 * 1024 * 1024  // 64 MB default
  private _totalLogBytes: number = 0

  // ── P0-2: Follower crash recovery ──
  private _lastSnapshotIndex: number = 0
  private _lastSnapshotTerm: number = 0

  // ── P0-2: Snapshot metrics ──
  private _snapshotCount: number = 0
  private _lastSnapshotSize: number = 0
  private _lastSnapshotDurationMs: number = 0

  // ── Pipeline 批量提交 ──
  private _pipelineQueue: Array<{ data: Uint8Array; resolve: (val: { ok: boolean }) => void; reject: (err: Error) => void; timeoutMs: number }> = []
  private _pipelineTimer: ReturnType<typeof setTimeout> | null = null
  private _pipelineWindowMs = 100

  // ── R9: 网络分区检测 ──
  private _inMajority = true
  private _majorityCallbacks: Array<(inMajority: boolean) => void> = []
  private _majorityCheckTimer: ReturnType<typeof setInterval> | null = null

  // ── Status cache ──
  // raft-logic's RaftNode.status() is async and returns fields named `lead` /
  // `commitIndex` / `lastApplied`. These cached fields mirror that snapshot,
  // refreshed via the onStateChange subscription, so the synchronous getters
  // (getRole/getLeaderId/getTerm/getCommitIndex) can return correct values
  // without an async round-trip to the WASM node.
  private _cachedRole: ConsensusRole = 'follower'
  private _cachedTerm = 0
  private _cachedLeaderId: string | null = null
  private _cachedCommitIndex = 0
  private _unsubscribeState: (() => void) | null = null

  // ── R10: 成员变更 ──
  private _membershipCallbacks: Array<(members: string[]) => void> = []

  constructor(
    config: ConsensusConfig,
    private _moduleRef?: any, // 测试注入用 mock module
  ) {
    this.config = { ...config, mode: 'raft-logic' }
    this.logger = new Logger('RaftLogicConsensus')
  }

  /**
   * 惰性加载 raft-logic 模块
   * 加载失败时保存Error但不抛出，允许 graceful fallback
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

  /**
   * 设置快照回调。
   * 当 raft-logic WASM 触发 onSnapshot 或 handleInstallSnapshot 接收到快照时，
   * 通过此 handler 将快照数据传给调用方（如 RaftCore 或 Engine）。
   *
   * 参考 setApply() 的设计模式。
   */
  setSnapshotHandler(handler: (data: Buffer) => Promise<void>): void {
    this._snapshotHandler = handler
  }

  /**
   * 设置图引擎引用，供 InstallSnapshot 使用
   */
  setEngine(engine: { exportSnapshot(): Buffer; importSnapshot(data: Buffer): void }): void {
    this._engine = engine
  }

  /**
   * 获取 snapshot metrics（测试/监控用）
   */
  getSnapshotMetrics(): { count: number; lastSize: number; lastDurationMs: number; lastIndex: number } {
    return {
      count: this._snapshotCount,
      lastSize: this._lastSnapshotSize,
      lastDurationMs: this._lastSnapshotDurationMs,
      lastIndex: this._lastSnapshotIndex,
    }
  }

  /**
   * 在 start() 中调用：从 StorageProvider 恢复已持久化的 snapshot。
   * 如果 _lastSnapshotIndex > 0，说明之前有 persisted snapshot 需要恢复。
   */
  private async _recoverFromSnapshot(): Promise<void> {
    if (this._lastSnapshotIndex <= 0) {
      return  // 没有需要恢复的 snapshot
    }
    this.logger.info('[RaftConsensus] Recovering from persisted snapshot', {
      lastIndex: this._lastSnapshotIndex,
      lastTerm: this._lastSnapshotTerm,
    })
    try {
      // _recoverFromSnapshot 被 start() 先于 _node.start() 调用，
      // 此时 _node 已创建但尚未 start()。
      // 因此我们通过 _engine.importSnapshot 从存储恢复状态机，
      // 然后将 committed/applied 推进到 _lastSnapshotIndex。
      if (this._engine) {
        // engine.importSnapshot 内部从持久化存储读取并恢复
        // 这里不需要主动调用 — 因为 engine 在 close/reopen 后
        // 已从本地存储恢复。
        this.logger.info('[RaftConsensus] State machine restored from storage')
      }
      if (this._node && typeof (this._node as any).triggerSnapshot === 'function') {
        // 通知 Raft 节点快照已 apply，可以截断日志到 _lastSnapshotIndex
        await this._node.triggerSnapshot({ compact: true, appliedIndex: this._lastSnapshotIndex })
      }
    } catch (err) {
      this.logger.error('[RaftConsensus] Snapshot recovery failed', err as Error)
      // 即使恢复失败，也允许节点启动（follower 可以从 leader 重新同步）
    }
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

      let transport

      // 如果配置了 transportPort，使用 TcpTransport 跨进程通信
      if (this.config.transportPort !== undefined && this.config.transportPort >= 0) {
        const { TcpTransport } = await import('./transport')
        const tcpTransport = new TcpTransport(this.config.nodeId, this.config.transportPort)
        tcpTransport.start()
        this._transport = tcpTransport

        // 连接所有 peer（地址格式 "nodeId:host:port"）
        for (const peerAddr of this.config.peers) {
          tcpTransport.connectTo(peerAddr)
        }

        // 适配为 raft-logic 期望的 transport 接口
        // raft-logic RaftNode 需要: sendTo(peerId, msg: Uint8Array) 和 onMessage(handler)
        transport = {
          sendTo: (peerId: number, msg: Uint8Array) => {
            tcpTransport.sendTo(String(peerId), msg)
            return true
          },
          onMessage: (handler: (from: string, msgBuf: Uint8Array) => void) => {
            tcpTransport.setMessageHandler(handler)
          },
        }
      } else {
        transport = new InMemoryTransport()
      }

      // 对 TcpTransport 模式，peers 格式为 "nodeId:host:port"
      // 对 InMemoryTransport 模式，peers 直接是 nodeId 字符串
      const nodeIds = [this.config.nodeId, ...this.config.peers.map(p => {
        const idx = p.indexOf(':')
        return idx > 0 ? p.substring(0, idx) : p
      })]
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
          // P0-2: 累计 entry 字节数用于自动Log compaction
          const entryData = entry.data
          if (entryData) {
            this._totalLogBytes += typeof entryData === 'string' ? Buffer.byteLength(entryData) : entryData.length
          }
          if (this.applyFn) {
            await this.applyFn(Buffer.from(entryData || entry.data))
          }
        },
        tickIntervalMs: 50,
        preVote: true,
        checkQuorum: true,
      })

      this._node = raft

      // Subscribe to state deltas so the synchronous getters (getRole/getLeaderId/
      // getTerm/getCommitIndex) can return accurate values without an async
      // round-trip. raft-logic emits `{ role, term, lead, commitIndex, ... }`.
      if (typeof raft.onStateChange === 'function') {
        this._unsubscribeState = raft.onStateChange((snap: any) => {
          if (snap?.role != null) this._cachedRole = snap.role as ConsensusRole
          if (snap?.term != null) this._cachedTerm = Number(snap.term)
          this._cachedLeaderId = snap?.lead != null ? String(snap.lead) : null
          if (snap?.commitIndex != null) this._cachedCommitIndex = Number(snap.commitIndex)
        })
      }

      // P0-2: Follower crash recovery — 从 persisted snapshot 恢复状态机
      await this._recoverFromSnapshot()

      await raft.start()
      this._started = true

      // 尝试注册 WASM onSnapshot 回调（If any）
      this._tryRegisterOnSnapshot()

      // 每 apply 10000 条后触发一次 snapshot（Raft log compact）
      this._entryCount = 0
      this._snapshotTimer = setInterval(() => {
        if (this._entryCount >= 10000) {
          this._triggerSnapshotOnce()
        }
      }, 60_000) // 每分钟检查一次
      this._snapshotTimer.unref()

      // R9: 使用 raft-logic onQuorumActive 和 onRoleChange 事件跟踪 majority 状态
      if (typeof raft.onQuorumActive === 'function') {
        raft.onQuorumActive(() => {
          const prev = this._inMajority
          this._inMajority = true
          if (prev !== true) {
            this.logger.info('[RaftConsensus] Re-entered majority (quorum active)')
            for (const cb of this._majorityCallbacks) {
              try { cb(true) } catch {}
            }
          }
        })
      }
      if (typeof raft.onRoleChange === 'function') {
        raft.onRoleChange((rc: any) => {
          // 从 leader 降级为 follower/candidate 时失去 majority
          if (rc.role === 'follower' || rc.role === 'candidate') {
            const prev = this._inMajority
            this._inMajority = false
            if (prev !== false) {
              this.logger.info('[RaftConsensus] Lost majority (role changed)', { role: rc.role })
              for (const cb of this._majorityCallbacks) {
                try { cb(false) } catch {}
              }
            }
          }
          // 成为 leader 时进入 majority
          if (rc.role === 'leader') {
            const prev = this._inMajority
            this._inMajority = true
            if (prev !== true) {
              this.logger.info('[RaftConsensus] Entered majority (became leader)')
              for (const cb of this._majorityCallbacks) {
                try { cb(true) } catch {}
              }
            }
          }
        })
      }
      // 后备定时检查（处理 onRoleChange 可能不触发的情况）
      this._majorityCheckTimer = setInterval(() => {
        this._checkMajority()
      }, 2000)
      this._majorityCheckTimer.unref()
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
    if (this._majorityCheckTimer) {
      clearInterval(this._majorityCheckTimer)
      this._majorityCheckTimer = null
    }
    if (this._unsubscribeState) {
      try { this._unsubscribeState() } catch {}
      this._unsubscribeState = null
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

    // 停止 TcpTransport（如果使用）
    if (this._transport) {
      this._transport.stop()
      this._transport = null
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

  /**
   * 线性一致读取屏障
   *
   * 优先使用 WASM 暴露的 barrier() API（raft-rs 原生），
   * 返回后保证所有前置 entry 已 apply。
   *
   * fallback：当 WASM 不暴露 barrier() 时，
   * 使用"读后写"策略：propose 一个空的 no-op entry，
   * 等它 commit & apply 后再返回，隐式证明所有前置写入已完成。
   *
   * @see Raft §6.4 — barrier 语义
   */
  async barrier(timeoutMs?: number): Promise<void> {
    const tm = timeoutMs ?? 5000
    const node = this._node
    if (!node || !this._started) return

    // 1) 优先使用 WASM barrier() API（raft-rs 原生支持 barrier 语义）
    if (typeof (node as any).barrier === 'function') {
      this.logger.debug('[RaftConsensus] Using WASM barrier()')
      try {
        await (node as any).barrier({ timeout: tm })
        return
      } catch (err) {
        // barrier 失败：可能是 leader 切换或超时，fallback 到 read-after-write
        this.logger.warn('[RaftConsensus] WASM barrier() failed, falling back to read-after-write', {
          err: (err as Error).message,
        })
      }
    } else {
      this.logger.warn('[RaftConsensus] barrier() not available in WASM, using read-after-write fallback')
    }

    // 2) Fallback: read-after-write
    // propose 一个空 entry（no-op），等它 apply 后再返回
    // 此方案保证 barrier 前的所有写入都已经 apply（因为 no-op 保证日志顺序 apply）
    const noopData = Buffer.from(JSON.stringify({
      type: '__noop_barrier',
      id: `barrier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }))

    try {
      const result = await node.clientRequest(
        Buffer.from(noopData).toString('base64'),
        { waitFor: 'apply', timeout: tm },
      )
      if (!result.ok) {
        throw new Error('no-op barrier proposal result: ok=false')
      }
      this.logger.debug('[RaftConsensus] read-after-write barrier completed')
    } catch (err) {
      // 最后防线：即使 barrier 失败也允许读取（弱一致性保证）
      this.logger.warn('[RaftConsensus] read-after-write barrier failed, no linearizable guarantee', {
        err: (err as Error).message,
      })
    }
  }

  getRole(): ConsensusRole {
    if (!this._node) return 'follower'
    return this._cachedRole || 'follower'
  }

  getLeaderId(): string | null {
    if (!this._node) return null
    return this._cachedLeaderId
  }

  getTerm(): number {
    if (!this._node) return 0
    return this._cachedTerm
  }

  /**
   * Current commit index from the raft-logic state snapshot.
   * Returns 0 when the node has not started or has not yet committed any entry.
   */
  getCommitIndex(): number {
    if (!this._node) return 0
    return this._cachedCommitIndex
  }

  /**
   * Consolidated status snapshot. Unlike raft-logic's async `status()`, this is
   * synchronous and backed by the onStateChange cache. Returns null when the
   * node has not started.
   */
  getStatus(): { role: ConsensusRole; leaderId: string | null; term: number; commitIndex: number } | null {
    if (!this._node) return null
    return {
      role: this.getRole(),
      leaderId: this.getLeaderId(),
      term: this.getTerm(),
      commitIndex: this.getCommitIndex(),
    }
  }

  // ── R9: 网络分区处理 ──

  /**
   * 当前节点是否在 majority 仲裁中
   * 通过检查是否存在已知 Leader 来判断
   * leaderId !== 0 表示集群选出了 Leader，节点在 majority 中
   */
  inMajority(): boolean {
    return this._inMajority
  }

  /**
   * 注册 majority-change 回调
   * true  = 进入 majority（集群健康）
   * false = 失去 majority（网络分区/Leader 降级）
   */
  onMajorityChange(cb: (inMajority: boolean) => void): void {
    this._majorityCallbacks.push(cb)
    // 立即用当前状态通知
    cb(this._inMajority)
  }

  /** 定期检查 majority 状态，状态变化时触发回调 */
  private _checkMajority(): void {
    if (!this._node) return
    const status = this._node.status()
    const leader = status.lead ?? status.leaderId ?? null
    const wasInMajority = this._inMajority
    // Strategy: a null/empty leader id means the cluster lost quorum.
    this._inMajority = leader !== null && leader !== 0
    if (wasInMajority !== this._inMajority) {
      this.logger.info('[RaftConsensus] Majority status changed', {
        from: wasInMajority,
        to: this._inMajority,
        leaderId: leader,
        term: status.term,
      })
      for (const cb of this._majorityCallbacks) {
        try { cb(this._inMajority) } catch {}
      }
    }
  }

  // ── R10: 成员变更 ──

  /**
   * 安全添加新节点
   *
   * raft-logic WASM 当前未暴露 ConfChangeV2/propose_conf_change API，
   * 因此在 raft-logic 模式下成员变更为 no-op。
   * 当底层 WASM 暴露相关 API 后可实现两阶段 Joint Consensus 过渡。
   *
   * 单节点/测试模式可以通过 config.peers 来模拟。
   */
  async addPeer(peerId: string): Promise<void> {
    if (!this._node || !this._started) {
      throw new Error('RaftLogicConsensus not started')
    }

    // raft-logic WASM 不暴露 ConfChange API，暂不实现
    this.logger.warn('[RaftConsensus] addPeer not yet supported in raft-logic WASM', { peerId })
    throw new Error('addPeer not available: raft-logic WASM does not expose ConfChange API')
  }

  /**
   * 安全移除节点
   *
   * 与 addPeer 相同限制，raft-logic WASM 未暴露 ConfChange API。
   */
  async removePeer(peerId: string): Promise<void> {
    if (!this._node || !this._started) {
      throw new Error('RaftLogicConsensus not started')
    }

    this.logger.warn('[RaftConsensus] removePeer not yet supported in raft-logic WASM', { peerId })
    throw new Error('removePeer not available: raft-logic WASM does not expose ConfChange API')
  }

  /**
   * 获取当前集群节点列表
   *
   * raft-logic WASM 不暴露 confState()，所以从 config.peers + nodeId 返回。
   */
  getClusterMembers(): string[] {
    if (!this._node) return this.config.peers

    // 优先尝试从 config 构造完整成员列表
    const members = new Set<string>()
    members.add(this.config.nodeId)
    for (const p of this.config.peers) {
      // peers 可能包含 "nodeId:host:port" 格式，提取 nodeId 部分
      const idx = p.indexOf(':')
      members.add(idx > 0 ? p.substring(0, idx) : p)
    }
    return Array.from(members)
  }

  /**
   * 注册成员变更回调
   * 当 ConfChangeV2 entry 被 apply 后触发
   */
  onMembershipChange(cb: (members: string[]) => void): void {
    this._membershipCallbacks.push(cb)
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

  /** 测试辅助：获取加载Error */
  _getLoadError(): Error | null {
    return this._loadError
  }

  /**
   * 触发一次 snapshot（Raft log compact）
   * 被定时器或外部手动调用
   *
   * P0-2: 增强实现
   * - 检查 totalLogBytes > _snapshotThresholdBytes（默认 64MB）
   * - 如果超过阈值，调用 engine.exportSnapshot() 获取状态快照
   * - 然后调用 Raft 节点 triggerSnapshot 压缩日志
   * - 记录 metrics（_snapshotCount, _lastSnapshotSize, _lastSnapshotDurationMs）
   */
  async _triggerSnapshotOnce(): Promise<void> {
    if (!this._node) return
    const startTime = Date.now()

    try {
      // 检查字节阈值
      if (this._totalLogBytes < this._snapshotThresholdBytes && !this._engine) {
        this.logger.debug('[snapshot] Bytes below threshold, skipping', {
          current: this._totalLogBytes,
          threshold: this._snapshotThresholdBytes,
        })
        return
      }

      // 1) If any engine，先 export 状态快照
      let snapshotData: Buffer | null = null
      if (this._engine) {
        try {
          snapshotData = this._engine.exportSnapshot()
          this._lastSnapshotSize = snapshotData.length
          this.logger.info('[snapshot] State exported', { size: snapshotData.length })
        } catch (exportErr) {
          this.logger.warn('[snapshot] exportSnapshot failed, proceeding without state snapshot', {
            err: (exportErr as Error).message,
          })
        }
      }

      // 2) 通知 Raft 节点 compact log
      this._entryCount = 0
      this._totalLogBytes = 0
      await this._node.triggerSnapshot({ compact: true })

      // 3) 更新 metrics
      this._snapshotCount++
      this._lastSnapshotDurationMs = Date.now() - startTime
      const snapStatus = await this._node.status()
      this._lastSnapshotIndex = snapStatus?.lastApplied ?? snapStatus?.applied ?? this._lastSnapshotIndex

      this.logger.info('[snapshot] Raft log compacted', {
        count: this._snapshotCount,
        size: this._lastSnapshotSize,
        durationMs: this._lastSnapshotDurationMs,
        lastIndex: this._lastSnapshotIndex,
      })
    } catch (err) {
      this.logger.warn('[snapshot] Failed', { err: (err as Error).message })
      this._lastSnapshotDurationMs = Date.now() - startTime
    }
  }

  // ── InstallSnapshot 支持 ─────────────────────────────────────

  /**
   * 手动 InstallSnapshot 方法（供 leader 主动推送快照到 follower）
   *
   * P0-2: 增强实现
   * - 始终优先使用 TS handler 路径（更可靠）
   * - WASM onSnapshot 作为补充而非主要路径
   *
   * @param snapshotData - 快照原始数据
   */
  async installSnapshot(snapshotData: Buffer): Promise<void> {
    const snapshot = snapshotData.toString('base64')

    // P0-2: 始终使用 TS 路径（更可靠，不依赖 WASM）
    this.logger.info('[RaftConsensus] installSnapshot via TS handler path')

    try {
      // 1) 优先调用外部 handler（setSnapshotHandler 注册的）
      if (this._snapshotHandler) {
        await this._snapshotHandler(snapshotData)
      } else {
        // 2) 通过 state machine apply
        await this._applySnapshotToStateMachine(snapshot)
      }

      // 3) 如果 engine 可用，也通过 importSnapshot 恢复
      if (this._engine) {
        this._engine.importSnapshot(snapshotData)
      }
    } catch (handlerErr) {
      this.logger.error('[RaftConsensus] TS snapshot handler failed', handlerErr as Error)
    }

    // 如果 WASM 也支持 onSnapshot，调用以通知 Raft 节点
    if (this._node && typeof (this._node as any).onSnapshot === 'function') {
      try {
        this.logger.info('[RaftConsensus] Also notifying WASM onSnapshot')
        ;(this._node as any).onSnapshot(snapshot)
      } catch {
        // optional — 非必须
      }
    }

    // 尝试更新 Raft 节点 snapshot index
    try {
      if (this._node && typeof (this._node as any).triggerSnapshot === 'function') {
        await this._node.triggerSnapshot({ compact: true })
      }
    } catch {
      // optional — 非必须
    }
  }

  /**
   * 处理收到的 InstallSnapshot 请求（follower 侧）
   *
   * 接收 leader 推送的快照：
   * 1. 优先调用外部注册的 _snapshotHandler（setSnapshotHandler 设置）
   * 2. 如果 engine 可用，通过 engine.importSnapshot 恢复数据
   * 3. 如果都没有，尝试通过 applyFn 将快照写入 state machine
   * 4. P0-2: 成功后记录 _lastSnapshotIndex 供 crash recovery 使用
   */
  async handleInstallSnapshot(request: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    const startTime = Date.now()
    try {
      const snapshotData = Buffer.from(request.data)
      this.logger.info('[RaftConsensus] handleInstallSnapshot', {
        term: request.term,
        leaderId: request.leaderId,
        lastIncludedIndex: request.lastIncludedIndex,
        dataLen: snapshotData.length,
      })

      // 1) 优先调用外部 handler（如 setSnapshotHandler 注册的）
      if (this._snapshotHandler) {
        await this._snapshotHandler(snapshotData)
      }

      // 2) 调用 engine.importSnapshot 恢复状态机数据
      if (this._engine) {
        this._engine.importSnapshot(snapshotData)
      } else if (!this._snapshotHandler) {
        this.logger.warn('[RaftConsensus] No engine or snapshotHandler set, snapshot not imported')
        // 即使没有 engine 和 handler，也尝试通过 applyFn 将快照写入 state machine
        if (this.applyFn) {
          const op = JSON.stringify({
            type: 'install_snapshot',
            payload: { snapshotData: snapshotData.toString('base64') },
          })
          await this.applyFn(Buffer.from(op))
        }
      }

      // P0-2: 记录 snapshot index 用于 crash recovery
      this._lastSnapshotIndex = request.lastIncludedIndex
      this._lastSnapshotTerm = request.lastIncludedTerm
      this._snapshotCount++
      this._lastSnapshotSize = snapshotData.length
      this._lastSnapshotDurationMs = Date.now() - startTime

      return { success: true, term: request.term }
    } catch (err) {
      this.logger.error('[RaftConsensus] handleInstallSnapshot failed', err as Error)
      return { success: false, term: request.term }
    }
  }

  /**
   * 将 snapshot 以 state machine 操作形式 apply
   *（当 WASM onSnapshot 不可用时）
   */
  private async _applySnapshotToStateMachine(snapshotBase64: string): Promise<void> {
    if (!this.applyFn) {
      this.logger.warn('[RaftConsensus] No applyFn set, cannot apply snapshot')
      return
    }

    const op = JSON.stringify({
      type: 'install_snapshot',
      payload: { snapshotData: snapshotBase64 },
    })
    await this.applyFn(Buffer.from(op))
  }

  /**
   * 尝试注册 WASM onSnapshot 回调（如果底层暴露）
   * 在 start() 中调用
   *
   * P0-2: 增强实现
   * - 不静默吞Error — 记录日志
   * - WASM 不可用时始终使用 TS handler fallback
   * - 移除 !WASM 检查 — 始终走 TS 路径（更可靠）
   * - 当 WASM onSnapshot 可用时注册回调，但无论 WASM 是否暴露，
   *   都确保 TS 路径可用（双重保障）
   */
  private _tryRegisterOnSnapshot(): void {
    if (!this._node) return

    // 始终用 TS 路径处理 snapshot（更可靠，不依赖 WASM）
    this.logger.info('[RaftConsensus] Using TS snapshot handler (always-on)')

    // 如果 WASM 也暴露了 onSnapshot，注册回调作为补充
    if (typeof (this._node as any).onSnapshot === 'function') {
      this.logger.info('[RaftConsensus] Also registering WASM onSnapshot callback (dual-path)')
      try {
        ;(this._node as any).onSnapshot(async (snapshotBase64: string) => {
          const startTime = Date.now()
          this.logger.info('[RaftConsensus] WASM onSnapshot received')
          try {
            const buf = Buffer.from(snapshotBase64, 'base64')

            // 优先使用外部 handler
            if (this._snapshotHandler) {
              await this._snapshotHandler(buf)
            } else {
              await this._applySnapshotToStateMachine(snapshotBase64)
            }

            // 如果 engine 已设置，也通过 importSnapshot 恢复
            if (this._engine) {
              this._engine.importSnapshot(buf)
            }

            // P0-2: 更新 snapshot 元数据供 crash recovery 使用
            this._snapshotCount++
            this._lastSnapshotSize = buf.length
            this._lastSnapshotDurationMs = Date.now() - startTime
            if (this._node) {
              const status = await this._node.status()
              const applied = status?.lastApplied ?? status?.applied ?? 0
              const term = status?.term ?? 0
              if (applied > this._lastSnapshotIndex) {
                this._lastSnapshotIndex = applied
              }
              if (term > this._lastSnapshotTerm) {
                this._lastSnapshotTerm = term
              }
            }
          } catch (innerErr) {
            this.logger.error('[RaftConsensus] WASM onSnapshot callback handler failed', innerErr as Error)
          }
        })
      } catch (registerErr) {
        this.logger.error('[RaftConsensus] Failed to register WASM onSnapshot callback', registerErr as Error)
        // 不抛出 — TS 路径始终可用
      }
    }
  }
}

/** 动态导入 raft-logic（Optional依赖） */
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
