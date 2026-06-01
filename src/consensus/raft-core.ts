/**
 * raft-core.ts — RaftCore 固化共识实现
 *
 * 将 Raft 共识从"可插拔组件"变为"固化的基础设施"。
 * 基于 Raft 论文 (Diego Ongaro, 2014) 实现，支持：
 *   - Leader 选举
 *   - 日志复制
 *   - 安全性
 *   - Leader 完整性保证
 *
 * 关键设计：
 *   - 使用 Transport 网络层进行节点间通信
 *   - 使用 WAL 进行日志持久化
 *   - 无 mode 概念：只有 RaftCore 一种实现
 *   - Leader 写入本节点 WAL + 广播到 followers
 */
import {
  Transport, AppendEntriesRequest, AppendEntriesResponse,
  RequestVoteRequest, RequestVoteResponse, MockTransport, RaftMessage,
  InstallSnapshotRequest, InstallSnapshotResponse,
} from './transport'
import { WAL, LogEntry } from './wal'
import { Logger } from '../ops/logger'
import * as fs from 'node:fs'
import { Telemetry } from '../ops/otel'
import { MetricsCollector } from '../ops/otel-metrics'

export type RaftRole = 'follower' | 'candidate' | 'leader'

export interface RaftCoreConfig {
  nodeId: string
  peers: string[]
  electionTimeoutMs?: number  // default 150
  heartbeatIntervalMs?: number // default 50
  walPath: string  // WAL 文件路径
  preVote?: boolean      // 启用 PreVote 前置投票
  checkQuorum?: boolean  // 启用 CheckQuorum 领导者退位
  snapshotThreshold?: number  // 达到多少条日志后触发快照（默认 10000）
  snapshotPath?: string      // 快照文件路径（默认 walPath + '.snapshot'）
}

export interface TimerProvider {
  setTimeout(cb: () => void, ms: number): number
  clearTimeout(id: number): void
  setInterval(cb: () => void, ms: number): number
  clearInterval(id: number): void
}

class RealTimer implements TimerProvider {
  setTimeout(cb: () => void, ms: number): number {
    return setTimeout(cb, ms) as unknown as number
  }
  clearTimeout(id: number): void { clearTimeout(id) }
  setInterval(cb: () => void, ms: number): number {
    return setInterval(cb, ms) as unknown as number
  }
  clearInterval(id: number): void { clearInterval(id) }
}

export class RaftCore {
  // ─── 持久化状态 ───
  private _role: RaftRole = 'follower'
  private _currentTerm: number = 0
  private _votedFor: string | null = null
  private wal: WAL

  // ─── 易失性状态 ───
  private _commitIndex: number = 0
  private _lastApplied: number = 0

  // ─── Snapshot 状态 ───
  private _lastSnapshotIndex: number = 0
  private _lastSnapshotTerm: number = 0

  // ─── 依赖 ───
  private transport: Transport
  private stateMachine: ((data: Uint8Array) => Promise<void>) | null = null
  private _onCommitFsync: (() => void) | null = null
  private config: RaftCoreConfig
  private timerProvider: TimerProvider
  private logger: Logger

  // ─── PreVote 状态 ───
  private _preVoteGranted: string[] = []  // 记录 PreVote 已同意的 peers
  private _inPreVote = false              // 是否在 PreVote 过程中
  private _preVoteTimerId: number | null = null // PreVote 超时定时器

  // ─── CheckQuorum 状态 ───
  private _connectedPeers: Set<string> = new Set()
  private _lastHeartbeatReachable: boolean = true

  // ─── Joint Consensus 状态 ───
  /** 当前集群配置版本 */
  private _configVersion: number = 0
  /** Joint Consensus 阶段：C_old_new 的额外 peers */
  private _jointPeers: string[] | null = null
  /** Joint Consensus C_old_new 阶段已确认的节点 */
  private _jointConfirmed: Set<string> = new Set()
  /** Joint Consensus 是否进入 C_new 阶段 */
  private _jointTransitionComplete: boolean = false

  // ─── 定时器 ───
  private _electionTimerId: number | null = null
  private _heartbeatTimerId: number | null = null
  private _started = false

  // ─── OTel 可观测性 ───
  private telemetry: Telemetry
  private metrics: MetricsCollector

  // ─── Leader 专用状态 ───
  private _nextIndex: Map<string, number> = new Map()
  private _matchIndex: Map<string, number> = new Map()
  /** Pipeline: 每个 follower 的 in-flight 追踪（未确认的 AppendEntries） */
  private _inFlight: Map<string, number> = new Map()
  /** Pipeline: 每个 follower 的待发送队列 */
  private _pendingQueue: Map<string, Array<{ entries: LogEntry[]; maxBatchSize: number }>> = new Map()
  /** Pipeline：批量配置 */
  static readonly MAX_BATCH_SIZE = 64
  /** Pipeline 是否激活（存在 3+ follower 时启用） */
  private _isPipelineActive = false

  constructor(
    config: RaftCoreConfig,
    transport?: Transport,
    timerProvider?: TimerProvider,
  ) {
    this.config = {
      nodeId: config.nodeId,
      peers: config.peers,
      electionTimeoutMs: config.electionTimeoutMs ?? 150,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 50,
      walPath: config.walPath,
      preVote: config.preVote ?? false,
      checkQuorum: config.checkQuorum ?? false,
      snapshotThreshold: config.snapshotThreshold ?? 10000,
      snapshotPath: config.snapshotPath ?? config.walPath + '.snapshot',
    }
    this.transport = transport ?? new MockTransport(config.nodeId)
    this.timerProvider = timerProvider ?? new RealTimer()
    this.wal = new WAL(config.walPath)
    this.logger = new Logger(`RaftCore[${config.nodeId}]`)
    this.telemetry = Telemetry.getInstance()
    this.metrics = MetricsCollector.getInstance()
  }

  // ─── 公共访问器 ──────────────────────────────────────────

  get role(): RaftRole { return this._role }
  get currentTerm(): number { return this._currentTerm }
  get votedFor(): string | null { return this._votedFor }
  get commitIndex(): number { return this._commitIndex }
  get lastApplied(): number { return this._lastApplied }
  get isStarted(): boolean { return this._started }
  get lastLogIndex(): number { return this.wal.getLastIndex() }
  get lastLogTerm(): number { return this.wal.getLastTerm() }

  setApply(fn: (data: Uint8Array) => Promise<void>): void {
    this.stateMachine = fn
  }

  /**
   * 设置 commit 完成后触发的 fsync 回调
   * Raft commit 将数据应用到状态机后，通过此回调通知外部 fsync
   * 状态机的底层存储，确保状态变更已持久化到磁盘。
   */
  setOnCommitFsync(fn: (() => void) | null): void {
    this._onCommitFsync = fn
  }

  // ─── Snapshot API ──────────────────────────────────────

  /** 手动触发快照 */
  async triggerSnapshot(): Promise<void> {
    await this._doSnapshot()
  }

  /** 获取最后一次快照包含的日志索引 */
  getLastSnapshotIndex(): number {
    return this._lastSnapshotIndex
  }

  // ─── Joint Consensus ────────────────────────────────────

  /**
   * 添加一个 peer（两阶段 Joint Consensus）
   *
   * Phase 1: C_old_new — 在集群中追加 Cold_New 配置条目
   * Phase 2: C_new — Cold_New 提交后，追加 C_new 配置条目
   */
  async addPeer(peerId: string): Promise<boolean> {
    if (this._role !== 'leader') return false
    if (this.config.peers.includes(peerId)) return true // already present
    if (this._jointPeers?.includes(peerId)) return true  // in transition

    // Phase 1: 进入 C_old_new 阶段
    const cNew = [...this.config.peers, peerId]
    this._jointPeers = cNew
    this._jointTransitionComplete = false
    this._jointConfirmed.clear()
    this._configVersion++

    // 追加 Joint Consensus 配置条目到 WAL
    const entryData = new TextEncoder().encode(JSON.stringify({
      type: 'joint_config',
      version: this._configVersion,
      cOld: this.config.peers,
      cNew: cNew,
      phase: 'C_old_new',
    }))
    await this.wal.append(this._currentTerm, entryData)

    // 通过 leader 的广播机制自动复制到所有节点
    this._broadcastAppendEntries().catch(() => {})

    this.logger.info(`[Joint] Phase 1 started: adding peer ${peerId}`, {
      cOld: this.config.peers,
      cNew,
    })

    // 等待 C_old_new 被多数确认
    await this._waitForJointCommit()

    // Phase 2: 切换到 C_new 阶段
    this._onJointConsensusCommit()

    return true
  }

  /**
   * 移除一个 peer（两阶段 Joint Consensus）
   */
  async removePeer(peerId: string): Promise<boolean> {
    if (this._role !== 'leader') return false
    if (!this.config.peers.includes(peerId)) return true // already absent
    if (this._jointPeers) return false // already in transition

    // Phase 1: 进入 C_old_new 阶段
    const cNew = this.config.peers.filter(p => p !== peerId)
    this._jointPeers = cNew
    this._jointTransitionComplete = false
    this._jointConfirmed.clear()
    this._configVersion++

    const entryData = new TextEncoder().encode(JSON.stringify({
      type: 'joint_config',
      version: this._configVersion,
      cOld: this.config.peers,
      cNew: cNew,
      phase: 'C_old_new',
    }))
    await this.wal.append(this._currentTerm, entryData)

    this._broadcastAppendEntries().catch(() => {})

    this.logger.info(`[Joint] Phase 1 started: removing peer ${peerId}`, {
      cOld: this.config.peers,
      cNew,
    })

    await this._waitForJointCommit()

    // Phase 2: 切换到 C_new
    this._onJointConsensusCommit()

    // 如果自己是被移除的节点，step down
    if (peerId === this.config.nodeId) {
      this._stepDown(this._currentTerm)
    }

    return true
  }

  /**
   * Joint Consensus 确认回调
   * 当 C_old_new 配置条目被提交时，触发 Phase 2
   */
  private _onJointConsensusCommit(): void {
    if (!this._jointPeers) return

    const cNew = this._jointPeers
    this.logger.info(`[Joint] Phase 2: transitioning to C_new`, { cNew })

    // 更新集群配置
    this.config.peers = cNew

    // 追加 C_new 配置条目
    const entryData = new TextEncoder().encode(JSON.stringify({
      type: 'joint_config',
      version: this._configVersion,
      cOld: this.config.peers,
      cNew: this.config.peers,
      phase: 'C_new',
    }))
    this.wal.append(this._currentTerm, entryData).then(() => {
      this._broadcastAppendEntries().catch(() => {})
    }).catch(() => {})

    // 清除 joint 状态
    this._jointPeers = null
    this._jointConfirmed.clear()
    this._jointTransitionComplete = true
  }

  /**
   * 等待 Joint Consensus 配置被提交
   */
  private async _waitForJointCommit(): Promise<void> {
    // 通过广播复制，等待 commitIndex 推进
    for (let i = 0; i < 50; i++) {
      if (this._jointTransitionComplete) return
      await new Promise(r => setTimeout(r, 50))
      // 检查最新追加的配置条目是否已提交
      const lastIdx = this.wal.getLastIndex()
      if (lastIdx > 0 && this._commitIndex >= lastIdx) {
        this._onJointConsensusCommit()
        return
      }
    }
  }

  // ─── 生命周期 ──────────────────────────────────────────

  async start(): Promise<void> {
    if (this._started) return

    await this.wal.open()

    // 加载快照状态
    this._loadSnapshotState()

    this.logger.info(`Started, recovered ${this.wal.readAll().length} entries from WAL`)

    this._started = true

    this.transport.onMessage((from: string, msg: RaftMessage) => {
      this._handleMessage(from, msg).catch(err => {
        this.logger.error(`Error handling message from ${from}:`, err as Error)
      })
    })

    await this.transport.start()

    // 单节点（无 peers）立即成为 leader，无需等待选举超时
    if (this.config.peers.length === 0) {
      this._becomeLeader()
    } else {
      this._resetElectionTimeout()
    }
  }

  async stop(): Promise<void> {
    this._started = false
    this._role = 'follower'
    this._clearTimers()
    await this.transport.stop()
    await this.wal.close()
  }

  // ─── 公共 API ──────────────────────────────────────────

  /**
   * 提交提案
   * - Leader：写入本节点 WAL → 并行 AppendEntries → 提交 → 应用
   * - Follower：返回 { ok: false }
   */
  async propose(data: Uint8Array): Promise<{ ok: boolean }> {
    if (!this._started) return { ok: false }
    if (this._role !== 'leader') return { ok: false }

    return this.telemetry.traceAsync('raft.propose', async () => {

    // 1. 写入本节点 WAL
    const entry = await this.wal.append(this._currentTerm, data)

    // 2. 并行广播到所有 peers，如有必要进行重试
    const maxRetries = 3
    for (let retry = 0; retry < maxRetries; retry++) {
      const responses = await Promise.all(
        this.config.peers.map(peerId =>
          this._sendAppendEntries(peerId).catch(() => null)
        )
      )

      // 3. 处理所有响应
      let allSuccess = true
      for (let i = 0; i < this.config.peers.length; i++) {
        const resp = responses[i]
        const peerId = this.config.peers[i]
        if (!resp) continue
        if (resp.success) {
          this._matchIndex.set(peerId, Math.max(
            this._matchIndex.get(peerId) ?? 0,
            resp.lastLogIndex,
          ))
          this._nextIndex.set(peerId, (this._nextIndex.get(peerId) ?? 0) + 1)
        } else {
          allSuccess = false
          // 日志不一致，回退 nextIndex
          const currentNext = this._nextIndex.get(peerId) ?? 1
          this._nextIndex.set(peerId, Math.max(1, currentNext - 1))
        }
      }

      if (allSuccess) break
    }

    // 4. 推进 commitIndex
    this._advanceCommitIndex()

    // 5. 应用到状态机
    await this._applyCommittedEntries()

    // 6. 检查是否需要触发快照
    await this._checkSnapshot()

    this.metrics.incrementCounter('graph.raft.proposals')

    return { ok: true }
    })
  }

  /**
   * 线性一致读
   * Leader 发送心跳到多数节点确认领导权后返回
   */
  async readIndex(_timeoutMs?: number): Promise<void> {
    if (this._role !== 'leader') return

    // 心跳确认领导权
    const quorum = this._majority() - 1 // 除自己外需要的确认数
    let successCount = 0

    const results = await Promise.allSettled(
      this.config.peers.map(peerId =>
        this._sendAppendEntries(peerId, true).then(resp => {
          if (resp && resp.success) successCount++
        })
      )
    )

    if (successCount < quorum) {
      this.logger.warn(`Read index: only got ${successCount}/${quorum} confirmations`)
    }
  }

  /**
   * Q05: Stale/Follower read — 检测 follower 是否可安全提供读取服务
   *
   * 原则（Raft §6.2 + §8）：
   * - Follower 可以服务读请求，前提是它已经赶上了 leader 的 commitIndex
   * - 如果 `lagSafeThreshold` 配置为 0, 则 follower 必须已完全同步（commitIndex = leaderCommitIndex）
   * - 如果配置 > 0, follower 的 commitIndex 与 leader 的差距在此范围内即可提供读
   *
   * @param leaderCommitIndex 来自 leader 的 commitIndex（从心跳中获取）
   * @param lagSafeThreshold 可接受的最大滞后量（0=完全同步，默认3）
   * @returns follower 是否可以响应读请求
   */
  canServeStaleRead(leaderCommitIndex: number, lagSafeThreshold: number = 3): boolean {
    if (this._role === 'leader') return true   // leader 始终可读
    if (this._role !== 'follower') return false // candidate 不可读

    // Follower 的已提交索引 ≥ leader 的已提交索引 - 滞后阈值
    const safe = this._commitIndex >= (leaderCommitIndex - lagSafeThreshold)
    if (!safe) {
      this.logger.debug(
        `Stale read blocked: follower commitIndex=${this._commitIndex}, ` +
        `leaderCommitIndex=${leaderCommitIndex}, threshold=${lagSafeThreshold}`
      )
    }
    return safe
  }

  /**
   * 获取当前 commit index（供外部判断 Follower read 使用）
   */
  getCommitIndex(): number {
    return this._commitIndex
  }

  // ─── 角色查询 ──────────────────────────────────────────

  getRole(): RaftRole { return this._role }
  getLeaderId(): string | null {
    return this._role === 'leader' ? this.config.nodeId : null
  }
  getTerm(): number { return this._currentTerm }
  getNodeId(): string { return this.config.nodeId }

  async waitForLeader(timeoutMs?: number): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? 5000)
    while (Date.now() < deadline) {
      if (this._role === 'leader') return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForLeader: timed out')
  }

  // ─── 内部消息处理 ──────────────────────────────────────

  private async _handleMessage(from: string, msg: RaftMessage): Promise<void> {
    switch (msg.type) {
      case 'AppendEntries': {
        const req = msg.data as AppendEntriesRequest
        const resp = await this._handleAppendEntries(from, req)
        this._sendResponse(from, {
          type: 'AppendEntriesResponse',
          term: resp.term,
          from: this.config.nodeId,
          to: from,
          data: resp,
        })
        break
      }
      case 'RequestVote': {
        const req = msg.data as RequestVoteRequest
        const resp = await this._handleRequestVote(from, req)
        this._sendResponse(from, {
          type: 'RequestVoteResponse',
          term: resp.term,
          from: this.config.nodeId,
          to: from,
          data: resp,
        })
        break
      }
      case 'PreVote': {
        const req = msg.data as RequestVoteRequest
        const resp = this.handlePreVoteRequest(from, req)
        this._sendResponse(from, {
          type: 'PreVoteResponse',
          term: resp.term,
          from: this.config.nodeId,
          to: from,
          data: resp,
        })
        break
      }
      case 'AppendEntriesResponse':
        // 作为 Leader 处理响应
        break
      case 'RequestVoteResponse':
        // Leader 选举中处理
        break
      case 'PreVoteResponse':
        this._handlePreVoteResponse(from, msg.data as RequestVoteResponse)
        break
      case 'InstallSnapshot': {
        const req = msg.data as InstallSnapshotRequest
        const resp = await this.handleInstallSnapshot(req)
        this._sendResponse(from, {
          type: 'InstallSnapshotResponse',
          term: resp.term,
          from: this.config.nodeId,
          to: from,
          data: resp,
        })
        break
      }
      case 'InstallSnapshotResponse': {
        // Leader 侧处理 follower 的快照安装确认
        break
      }
    }
  }

  /** 发送响应消息 */
  private _sendResponse(to: string, msg: RaftMessage): void {
    if (this.transport instanceof MockTransport) {
      MockTransport.sendResponse(to, this.config.nodeId, msg)
    }
  }

  // ─── 发送 RPC ──────────────────────────────────────────────

  /**
   * Pipeline-aware AppendEntries 发送
   *
   * 1. 检查该 follower 的 inFlight 计数
   * 2. 如果 inFlight >= MAX_BATCH_SIZE/2，将请求加入 pendingQueue 延迟发送
   * 3. 否则直接发送，递增 inFlight
   * 4. 收到响应后递减 inFlight，处理 pendingQueue 中积压的请求
   */
  private async _sendAppendEntries(
    peerId: string,
    heartbeat?: boolean,
  ): Promise<AppendEntriesResponse | null> {
    try {
      if (heartbeat || !this._isPipelineActive) {
        // 心跳或 Pipeline 未启用：直接发送
        return await this._sendAppendEntriesRaw(peerId, heartbeat)
      }

      // Pipeline 模式
      const inflight = this._inFlight.get(peerId) ?? 0
      if (inflight >= RaftCore.MAX_BATCH_SIZE / 2) {
        // inFlight 已满，加入 pending 队列
        const queue = this._pendingQueue.get(peerId) ?? []
        const lastIdx = this.wal.getLastIndex()
        const nextIdx = this._nextIndex.get(peerId) ?? 1
        if (lastIdx >= nextIdx) {
          queue.push({
            entries: this.wal.getEntriesFrom(nextIdx),
            maxBatchSize: RaftCore.MAX_BATCH_SIZE,
          })
          this._pendingQueue.set(peerId, queue)
        }
        return null
      }

      // 可发送，递增 inFlight
      this._inFlight.set(peerId, inflight + 1)
      const req: AppendEntriesRequest = this._buildAppendEntriesRequest(peerId, heartbeat)
      const resp = await (this.transport instanceof MockTransport
        ? this.transport.appendEntries(peerId, req)
        : this.transport.appendEntries
          ? this.transport.appendEntries(peerId, req)
          : null)

      // 递减 inFlight
      const currentInFlight = (this._inFlight.get(peerId) ?? 1) - 1
      if (currentInFlight <= 0) {
        this._inFlight.delete(peerId)
      } else {
        this._inFlight.set(peerId, currentInFlight)
      }

      // 处理 pending 队列
      this._processPendingQueue(peerId).catch(() => {})

      return resp
    } catch (err) {
      // 出错时递减 inFlight
      this._inFlight.delete(peerId)
      this.logger.warn(`AppendEntries send failed to ${peerId}:`, { err: (err as Error).message })
      return null
    }
  }

  /**
   * 直接发送 AppendEntries（无 Pipeline）
   */
  private async _sendAppendEntriesRaw(
    peerId: string,
    heartbeat?: boolean,
  ): Promise<AppendEntriesResponse | null> {
    try {
      if (this.transport instanceof MockTransport) {
        const req: AppendEntriesRequest = this._buildAppendEntriesRequest(peerId, heartbeat)
        return await this.transport.appendEntries(peerId, req)
      }
      if (this.transport.appendEntries) {
        const req = this._buildAppendEntriesRequest(peerId, heartbeat)
        return await this.transport.appendEntries(peerId, req)
      }
      return null
    } catch (err) {
      this.logger.warn(`AppendEntries send failed to ${peerId}:`, { err: (err as Error).message })
      return null
    }
  }

  /**
   * 处理 pending 队列中的积压请求
   */
  private async _processPendingQueue(peerId: string): Promise<void> {
    const queue = this._pendingQueue.get(peerId)
    if (!queue || queue.length === 0) return

    const batch = queue.shift()!
    this._pendingQueue.set(peerId, queue)

    // 发送 batch
    const inflight = this._inFlight.get(peerId) ?? 0
    this._inFlight.set(peerId, inflight + 1)
    const req = this._buildAppendEntriesRequest(peerId)
    const resp = await (this.transport instanceof MockTransport
      ? this.transport.appendEntries(peerId, req)
      : this.transport.appendEntries
        ? this.transport.appendEntries(peerId, req)
        : null)

    // 递减 inFlight
    const currentInFlight = (this._inFlight.get(peerId) ?? 1) - 1
    if (currentInFlight <= 0) {
      this._inFlight.delete(peerId)
    } else {
      this._inFlight.set(peerId, currentInFlight)
    }

    // 继续处理剩余队列
    this._processPendingQueue(peerId).catch(() => {})
  }

  /**
   * 广播 AppendEntries 到所有 peer（包括 joint 额外的）
   */
  private _broadcastAppendEntries(): Promise<Array<AppendEntriesResponse | null>> {
    const allPeers = this._getAllPeers()
    return Promise.all(
      allPeers.map(peerId => this._sendAppendEntries(peerId).catch(() => null))
    )
  }

  private async _sendRequestVote(peerId: string): Promise<RequestVoteResponse | null> {
    try {
      const lastLogIndex = this.wal.getLastIndex()
      const lastLogTerm = this.wal.getLastTerm()

      if (this.transport instanceof MockTransport) {
        return await this.transport.requestVote(peerId, {
          term: this._currentTerm,
          candidateId: this.config.nodeId,
          lastLogIndex,
          lastLogTerm,
        })
      }
      if (this.transport.requestVote) {
        return await this.transport.requestVote(peerId, {
          term: this._currentTerm,
          candidateId: this.config.nodeId,
          lastLogIndex,
          lastLogTerm,
        })
      }
      return null
    } catch (err) {
      this.logger.warn(`RequestVote send failed to ${peerId}:`, { err: (err as Error).message })
      return null
    }
  }

  private _buildAppendEntriesRequest(
    peerId: string,
    heartbeat?: boolean,
  ): AppendEntriesRequest {
    let prevLogIndex: number
    let prevLogTerm: number
    let entries: LogEntry[]

    if (heartbeat) {
      prevLogIndex = 0
      prevLogTerm = 0
      entries = []
    } else {
      // Use nextIndex per peer (Raft §5.3)
      const nextIdx = this._nextIndex.get(peerId) ?? 1
      const lastIdx = this.wal.getLastIndex()

      if (nextIdx <= 1) {
        // No previous log for this peer
        prevLogIndex = 0
        prevLogTerm = 0
      } else {
        prevLogIndex = nextIdx - 1
        const prevEntry = this.wal.getEntry(prevLogIndex)
        prevLogTerm = prevEntry ? prevEntry.term : 0
      }

      // Send entries from nextIdx to the end
      entries = this.wal.getEntriesFrom(nextIdx)
    }

    return {
      term: this._currentTerm,
      leaderId: this.config.nodeId,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this._commitIndex,
    }
  }

  // ─── RPC Handlers ──────────────────────────────────────────

  private async _handleAppendEntries(
    from: string,
    req: AppendEntriesRequest,
  ): Promise<AppendEntriesResponse> {
    // 1. 任期检查
    if (req.term > this._currentTerm) {
      this._stepDown(req.term)
      this.metrics.incrementCounter('graph.raft.leader_changes')
    }
    if (req.term < this._currentTerm) {
      return { term: this._currentTerm, success: false, lastLogIndex: this.wal.getLastIndex() }
    }

    // 重置选举超时（合法 leader 的心跳）
    this._resetElectionTimeout()

    // 2. prevLog 一致性检查
    if (req.prevLogIndex > 0) {
      const prevEntry = this.wal.getEntry(req.prevLogIndex)
      if (!prevEntry || prevEntry.term !== req.prevLogTerm) {
        return { term: this._currentTerm, success: false, lastLogIndex: this.wal.getLastIndex() }
      }
    }

    // 3. 追加新条目
    for (const entry of req.entries) {
      const existing = this.wal.getEntry(entry.index)
      if (existing) {
        if (existing.term !== entry.term) {
          await this.wal.truncate(entry.index - 1)
        } else {
          continue
        }
      }
      await this.wal.append(entry.term, entry.data)
    }

    // 4. 推进 commitIndex
    if (req.leaderCommit > this._commitIndex) {
      this._commitIndex = Math.min(req.leaderCommit, this.wal.getLastIndex())
    }

    // 5. 应用已提交的条目
    await this._applyCommittedEntries()

    // 6. 检查是否需要触发快照
    void this._checkSnapshot()

    return { term: this._currentTerm, success: true, lastLogIndex: this.wal.getLastIndex() }
  }

  private async _handleRequestVote(
    from: string,
    req: RequestVoteRequest,
  ): Promise<RequestVoteResponse> {
    if (req.term > this._currentTerm) this._stepDown(req.term)
    if (req.term < this._currentTerm) {
      return { term: this._currentTerm, voteGranted: false }
    }

    if (this._votedFor !== null && this._votedFor !== req.candidateId) {
      return { term: this._currentTerm, voteGranted: false }
    }

    const myLastIndex = this.wal.getLastIndex()
    const myLastTerm = this.wal.getLastTerm()

    const logIsAtLeastAsNew =
      req.lastLogTerm > myLastTerm ||
      (req.lastLogTerm === myLastTerm && req.lastLogIndex >= myLastIndex)

    if (!logIsAtLeastAsNew) {
      return { term: this._currentTerm, voteGranted: false }
    }

    this._votedFor = req.candidateId
    this._resetElectionTimeout()
    return { term: this._currentTerm, voteGranted: true }
  }

  // ─── PreVote ────────────────────────────────────────────────

  /**
   * 处理 PreVote 请求
   * PreVote 使用 RequestVoteRequest 结构，但 term 是 candidate 的 nextTerm
   * PreVote 不会修改 votedFor 或触发 stepDown
   * 关键：PreVote 阶段 candidate 不递增 term
   */
  public handlePreVoteRequest(
    from: string,
    req: RequestVoteRequest,
  ): RequestVoteResponse {
    // 如果请求 term 小于当前 term，拒绝
    if (req.term <= this._currentTerm) {
      return { term: this._currentTerm, voteGranted: false }
    }

    // 检查候选人的日志是否至少和自己一样新（与 RequestVote 相同的日志比较逻辑）
    const myLastIndex = this.wal.getLastIndex()
    const myLastTerm = this.wal.getLastTerm()

    const logIsAtLeastAsNew =
      req.lastLogTerm > myLastTerm ||
      (req.lastLogTerm === myLastTerm && req.lastLogIndex >= myLastIndex)

    if (!logIsAtLeastAsNew) {
      return { term: req.term, voteGranted: false }
    }

    return { term: req.term, voteGranted: true }
  }

  /**
   * 处理 PreVote 响应
   */
  private _handlePreVoteResponse(from: string, resp: RequestVoteResponse): void {
    if (!this._inPreVote || this._role !== 'candidate') return

    if (resp.voteGranted) {
      this._preVoteGranted.push(from)
    }

    const totalNodes = this.config.peers.length + 1
    const majority = Math.floor(totalNodes / 2) + 1

    if (this._preVoteGranted.length + 1 >= majority) {
      // PreVote 通过，正式发起选举
      this._preVoteGranted = []
      this._inPreVote = false
      this._doRealElection()
    }
  }

  /**
   * 发送 PreVote 请求到指定 peer
   * PreVote 请求复用 RequestVoteRequest 数据结构，但以独立消息类型发送
   */
  private async _sendPreVote(peerId: string): Promise<RequestVoteResponse | null> {
    try {
      const lastLogIndex = this.wal.getLastIndex()
      const lastLogTerm = this.wal.getLastTerm()
      const nextTerm = this._currentTerm + 1

      if (this.transport instanceof MockTransport) {
        return await this.transport.preVote(peerId, {
          term: nextTerm,
          candidateId: this.config.nodeId,
          lastLogIndex,
          lastLogTerm,
        })
      }
      if (this.transport.requestVote) {
        // 非 MockTransport: 使用 requestVote，RaftCore 会收到 RequestVote 消息
        // 对于非 MockTransport 的 PreVote，消息分发由 transport 层处理
        return await this.transport.requestVote(peerId, {
          term: nextTerm,
          candidateId: this.config.nodeId,
          lastLogIndex,
          lastLogTerm,
        })
      }
      return null
    } catch {
      return null
    }
  }

  // ─── 选举 ──────────────────────────────────────────────────

  private async _startElection(): Promise<void> {
    if (!this._started || this._role === 'leader') return

    this.metrics.incrementCounter('graph.raft.elections')

    // PreVote 模式：先发送 PreVote 请求
    if (this.config.preVote) {
      await this._startPreVote()
      return
    }

    // 直接选举模式
    await this._doRealElection()
  }

  /**
   * PreVote 前置投票
   * 不递增 term，发送 term=self._currentTerm+1 的 PreVote 请求给所有 peers
   * 收集响应，超过半数同意后正式发起选举
   */
  private async _startPreVote(): Promise<void> {
    this.logger.info(`Starting pre-vote, nextTerm=${this._currentTerm + 1}`)
    this._role = 'candidate'
    this._inPreVote = true
    this._preVoteGranted = []

    // 设置 PreVote 超时定时器
    if (this._preVoteTimerId !== null) {
      this.timerProvider.clearTimeout(this._preVoteTimerId)
    }
    this._preVoteTimerId = this.timerProvider.setTimeout(() => {
      if (this._inPreVote && this._role === 'candidate') {
        this.logger.info('Pre-vote timed out, stepping back to follower without triggering election')
        this._inPreVote = false
        this._preVoteGranted = []
        this._preVoteTimerId = null
        this._role = 'follower'
        this._votedFor = null
        this._resetElectionTimeout()
      }
    }, this.config.electionTimeoutMs! * 2) // 2x election timeout

    const totalNodes = this.config.peers.length + 1
    const majority = Math.floor(totalNodes / 2) + 1

    // 并行发送 PreVote 到所有 peers
    const results = await Promise.all(
      this.config.peers.map(peerId => this._sendPreVote(peerId))
    )

    let preVotes = 1 // 自己同意自己

    for (const resp of results) {
      if (!resp) continue
      if (resp.voteGranted) {
        preVotes++
      }
    }

    this.logger.info(`Pre-vote result: ${preVotes}/${majority}`)

    // 仅在仍处于 PreVote 状态时处理结果
    if (!this._inPreVote) return

    if (preVotes >= majority) {
      // PreVote 通过，正式发起选举
      this._clearPreVoteTimer()
      this._inPreVote = false
      this._preVoteGranted = []
      await this._doRealElection()
    } else {
      // PreVote 未通过，退回 follower 状态
      this.logger.info('Pre-vote failed, stepping back to follower')
      this._clearPreVoteTimer()
      this._inPreVote = false
      this._preVoteGranted = []
      this._role = 'follower'
      this._votedFor = null
      this._resetElectionTimeout()
    }
  }

  private _clearPreVoteTimer(): void {
    if (this._preVoteTimerId !== null) {
      this.timerProvider.clearTimeout(this._preVoteTimerId)
      this._preVoteTimerId = null
    }
  }

  /**
   * 正式选举（实际自增 term 并发起 RequestVote）
   */
  private async _doRealElection(): Promise<void> {
    if (!this._started || this._role === 'leader') return

    this.logger.info(`Starting election, term=${this._currentTerm + 1}`)
    this._role = 'candidate'
    this._currentTerm++
    this._votedFor = this.config.nodeId

    const totalNodes = this.config.peers.length + 1
    const majority = Math.floor(totalNodes / 2) + 1
    let votesReceived = 1 // 自己投给自己

    // 并行发送 RequestVote 到所有 peers
    const results = await Promise.all(
      this.config.peers.map(peerId => this._sendRequestVote(peerId))
    )

    for (const resp of results) {
      if (!resp) continue
      if (resp.term > this._currentTerm) {
        this._stepDown(resp.term)
        return
      }
      if (this._role !== 'candidate') return
      if (resp.voteGranted) {
        votesReceived++
        this.logger.info(`Got vote (${votesReceived}/${majority})`)
        if (votesReceived >= majority) {
          this._becomeLeader()
          return
        }
      }
    }

    // 没有 peers 或所有投票失败时检查是否达到多数
    if (votesReceived >= majority) {
      this._becomeLeader()
      return
    }

    // 未获得足够投票，继续 candidate 状态（由选举超时触发重试）
  }

  private _becomeLeader(): void {
    this.logger.info(`Became leader, term=${this._currentTerm}`)
    this._role = 'leader'
    this.metrics.incrementCounter('graph.raft.leader_changes')

    const lastIndex = this.wal.getLastIndex() + 1
    for (const peerId of this.config.peers) {
      this._nextIndex.set(peerId, lastIndex)
      this._matchIndex.set(peerId, 0)
    }

    // 初始化连接跟踪
    this._connectedPeers = new Set(this.config.peers)
    this._lastHeartbeatReachable = true

    this._clearTimers()
    this._sendHeartbeat()
    this._startHeartbeatTimer()
  }

  // ─── Heartbeat ─────────────────────────────────────────────

  private _sendHeartbeat(): void {
    if (this._role !== 'leader') return

    for (const peerId of this.config.peers) {
      this._sendAppendEntries(peerId, true)
        .then(resp => {
          if (resp && resp.success) {
            this._connectedPeers.add(peerId)
          } else {
            this._connectedPeers.delete(peerId)
          }
        })
        .catch(() => {
          this._connectedPeers.delete(peerId)
        })
    }
  }

  // ─── 状态机 ────────────────────────────────────────────────

  private async _applyCommittedEntries(): Promise<void> {
    if (!this.stateMachine) return

    const entries = this.wal.readAll()
    for (const entry of entries) {
      // 跳过已被快照覆盖的条目
      if (entry.index <= this._lastSnapshotIndex) continue
      if (entry.index > this._lastApplied && entry.index <= this._commitIndex) {
        try {
          await this.stateMachine(entry.data)
          this._lastApplied = entry.index
        } catch (err) {
          this.logger.error(`Apply failed entry ${entry.index}:`, err as Error)
        }
      }
    }

    // Raft commit → WAL fsync linkage: 状态机变更持久化后刷盘
    if (this._onCommitFsync) {
      this._onCommitFsync()
    }
  }

  private _advanceCommitIndex(): void {
    if (this._role !== 'leader') return

    const indexes = [this.wal.getLastIndex()]
    for (const [, matchIdx] of this._matchIndex) {
      indexes.push(matchIdx)
    }
    indexes.sort((a, b) => b - a)

    const majorityIdx = indexes[this._majority() - 1]
    if (majorityIdx > this._commitIndex) {
      const entry = this.wal.getEntry(majorityIdx)
      if (entry && entry.term === this._currentTerm) {
        this._commitIndex = majorityIdx
      }
    }
  }

  // ─── 辅助方法 ──────────────────────────────────────────────

  private _stepDown(term: number): void {
    if (term <= this._currentTerm) return
    this.logger.info(`StepDown to term=${term}`)
    if (this._role === 'leader') {
      this.metrics.incrementCounter('graph.raft.leader_changes')
    }
    this._currentTerm = term
    this._role = 'follower'
    this._votedFor = null
    this._connectedPeers.clear()
    this._clearTimers()
    if (this._started) this._resetElectionTimeout()
  }

  /**
   * Joint Consensus-aware majority calculation
   *
   * 正常模式：返回 (len(peers) + 1) / 2 + 1
   * Joint Consensus 模式 (C_old_new)：需要两个 Majority
   *   - C_old majority: (len(C_old) + 1) / 2 + 1
   *   - C_new majority: (len(C_new) + 1) / 2 + 1
   *   返回两个 majority 之和（用于 commit 判断）
   */
  private _majority(): number {
    if (this._jointPeers) {
      const cOld = this.config.peers
      const cNew = this._jointPeers
      const majorityOld = Math.floor((cOld.length + 1) / 2) + 1
      const majorityNew = Math.floor((cNew.length + 1) / 2) + 1
      // 返回较大的 majority（实际 commit 需要两者都满足）
      return Math.max(majorityOld, majorityNew)
    }
    return Math.floor((this.config.peers.length + 1) / 2) + 1
  }

  /** 获取当前所有 peers（包括 joint 阶段的额外 peers） */
  private _getAllPeers(): string[] {
    if (this._jointPeers) {
      const cOld = this.config.peers
      const cNew = this._jointPeers
      // union of C_old and C_new
      const all = new Set([...cOld, ...cNew])
      return Array.from(all)
    }
    return this.config.peers
  }

  private _resetElectionTimeout(): void {
    if (!this._started || this._role === 'leader') return

    if (this._electionTimerId !== null) {
      this.timerProvider.clearTimeout(this._electionTimerId)
    }
    const timeout = this.config.electionTimeoutMs!
    const jitter = Math.floor(Math.random() * timeout) + timeout

    this._electionTimerId = this.timerProvider.setTimeout(() => {
      if (this._started && this._role !== 'leader') {
        this._startElection()
      }
    }, jitter)
  }

  private _startHeartbeatTimer(): void {
    if (this._heartbeatTimerId !== null) {
      this.timerProvider.clearInterval(this._heartbeatTimerId)
    }
    this._heartbeatTimerId = this.timerProvider.setInterval(() => {
      if (this._started && this._role === 'leader') {
        // CheckQuorum: 在每次心跳前检查是否能联系到多数节点
        if (this.config.checkQuorum) {
          const totalNodes = this.config.peers.length + 1
          const majority = Math.floor(totalNodes / 2) + 1
          const connected = this._connectedPeers.size + 1 // 包括自己

          if (connected < majority) {
            this.logger.warn(
              `CheckQuorum[${this.config.nodeId}]: only ${connected}/${majority} nodes reachable, stepping down (connectedPeers=[${Array.from(this._connectedPeers).join(',')}])`
            )
            this._stepDown(this._currentTerm)
            return
          }
        }
        this._sendHeartbeat()
      }
    }, this.config.heartbeatIntervalMs!)
  }

  private _clearTimers(): void {
    this._clearPreVoteTimer()
    if (this._electionTimerId !== null) {
      this.timerProvider.clearTimeout(this._electionTimerId)
      this._electionTimerId = null
    }
    if (this._heartbeatTimerId !== null) {
      this.timerProvider.clearInterval(this._heartbeatTimerId)
      this._heartbeatTimerId = null
    }
  }

  // ─── Snapshot 方法 ──────────────────────────────────────

  /**
   * 检查是否需要触发快照，并在需要时自动执行
   */
  private async _checkSnapshot(): Promise<void> {
    const entryCount = this.wal.entriesCount()
    if (entryCount - this._lastSnapshotIndex <= this.config.snapshotThreshold!) return

    await this._doSnapshot()
  }

  /**
   * 执行快照
   * 1. 调用 stateMachine 传入特殊标记让外部持久化状态
   * 2. 将状态写入 snapshotPath 文件（JSON 格式）
   * 3. 截断 WAL 中已被快照包含的条目
   */
  private async _doSnapshot(): Promise<void> {
    if (!this.stateMachine) return

    const lastIncludedIndex = this.wal.getLastIndex()
    const lastIncludedTerm = this.wal.getLastTerm()

    if (lastIncludedIndex <= this._lastSnapshotIndex) return // nothing new to snapshot

    // 让状态机持久化当前状态
    // 传入空的 Uint8Array 作为快照标记（状态机自行持久化）
    await this.stateMachine(new Uint8Array(0))

    // 写 snapshot 文件
    const snapshot = {
      lastIncludedIndex,
      lastIncludedTerm,
      state: 'snapshot-complete',
    }

    const snapshotPath = this.config.snapshotPath!
    const dir = snapshotPath.substring(0, snapshotPath.lastIndexOf('/'))
    if (dir && dir !== snapshotPath) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    fs.fsyncSync(fs.openSync(snapshotPath, 'r'))

    this._lastSnapshotIndex = lastIncludedIndex
    this._lastSnapshotTerm = lastIncludedTerm

    // 截断 WAL：删除 lastIncludedIndex 及之前的条目
    await this.wal.truncateBefore(lastIncludedIndex + 1)

    this.logger.info(
      `Snapshot completed: lastIncludedIndex=${lastIncludedIndex}, ` +
      `lastIncludedTerm=${lastIncludedTerm}, ` +
      `WAL entries remaining=${this.wal.entriesCount()}`
    )
  }

  /**
   * 加载 snapshot 状态（启动时调用）
   */
  private _loadSnapshotState(): void {
    const snapshotPath = this.config.snapshotPath!
    if (!fs.existsSync(snapshotPath)) return

    try {
      const raw = fs.readFileSync(snapshotPath, 'utf-8')
      const snapshot = JSON.parse(raw) as {
        lastIncludedIndex: number
        lastIncludedTerm: number
        state: string
      }

      this._lastSnapshotIndex = snapshot.lastIncludedIndex
      this._lastSnapshotTerm = snapshot.lastIncludedTerm

      // 快照后的 _lastApplied 至少达到 lastSnapshotIndex
      if (this._lastApplied < this._lastSnapshotIndex) {
        this._lastApplied = this._lastSnapshotIndex
      }
      // 快照后的 _commitIndex 至少达到 lastSnapshotIndex
      if (this._commitIndex < this._lastSnapshotIndex) {
        this._commitIndex = this._lastSnapshotIndex
      }

      this.logger.info(
        `Loaded snapshot: lastIncludedIndex=${this._lastSnapshotIndex}, ` +
        `lastIncludedTerm=${this._lastSnapshotTerm}`
      )
    } catch (err) {
      this.logger.error('Failed to load snapshot state:', err as Error)
    }
  }

  // ─── InstallSnapshot RPC ──────────────────────────────────

  /**
   * 处理 InstallSnapshot 请求（follower 侧）
   */
  async handleInstallSnapshot(request: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    this.logger.info('[InstallSnapshot] Received', {
      term: request.term,
      leaderId: request.leaderId,
      lastIncludedIndex: request.lastIncludedIndex,
      dataLength: request.data.length,
    })

    // 任期检查
    if (request.term < this._currentTerm) {
      return { term: this._currentTerm, success: false }
    }
    if (request.term > this._currentTerm) {
      this._stepDown(request.term)
    }

    // 重置选举超时
    this._resetElectionTimeout()

    // 将快照数据应用到状态机
    if (this.stateMachine) {
      await this.stateMachine(request.data)
    }

    // 更新 snapshot 状态
    this._lastSnapshotIndex = Math.max(this._lastSnapshotIndex, request.lastIncludedIndex)
    this._lastSnapshotTerm = Math.max(this._lastSnapshotTerm, request.lastIncludedTerm)

    // 截断 WAL
    if (request.lastIncludedIndex > 0) {
      await this.wal.truncateBefore(request.lastIncludedIndex + 1)
    }

    this._persistSnapshotState(request.lastIncludedIndex, request.lastIncludedTerm)

    this.logger.info('[InstallSnapshot] Applied', {
      lastIncludedIndex: request.lastIncludedIndex,
      lastIncludedTerm: request.lastIncludedTerm,
    })

    return { term: this._currentTerm, success: true }
  }

  /**
   * Leader 发送 InstallSnapshot 到 follower
   */
  private async _sendInstallSnapshot(peerId: string): Promise<InstallSnapshotResponse | null> {
    try {
      const snapshotPath = this.config.snapshotPath!
      if (!fs.existsSync(snapshotPath)) return null

      const raw = fs.readFileSync(snapshotPath, 'utf-8')
      const snapshot = JSON.parse(raw) as {
        lastIncludedIndex: number
        lastIncludedTerm: number
        state: string
      }

      const data = Buffer.from(JSON.stringify(snapshot))

      if (this.transport instanceof MockTransport) {
        return await this.transport.installSnapshot(peerId, {
          term: this._currentTerm,
          leaderId: this.config.nodeId,
          lastIncludedIndex: snapshot.lastIncludedIndex,
          lastIncludedTerm: snapshot.lastIncludedTerm,
          data,
          done: true,
        })
      }
      if (this.transport.installSnapshot) {
        return await this.transport.installSnapshot(peerId, {
          term: this._currentTerm,
          leaderId: this.config.nodeId,
          lastIncludedIndex: snapshot.lastIncludedIndex,
          lastIncludedTerm: snapshot.lastIncludedTerm,
          data,
          done: true,
        })
      }
      return null
    } catch (err) {
      this.logger.warn(`InstallSnapshot send failed to ${peerId}:`, { err: (err as Error).message })
      return null
    }
  }

  private _persistSnapshotState(lastIncludedIndex: number, lastIncludedTerm: number): void {
    const snapshotPath = this.config.snapshotPath!
    const snapshot = {
      lastIncludedIndex,
      lastIncludedTerm,
      state: 'snapshot-complete',
    }
    const dir = snapshotPath.substring(0, snapshotPath.lastIndexOf('/'))
    if (dir && dir !== snapshotPath) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    try { fs.fsyncSync(fs.openSync(snapshotPath, 'r')) } catch {}
  }

  /**
   * 删除 snapshot 文件（测试辅助）
   */
  async destroySnapshot(): Promise<void> {
    const snapshotPath = this.config.snapshotPath!
    try {
      if (fs.existsSync(snapshotPath)) {
        fs.unlinkSync(snapshotPath)
      }
    } catch {
      // ignore
    }
    this._lastSnapshotIndex = 0
    this._lastSnapshotTerm = 0
  }
}
