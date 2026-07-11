/**
 * GraphPartitioner — 图分割工具
 *
 * 将图划分为多个分区（partition），支持：
 *   - Louvain-based 切分：使用社区发现结果将图划分为自然组团
 *   - Greedy 切分：METIS 简化版 — 贪心 BFS 逐层扩展
 *   - Edge-cut / Vertex-cut 策略
 *   - 分区元数据输出
 *
 * 分区编号从 0 开始到 numPartitions-1。
 */

import { NodeId } from '../types'
import { louvainCommunity } from '../algorithms/louvain'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type PartitionStrategy = 'edge-cut' | 'vertex-cut'
export type PartitionMethod = 'louvain' | 'greedy'

export interface GraphPartitionerOptions {
  /** 分区数量 (仅 greedy 使用) */
  numPartitions?: number
  /** 分割策略 */
  strategy?: PartitionStrategy
  /** 分割方法 */
  method?: PartitionMethod
  /** 用于 louvain 的边权重，默认每条边权重为 1 */
  edgeWeights?: Array<{ src: number; dst: number; weight: number }>
  /** Louvain 平衡因子 (0~1)，控制合并环节的平衡度，默认 0.3 */
  balanceFactor?: number
  /** 每个分区的最大节点数限制 (仅 greedy 使用) */
  maxPartitionSize?: number
  /** Louvain 社区发现的最小社区大小（小于此值的社区合并到最近社区），默认 1 */
  minCommunitySize?: number
}

export interface PartitionMetadata {
  /** 分区编号 */
  partitionId: number
  /** 分区内节点数 */
  nodeCount: number
  /** 分区内边数 */
  edgeCount: number
  /** 连接该分区与其它分区的边数（cut edges） */
  cutEdges: number
  /** 分区节点占全部节点的比例 */
  nodeRatio: number
}

export interface GraphPartitionerResult {
  /** nodeId → partitionId 映射 */
  assignment: Map<NodeId, number>
  /** 分区元数据数组 */
  partitions: PartitionMetadata[]
  /** 总 cut edge 数量 (edge-cut) 或总 cut vertex 数 (vertex-cut) */
  cutSize: number
  /** 平衡度度量 (0~1)，1 = 完全平衡 */
  balance: number
  /** 分割方法 */
  method: PartitionMethod
  /** 使用的策略 */
  strategy: PartitionStrategy
}

// ──────────────────────────────────────────
// GraphPartitioner 类
// ──────────────────────────────────────────

export class GraphPartitioner {
  private vertices: NodeId[]
  private adjacency: Map<NodeId, NodeId[]>  // 无向邻接表

  /**
   * @param vertices - 所有Node ID
   * @param edges - 无向边 (src, dst)
   */
  constructor(vertices: NodeId[], edges: Array<{ src: NodeId; dst: NodeId }>) {
    this.vertices = [...vertices]
    this.adjacency = new Map()
    for (const v of vertices) {
      this.adjacency.set(v, [])
    }
    for (const { src, dst } of edges) {
      if (this.adjacency.has(src)) {
        this.adjacency.get(src)!.push(dst)
      }
      if (this.adjacency.has(dst)) {
        this.adjacency.get(dst)!.push(src)
      }
    }
  }

  /**
   * 运行图分割
   *
   * @param options - 分割选项
   * @returns 分割结果
   */
  public partition(options?: GraphPartitionerOptions): GraphPartitionerResult {
    const method = options?.method ?? 'louvain'
    const strategy = options?.strategy ?? 'edge-cut'

    if (method === 'louvain') {
      return this._louvainPartition(options, strategy)
    } else {
      return this._greedyPartition(options, strategy)
    }
  }

  /**
   * Louvain-based 分区
   *   - 先用 Louvain 算法做社区发现
   *   - 然后贪心合并小社区直到达到目标分区数
   *   - 社区即分区
   */
  private _louvainPartition(options: GraphPartitionerOptions | undefined, strategy: PartitionStrategy): GraphPartitionerResult {
    const balanceFactor = options?.balanceFactor ?? 0.3
    const minCommunitySize = options?.minCommunitySize ?? 1

    // Step 1: 运行 Louvain 社区发现
    const weightedEdges = options?.edgeWeights ?? this.vertices.flatMap((v) =>
      (this.adjacency.get(v) ?? []).filter((n) => v < n).map((n) => ({
        src: v as number,
        dst: n as number,
        weight: 1,
      })),
    )

    const louvainResult = louvainCommunity(
      this.vertices.map(Number),
      Array.from(weightedEdges),
    )

    const communityMap = louvainResult.communities as Map<number, number>

    // Step 2: 收集社区Info
    const commNodes = new Map<number, NodeId[]>()
    for (const v of this.vertices) {
      const commId = communityMap.get(v as number)!
      if (!commNodes.has(commId)) commNodes.set(commId, [])
      commNodes.get(commId)!.push(v)
    }

    let communities = Array.from(commNodes.entries()).map(([commId, nodes]) => ({
      commId,
      nodes,
    }))

    // Step 3: 合并小社区
    if (minCommunitySize > 1) {
      communities = this._mergeSmallCommunities(communities, minCommunitySize)
    }

    const numPartitions = options?.numPartitions
    let finalCommunities = communities

    // Step 4: 如果社区数量超过目标分区数，贪心合并
    if (numPartitions !== undefined && communities.length > numPartitions) {
      finalCommunities = this._greedyMergeCommunities(communities, numPartitions, balanceFactor)
    }

    // Step 5: 构建 assignment
    const assignment = new Map<NodeId, number>()
    finalCommunities.forEach((comm, idx) => {
      for (const node of comm.nodes) {
        assignment.set(node, idx)
      }
    })

    // Step 6: 统计分区元数据
    return this._buildResult(assignment, strategy, 'louvain')
  }

  /**
   * Greedy 分区 — METIS 简化版
   *   - 通过 BFS 从种子节点扩展分区
   *   - 每次将最邻接的未分配节点纳入当前分区
   *   - 达到 maxPartitionSize 后创建新分区
   */
  private _greedyPartition(options: GraphPartitionerOptions | undefined, strategy: PartitionStrategy): GraphPartitionerResult {
    const numPartitions = options?.numPartitions ?? Math.max(2, Math.ceil(this.vertices.length / 10))
    const maxSize = options?.maxPartitionSize ?? Math.ceil(this.vertices.length / numPartitions)

    const assignment = new Map<NodeId, number>()
    const unassigned = new Set(this.vertices)

    let partitionId = 0
    let lastFrontier: NodeId[] = []

    while (unassigned.size > 0 && partitionId < numPartitions) {
      // 选择一个种子节点（优先从上一分区的邻接节点中选择）
      let seed: NodeId | null = null

      if (lastFrontier.length > 0) {
        for (const f of lastFrontier) {
          if (unassigned.has(f)) {
            seed = f
            break
          }
        }
      }

      if (seed === null) {
        // 任意选取一个未分配节点
        seed = unassigned.values().next().value ?? null
      }

      if (seed === null) break

      // BFS 扩展
      const queue: NodeId[] = [seed]
      const visited = new Set<NodeId>([seed])
      const partitionNodes: NodeId[] = []
      let queueHead = 0

      while (queueHead < queue.length && partitionNodes.length < maxSize) {
        const current = queue[queueHead++]
        if (assignment.has(current)) continue

        assignment.set(current, partitionId)
        partitionNodes.push(current)
        unassigned.delete(current)

        // 将邻居加入队列（优先选择连接数多的）
        const neighbors = this.adjacency.get(current) ?? []
        for (const n of neighbors) {
          if (!visited.has(n) && unassigned.has(n)) {
            visited.add(n)
            queue.push(n)
          }
        }
      }

      // 记录 frontier（当前分区相邻的未分配节点）
      lastFrontier = []
      for (const node of partitionNodes) {
        for (const n of this.adjacency.get(node) ?? []) {
          if (unassigned.has(n)) {
            lastFrontier.push(n)
          }
        }
      }

      partitionId++
    }

    // 如果还有未分配节点，分配给已有分区
    let remainingIdx = 0
    for (const node of unassigned) {
      assignment.set(node, remainingIdx % partitionId)
      remainingIdx++
    }

    return this._buildResult(assignment, strategy, 'greedy')
  }

  /**
   * 合并小社区到相邻的大社区
   */
  private _mergeSmallCommunities(
    communities: Array<{ commId: number; nodes: NodeId[] }>,
    minSize: number,
  ): Array<{ commId: number; nodes: NodeId[] }> {
    const commNodeCount = new Map<number, number>()
    const commMap = new Map<number, NodeId[]>()
    for (const c of communities) {
      commNodeCount.set(c.commId, c.nodes.length)
      commMap.set(c.commId, c.nodes)
    }

    // 找到每个社区到其他社区的连接数
    const commConnections = new Map<number, Map<number, number>>()
    for (const c of communities) {
      const connections = new Map<number, number>()
      for (const node of c.nodes) {
        for (const neighbor of this.adjacency.get(node) ?? []) {
          const neighborComm = this._findCommunity(neighbor, communities)
          if (neighborComm !== c.commId && neighborComm !== undefined) {
            connections.set(neighborComm, (connections.get(neighborComm) ?? 0) + 1)
          }
        }
      }
      commConnections.set(c.commId, connections)
    }

    // 标记小社区，合并到连接最多的社区
    const merged = new Set<number>()
    const remaining: Array<{ commId: number; nodes: NodeId[] }> = []

    for (const c of communities) {
      if (c.nodes.length >= minSize || merged.has(c.commId)) {
        if (!merged.has(c.commId)) {
          remaining.push(c)
        }
        continue
      }

      const connections = commConnections.get(c.commId) ?? new Map()
      let bestTarget: number | null = null
      let bestCount = -1

      for (const [target, count] of connections) {
        if (!merged.has(target) && count > bestCount) {
          bestTarget = target
          bestCount = count
        }
      }

      if (bestTarget !== null && commMap.has(bestTarget)) {
        // 合并到 target
        const targetNodes = commMap.get(bestTarget)!
        targetNodes.push(...c.nodes)
        merged.add(c.commId)
      } else {
        remaining.push(c)
      }
    }

    // 重建 communities 列表
    return remaining.map((c) => ({
      commId: c.commId,
      nodes: commMap.get(c.commId)!,
    }))
  }

  /**
   * 贪心合并社区到目标数量
   */
  private _greedyMergeCommunities(
    communities: Array<{ commId: number; nodes: NodeId[] }>,
    targetCount: number,
    _balanceFactor: number,
  ): Array<{ commId: number; nodes: NodeId[] }> {
    // 按大小排序
    let comms = communities.map((c) => ({
      ...c,
      size: c.nodes.length,
    }))

    while (comms.length > targetCount) {
      // 找到连接最紧密的两个相邻社区，合并最小的那个到它的最佳邻居
      let bestMerge: { fromIdx: number; toIdx: number; connectionCount: number } | null = null

      for (let i = 0; i < comms.length; i++) {
        let maxConnections = 0
        let maxTarget = -1

        for (const node of comms[i].nodes) {
          for (const neighbor of this.adjacency.get(node) ?? []) {
            for (let j = 0; j < comms.length; j++) {
              if (i === j) continue
              if (comms[j].nodes.includes(neighbor as NodeId)) {
                maxConnections++
                if (maxConnections > (bestMerge?.connectionCount ?? 0)) {
                  maxTarget = j
                }
              }
            }
          }
        }

        if (maxTarget >= 0 && (bestMerge === null || maxConnections > bestMerge.connectionCount)) {
          bestMerge = { fromIdx: i, toIdx: maxTarget, connectionCount: maxConnections }
        }
      }

      if (bestMerge === null) {
        // 孤立社区，合并最小的两个
        let smallest = 0
        for (let i = 1; i < comms.length; i++) {
          if (comms[i].size < comms[smallest].size) smallest = i
        }
        bestMerge = { fromIdx: smallest, toIdx: (smallest + 1) % comms.length, connectionCount: 0 }
      }

      // 执行合并
      const from = comms[bestMerge.fromIdx]
      const to = comms[bestMerge.toIdx]
      to.nodes.push(...from.nodes)
      to.size += from.size
      comms.splice(bestMerge.fromIdx, 1)
    }

    return comms.map((c) => ({ commId: c.commId, nodes: c.nodes }))
  }

  /**
   * 查找节点所属的社区
   */
  private _findCommunity(
    node: NodeId,
    communities: Array<{ commId: number; nodes: NodeId[] }>,
  ): number | undefined {
    for (const c of communities) {
      if (c.nodes.includes(node)) return c.commId
    }
    return undefined
  }

  /**
   * 构建分割结果
   */
  private _buildResult(
    assignment: Map<NodeId, number>,
    strategy: PartitionStrategy,
    method: PartitionMethod,
  ): GraphPartitionerResult {
    // 收集分区Info
    const partitionNodes = new Map<number, NodeId[]>()
    for (const [node, partId] of assignment) {
      if (!partitionNodes.has(partId)) partitionNodes.set(partId, [])
      partitionNodes.get(partId)!.push(node)
    }

    // Edge-cut: 边跨越了多少分区
    let cutSize = 0
    const edgeSet = new Set<string>()

    for (const [node, neighbors] of this.adjacency) {
      const nodePart = assignment.get(node)!
      for (const neighbor of neighbors) {
        const edgeKey = node < neighbor ? `${node}:${neighbor}` : `${neighbor}:${node}`
        if (edgeSet.has(edgeKey)) continue
        edgeSet.add(edgeKey)

        const neighborPart = assignment.get(neighbor)
        if (neighborPart !== undefined && nodePart !== neighborPart) {
          cutSize++
        }
      }
    }

    const totalNodes = this.vertices.length
    const partitions: PartitionMetadata[] = []

    for (const [partId, nodes] of partitionNodes) {
      let edgeCount = 0
      for (const node of nodes) {
        for (const neighbor of this.adjacency.get(node) ?? []) {
          if (assignment.get(neighbor) === partId) {
            edgeCount++
          }
        }
      }

      // 计算与该分区相关的 cut edges
      let cutEdges = 0
      for (const node of nodes) {
        for (const neighbor of this.adjacency.get(node) ?? []) {
          if (assignment.get(neighbor) !== partId) {
            cutEdges++
          }
        }
      }

      partitions.push({
        partitionId: partId,
        nodeCount: nodes.length,
        edgeCount: Math.floor(edgeCount / 2),
        cutEdges,
        nodeRatio: nodes.length / totalNodes,
      })
    }

    // 平衡度: (最小分区大小 / 最大分区大小)
    const sizes = partitions.map((p) => p.nodeCount)
    const maxSize = Math.max(...sizes)
    const minSize = Math.min(...sizes)
    const balance = maxSize > 0 ? minSize / maxSize : 0

    return {
      assignment,
      partitions,
      cutSize,
      balance,
      method,
      strategy,
    }
  }
}
