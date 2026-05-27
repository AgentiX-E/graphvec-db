/**
 * multi-leader-replication.ts — Multi-Leader 复制层
 *
 * 基于 Outbox Worker 的最终一致性复制：
 * 1. replicate() 写入 Outbox（LMDB 持久化）后立即返回
 * 2. 单一 OutboxWorker 后台发送，per-peer 退避独立
 * 3. 退避重试（maxBackoffSeconds = 60s），无限重试
 * 4. 节点下线（.pub 删除）→ Worker 自动停止发送
 */

import { OutboxReplicationManager, type OutboxReplicationConfig } from './outbox-replication'
import type { NodeProperties, NodeId, TemporalValidity } from '../types'
import type { ConsensusProvider } from '../consensus/consensus-provider'
import * as crypto from 'node:crypto'

/** 拓扑类型，决定 Outbox 退避时间 */
export type TopologyType = 'intra-dc' | 'cross-dc' | 'edge'

/** Multi-Leader 复制配置 */
export interface MultiLeaderConfig {
  /** 当前节点 ID */
  nodeId: string
  /** peers 列表 [{ nodeId, addr }] */
  peers: Array<{ nodeId: string; addr: string }>
  /** Curve 公钥目录 */
  curveDir: string
  /** LMDB 数据库路径（可选） */
  dbPath?: string
  /** tick 间隔（ms），默认 500 */
  tickMs?: number
  /** 拓扑类型（intra-dc: 3s, cross-dc: 60s, edge: 300s），默认 cross-dc */
  topology?: TopologyType
  /** 最大退避时间（s），默认 60。如果显式设置此值，则覆盖 topology 推导值 */
  maxBackoffSeconds?: number
  /** 已送达记录保留天数，默认 14 */
  entryTTLDays?: number
  /** Housekeeping 执行间隔（ms），默认 86400000 */
  housekeepingIntervalMs?: number
  /** 批量发送大小 */
  batchSize?: number
  /** 启用 per-peer 分库（OutboxV2） */
  usePerPeerDb?: boolean
  /** EventBus 实例（用于 send + 重建 DEALER） */
  eventBus: {
    send: (nodeId: string, msg: any) => Promise<void>
    _recoverDealerByNodeId?: (nodeId: string) => Promise<void>
    _handleDealerSendError?: (nodeId: string, err: Error) => void
  }
}

/** Multi-Leader 复制结果 */
export interface WriteResult {
  success: boolean
  acksReceived: number
  expectedAcks: number
  error?: string
}

/** replicate 的运行时参数 */
export interface ReplicateOptions {
  /** 预期的 ACK 数（0 = 只写本地），默认 peer 数 */
  emitReplica?: number
}

/**
 * Multi-Leader 复制层
 */
export class MultiLeaderReplication {
  private manager: OutboxReplicationManager
  private config: MultiLeaderConfig

  constructor(config: MultiLeaderConfig) {
    this.config = { ...config }
    const peerAddrs = config.peers.filter(p => p.nodeId !== config.nodeId)

    // Derive maxBackoffSeconds from topology if not explicitly set.
    // Store result back in config so getConfig() reflects the resolved value.
    if (this.config.maxBackoffSeconds === undefined) {
      switch (this.config.topology ?? 'cross-dc') {
        case 'intra-dc':
          this.config.maxBackoffSeconds = 3
          break
        case 'cross-dc':
          this.config.maxBackoffSeconds = 60
          break
        case 'edge':
          this.config.maxBackoffSeconds = 300
          break
      }
    }

    const mgrConfig: OutboxReplicationConfig = {
      nodeId: this.config.nodeId,
      peers: peerAddrs,
      dbPath: this.config.dbPath,
      curveDir: this.config.curveDir,
      tickMs: this.config.tickMs,
      maxBackoffSeconds: this.config.maxBackoffSeconds,
      batchSize: this.config.batchSize,
      entryTTLDays: this.config.entryTTLDays,
      housekeepingIntervalMs: this.config.housekeepingIntervalMs,
      usePerPeerDb: this.config.usePerPeerDb,
      eventBus: this.config.eventBus,
    }
    this.manager = new OutboxReplicationManager(mgrConfig)
  }

  /** 当前节点 ID */
  get nodeId(): string { return this.config.nodeId }

  /** 获取当前配置副本（包含由 topology 推导的最终值） */
  getConfig(): Readonly<MultiLeaderConfig> {
    return { ...this.config }
  }

  /** 启动所有 Outbox Worker 并注册 shutdown hook */
  start(): void {
    this.manager.start()
    this.manager.registerShutdownHook()
  }

  /**
   * 写入 Outbox（不等待远程 ACK）
   */
  async replicate(type: string, data: Record<string, unknown>, opts?: ReplicateOptions): Promise<WriteResult> {
    const expectedAcks = opts?.emitReplica ?? this.config.peers.filter(p => p.nodeId !== this.config.nodeId).length

    if (expectedAcks <= 0) {
      return { success: true, acksReceived: 0, expectedAcks: 0 }
    }

    // 标记消息 ID
    const msgId = crypto.randomUUID()
    const payload = { ...data, msgId }

    this.manager.addMessage(type, payload)

    return { success: true, acksReceived: 0, expectedAcks }
  }

  /** 停止 */
  stop(): void {
    this.manager.stop()
  }

  /** 统计信息 */
  getStats(): { workers: number; pending: number } {
    return {
      workers: this.config.peers.filter(p => p.nodeId !== this.config.nodeId).length,
      pending: this.manager.getStats().pending,
    }
  }

  /** 通知 Worker 某个 peer 已连接 */
  notifyConnected(peerId: string): void {
    this.manager.notifyConnected(peerId)
  }

  /** 通知 Worker 收到某个 peer 的 ACK */
  notifyAcked(peerId: string): void {
    this.manager.notifyAcked(peerId)
  }

  /** R9: 绑定 ConsensusProvider，自动注册 majority-change 回调
   *
   * 当节点失去 majority（网络分区）时，自动冻结 Outbox 出站发送；
   * 恢复 majority 后自动解冻。
   */
  setConsensus(consensus: ConsensusProvider): void {
    consensus.onMajorityChange((inMajority) => {
      this.manager.setMajorityStatus(inMajority)
    })
  }
}
