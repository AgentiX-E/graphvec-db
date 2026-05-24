/**
 * SafeReader — 安全读一致性层
 *
 * 在 Raft 集群中，Follower 的读操作可能读到过时数据。
 * 通过 readIndex() 确保 Follower 的 appliedIndex ≥ Leader 的 commitIndex。
 *
 * 用法:
 *   const reader = new SafeReader(provider)
 *   const node = reader.read(() => storage.getNode(id, true))
 *
 * 支持配置:
 * - readIndexTimeoutMs: readIndex 等待超时 (默认 5000ms)
 * - enabled: 是否启用 (默认 true; Raft 未配置时设为 false)
 */

import type { ConsensusProvider } from '../consensus/consensus-provider'
import type { NodeRecord, EdgeRecord } from '../types'

export interface ReadResult<T> {
  data: T
  refreshedAt: number
}

export interface SafeReaderConfig {
  enabled: boolean
  readIndexTimeoutMs: number
}

export class SafeReader {
  private _provider: ConsensusProvider | null
  private _enabled: boolean
  private _timeoutMs: number
  private _lastRefresh = 0

  constructor(provider?: ConsensusProvider, config?: Partial<SafeReaderConfig>) {
    this._provider = provider ?? null
    this._enabled = config?.enabled ?? (this._provider !== null)
    this._timeoutMs = config?.readIndexTimeoutMs ?? 5000
  }

  /**
   * 在执行 read 操作前先同步 readIndex，确保读到最新数据。
   * 如果 SafeReader 被禁用，直接执行 read 函数。
   */
  async read<T>(fn: () => T): Promise<ReadResult<T>> {
    if (this._enabled && this._provider) {
      await this._provider.readIndex(this._timeoutMs)
    }
    this._lastRefresh = Date.now()
    return { data: fn(), refreshedAt: this._lastRefresh }
  }

  /**
   * 获取最后同步时间
   */
  get lastRefresh(): number {
    return this._lastRefresh
  }

  /**
   * 启用/禁用
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled
  }

  /** 当前启用状态 */
  get enabled(): boolean {
    return this._enabled
  }

  /** 更新 provider (Raft 实例化后注入) */
  setProvider(provider: ConsensusProvider): void {
    this._provider = provider
  }
}
