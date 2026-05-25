/**
 * multi-leader-replication.ts — Multi-Leader 同步复制层
 *
 * 在 GraphEngine 的 upsert 路径上加入同步复制：写入本地 storage + WAL 后，
 * 通过 EventStream 广播到同 DC 内所有节点，等待所有节点持久化确认后再返回。
 *
 * 冲突解决：HLC 时间戳 + nodeId 比较（LWW），大者覆盖。
 *
 * 架构：
 *   upsertNode / upsertEdge
 *       │
 *       ▼
 *   MultiLeaderReplication.write()
 *       ├── 1. 写入本地 storage + 内存索引
 *       ├── 2. EventStream.emitSync()（同步等待所有远程节点 ACK）
 *       └── 3. 返回结果（或抛出异常）
 */

import { EventStream } from './event-stream'
import { HlcClock } from '../replication/hlc-clock'
import type { NodeProperties, NodeId, TemporalValidity } from '../types'

/** Multi-Leader 复制配置 */
export interface MultiLeaderConfig {
  /** 当前节点 ID */
  nodeId: string
  /** 同 DC 内所有参与 Multi-Leader 的节点 ID（包括自己） */
  peers: string[]
  /** EventStream 实例（需已 open） */
  eventStream: EventStream
  /** HLC 时钟实例 */
  clock: HlcClock
  /** emitSync 超时（毫秒），默认 30000 */
  syncTimeoutMs?: number
}

/** Multi-Leader 复制结果 */
export interface WriteResult {
  success: boolean
  acksReceived: number
  expectedAcks: number
  error?: string
}

/**
 * Multi-Leader 同步复制层
 *
 * 封装写入同步 + LWW 冲突解决的逻辑
 */
export class MultiLeaderReplication {
  private config: MultiLeaderConfig

  constructor(config: MultiLeaderConfig) {
    if (!config.peers.includes(config.nodeId)) {
      throw new Error(`MultiLeader: nodeId ${config.nodeId} must be in peers list`)
    }
    this.config = config
  }

  /** 当前节点 ID */
  get nodeId(): string { return this.config.nodeId }

  /**
   * 同步复制：将变更事件广播到所有 remote 节点并等待 ACK
   *
   * @param type 事件类型（'node:created' | 'node:updated' | 'node:deleted' | 'edge:created'等）
   * @param data 事件数据
   * @returns WriteResult
   * @throws 同步超时异常
   */
  async replicate(type: string, data: Record<string, unknown>): Promise<WriteResult> {
    // 需要等待的 ACK 数 = 所有远程节点数
    const expectedAcks = this.config.peers.length - 1

    if (expectedAcks <= 0) {
      return { success: true, acksReceived: 0, expectedAcks: 0 }
    }

    // 标记 HLC 时间戳
    const timestamp = this.config.clock.nowWithWallTime()
    const hlcBytes = Array.from(timestamp.toBytes()).map(b => b.toString(16).padStart(2, '0')).join('')

    const acksReceived = await this.config.eventStream.emitSync(
      {
        type,
        data: {
          ...data,
          __hlc: hlcBytes,
          __nodeId: this.config.nodeId,
        },
      },
      expectedAcks,
      this.config.syncTimeoutMs ?? 30000,
    )

    return {
      success: acksReceived >= expectedAcks,
      acksReceived,
      expectedAcks,
    }
  }
}
