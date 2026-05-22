/**
 * consensus_provider_compat.ts — 兼容层
 *
 * 临时桥接旧的 ConsensusProvider 接口到 RaftCore。
 * 当所有 spec 迁移完成后删除此文件。
 *
 * 当前作为类型定义 + 空接口/类型 export 保留，
 * 确保现有 spec 文件的 import 不会编译报错。
 *
 * TODO(cleanup): 所有 spec 迁移完成后删除此文件
 *   - consensus-provider.spec.ts 改为引用 raft-core 接口
 *   - standalone-consensus.ts 改为委托到 RaftCore 或删除
 */

export type ConsensusRole = 'leader' | 'follower' | 'candidate' | 'standalone'

export interface ConsensusProvider {
  /** 初始化共识 */
  start(): Promise<void>

  /** 停止共识 */
  stop(): Promise<void>

  /**
   * 提交提案并等待应用
   * 跟随者应自动转发到 Leader
   */
  propose(data: Uint8Array, timeoutMs?: number): Promise<{ ok: boolean }>

  /**
   * 确保读取的安全索引（线性一致读）
   */
  readIndex(timeoutMs?: number): Promise<void>

  /** 获取当前角色 */
  getRole(): ConsensusRole

  /** 获取当前 Leader ID */
  getLeaderId(): string | null

  /** 获取当前任期 */
  getTerm(): number

  /** 等待 Leader 稳定 */
  waitForLeader(timeoutMs?: number): Promise<void>

  /**
   * 设置 apply 回调（由共识引擎在条目提交时调用）
   * 可选方法，仅特定实现支持
   */
  setApply?(fn: (data: Uint8Array) => Promise<void>): void
}

export interface ConsensusConfig {
  mode: 'standalone' | 'simulated-raft' | 'raft-logic'
  nodeId: string
  peers: string[]
  electionTimeoutMs?: number
  heartbeatIntervalMs?: number
}
