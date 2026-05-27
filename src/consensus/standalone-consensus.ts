import { ConsensusProvider, ConsensusRole, ConsensusConfig } from './consensus-provider'
import { v4 as uuid } from 'uuid'

/**
 * StandaloneConsensus — 单节点共识实现
 *
 * 无网络共识，直接本地应用写入
 * 适用于开发、测试、单节点部署
 */
export class StandaloneConsensus implements ConsensusProvider {
  private config: ConsensusConfig
  private applyFn: ((data: Uint8Array) => Promise<void>) | null = null
  private _started = false

  constructor(config: ConsensusConfig) {
    this.config = { ...config, mode: 'standalone' }
  }

  setApply(fn: (data: Uint8Array) => Promise<void>): void {
    this.applyFn = fn
  }

  async start(): Promise<void> {
    this._started = true
  }

  async stop(): Promise<void> {
    this._started = false
  }

  async propose(data: Uint8Array, _timeoutMs?: number): Promise<{ ok: boolean }> {
    if (!this._started) return { ok: false }
    if (this.applyFn) {
      try {
        await this.applyFn(data)
        return { ok: true }
      } catch (err) {
        return { ok: false }
      }
    }
    return { ok: false }
  }

  async readIndex(_timeoutMs?: number): Promise<void> {
    // standalone 模式无需等待
    return
  }

  async barrier(_timeoutMs?: number): Promise<void> {
    // standalone 模式：单点写入后本机读取必然是线性一致
    // 无需额外屏障
    return
  }

  getRole(): ConsensusRole {
    return 'standalone'
  }

  getLeaderId(): string | null {
    return this._started ? this.config.nodeId : null
  }

  getTerm(): number {
    return 1
  }

  async waitForLeader(_timeoutMs?: number): Promise<void> {
    return
  }

  // ── R9: 网络分区（单节点总是在 majority 中） ──

  /** 单节点总是在 majority 中 */
  inMajority(): boolean {
    return true
  }

  private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

  /** 单节点无网络，永远不会触发回调 */
  onMajorityChange(cb: (inMajority: boolean) => void): void {
    this._majorityCallbacks.push(cb)
  }

  // ── R10: 成员变更（单节点无 peers） ──

  /** 单节点无 peers，addPeer 为空操作 */
  async addPeer(_peerId: string): Promise<void> {
    // standalone 模式没有其他节点，no-op
  }

  /** 单节点无 peers，removePeer 为空操作 */
  async removePeer(_peerId: string): Promise<void> {
    // standalone 模式没有其他节点，no-op
  }

  /** 返回仅包含当前节点的列表 */
  getClusterMembers(): string[] {
    return [this.config.nodeId]
  }

  private _membershipCallbacks: Array<(members: string[]) => void> = []

  /** 单节点无成员变更，永远不会触发回调 */
  onMembershipChange(cb: (members: string[]) => void): void {
    this._membershipCallbacks.push(cb)
  }
}
