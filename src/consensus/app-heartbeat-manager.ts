/**
 * app-heartbeat-manager.ts — 应用层心跳分区检测
 *
 * 不依赖 raft-logic WASM，在应用层实现独立的心跳检测：
 *
 * 工作原理：
 * 1. 每 pingIntervalMs（默认 1s）向所有 peer 发送 ping
 * 2. 3 次连续无响应 → suspect
 * 3. Outbox 发送失败作为二次确认 → 确定分区/推翻 suspect
 * 4. 确定分区 → onMajorityChange(false)，恢复 → onMajorityChange(true)
 *
 * R9: 与 raft-logic onQuorumActive/onRoleChange 互补。
 * 两者可同时启用以提供心跳 + raft 事件双重检测。
 */

import { Logger } from '../ops/logger'

/** 心跳传输层接口 */
export interface HeartbeatTransport {
  send(peerId: string, msg: any): Promise<void>
}

/** Heartbeat manager配置 */
export interface HeartbeatConfig {
  /** 当前Node ID */
  nodeId: string
  /** peer 列表 */
  peers: Array<{ nodeId: string; addr: string }>
  /** 发送心跳的间隔（ms），默认 1000 */
  pingIntervalMs?: number
  /** 丢失几次心跳判定为 suspect，默认 3 */
  suspectThreshold?: number
  /** 分区确认后，连续成功几次心跳后恢复 healthy，默认 3 */
  recoveryThreshold?: number
  /** 传输层接口 */
  transport: HeartbeatTransport
  /** majority 状态变化回调 */
  onMajorityChange: (inMajority: boolean) => void
}

/** 单个 peer 的心跳状态 */
interface PeerHeartbeatState {
  /** 最后收到心跳的时间戳 */
  lastReceived: number
  /** 连续未收到心跳的轮次 */
  missedPings: number
  /** 当前 suspect 状态 */
  suspect: boolean
  /** 连续成功心跳数（用于 recovery） */
  consecutiveSuccesses: number
  /** 当前是否被 Outbox 确认失败 */
  outboxConfirmedFailing: boolean
}

/**
 * 应用层Heartbeat manager
 *
 * 提供独立于 raft-logic WASM 的分区检测。
 *
 * 使用Example: 
 *
 * ```typescript
 * const hb = new AppHeartbeatManager({
 *   nodeId: 'node-1',
 *   peers: [{ nodeId: 'node-2', addr: 'tcp://...' }],
 *   transport: eventBus,
 *   onMajorityChange: (inMajority) => {
 *     multiLeaderReplication.setConsensus(inMajority)
 *   }
 * })
 * hb.start()
 * ```
 */
export class AppHeartbeatManager {
  private config: HeartbeatConfig
  private logger: Logger
  private _running = false
  private _pingTimer: ReturnType<typeof setInterval> | null = null
  private _peers = new Map<string, PeerHeartbeatState>()
  /** 之前是否处于 majority（去重 onMajorityChange 回调） */
  private _prevMajority = true
  /** 发送的 seq 编号，用于去重 */
  private _nextSeq = 0

  constructor(config: HeartbeatConfig) {
    this.config = {
      pingIntervalMs: config.pingIntervalMs ?? 1000,
      suspectThreshold: config.suspectThreshold ?? 3,
      recoveryThreshold: config.recoveryThreshold ?? 3,
      ...config,
    }
    this.logger = new Logger('AppHeartbeatManager')
    this._initPeers()
  }

  private _initPeers(): void {
    for (const p of this.config.peers) {
      if (p.nodeId === this.config.nodeId) continue
      if (!this._peers.has(p.nodeId)) {
        this._peers.set(p.nodeId, {
          lastReceived: Date.now(),
          missedPings: 0,
          suspect: false,
          consecutiveSuccesses: 0,
          outboxConfirmedFailing: false,
        })
      }
    }
  }

  /** 启动心跳检测 */
  start(): void {
    if (this._running) return
    this._running = true
    this._prevMajority = true

    // 重置所有 peer 状态
    this._peers.clear()
    this._initPeers()

    // 单节点：始终 inMajority
    if (this.config.peers.length <= 1) {
      this.logger.info('[Heartbeat] Single-node cluster, always in majority')
      return
    }

    const interval = this.config.pingIntervalMs!
    this._pingTimer = setInterval(() => this._tick(), interval)
    this.logger.info(`[Heartbeat] Started, interval=${interval}ms, threshold=${this.config.suspectThreshold}`)
  }

  /** 停止心跳检测 */
  stop(): void {
    this._running = false
    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
    this._peers.clear()
  }

  /**
   * 由传输层回调：收到一个心跳消息
   * ping 消息格式: { type: 'heartbeat', from: string, seq: number }
   */
  handleHeartbeat(from: string): void {
    const state = this._peers.get(from)
    if (!state) {
      // 未知 peer — 可能是动态加入的成员
      this.logger.debug(`[Heartbeat] Received heartbeat from unknown peer ${from}`)
      return
    }

    state.lastReceived = Date.now()
    state.missedPings = 0

    // 立即清除 suspect 状态（有心跳说明对方在线）
    if (state.suspect) {
      state.suspect = false
      state.outboxConfirmedFailing = false
      state.consecutiveSuccesses = 0
    }

    // 重新计算 majority 状态
    this._recalculateMajority()
  }

  /**
   * 发送心跳 ping 到所有 peer
   * 由外部定时调用，或由 _tick() 内部调用
   */
  async sendPings(): Promise<void> {
    if (!this._running) return
    const seq = this._nextSeq++
    const msg = { type: 'heartbeat', from: this.config.nodeId, seq }

    const promises: Promise<void>[] = []
    for (const [peerId] of this._peers) {
      promises.push(
        this.config.transport.send(peerId, msg).catch((err: Error) => {
          this.logger.debug(`[Heartbeat] Send to ${peerId} failed: ${err.message}`)
        })
      )
    }
    await Promise.all(promises)
  }

  /**
   * Outbox 报告发送失败：用于二次确认 suspect
   *
   * @param peerId - 失败的 peer
   * @param consecutiveFailures - 连续失败次数
   */
  reportSendFailure(peerId: string, consecutiveFailures: number): void {
    const state = this._peers.get(peerId)
    if (!state) return

    // 只有连续失败超过 suspectThreshold 时才标记分区确认
    if (consecutiveFailures >= this.config.suspectThreshold!) {
      state.outboxConfirmedFailing = true
      this.logger.warn(`[Heartbeat] Outbox confirms peer ${peerId} failing (${consecutiveFailures} consecutive failures)`)

      // 如果也在 suspect 状态，触发 majority 变更
      if (state.suspect) {
        this._recalculateMajority()
      }
    }
  }

  /** 获取当前 suspect 状态 */
  getSuspects(): Map<string, boolean> {
    const result = new Map<string, boolean>()
    for (const [peerId, state] of this._peers) {
      result.set(peerId, state.suspect)
    }
    return result
  }

  /** 当前是否 in majority */
  isMajority(): boolean {
    return this._computeMajority()
  }

  /** 更新 peer 列表（R10 成员变更后调用） */
  updatePeers(peers: Array<{ nodeId: string; addr: string }>): void {
    const newPeers = new Map<string, PeerHeartbeatState>()
    for (const p of peers) {
      if (p.nodeId === this.config.nodeId) continue
      const existing = this._peers.get(p.nodeId)
      newPeers.set(p.nodeId, existing ?? {
        lastReceived: Date.now(),
        missedPings: 0,
        suspect: false,
        consecutiveSuccesses: 0,
        outboxConfirmedFailing: false,
      })
    }
    this._peers = newPeers
    this._recalculateMajority()
  }

  /** 内部 tick：发送 ping + 检查超时 */
  private async _tick(): Promise<void> {
    if (!this._running) return

    // 1. 发送 ping
    await this.sendPings()

    // 2. 检查超时：每个 peer 是否在超时前收到了心跳
    // 如果 miss 计数 >= suspectThreshold，标记 suspect
    // （missedPings 在 handleHeartbeat 中清空）
    for (const [peerId, state] of this._peers) {
      state.missedPings++
      if (state.missedPings >= this.config.suspectThreshold! && !state.suspect) {
        state.suspect = true
        state.consecutiveSuccesses = 0
        this.logger.warn(`[Heartbeat] Peer ${peerId} suspect (missed ${state.missedPings} pings)`)
      }
    }

    // 3. 重新计算 majority
    this._recalculateMajority()
  }

  /** 重新计算 majority 状态 */
  private _recalculateMajority(): void {
    const inMajority = this._computeMajority()
    if (inMajority !== this._prevMajority) {
      this._prevMajority = inMajority
      this.logger.info(`[Heartbeat] Majority status changed: ${inMajority}`)
      try {
        this.config.onMajorityChange(inMajority)
      } catch (err) {
        this.logger.error(`[Heartbeat] onMajorityChange callback error: ${(err as Error).message}`)
      }
    }
  }

  /**
   * 计算当前是否 in majority：
   * - 单节点：true
   * - 需要 >50% 的 peer 健康（非 suspect）
   * - 如果 suspect 但 Outbox 未确认失败，仍视为可能健康（不触发分区）
   * - 如果 suspect + Outbox 确认失败，该 peer 计入分区
   */
  private _computeMajority(): boolean {
    const total = this._peers.size

    // 单节点
    if (total === 0) return true

    // 计算确认失败的 peer 数：
    // suspect + outboxConfirmedFailing = 确定分区
    // suspect + !outboxConfirmedFailing = 暂不处理（等待 Outbox 二次确认）
    let confirmedFailed = 0
    let suspectCount = 0

    for (const state of this._peers.values()) {
      if (state.suspect && state.outboxConfirmedFailing) {
        confirmedFailed++
      }
      if (state.suspect) {
        suspectCount++
      }
    }

    // majority = 超过一半 peer 健康且确认没有分区
    const healthy = total - confirmedFailed
    const quorum = Math.floor(total / 2) + 1

    this.logger.debug(`[Heartbeat] Majority check: total=${total}, suspect=${suspectCount}, confirmedFailed=${confirmedFailed}, healthy=${healthy}, quorum=${quorum}`)

    return healthy >= quorum
  }

  /**
   * 手动触发一次 tick（Test only）
   * 发送 ping + 检查超时 + 重新计算 majority
   */
  async manualTick(): Promise<void> {
    await this._tick()
  }

  /** 获取状态统计（用于监控/测试） */
  getStats(): { total: number; suspect: number; confirmedFailed: number; inMajority: boolean } {
    let suspect = 0
    let confirmedFailed = 0
    for (const state of this._peers.values()) {
      if (state.suspect) suspect++
      if (state.suspect && state.outboxConfirmedFailing) confirmedFailed++
    }
    return {
      total: this._peers.size,
      suspect,
      confirmedFailed,
      inMajority: this._computeMajority(),
    }
  }
}
