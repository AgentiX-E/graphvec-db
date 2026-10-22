/**
 * GlobalScheduler — 全局分片调度器（对标 Dgraph Zero）
 *
 * 职责：
 * 1. 监控所有分片的 CPU、内存、QPS、延迟分布
 * 2. 基于负载建议分片分裂（利用 AutoSplitter 的检测结果）
 * 3. 基于"热点"检测建议分片迁移（将热点分片迁往低负载节点）
 * 4. 维护全局资源视图（每个节点的可用资源）
 *
 * 设计原则：
 * - 建议驱动（advisory）：GlobalScheduler 只生成 Suggestion，
 *   由 ReshardManager 决定是否执行
 * - 无锁状态：GlobalScheduler 状态独立于 ShardManager，
 *   不要求强一致——调度延迟在秒级可接受
 * - 节流：单次调度周期最多生成 N 条建议，避免调度风暴
 */

import { Logger } from '../ops/logger'

// ── 类型定义 ──

/** 节点资源状态 */
export interface NodeResource {
  nodeId: string
  cpuPercent: number        // 0-100
  memoryPercent: number     // 0-100
  shardCount: number
  avgLatencyMs: number
}

/** 分片负载快照 */
export interface ShardLoad {
  rangeId: string
  nodeCount: number
  edgeCount: number
  qps: number              // 每秒查询数
  avgLatencyMs: number
  diskBytes: number
  localNodeId: string       // 当前驻留的Node ID
  isHot: boolean            // 热点标记（QPS/延迟超过阈值）
}

/** 调度建议类型 */
export type SuggestionType =
  | 'split'     // 分片过大，建议分裂
  | 'migrate'   // 分片成热点，建议迁移到低负载节点
  | 'merge'     // 分片过小，建议合并

/** 全局调度建议 */
export interface GlobalSuggestion {
  type: SuggestionType
  rangeId: string
  reason: string
  priority: number                   // 0（紧急）到 10（Optional）
  /** 仅 migrate 类型：建议的目标Node ID */
  targetNodeId?: string
  /** 仅 split 类型：建议分裂成的目标分片数 */
  suggestedTargetCount?: number
}

/** 全局调度器配置 */
export interface GlobalSchedulerConfig {
  /** 调度周期（毫秒），默认 10000 */
  scheduleIntervalMs?: number
  /** QPS 热点阈值，默认 500 */
  hotQpsThreshold?: number
  /** 延迟热点阈值（ms），默认 100 */
  hotLatencyMsThreshold?: number
  /** 分片最大节点数，默认 100000 */
  maxNodesPerRange?: number
  /** 分片最小节点数（低于此值建议合并），默认 100 */
  minNodesPerRange?: number
  /** 单次调度最大建议数，默认 3 */
  maxSuggestionsPerCycle?: number
  /** 节点最大分片数占比偏差（高于此值建议迁出），默认 1.5 */
  maxShardImbalanceRatio?: number
}

/** 资源获取函数类型 */
export type ResourceProvider = () => Promise<{
  nodes: NodeResource[]
  shards: ShardLoad[]
}>

/** 建议消费函数类型 */
export type SuggestionConsumer = (suggestion: GlobalSuggestion) => void

// ── 默认配置 ──

const DEFAULT_CONFIG: Required<GlobalSchedulerConfig> = {
  scheduleIntervalMs: 10000,
  hotQpsThreshold: 500,
  hotLatencyMsThreshold: 100,
  maxNodesPerRange: 100000,
  minNodesPerRange: 100,
  maxSuggestionsPerCycle: 3,
  maxShardImbalanceRatio: 1.5,
}

// ── GlobalScheduler 类 ──

export class GlobalScheduler {
  private _config: Required<GlobalSchedulerConfig>
  private _getResources: ResourceProvider
  private _onSuggestion: SuggestionConsumer
  private _timer: ReturnType<typeof setInterval> | null = null
  private _running = false
  private _logger: Logger
  /** 跳过列表：避免反复对同一分片生成重复建议 */
  private _skipList = new Set<string>()
  private _skipListTimer: ReturnType<typeof setInterval> | null = null
  /** B-10: 建议历史记录（用于反馈闭环） */
  private _suggestionHistory: Map<string, { suggestion: GlobalSuggestion; emittedAt: number; result?: 'accepted' | 'rejected' | 'ignored'; resultAt?: number }> = new Map()
  /** B-10: 历史记录最大保留数 */
  private static readonly MAX_HISTORY = 100

  constructor(
    getResources: ResourceProvider,
    onSuggestion: SuggestionConsumer,
    config?: GlobalSchedulerConfig,
  ) {
    this._getResources = getResources
    this._onSuggestion = onSuggestion
    this._config = { ...DEFAULT_CONFIG, ...config }
    this._logger = new Logger('GlobalScheduler')
  }

  get running(): boolean {
    return this._running
  }

  /** 启动全局调度 */
  start(): void {
    if (this._running) return
    this._running = true

    // 主调度循环
    this._timer = setInterval(() => {
      this._schedule().catch(() => {
        // 单次调度失败静默
      })
    }, this._config.scheduleIntervalMs)
    this._timer.unref()

    // 每 60s 清空跳过列表
    this._skipListTimer = setInterval(() => {
      this._skipList.clear()
    }, 60000)
    this._skipListTimer.unref()
  }

  /** 停止调度 */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._skipListTimer) {
      clearInterval(this._skipListTimer)
      this._skipListTimer = null
    }
    this._running = false
  }

  /** 立即执行一次调度（返回建议数） */
  async scheduleNow(): Promise<number> {
    return this._schedule()
  }

  private async _schedule(): Promise<number> {
    const resources = await this._getResources()
    const suggestions = this._analyze(resources.nodes, resources.shards)

    let emitted = 0
    for (const s of suggestions) {
      if (this._skipList.has(s.rangeId)) continue
      this._skipList.add(s.rangeId)
      this._onSuggestion(s)
      emitted++

      // 记录历史
      const key = `${s.type}:${s.rangeId}`
      this._suggestionHistory.set(key, { suggestion: s, emittedAt: Date.now() })

      // 限制历史数量
      if (this._suggestionHistory.size > GlobalScheduler.MAX_HISTORY) {
        const oldest = this._suggestionHistory.keys().next().value
        if (oldest) this._suggestionHistory.delete(oldest)
      }
    }

    if (emitted > 0) {
      this._logger.info(`GlobalScheduler: ${emitted} suggestion(s) emitted`)
    }

    return emitted
  }

  /**
   * 核心分析逻辑：
   * 1. 计算集群负载基线
   * 2. 对每个分片做三模式检测：split / migrate / merge
   * 3. 按优先级排序，返回 top N
   */
  private _analyze(nodes: NodeResource[], shards: ShardLoad[]): GlobalSuggestion[] {
    const candidates: GlobalSuggestion[] = []

    // 计算全局基线
    const avgQps = shards.length > 0
      ? shards.reduce((s, sh) => s + sh.qps, 0) / shards.length
      : 0
    const avgLatency = shards.length > 0
      ? shards.reduce((s, sh) => s + sh.avgLatencyMs, 0) / shards.length
      : 0

    // 找出低负载节点（用于迁移目标）
    const lowLoadNodes = nodes
      .filter(n => n.memoryPercent < 60 && n.cpuPercent < 50)
      .sort((a, b) => a.shardCount - b.shardCount)

    for (const shard of shards) {
      // 模式 1：split — 分片过大
      if (shard.nodeCount > this._config.maxNodesPerRange) {
        candidates.push({
          type: 'split',
          rangeId: shard.rangeId,
          reason: `node_count ${shard.nodeCount} > max ${this._config.maxNodesPerRange}`,
          priority: 3,
          suggestedTargetCount: Math.ceil(shard.nodeCount / this._config.maxNodesPerRange),
        })
        continue // split 优先级高于 migrate，跳过后续检测
      }

      // 模式 2：migrate — 热点分片可迁往低负载节点
      if (shard.isHot || shard.qps > this._config.hotQpsThreshold || shard.avgLatencyMs > this._config.hotLatencyMsThreshold) {
        // 找负载最低的不同节点
        const bestNode = lowLoadNodes.find(n => n.nodeId !== shard.localNodeId)
        if (bestNode) {
          // 检查当前节点的分片分布是否均衡
          const currentNode = nodes.find(n => n.nodeId === shard.localNodeId)
          const avgShardsPerNode = nodes.length > 0
            ? nodes.reduce((s, n) => s + n.shardCount, 0) / nodes.length
            : 1
          const shouldMigrate = currentNode
            ? currentNode.shardCount > avgShardsPerNode * this._config.maxShardImbalanceRatio
            : false

          if (shouldMigrate) {
            candidates.push({
              type: 'migrate',
              rangeId: shard.rangeId,
              reason: `hot shard (qps=${shard.qps}, latency=${shard.avgLatencyMs}ms) on overloaded node`,
              priority: 5,
              targetNodeId: bestNode.nodeId,
            })
            continue
          }
        }
      }

      // 模式 3：merge — 分片过小，建议合并
      if (shard.nodeCount < this._config.minNodesPerRange && shards.length > 1) {
        candidates.push({
          type: 'merge',
          rangeId: shard.rangeId,
          reason: `node_count ${shard.nodeCount} < min ${this._config.minNodesPerRange}`,
          priority: 8,
        })
      }
    }

    // 按优先级排序（低 = 紧急）
    candidates.sort((a, b) => a.priority - b.priority)
    return candidates.slice(0, this._config.maxSuggestionsPerCycle)
  }

  /**
   * B-10: 报告建议的执行结果（反馈闭环）
   *
   * 调用方（如 ReshardManager）在完成/拒绝一个建议后调用此方法，
   * 将结果反馈给 GlobalScheduler，用于优化后续调度决策。
   *
   * @param rangeId 分片 ID
   * @param type 建议类型
   * @param result 执行结果：'accepted' | 'rejected' | 'ignored'
   */
  reportResult(rangeId: string, type: SuggestionType, result: 'accepted' | 'rejected' | 'ignored'): void {
    const key = `${type}:${rangeId}`
    const entry = this._suggestionHistory.get(key)
    if (entry) {
      entry.result = result
      entry.resultAt = Date.now()
      this._logger.info(`Suggestion feedback: ${key} → ${result}`)

      // 如果建议被拒绝，清除 skipList 以允许后续重试
      if (result === 'rejected') {
        this._skipList.delete(rangeId)
      }
      // 如果建议被接受，延长 skipList 时长
      if (result === 'accepted') {
        // 接受后保持在 skipList 中，防止同周期重复建议
      }
      // ignored：保持现状
    }
  }

  /**
   * B-10: 获取建议历史
   */
  getSuggestionHistory(): Array<{ suggestion: GlobalSuggestion; emittedAt: number; result?: string; resultAt?: number }> {
    return Array.from(this._suggestionHistory.values()).map(e => ({
      suggestion: e.suggestion,
      emittedAt: e.emittedAt,
      result: e.result,
      resultAt: e.resultAt,
    }))
  }

  /**
   * B-10: 获取已接受建议的数量
   */
  getAcceptedCount(): number {
    let count = 0
    for (const [, entry] of this._suggestionHistory) {
      if (entry.result === 'accepted') count++
    }
    return count
  }
}
