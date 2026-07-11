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
   * 标准读 — 使用 readIndex 同步后读取
   * 保证读到 leader 已 commit 的最新数据
   */
  async read<T>(fn: () => T): Promise<ReadResult<T>> {
    if (this._enabled && this._provider) {
      await this._provider.readIndex(this._timeoutMs)
    }
    this._lastRefresh = Date.now()
    return { data: fn(), refreshedAt: this._lastRefresh }
  }

  /**
   * 线性一致读 — 使用 barrier 语义后读取
   * barrier() 返回后保证所有 barrier 前的写入都已 apply，
   * 比 readIndex 提供更强的线性一致保证（Raft §6.4）。
   *
   * 适用场景：
   * - 客户端先写入，后续读必须看到写入（读己之写）
   * - 对一致性要求极高的读取（如分布式锁判定）
   *
   * Note: 
   * - barrier 是Optional API（provider.barrier?），不暴露时 fallback 到 readIndex
   * - barrier 的性能开销略高于 readIndex（可能涉及 no-op proposal）
   */
  async consistentRead<T>(fn: () => T): Promise<ReadResult<T>> {
    if (this._enabled && this._provider) {
      if (this._provider.barrier) {
        await this._provider.barrier(this._timeoutMs)
      } else {
        // provider Not implemented barrier，fallback 到 readIndex
        await this._provider.readIndex(this._timeoutMs)
      }
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
