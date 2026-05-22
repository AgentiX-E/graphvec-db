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
}
