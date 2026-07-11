/**
 * GraphProjection — 基于 CSR（Compressed Sparse Row）格式的子图投影
 *
 * 从 GraphEngine 加载子图，使用 CSR 数组 { nodeOffsets, edges } 存储邻接表，
 * 支持 O(1) 邻居查询和流式分批迭代。
 *
 * 不加载全图，通过 nodeFilter/edgeFilter/maxDepth 控制子图范围。
 * 适用于 10M+ 节点图上避免 OOM。
 */

import { NodeId, NodeRecord, EdgeRecord } from '../types'
import { GraphEngine } from '../core/graph-engine'

export interface ProjectionOptions {
  /** 节点过滤函数（按 NodeRecord 过滤） */
  nodeFilter?: (node: NodeRecord) => boolean
  /** 边过滤函数（按 EdgeRecord 过滤） */
  edgeFilter?: (edge: EdgeRecord) => boolean
  /** BFS 最大深度（从 seed 节点向外扩展多少跳） */
  maxDepth?: number
  /** 最大节点数上限 */
  maxNodes?: number
  /** 分批大小（用于流式处理） */
  batchSize?: number
  /** 种子节点列表（不提供则扫描所有节点） */
  seedNodes?: NodeId[]
}

export interface ProjectionStats {
  /** 节点总数 */
  nodeCount: number
  /** 边总数 */
  edgeCount: number
  /** 构造耗时（毫秒） */
  constructionTimeMs: number
  /** 内存估算（字节） */
  estimatedMemoryBytes: number
}

/**
 * GraphProjection — 轻量子图投影
 *
 * CSR 格式：
 *   nodeOffsets: 长度为 (nodeCount + 1) 的数组，nodeOffsets[i] 是节点 i 的边起始位置
 *   edges: 所有邻居Node ID 的扁平数组
 *
 * 本地节点的索引映射：projectionNodeIds[i] = 原始 nodeId
 * nodeIndex: Map<nodeId, csrIdx>
 */
export class GraphProjection {
  /** CSR 节点偏移数组 */
  public readonly nodeOffsets: Uint32Array
  /** CSR 边数组 */
  public readonly edges: Uint32Array
  /** 本地 CSR 索引 → 原始 NodeId */
  public readonly projectionNodeIds: number[]
  /** 原始 NodeId → CSR 索引 */
  public readonly nodeIndex: Map<NodeId, number>
  /** 投影的原始 NodeRecord 列表（保持索引顺序） */
  public readonly nodeRecords: NodeRecord[]
  /** 投影统计Info */
  public readonly stats: ProjectionStats

  constructor(
    nodeOffsets: Uint32Array,
    edges: Uint32Array,
    projectionNodeIds: number[],
    nodeIndex: Map<NodeId, number>,
    nodeRecords: NodeRecord[],
    stats: ProjectionStats,
  ) {
    this.nodeOffsets = nodeOffsets
    this.edges = edges
    this.projectionNodeIds = projectionNodeIds
    this.nodeIndex = nodeIndex
    this.nodeRecords = nodeRecords
    this.stats = stats
  }

  /** 投影中的节点总数 */
  get nodeCount(): number {
    return this.stats.nodeCount
  }

  /** 投影中的边总数 */
  get edgeCount(): number {
    return this.stats.edgeCount
  }

  /**
   * O(1) 邻居查询 — 返回指定节点的所有邻居原始 NodeId
   */
  neighbors(nodeId: number): number[] {
    const idx = this.nodeIndex.get(nodeId)
    if (idx === undefined) return []
    const start = this.nodeOffsets[idx]
    const end = this.nodeOffsets[idx + 1]
    const result: number[] = new Array(end - start)
    for (let i = start; i < end; i++) {
      result[i - start] = this.projectionNodeIds[this.edges[i]]
    }
    return result
  }

  /**
   * 返回投影中所有节点的原始 ID
   */
  getNodes(): number[] {
    return this.projectionNodeIds.slice()
  }

  /**
   * 流式分批迭代节点，每批 yield 包含 batchSize 个节点的数组。
   * 用于内存高效的迭代处理。
   */
  async *streamBatches(batchSize: number = 1000): AsyncGenerator<number[]> {
    if (batchSize <= 0) throw new Error('batchSize must be > 0')
    const nodes = this.projectionNodeIds
    for (let i = 0; i < nodes.length; i += batchSize) {
      yield nodes.slice(i, i + batchSize)
    }
  }

  /**
   * P1-S03: 压缩 CSR 数组，移除空洞。
   *
   * 当前 CSR 实现使用 Uint32Array 且没有空洞（每个槽位都填充了有效值），
   * 此方法提供防御性压缩：如果 edges 数组末尾存在全 0 值，将其截断。
   *
   * 在共享内存或内存映射场景中，CSR 可能因为预留空间而产生空洞，
   * 此方法确保内存最紧凑。
   *
   * @returns 压缩后的新 GraphProjection 实例
   */
  compress(): GraphProjection {
    // 检查 edges 末尾是否有全 0 空洞
    let lastEdgeIdx = this.edges.length - 1
    while (lastEdgeIdx >= 0 && this.edges[lastEdgeIdx] === 0) {
      // 还需要检查这个位置是否被任何 offset 使用
      let isUsed = false
      for (let i = 0; i < this.nodeOffsets.length; i++) {
        if (this.nodeOffsets[i] === lastEdgeIdx || this.nodeOffsets[i] === lastEdgeIdx + 1) {
          isUsed = true
          break
        }
      }
      if (isUsed) break
      lastEdgeIdx--
    }
    const compactEdgeLen = lastEdgeIdx + 1

    if (compactEdgeLen >= this.edges.length) {
      return this // 无空洞
    }

    // 创建压缩后的 CSR
    const compressedEdges = new Uint32Array(compactEdgeLen)
    for (let i = 0; i < compactEdgeLen; i++) {
      compressedEdges[i] = this.edges[i]
    }

    return new GraphProjection(
      this.nodeOffsets,
      compressedEdges,
      this.projectionNodeIds,
      this.nodeIndex,
      this.nodeRecords,
      {
        ...this.stats,
        estimatedMemoryBytes:
          this.nodeOffsets.byteLength + compressedEdges.byteLength,
      },
    )
  }

  /**
   * O(indegree) 入边查询 — 返回所有指向指定节点的源节点原始 NodeId。
   *
   * Note: 每次调用都需要遍历整个 CSR 以构建入边列表。
   * 如果需要多次调用，建议手动构建一次 `buildInEdges()` 并缓存。
   */
  inEdges(nodeId: number): number[] {
    const dstIdx = this.nodeIndex.get(nodeId)
    if (dstIdx === undefined) return []
    const result: number[] = []
    const n = this.nodeCount
    for (let srcIdx = 0; srcIdx < n; srcIdx++) {
      const start = this.nodeOffsets[srcIdx]
      const end = this.nodeOffsets[srcIdx + 1]
      for (let ei = start; ei < end; ei++) {
        if (this.edges[ei] === dstIdx) {
          result.push(this.projectionNodeIds[srcIdx])
          break // no duplicate edges expected in CSR
        }
      }
    }
    return result
  }

  /**
   * 从 GraphEngine 构造子图投影
   *
   * 通过 BFS 遍历或种子节点加载子图，构建 CSR 格式的邻接表。
   */
  static async create(
    engine: GraphEngine,
    options?: ProjectionOptions,
  ): Promise<GraphProjection> {
    const startTime = Date.now()

    const nodeFilter = options?.nodeFilter
    const edgeFilter = options?.edgeFilter
    const maxDepth = options?.maxDepth ?? -1 // -1 = unlimited
    const maxNodes = options?.maxNodes ?? 0 // 0 = unlimited

    // 收集节点
    const visited = new Set<NodeId>()
    const seedNodes = options?.seedNodes

    if (seedNodes && seedNodes.length > 0) {
      // BFS 从种子节点扩展
      const queue: { nodeId: NodeId; depth: number }[] = []
      for (const sn of seedNodes) {
        if (!visited.has(sn)) {
          const node = engine.getNode(sn)
          if (node && (!nodeFilter || nodeFilter(node))) {
            visited.add(sn)
            queue.push({ nodeId: sn, depth: 0 })
          }
        }
      }

      let head = 0
      while (head < queue.length) {
        const { nodeId, depth } = queue[head]
        head++

        // 检查 maxDepth
        if (maxDepth >= 0 && depth >= maxDepth) continue

        // 检查 maxNodes
        if (maxNodes > 0 && visited.size >= maxNodes) break

        const { edges: neighborEdges } = engine.neighbors(nodeId)
        for (const edge of neighborEdges) {
          if (edgeFilter && !edgeFilter(edge)) continue

          const neighborId = edge.dst
          if (visited.has(neighborId)) continue

          const neighbor = engine.getNode(neighborId)
          if (!neighbor) continue
          if (nodeFilter && !nodeFilter(neighbor)) continue

          visited.add(neighborId)
          if (maxNodes > 0 && visited.size >= maxNodes) break

          queue.push({ nodeId: neighborId, depth: depth + 1 })
        }

        if (maxNodes > 0 && visited.size >= maxNodes) break
      }
    } else {
      // 无种子节点：扫描所有节点
      // 通过 LabelEngine 或 stats() 获取节点列表
      const stats = engine.stats()
      for (let id = 1; id <= stats.nodeCount + 100; id++) { // 试探性扫描
        try {
          const node = engine.getNode(id)
          if (node && (!nodeFilter || nodeFilter(node))) {
            visited.add(id)
            if (maxNodes > 0 && visited.size >= maxNodes) break
          }
        } catch {
          // skip non-existent ids
        }
      }
    }

    const projectionNodeIds = Array.from(visited)
    const nodeCount = projectionNodeIds.length
    const nodeIndex = new Map<NodeId, number>()
    const nodeRecords: NodeRecord[] = new Array(nodeCount)

    for (let i = 0; i < nodeCount; i++) {
      const nid = projectionNodeIds[i]
      nodeIndex.set(nid, i)
      const n = engine.getNode(nid)
      nodeRecords[i] = n ?? { id: nid, type: 0, name: '', props: {} }
    }

    // 构建 CSR：先计算每条边的目标 CSR 索引
    const degreeList: number[] = new Array(nodeCount).fill(0)

    // 第一遍：计算每个节点的出度
    for (let i = 0; i < nodeCount; i++) {
      const nid = projectionNodeIds[i]
      const nodeRecord = nodeRecords[i]
      const { edges: neighborEdges } = engine.neighbors(nid)

      let deg = 0
      for (const edge of neighborEdges) {
        if (edgeFilter && !edgeFilter(edge)) continue
        if (nodeIndex.has(edge.dst)) {
          deg++
        }
      }
      degreeList[i] = deg
    }

    // 构建 nodeOffsets（前缀和）
    const nodeOffsets = new Uint32Array(nodeCount + 1)
    let totalEdges = 0
    for (let i = 0; i < nodeCount; i++) {
      nodeOffsets[i] = totalEdges
      totalEdges += degreeList[i]
    }
    nodeOffsets[nodeCount] = totalEdges

    // 填充 edges 数组
    const edges = new Uint32Array(totalEdges)
    const cursor = new Uint32Array(nodeCount) // 写入游标
    for (let i = 0; i < nodeCount; i++) {
      cursor[i] = nodeOffsets[i]
    }

    for (let i = 0; i < nodeCount; i++) {
      const nid = projectionNodeIds[i]
      const { edges: neighborEdges } = engine.neighbors(nid)

      for (const edge of neighborEdges) {
        if (edgeFilter && !edgeFilter(edge)) continue
        const dstIdx = nodeIndex.get(edge.dst)
        if (dstIdx !== undefined) {
          edges[cursor[i]] = dstIdx
          cursor[i]++
        }
      }
    }

    // 估算内存（CSR 数组 + 元数据）
    const estimatedMemoryBytes =
      nodeOffsets.byteLength +
      edges.byteLength +
      projectionNodeIds.length * 8 +  // array + Map overhead approx
      nodeCount * 8 * 2  // Map entries overhead

    const constructionTimeMs = Date.now() - startTime

    return new GraphProjection(
      nodeOffsets,
      edges,
      projectionNodeIds,
      nodeIndex,
      nodeRecords,
      {
        nodeCount,
        edgeCount: totalEdges,
        constructionTimeMs,
        estimatedMemoryBytes,
      },
    )
  }
}
