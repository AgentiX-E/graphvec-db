/**
 * AutoSplitter — 自动 Range 分裂触发器
 *
 * 定期检查 Range 数据量，当超过阈值时自动生成 split 计划并执行。
 *
 * 设计原则:
 * - 无侵入：通过 shardManager 检测，Splitter 只触发不执行迁移
 * - 可配置：maxNodesPerRange、checkIntervalMs
 * - 安全：预留 min check 间隔，避免 split 风暴
 */

import type { ShardManager } from './shard-manager'
import type { RangeInstance } from './range-instance'

export interface AutoSplitterConfig {
  /** 每个 Range 的最大节点数阈值（默认 100000） */
  maxNodesPerRange?: number
  /** 检查间隔（毫秒，默认 30000 = 30s） */
  checkIntervalMs?: number
  /** 最小分裂间隔（毫秒，同一个 Range 两次 split 之间，默认 60000 = 1min） */
  minSplitIntervalMs?: number
  /** 每个检查周期最大分裂次数，超过此数则跳过后续 split（默认 2，防止 split 风暴） */
  maxSplitsPerCycle?: number
}

/**
 * SplitSuggestion — AutoSplitter 传递给外部 ReshardManager 的 split 建议
 *
 * 包含触发原因、当前负载和建议的分片数量，使 ReshardManager 无需二次计算即可决策。
 */
export interface SplitSuggestion {
  rangeId: string
  nodeCount: number
  edgeCount: number
  diskSizeBytes: number
  suggestedSplitKey?: number
  suggestedTargetCount: number
  reason: string
}

/**
 * ReshardCallback — 触发 rebalance 的回调签名
 * - suggestion 可选：传递时不破坏向后兼容，ReshardManager 可选择忽略或使用建议。
 */
export type ReshardCallback = (suggestion?: SplitSuggestion) => void

export class AutoSplitter {
  private _config: Required<AutoSplitterConfig>
  private _getRangeInstances: () => RangeInstance[]
  private _onReshard: ReshardCallback
  private _timer: ReturnType<typeof setInterval> | null = null
  private _lastSplit = new Map<string, number>()
  private _running = false

  constructor(getRangeInstances: () => RangeInstance[], onReshard: ReshardCallback, config?: AutoSplitterConfig) {
    this._getRangeInstances = getRangeInstances
    this._onReshard = onReshard
    this._config = {
      maxNodesPerRange: config?.maxNodesPerRange ?? 100000,
      checkIntervalMs: config?.checkIntervalMs ?? 30000,
      minSplitIntervalMs: config?.minSplitIntervalMs ?? 60000,
      maxSplitsPerCycle: config?.maxSplitsPerCycle ?? 2,
    }
  }

  /** 启动自动分裂检查 */
  start(): void {
    if (this._running) return
    this._running = true
    this._timer = setInterval(() => this._check(), this._config.checkIntervalMs)
    this._timer.unref()
  }

  /** 停止自动分裂检查 */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._running = false
  }

  get running(): boolean {
    return this._running
  }

  /** 立即执行一次检查 */
  async checkNow(): Promise<number> {
    return this._check()
  }

  private async _check(): Promise<number> {
    const now = Date.now()
    let splits = 0

    try {
      const ranges = this._getRangeInstances()
      for (const range of ranges) {
        // 跳过 draining range
        if (range.isDraining()) continue

        // 风暴预防：一周期最多 split maxSplitsPerCycle 次
        if (splits >= this._config.maxSplitsPerCycle) break

        const engine = range.engine
        const stats = engine.stats()
        const nodeCount = stats.nodeCount ?? 0

        if (nodeCount > this._config.maxNodesPerRange) {
          const rangeId = range.config.rangeId
          const lastSplit = this._lastSplit.get(rangeId) ?? 0

          if (now - lastSplit < this._config.minSplitIntervalMs) {
            continue // 过早，跳过
          }

          // 触发 split
          this._lastSplit.set(rangeId, now)

          const suggestion: SplitSuggestion = {
            rangeId,
            nodeCount,
            edgeCount: stats.edgeCount ?? 0,
            diskSizeBytes: stats.diskSizeBytes ?? 0,
            suggestedTargetCount: Math.ceil(nodeCount / this._config.maxNodesPerRange),
            reason: 'node_count_exceeded',
          }

          this._onReshard(suggestion)
          splits++
        }
      }
    } catch (err) {
      // 静默：单次检查失败不影响后续
    }

    return splits
  }
}
