import { LRUCache } from 'lru-cache'
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
 *
 * 路由一致性：
 * - 所有节点操作统一按名称（prefixedName）路由
 * - 维护 _nodeIdToName 缓存将 NodeId 映射回名称
 * - upsertNode 写入后更新缓存
 * - getNode/deleteNode/neighbors 先查缓存，按名称路由
 * - upsertEdge 按源节点名称路由
 */
export class ShardManager {
  private ranges: Map<string, RangeInstance> = new Map()
  private router: ShardRouter
  private clock: HlcClock
  private shardMap: ShardMap
  private telemetry: Telemetry
  private metrics: MetricsCollector

  /** nodeId → prefixedName 缓存（LRU），确保按名称路由一致性 */
  private _nodeIdToName = new LRUCache<NodeId, string>({
    max: 10_000_000,
    ttl: 24 * 60 * 60 * 1000,
  })

  /**
   * Smart Sharding: range 亲和度计数器
   * Map<rangeId, Map<typeId, count>>
   * 统计每个 range 上各类型的数据量，用于智能路由决策
   */
  private _rangeTypeAffinity: Map<string, Map<number, number>> = new Map()

  constructor(shardMap: ShardMap, clock: HlcClock) {
    this.shardMap = shardMap
    this.clock = clock
    this.router = new ShardRouter(shardMap)
    this.telemetry = Telemetry.getInstance()
    this.metrics = MetricsCollector.getInstance()
    // 初始化每个 range 的亲和度计数器
    for (const rc of shardMap.ranges) {
      this._rangeTypeAffinity.set(rc.rangeId, new Map())
    }
  }

  /**
   * 根据节点 ID 获取目标 Range
   * 优先使用缓存的名称路由，回退到 String(id) 路由
   * 缓存 miss 概率很低：upsertNode 写入缓存 + 持久化 _rangeKey 到 props，
   * getNode 在每次读取后会从 _rangeKey 恢复缓存。
   */
  private _getRangeForNodeId(id: NodeId): string {
    const name = this._nodeIdToName.get(id)
    if (name !== undefined) {
      return this.router.getRangeForKey(name)
    }
    // 缓存 miss 时回退到 String(id) 路由（无法保证与 upsert 一致，但为防止 crash）
    return this.router.getRangeForKey(String(id))
  }

  /** 获取节点名称缓存（用于测试/诊断） */
  getNodeName(id: NodeId): string | undefined {
    return this._nodeIdToName.get(id)
  }

  /** 获取亲和度计数器（用于测试/诊断） */
  getRangeAffinity(rangeId: string): Map<number, number> | undefined {
    return this._rangeTypeAffinity.get(rangeId)
  }

  /**
   * Smart Routing（智能路由）
   *
   * 为新节点选择最佳的 Range。
   * 如果有 Range 已经拥有该 typeId 的数据，优先选择数据最多的 Range，
   * 以尽量减少跨 Range 查询。如果没有任何 Range 有该 typeId 的数据，
   * 则回退到一致性哈希路由。
   */
  private _smartRoute(name: string, typeId: number): string {
    // 查找对此 typeId 亲和度最高的 range
    let bestRangeId: string | null = null
    let bestAffinity = -1

    for (const [rangeId, typeCounts] of this._rangeTypeAffinity) {
      const count = typeCounts.get(typeId) ?? 0
      if (count > bestAffinity) {
        bestAffinity = count
        bestRangeId = rangeId
      }
    }

    if (bestRangeId !== null && bestAffinity > 0) {
      return bestRangeId
    }

    // 没有任何 range 有此类型数据，回退到一致性哈希
    return this.router.getRangeForKey(name)
  }

  /** 递增指定 range 上某 typeId 的亲和度计数 */
  private _incrementAffinity(rangeId: string, typeId: number): void {
    let typeCounts = this._rangeTypeAffinity.get(rangeId)
    if (!typeCounts) {
      typeCounts = new Map()
      this._rangeTypeAffinity.set(rangeId, typeCounts)
    }
    typeCounts.set(typeId, (typeCounts.get(typeId) ?? 0) + 1)
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
          instance.waitForLeader(2000),
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

  /** 写入节点 — 一致性哈希路由（自动添加租户前缀） */
  async upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): Promise<NodeId> {
    return this.telemetry.traceAsync('shard.upsertNode', async () => {
      const start = Date.now()
      const tenantName = name
      const rangeId = this._smartRoute(tenantName, typeId)
      const range = this.getRange(rangeId)
      // 将 _rangeKey 注入 props，用于缓存 miss 时恢复路由键
      const enrichedOpts: UpsertNodeOptions | undefined = opts
        ? { ...opts, props: { ...opts.props, _rangeKey: tenantName } as any }
        : { props: { _rangeKey: tenantName } as any }
      const result = await range.write({
        type: 'upsert_node',
        payload: { typeId, name: tenantName, opts: enrichedOpts },
      })
      this.metrics.incrementCounter('graph.ops.writes')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      const nodeId = typeof result === 'number' ? result : typeId
      // 缓存 nodeId → prefixedName，确保后续按名称路由的一致性
      this._nodeIdToName.set(nodeId, tenantName)
      // Smart Sharding: 递增目标 range 上此 typeId 的亲和度计数
      this._incrementAffinity(rangeId, typeId)
      return nodeId
    })
  }

  /** 写入边 — 跟随源节点（按名称）路由 */
  async upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): Promise<void> {
    const rangeId = this._getRangeForNodeId(src)
    const range = this.getRange(rangeId)
    await range.write({
      type: 'upsert_edge',
      payload: { src, dst, typeId, opts },
    })
  }

  /** Batch 写入多个节点 — 按 shard 分组并行写入（自动添加租户前缀） */
  async batchUpsertNodes(
    inputs: Array<{ typeId: number; name: string; opts?: UpsertNodeOptions }>
  ): Promise<number[]> {
    if (inputs.length === 0) return []

    // 应用租户前缀到所有名称
    const prefixedInputs = inputs.map(input => ({
      ...input,
      name: input.name,
    }))

    // 按 rangeId 分组
    const groups = new Map<string, typeof prefixedInputs>()
    for (const input of prefixedInputs) {
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
    // 结果 key 是带前缀的名称（如在 tenant 上下文中），需匹配 prefixedInputs
    const prefixedNameToId = new Map<string, number>()
    for (const nameMap of results) {
      for (const [name, id] of Object.entries(nameMap)) {
        prefixedNameToId.set(name, id)
      }
    }

    const allIds: number[] = []
    for (const prefixed of prefixedInputs) {
      const id = prefixedNameToId.get(prefixed.name)
      if (id === undefined) {
        throw new Error(`Batch upsert did not return an ID for node "${prefixed.name}"`)
      }
      allIds.push(id)
    }

    // 缓存所有 nodeId → prefixedName 映射，确保后续路由一致性
    for (let i = 0; i < allIds.length; i++) {
      this._nodeIdToName.set(allIds[i], prefixedInputs[i].name)
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
      const rangeId = this._getRangeForNodeId(input.src)
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

  /** 读取节点 — 按名称路由（通过 nodeId→name 缓存） */
  async getNode(id: NodeId): Promise<NodeRecord | null> {
    return this.telemetry.traceAsync('shard.getNode', async () => {
      const start = Date.now()
      const rangeId = this._getRangeForNodeId(id)
      const range = this.getRange(rangeId)
      const result = await range.read(engine => engine.getNode(id))
      this.metrics.incrementCounter('graph.ops.reads')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      // 缓存 miss 时，从 node props 中的 _rangeKey 恢复路由键
      if (result) {
        const rangeKey = (result.props as any)?._rangeKey
        if (rangeKey) {
          this._nodeIdToName.set(id, rangeKey)
        }
      }
      return result
    })
  }

  /** 删除节点 — 按名称路由 */
  async deleteNode(id: NodeId): Promise<void> {
    const rangeId = this._getRangeForNodeId(id)
    const range = this.getRange(rangeId)
    await range.write({ type: 'delete_node', payload: { id } })
    // 清理缓存
    this._nodeIdToName.delete(id)
  }

  /** 按类型查找节点 — fan-out 到所有 Range */
  async findNodesByType(typeId: number): Promise<number[]> {
    return this.telemetry.traceAsync('shard.findNodesByType', async () => {
      const start = Date.now()
      const promises: Promise<number[]>[] = []
      for (const [_, range] of this.ranges) {
        promises.push(range.read(engine => engine.findNodesByType(typeId)))
      }
      const allResults = await Promise.all(promises)
      const merged: number[] = []
      for (const res of allResults) merged.push(...res)
      this.metrics.incrementCounter('graph.ops.reads')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      return merged
    })
  }

  /** 按属性查找节点 — fan-out 到所有 Range */
  async findNodesByProperty(typeId: number, propKey: string, propValue: unknown): Promise<number[]> {
    return this.telemetry.traceAsync('shard.findNodesByProperty', async () => {
      const start = Date.now()
      const promises: Promise<number[]>[] = []
      for (const [_, range] of this.ranges) {
        promises.push(range.read(engine => engine.findNodesByProperty(typeId, propKey, propValue)))
      }
      const allResults = await Promise.all(promises)
      const merged: number[] = []
      for (const res of allResults) merged.push(...res)
      this.metrics.incrementCounter('graph.ops.reads')
      this.metrics.recordHistogram('graph.ops.latency', Date.now() - start)
      return merged
    })
  }

  /** 邻居遍历 */
  async neighbors(id: NodeId, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: EdgeRecord[]; nodes: NodeRecord[]
  }> {
    return this.telemetry.traceAsync('shard.neighbors', async () => {
      const start = Date.now()
      const rangeId = this._getRangeForNodeId(id)
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

  /** 图算法 — 跨所有 Range 执行 */
  async personalizedPageRank(opts: { sourceNode: NodeId; topK?: number }): Promise<{ nodeId: number; score: number }[]> {
    const topK = opts.topK ?? 10
    const alpha = 0.85
    const tolerance = 1e-6
    const maxIter = 100

    if (this.ranges.size === 0) return []

    // ── 阶段 1: 从 sourceNode 出发，跨所有 Range 收集可达节点（BFS） ──
    const reachable = new Set<number>()

    // 先确认源节点存在
    const sourceRangeId = this._getRangeForNodeId(opts.sourceNode)
    const sourceRange = this.ranges.get(sourceRangeId)
    if (!sourceRange) return []

    const sourceNode = await sourceRange.read(e => e.getNode(opts.sourceNode))
    if (!sourceNode) return []

    // BFS 队列
    const queue: number[] = [opts.sourceNode]
    reachable.add(opts.sourceNode)

    // 限制 BFS 节点数，防止 OOM
    const MAX_NODES = 50000

    while (queue.length > 0 && reachable.size < MAX_NODES) {
      const current = queue.shift()!
      const currentRangeId = this._getRangeForNodeId(current)
      const currentRange = this.ranges.get(currentRangeId)
      if (!currentRange) continue

      const { edges } = await currentRange.read(e => e.neighbors(current))
      for (const edge of edges) {
        if (!reachable.has(edge.dst) && reachable.size < MAX_NODES) {
          reachable.add(edge.dst)
          queue.push(edge.dst)
        }
      }
    }

    if (reachable.size === 0) return []
    const N = reachable.size

    // ── 阶段 2: 为所有可达节点构建内存 out-degree ──
    // 将节点按所在 Range 分组，批量查询 neighbors 以减少跨 Range 调用
    const nodeToRange = new Map<number, string>()
    for (const nodeId of reachable) {
      nodeToRange.set(nodeId, this._getRangeForNodeId(nodeId))
    }

    // 按 Range 分组查询
    const rangeGrouped = new Map<string, number[]>()
    for (const [nodeId, rid] of nodeToRange) {
      const group = rangeGrouped.get(rid)
      if (group) {
        group.push(nodeId)
      } else {
        rangeGrouped.set(rid, [nodeId])
      }
    }

    // out-degree 计数（相对于 reachable 集合内节点）
    const outDegree = new Map<number, number>()

    // 如果跨 Range 场景，按 Range 分组查询，然后本地统计
    for (const [rid, nodeIds] of rangeGrouped) {
      const range = this.ranges.get(rid)
      if (!range) continue
      for (const nodeId of nodeIds) {
        const { edges } = await range.read(e => e.neighbors(nodeId))
        let deg = 0
        for (const edge of edges) {
          if (reachable.has(edge.dst)) deg++
        }
        outDegree.set(nodeId, deg)
      }
    }

    // ── 阶段 3: 幂迭代 PPR（在协调者内存中执行）──
    const rank = new Map<number, number>()
    rank.set(opts.sourceNode, 1)
    // 所有其他节点初始化为 0
    for (const nodeId of reachable) {
      if (nodeId !== opts.sourceNode) {
        rank.set(nodeId, 0)
      }
    }

    const base = (1 - alpha) / N

    for (let iter = 0; iter < maxIter; iter++) {
      const newRank = new Map<number, number>()
      // 初始化所有节点为 base
      for (const nodeId of reachable) {
        newRank.set(nodeId, base)
      }

      // 分配分数
      for (const u of reachable) {
        const ru = rank.get(u) ?? 0
        const deg = outDegree.get(u) ?? 0
        if (deg === 0) continue
        const contribution = (alpha * ru) / deg

        // 对 u 的每个邻居 v：newRank[v] += contribution
        const rid = nodeToRange.get(u)
        const range = rid ? this.ranges.get(rid) : undefined
        if (!range) continue

        const { edges } = await range.read(e => e.neighbors(u))
        for (const edge of edges) {
          if (reachable.has(edge.dst)) {
            newRank.set(edge.dst, (newRank.get(edge.dst) ?? base) + contribution)
          }
        }
      }

      // 检查收敛
      let diff = 0
      for (const nodeId of reachable) {
        diff += Math.abs((newRank.get(nodeId) ?? 0) - (rank.get(nodeId) ?? 0))
      }

      for (const nodeId of reachable) {
        rank.set(nodeId, newRank.get(nodeId) ?? base)
      }

      if (diff < tolerance) break
    }

    // 排序取 topK
    const sorted = [...rank.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)

    return sorted.map(([nodeId, score]) => ({ nodeId, score }))
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
