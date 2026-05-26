/**
 * ConsensusProvider — 共识层抽象接口
 *
 * 允许插件化切换共识实现：
 * - standalone: 单节点模式（开发/测试），无网络共识
 * - simulated-raft: 内存模拟 Raft（多节点开发/测试）
 * - raft-logic: 生产级 tikv/raft-rs WASM 共识（当 raft-logic 稳定时启用）
 */
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

  /**
   * 线性一致读取屏障
   * barrier() 返回后，保证 barrier 前的所有提案都已 apply 到状态机。
   * barrier 后读取的数据保证看到 barrier 前的所有写入（Raft §6.4）。
   *
   * 如果共识实现暴露此 API，调用方获得更强的线性一致保障（barrier
   * 语义严格强于 readIndex：barrier 确保所有前置 entry 已 apply，
   * 而 readIndex 只确保 leader 的 commitIndex ≥ follower 的 appliedIndex）。
   *
   * 实现注意：
   * - 优先使用底层 `barrier()` API（如 raft-rs WASM 提供）
   * - fallback：在无 barrier API 时，propose 一个 no-op entry 并等它 apply
   * - standalone 模式可以为空实现（线性一致保证由单点保证）
   */
  barrier?(timeoutMs?: number): Promise<void>

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

export type ConsensusRole = 'leader' | 'follower' | 'candidate' | 'standalone'

export interface ConsensusConfig {
  mode: 'standalone' | 'simulated-raft' | 'raft-logic'
  nodeId: string
  peers: string[]
  electionTimeoutMs?: number
  heartbeatIntervalMs?: number
  /** 当设置时，使用 TcpTransport 而非 InMemoryTransport（跨进程通信） */
  transportPort?: number
}
