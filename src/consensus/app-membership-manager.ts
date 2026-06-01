/**
 * app-membership-manager.ts — 应用层成员变更管理
 *
 * 不依赖 raft-logic WASM 的 ConfChangeV2 API。
 * 通过 EventBus 应用层广播 + 多数派确认实现安全成员变更。
 *
 * 流程（两阶段提交）：
 * Phase 1: 发起者广播 MembershipProposal{type, peerId, seq, term}
 * Phase 2: 收集多数派 ACK（含各节点配置快照）
 * Phase 3: 广播 MembershipCommit{seq} → 各节点本地 apply
 *           a) 更新 config.peers
 *           b) EventBus 重建 DEALER 连接
 *           c) 触发 onMembershipChange()
 * 回滚: 超时则广播 MembershipAbort{seq, reason}
 *
 * R10: 与 raft-logic ConfChangeV2 互补。两者可同时启用。
 */

import { Logger } from '../ops/logger'
import { MembershipRouteTable } from './membership-route-table'

/** 成员变更消息类型 */
export type MembershipMessageType = 'proposal' | 'ack' | 'commit' | 'abort'

/** 成员变更操作类型 */
export type MembershipChangeType = 'add' | 'remove'

/** 通用成员变更消息 */
export interface MembershipMessage {
  type: MembershipMessageType
  /** 提案序号（单调递增，去重） */
  seq: number
  /** 发起者 nodeId */
  from: string
  /** 操作类型 */
  changeType?: MembershipChangeType
  /** 目标 peerId */
  targetPeerId?: string
  /** 发起者配置快照（用于 Phase 2 一致性校验） */
  configHash?: string
  /** abort 原因 */
  reason?: string
  /** 确认的节点数 */
  ackCount?: number
  /** ACK 来源列表 */
  ackFrom?: string[]
  /** 提交的成员列表 */
  members?: string[]
}

/** 成员变更传输层接口 */
export interface MembershipTransport {
  /** 向指定 peer 发送消息 */
  send(peerId: string, msg: any): Promise<void>
  /** 广播消息到所有 peer */
  broadcast(msg: any): Promise<void>
  /** 注册消息回调 */
  onMessage(cb: (from: string, msg: any) => void): void
  /** 获取当前 peer 列表 */
  getPeers(): Array<{ nodeId: string; addr: string }>
}

/** 成员变更管理器配置 */
export interface MembershipManagerConfig {
  /** 当前节点 ID */
  nodeId: string
  /** 传输层接口 */
  transport: MembershipTransport
  /** 路由表（可选） */
  routeTable?: MembershipRouteTable
  /** 成员变更回调 */
  onMembershipChange: (members: string[]) => void
  /** 变更提案的 ACK 超时时间（ms），默认 5000 */
  ackTimeoutMs?: number
  /** Leader 存活检查回调（可选），返回 true 表示 leader 存活 */
  checkLeaderAlive?: () => Promise<boolean>
  /**
   * Commit 前一致性检查（可选）
   * 在 Phase 2（ACK 收集完成）后、Phase 3（广播 commit）前执行。
   * 返回 false → 取消变更，回滚 pending。
   */
  syncCheck?: () => Promise<boolean>
  /**
   * PreSync 确认回调（可选）
   * 在 Phase 1（广播 proposal）前调用。
   * 用于验证新节点数据预同步已完成。
   */
  preSyncCheck?: (peerId: string) => Promise<boolean>
}

/** 待处理的提案 */
interface PendingProposal {
  seq: number
  changeType: MembershipChangeType
  targetPeerId: string
  configHash: string
  acks: Set<string>
  ackTimer: ReturnType<typeof setTimeout> | null
  startTime: number
  resolve: (value: void) => void
  reject: (err: Error) => void
}

/**
 * 应用层成员变更管理器
 *
 * 支持安全的 addPeer/removePeer，不依赖 raft-logic WASM。
 *
 * 使用示例：
 *
 * ```typescript
 * const mm = new AppMembershipManager({
 *   nodeId: 'node-1',
 *   transport: eventBusMembershipAdapter,
 *   onMembershipChange: (members) => {
 *     hbManager.updatePeers(members)
 *     multiLeaderReplication.updatePeers(members)
 *   }
 * })
 * mm.start()
 * await mm.proposeChange('add', 'node-5')
 * ```
 */
export class AppMembershipManager {
  private config: MembershipManagerConfig
  private logger: Logger
  private _running = false
  /** 当前待处理的提案（一次只能一个） */
  private _pending: PendingProposal | null = null
  /** 已处理过的 seq（去重），key: "type:seq" */
  private _seenSeqs = new Set<string>()
  /** 当前 seq 递进 */
  private _nextSeq = 0
  /** 当前成员视图 */
  private _members: string[] = []
  /** 成员变更回调列表 */
  private _membershipCallbacks: Array<(members: string[]) => void> = []

  constructor(config: MembershipManagerConfig) {
    this.config = {
      ackTimeoutMs: config.ackTimeoutMs ?? 5000,
      ...config,
    }
    this.logger = new Logger('AppMembershipManager')

    // 初始化成员列表
    this._syncMembersFromTransport()
  }

  /** 启动管理器（注册消息回调） */
  start(): void {
    if (this._running) return
    this._running = true

    this.config.transport.onMessage((from, msg) => {
      this.handleMessage(from, msg)
    })

    this._syncMembersFromTransport()
    this.logger.info(`[Membership] Started, initial members: ${this._members.join(', ')}`)
  }

  /** 停止管理器 */
  stop(): void {
    this._running = false
    if (this._pending) {
      clearTimeout(this._pending.ackTimer!)
      this._pending = null
    }
    this._seenSeqs.clear()
  }

  /**
   * 发起成员变更提案
   *
   * @param type - add 或 remove
   * @param peerId - 目标 nodeId
   * @returns 变更完成时 resolve
   */
  async proposeChange(type: MembershipChangeType, peerId: string): Promise<void> {
    if (!this._running) throw new Error('AppMembershipManager not started')

    // 验证：不能加自己
    if (type === 'add' && peerId === this.config.nodeId) {
      throw new Error('Cannot add self to cluster')
    }
    // 验证：不能移除自己
    if (type === 'remove' && peerId === this.config.nodeId) {
      throw new Error('Cannot remove self from cluster')
    }
    // 验证：add 时 peer 是否已存在
    if (type === 'add' && this._members.includes(peerId)) {
      this.logger.info(`[Membership] Peer ${peerId} already in cluster, skipping`)
      return Promise.resolve() // 幂等
    }
    // 验证：remove 时 peer 是否不存在
    if (type === 'remove' && !this._members.includes(peerId)) {
      this.logger.info(`[Membership] Peer ${peerId} not in cluster, skipping`)
      return Promise.resolve() // 幂等
    }
    // 验证：remove 时安全保护
    if (type === 'remove') {
      // 禁止在只有 3 个节点时移除（防止破坏 quorum）
      if (this._members.length <= 3) {
        throw new Error(`Cannot remove peer: cluster size ${this._members.length} <= 3, removing would reduce fault tolerance`)
      }
    }

    // 检查并发提案（必须在 Leader 存活检查之前，防止重复提案）
    if (this._pending) {
      throw new Error(`Concurrent membership change in progress (seq=${this._pending.seq})`)
    }

    const seq = this._nextSeq++
    const configHash = this._computeConfigHash()
    const ackTimeout = this.config.ackTimeoutMs!

    // Leader 存活检查（在设置 _pending 之前完成，避免 ACK 竞态）
    if (this.config.checkLeaderAlive) {
      const isLeaderAlive = await Promise.race([
        this.config.checkLeaderAlive(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ])
      if (!isLeaderAlive) {
        throw new Error(`Cannot change membership during leader election or partition`)
      }
    }

    // PreSync 检查（add 操作时验证新节点数据已对齐）
    if (this.config.preSyncCheck && type === 'add') {
      const syncReady = await Promise.race([
        this.config.preSyncCheck(peerId),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ])
      if (!syncReady) {
        throw new Error(`PreSync not complete for ${peerId}, cannot add yet`)
      }
      this.logger.info(`[Membership] PreSync confirmed for ${peerId}`)
    }

    // Phase 1: 广播提案
    const proposal: MembershipMessage = {
      type: 'proposal',
      seq,
      from: this.config.nodeId,
      changeType: type,
      targetPeerId: peerId,
      configHash,
    }

    this.logger.info(`[Membership] Phase 1: Broadcasting proposal seq=${seq}, ${type} ${peerId}`)

    // Phase 2: 先设置 _pending，再广播（确保 ACK 到达时 _pending 已就绪）
    return new Promise<void>((resolve, reject) => {
      this._pending = {
        seq,
        changeType: type,
        targetPeerId: peerId,
        configHash,
        acks: new Set([this.config.nodeId]), // 自投票
        ackTimer: null,
        startTime: Date.now(),
        resolve,
        reject,
      }

      const timer = setTimeout(() => {
        // ACK 超时 → abort
        const pending = this._pending
        if (!pending) return

        this._pending = null
        this.logger.warn(`[Membership] Phase 2 timeout: seq=${seq}, acks=${pending.acks.size}`)

        // 广播 abort
        this.config.transport.broadcast({
          type: 'abort',
          seq,
          from: this.config.nodeId,
          reason: 'Timeout waiting for majority ACK',
        } as MembershipMessage).catch(() => {})

        reject(new Error(`Membership change timeout: seq=${seq}, ${type} ${peerId}`))
      }, ackTimeout)

      this._pending.ackTimer = timer

        // 异步广播 proposal（不阻塞 Promise 构造）
      this.config.transport.broadcast(proposal).then(() => {
        // 广播完成后检查是否已满足（self ACK + 收到的 ACK）
        this._checkProposalCompletion(resolve, reject)
      }).catch((err: Error) => {
        reject(err)
      })
    })
  }

  /**
   * 处理收到的成员变更消息
   * 由外部传输层回调
   */
  handleMessage(from: string, msg: any): void {
    if (!msg || msg.type !== 'proposal' && msg.type !== 'ack' && msg.type !== 'commit' && msg.type !== 'abort') {
      return // 不是成员变更消息
    }

    const mm = msg as MembershipMessage

    // 去重（按 type:from:seq 区分——不同源的 ACK 需要各自保留）
    const dedupKey = mm.type === 'proposal' || mm.type === 'commit' || mm.type === 'abort'
      ? `${mm.type}:${mm.from}:${mm.seq}`
      : `${mm.type}:${from}:${mm.seq}`
    if (this._seenSeqs.has(dedupKey)) return
    this._seenSeqs.add(dedupKey)

    // 限制 seenSeqs 大小
    if (this._seenSeqs.size > 1000) {
      const first = this._seenSeqs.values().next().value
      if (first !== undefined) this._seenSeqs.delete(first)
    }

    switch (mm.type) {
      case 'proposal':
        this._handleProposal(from, mm)
        break
      case 'ack':
        this._handleAck(from, mm)
        break
      case 'commit':
        this._handleCommit(mm)
        break
      case 'abort':
        this._handleAbort(mm)
        break
    }
  }

  /** 获取当前成员列表 */
  getMembers(): string[] {
    return [...this._members]
  }

  /** 注册成员变更回调 */
  onMembershipChange(cb: (members: string[]) => void): void {
    this._membershipCallbacks.push(cb)
  }

  /** 处理收到的提案 */
  private _handleProposal(from: string, msg: MembershipMessage): void {
    if (!msg.changeType || !msg.targetPeerId) return

    // 验证提案的 configHash 与本地一致
    const localHash = this._computeConfigHash()
    // 回复 ACK（含自己的 configHash）
    this.config.transport.send(from, {
      type: 'ack',
      seq: msg.seq,
      from: this.config.nodeId,
      configHash: localHash,
    } as MembershipMessage).catch(() => {})

    this.logger.info(`[Membership] Received proposal seq=${msg.seq}, ${msg.changeType} ${msg.targetPeerId} from ${from}, sent ACK`)
  }

  /** 处理收到的 ACK */
  private _handleAck(from: string, msg: MembershipMessage): void {
    if (!this._pending || this._pending.seq !== msg.seq) {
      return
    }

    // 检查 configHash 一致性（debug 日志，不拒绝 ACK）
    if (msg.configHash && msg.configHash !== this._pending.configHash) {
      this.logger.debug(`[Membership] ACK from ${from} configHash mismatch: ${msg.configHash} vs ${this._pending.configHash}`)
    }

    this._pending.acks.add(from)
    this.logger.debug(`[Membership] Received ACK from ${from} for seq=${msg.seq} (${this._pending.acks.size}/${Math.floor(this._members.length / 2) + 1})`)

    // 检查是否已满足 quorum，使用存储的 resolve/reject
    const pending = this._pending
    const totalMembers = this._members.length
    const quorum = Math.floor(totalMembers / 2) + 1

    if (pending.acks.size >= quorum) {
      this._checkProposalCompletion(pending.resolve, pending.reject)
    }
  }

  /** 检查提案是否完成 */
  private async _checkProposalCompletion(
    resolve: (value: void) => void,
    reject: (err: Error) => void
  ): Promise<void> {
    if (!this._pending) return

    const pending = this._pending
    const totalMembers = this._members.length
    const quorum = Math.floor(totalMembers / 2) + 1

    if (pending.acks.size >= quorum) {
      // 防止重复提交
      if (pending.ackTimer === null) {
        return // 已经 commit 过了
      }

      // 清除超时定时器
      if (pending.ackTimer) {
        clearTimeout(pending.ackTimer)
        pending.ackTimer = null
      }

      // Phase 3: Commit 前一致性检查
      if (this.config.syncCheck) {
        try {
          const checkOk = await Promise.race([
            this.config.syncCheck(),
            new Promise<boolean>((_, reject) =>
              setTimeout(() => reject(new Error('syncCheck timeout')), 5000)
            ),
          ] as const).catch(() => false)

          if (!checkOk) {
            this.logger.warn(`[Membership] syncCheck failed for seq=${pending.seq}, aborting`)
            this._pending = null
            reject(new Error(`Membership change rejected by syncCheck: seq=${pending.seq}`))
            return
          }

          this.logger.debug(`[Membership] syncCheck passed for seq=${pending.seq}`)
        } catch (err: any) {
          this.logger.error(`[Membership] syncCheck error for seq=${pending.seq}: ${err.message}`)
          this._pending = null
          reject(new Error(`Membership change rejected: syncCheck error: ${err.message}`))
          return
        }
      }

      // Phase 4: 广播 commit
      this._commitChange(pending, resolve, reject)
    }
    // 否则继续等待（ACK 尚未满足 quorum，_handleAck 会再次调用此方法）
  }

  private _commitChange(
    pending: PendingProposal,
    resolve: (value: void) => void,
    reject: (err: Error) => void
  ): void {
    // 计算新成员列表
    let newMembers: string[]
    if (pending.changeType === 'add') {
      newMembers = [...this._members, pending.targetPeerId]
    } else {
      newMembers = this._members.filter(m => m !== pending.targetPeerId)
    }

    // 本地 apply
    this._applyMembershipChange(newMembers)

    // 广播 commit
    const commitMsg: MembershipMessage = {
      type: 'commit',
      seq: pending.seq,
      from: this.config.nodeId,
      members: newMembers,
      ackCount: pending.acks.size,
      ackFrom: Array.from(pending.acks),
    }

    this.logger.info(`[Membership] Phase 3: Broadcasting commit seq=${pending.seq}, new members (${newMembers.length}): ${newMembers.join(', ')}`)

    // 更新路由表
    if (this.config.routeTable) {
      // add：为新节点注册路由（地址从 transport 获取）
      if (pending.changeType === 'add') {
        const peers = this.config.transport.getPeers()
        const peerInfo = peers.find(p => p.nodeId === pending.targetPeerId)
        if (peerInfo) {
          this.config.routeTable.setRoute(peerInfo.nodeId, peerInfo.addr)
          this.logger.info(`[Membership] RouteTable updated: ${peerInfo.nodeId} → ${peerInfo.addr}`)
        }
      } else {
        // remove：清理路由
        this.config.routeTable.removeRoute(pending.targetPeerId)
        this.logger.info(`[Membership] RouteTable updated: removed ${pending.targetPeerId}`)
      }
    }

    this.config.transport.broadcast(commitMsg).then(() => {
      // commit 后：路由表标记新节点健康
      if (this.config.routeTable && pending.changeType === 'add') {
        this.config.routeTable.setHealth(pending.targetPeerId, true)
      }
      this._pending = null
      resolve()
    }).catch((err: Error) => {
      this._pending = null
      // commit 广播失败但本地已 apply，标记不一致
      this.logger.error(`[Membership] Commit broadcast failed after local apply: ${err.message}`)
      resolve() // 仍然 resolve，本地已生效
    })
  }

  /** 本地 apply 成员变更 */
  private _applyMembershipChange(newMembers: string[]): void {
    this._members = [...newMembers].sort()

    // 触发回调
    for (const cb of this._membershipCallbacks) {
      try {
        cb(this._members)
      } catch (err) {
        this.logger.error(`[Membership] Callback error: ${(err as Error).message}`)
      }
    }

    try {
      this.config.onMembershipChange(this._members)
    } catch (err) {
      this.logger.error(`[Membership] onMembershipChange callback error: ${(err as Error).message}`)
    }
  }

  /** 处理收到的 commit */
  private _handleCommit(msg: MembershipMessage): void {
    if (!msg.members || msg.members.length === 0) return

    // 如果本地已经是最新，跳过
    const sorted = [...msg.members].sort()
    if (this._members.length === sorted.length &&
        this._members.every((m, i) => m === sorted[i])) {
      this.logger.debug(`[Membership] Commit seq=${msg.seq} already applied locally`)
      return
    }

    this.logger.info(`[Membership] Applying commit seq=${msg.seq}, members: ${sorted.join(', ')}`)
    this._applyMembershipChange(sorted)

    // 同步路由表：清理不在成员列表中的路由
    if (this.config.routeTable) {
      const currentPeers = this.config.transport.getPeers()
      const currentIds = new Set(currentPeers.map(p => p.nodeId))
      const memberSet = new Set(sorted)

      // 清理已移除的路由
      for (const [nodeId] of this.config.routeTable.snapshot()) {
        if (!memberSet.has(nodeId)) {
          this.config.routeTable.removeRoute(nodeId)
          this.logger.info(`[Membership] RouteTable cleanup: removed stale route for ${nodeId}`)
        }
      }

      // 添加新成员路由（从 transport 获取地址）
      for (const member of sorted) {
        // 已存在的路由跳过
        if (this.config.routeTable.getAddr(member)) continue

        const peerInfo = currentPeers.find(p => p.nodeId === member)
        if (peerInfo) {
          this.config.routeTable.setRoute(peerInfo.nodeId, peerInfo.addr)
        }
      }
    }

    // 更新传输层 peer 列表（子类/适配器可能需要）
    // EventBus 会通过 onMembershipChange 回调接收新成员列表
  }

  /** 处理 abort */
  private _handleAbort(msg: MembershipMessage): void {
    if (this._pending && this._pending.seq === msg.seq) {
      if (this._pending.ackTimer) {
        clearTimeout(this._pending.ackTimer)
      }
      this._pending = null
      this.logger.warn(`[Membership] Abort seq=${msg.seq}: ${msg.reason || 'No reason'}`)
    }
  }

  /** 从传输层同步成员列表 */
  private _syncMembersFromTransport(): void {
    const peers = this.config.transport.getPeers()
    const members = new Set<string>()
    members.add(this.config.nodeId)
    for (const p of peers) {
      members.add(p.nodeId)
    }
    this._members = Array.from(members).sort()
  }

  /** 计算配置快照 hash（简单实现，用于检测不一致） */
  private _computeConfigHash(): string {
    return this._members.sort().join(',')
  }
}
