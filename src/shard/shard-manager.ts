import { RangeInstance } from './range-instance'
import { ShardRouter } from './shard-router'
import { HlcClock } from '../replication/hlc-clock'
import {
  NodeId, NodeRecord, EdgeRecord,
  UpsertNodeOptions, UpsertEdgeOptions,
  VectorSearchOptions, VectorSearchResult,
  ShardMap, RaftOperation,
} from '../types'
import { Telemetry } from '../ops/otel'
import { MetricsCollector } from '../ops/otel-metrics'

/**
 * ShardManager — 全局分片管理器
 *
 * 职责：
 * 1. 管理所有 RangeInstance 的生命周期
 * 2. 单 key 操作直接路由到对应 Range
 * 3. 跨 Range 操作（向量搜索）执行 fan-out
 */
export class ShardManager {
  private ranges: Map<string, RangeInstance> = new Map()
  private router: ShardRouter
  private clock: HlcClock
  private shardMap: ShardMap
  private telemetry: Telemetry
  private metrics: MetricsCollector

  constructor(shardMap: ShardMap, clock: HlcClock) {
    this.shardMap = shardMap
    this.clock = clock
    this.router = new ShardRouter(shardMap)
    this.telemetry = Telemetry.getInstance()
    this.metrics = MetricsCollector.getInstance()
  }

  async start(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const rangeConfig of this.shardMap.ranges) {
      const instance = new RangeInstance(rangeConfig, this.clock)
      promises.push(instance.start())
      this.ranges.set(rangeConfig.rangeId, instance)
    }
    await Promise.all(promises)
    // 单节点 Raft 需要等待选举完成（默认 150-300ms 超时窗口）
    // 这里等所有 range 的 Raft 就绪
    for (const [_, instance] of this.ranges) {
      try {
        await Promise.race([
          instance.raft.waitForLeader(2000),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ])
      } catch {
        // 单节点 leader 超时是正常的；跳过
      }
    }
  }

  async stop(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [_, instance] of this.ranges) {
      promises.push(instance.stop())
    }
    await Promise.all(promises)
    this.ranges.clear()
  }

  getRange(rangeId: string): RangeInstance {
    const instance = this.ranges.get(rangeId)
    if (!instance) throw new Error(`Range not found: ${rangeId}`)
    return instance
  }

  getRouter(): ShardRouter {
    return this.router
  }

  /** 写入节点 — 一致性哈希路由 */
  async upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): Promise<NodeId> {
    return this.telemetry.traceAsync('shard.upsertNode', async () => {
      const start = Date.now()
      const rangeId = this.router.getRangeForKey(name)
      const range = this.getRange(rangeId)
      const result = await range.write({
        type: 'upsert_node',
        payload: { typeId, name, opts },
      })
      this.metrics.incrementCounter('graph.ops.writes')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      if (typeof result === 'number') return result
      return typeId
    })
  }

  /** 写入边 — 跟随源节点路由 */
  async upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): Promise<void> {
    const rangeId = this.router.getRange(src)
    const range = this.getRange(rangeId)
    await range.write({
      type: 'upsert_edge',
      payload: { src, dst, typeId, opts },
    })
  }

  /** Batch 写入多个节点 — 按 shard 分组并行写入 */
  async batchUpsertNodes(
    inputs: Array<{ typeId: number; name: string; opts?: UpsertNodeOptions }>
  ): Promise<number[]> {
    if (inputs.length === 0) return []

    // 按 rangeId 分组
    const groups = new Map<string, typeof inputs>()
    for (const input of inputs) {
      const rangeId = this.router.getRangeForKey(input.name)
      const group = groups.get(rangeId)
      if (group) {
        group.push(input)
      } else {
        groups.set(rangeId, [input])
      }
    }

    // 每个 range 并发发出 batch_upsert 操作
    const promises: Promise<unknown>[] = []
    const rangeOrder: string[] = []
    for (const [rangeId, groupInputs] of groups) {
      const range = this.getRange(rangeId)
      rangeOrder.push(rangeId)
      promises.push(range.write({
        type: 'batch_upsert',
        payload: { inputs: groupInputs },
      }))
    }

    // 按 range 分组收集结果 (Record<string, NodeId>)
    const results = await Promise.all(promises) as Record<string, number>[]

    // 按原始输入顺序重建 ID 数组
    const nameToId = new Map<string, number>()
    for (const nameMap of results) {
      for (const [name, id] of Object.entries(nameMap)) {
        nameToId.set(name, id)
      }
    }

    const allIds: number[] = []
    for (const input of inputs) {
      const id = nameToId.get(input.name)
      if (id === undefined) {
        throw new Error(`Batch upsert did not return an ID for node "${input.name}"`)
      }
      allIds.push(id)
    }

    return allIds
  }

  /** Batch 写入多条边 — 按源节点 shard 分组并行写入 */
  async batchUpsertEdges(
    inputs: Array<{ src: NodeId; dst: NodeId; typeId: number; opts?: UpsertEdgeOptions }>
  ): Promise<void> {
    if (inputs.length === 0) return

    // 按 src 节点的 range 分组
    const groups = new Map<string, typeof inputs>()
    for (const input of inputs) {
      const rangeId = this.router.getRange(input.src)
      const group = groups.get(rangeId)
      if (group) {
        group.push(input)
      } else {
        groups.set(rangeId, [input])
      }
    }

    // 每个 range 并发发出 batch_edge 操作
    const promises: Promise<unknown>[] = []
    for (const [rangeId, groupInputs] of groups) {
      const range = this.getRange(rangeId)
      promises.push(range.write({
        type: 'batch_edge',
        payload: { inputs: groupInputs },
      }))
    }

    await Promise.all(promises)
  }

  /** 读取节点 */
  async getNode(id: NodeId): Promise<NodeRecord | null> {
    return this.telemetry.traceAsync('shard.getNode', async () => {
      const start = Date.now()
      const rangeId = this.router.getRange(id)
      const range = this.getRange(rangeId)
      const result = await range.read(engine => engine.getNode(id))
      this.metrics.incrementCounter('graph.ops.reads')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      return result
    })
  }

  /** 删除节点 */
  async deleteNode(id: NodeId): Promise<void> {
    const rangeId = this.router.getRange(id)
    const range = this.getRange(rangeId)
    await range.write({ type: 'delete_node', payload: { id } })
  }

  /** 邻居遍历 */
  async neighbors(id: NodeId, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: EdgeRecord[]; nodes: NodeRecord[]
  }> {
    return this.telemetry.traceAsync('shard.neighbors', async () => {
      const start = Date.now()
      const rangeId = this.router.getRange(id)
      const range = this.getRange(rangeId)
      const result = await range.read(engine => engine.neighbors(id, opts))
      this.metrics.incrementCounter('graph.ops.reads')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      return result
    })
  }

  /** 向量搜索 — fan-out 到所有 Range */
  async vectorSearch(query: VectorSearchOptions): Promise<VectorSearchResult[]> {
    return this.telemetry.traceAsync('shard.vectorSearch', async () => {
      const start = Date.now()
      const promises: Promise<VectorSearchResult[]>[] = []
      for (const [_, range] of this.ranges) {
        promises.push(range.read(engine => engine.vectorSearch(query)))
      }
      const allResults = await Promise.all(promises)
      const merged: VectorSearchResult[] = []
      for (const res of allResults) merged.push(...res)
      merged.sort((a, b) => b.score - a.score)
      const topK = merged.slice(0, query.k ?? 10)
      this.metrics.incrementCounter('graph.ops.reads')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      return topK
    })
  }

  /** 图算法 — 需要全局执行 */
  async personalizedPageRank(opts: { sourceNode: NodeId; topK?: number }): Promise<{ nodeId: number; score: number }[]> {
    // PPR 需要全局图 — 简化为在第一个 Range 上执行
    const firstRange = this.ranges.values().next().value
    if (!firstRange) return []
    return firstRange.read(engine => engine.personalizedPageRank({
      sourceNode: opts.sourceNode,
      topK: opts.topK,
    }))
  }

  /** 获取分片状态 */
  getShardStatus(): { rangeId: string; raftRole: string; nodeCount: number }[] {
    const result: { rangeId: string; raftRole: string; nodeCount: number }[] = []
    for (const [rangeId, instance] of this.ranges) {
      const status = instance.getStatus()
      result.push({ rangeId, raftRole: status.raft.role, nodeCount: status.storage.nodeCount })
    }
    return result
  }

  /** 获取所有 Range 实例（用于 Resharding） */
  getAllRanges(): Map<string, RangeInstance> {
    return this.ranges
  }

  /** 添加 Range（用于 Resharding 双写阶段） */
  addRange(rangeId: string, instance: RangeInstance): void {
    this.ranges.set(rangeId, instance)
  }

  /** 移除 Range（用于 Resharding 清理阶段） */
  removeRange(rangeId: string): void {
    this.ranges.delete(rangeId)
  }

  /** 重建路由表 */
  rebuildRouter(shardMap: ShardMap): void {
    this.shardMap = shardMap
    this.router.rebuild(shardMap)
  }
}
