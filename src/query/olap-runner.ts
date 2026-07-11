/**
 * olap-runner.ts — OLAP 批量分析执行器
 *
 * 提供全图批量分析能力，支持以下算法：
 *   - pagerank            : 全局 PageRank 计算
 *   - bfs                 : 从指定节点出发的 BFS 遍历
 *   - betweenness         : 中介中心性（Brandes 算法）
 *   - louvain             : Louvain 社区发现
 *   - degree_centrality   : 度中心性
 *
 * 使用方式:
 *   const runner = new OlapRunner(engine, { algo: 'pagerank', iterations: 20 })
 *   const result = await runner.run()
 */

import { GraphEngine, NodeId } from '../core/graph-engine'

// ── 类型定义 ───────────────────────────────────────────────

export interface OlapConfig {
  /** 算法名称 */
  algo: 'pagerank' | 'bfs' | 'betweenness' | 'louvain' | 'degree_centrality'
  /** PageRank 迭代次数（默认 20） */
  iterations?: number
  /** BFS 起始Node ID */
  startNode?: number
  /** 中介中心性采样数（Optional） */
  sample?: number
  /** Louvain 分辨率参数（默认 1.0） */
  resolution?: number
}

export interface OlapResult {
  /** 算法名称 */
  algo: string
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 结果数据（各算法格式不同） */
  data: Record<string, unknown> | Map<number, unknown> | unknown
  /** 图统计快照 */
  graphStats: {
    nodeCount: number
    edgeCount: number
  }
}

// ── 支持的算法列表 ─────────────────────────────────────────

const SUPPORTED_ALGOS = new Set([
  'pagerank',
  'bfs',
  'betweenness',
  'louvain',
  'degree_centrality',
])

// ── OlapRunner ─────────────────────────────────────────────

export class OlapRunner {
  constructor(
    private engine: GraphEngine,
    private config: OlapConfig,
  ) {}

  /**
   * 执行配置的 OLAP 分析。
   *
   * 根据 this.config.algo 路由到相应的算法执行路径。
   * 所有算法都在 engine 提供的 API 之上运行，
   * 通过 engine.neighbors() 获取邻接关系。
   *
   * @returns OlapResult — 包含结果数据、耗时和图统计
   * @throws Error — 如果 algo 不受支持
   */
  async run(): Promise<OlapResult> {
    this.validateConfig()
    const startTime = Date.now()

    const graphStats = this.engine.stats()

    let data: unknown

    switch (this.config.algo) {
      case 'pagerank': {
        data = await this.runPageRank()
        break
      }
      case 'bfs': {
        data = await this.runBFS()
        break
      }
      case 'betweenness': {
        data = await this.runBetweenness()
        break
      }
      case 'louvain': {
        data = await this.runLouvain()
        break
      }
      case 'degree_centrality': {
        data = await this.runDegreeCentrality()
        break
      }
      default: {
        // 安全兜底 — validateConfig 已阻止未支持的算法到达这里
        throw new Error(`Unsupported OLAP algorithm: ${this.config.algo}`)
      }
    }

    const durationMs = Date.now() - startTime

    return {
      algo: this.config.algo,
      durationMs,
      data,
      graphStats: {
        nodeCount: graphStats.nodeCount,
        edgeCount: graphStats.edgeCount,
      },
    }
  }

  /**
   * 验证配置的合法性。
   * - algo 必须是支持的值之一
   * - bfs 必须提供 startNode
   */
  private validateConfig(): void {
    if (!SUPPORTED_ALGOS.has(this.config.algo)) {
      throw new Error(
        `Unsupported OLAP algorithm: "${this.config.algo}". ` +
        `Supported: ${Array.from(SUPPORTED_ALGOS).join(', ')}`,
      )
    }

    if (this.config.algo === 'bfs' && this.config.startNode == null) {
      throw new Error('BFS requires a startNode parameter')
    }
  }

  /**
   * 执行 PageRank。
   * 使用 engine.pagerank() 方法，传入Optional的迭代次数。
   * 将 Map 转换为普通对象以便序列化。
   */
  private async runPageRank(): Promise<Record<string, number>> {
    const iterations = this.config.iterations ?? 20
    const damping = 0.85

    const result = await this.engine.pagerank({
      maxIterations: iterations,
      dampingFactor: damping,
    })

    // Map → 普通对象
    const obj: Record<string, number> = {}
    for (const [nodeId, score] of result) {
      obj[String(nodeId)] = score
    }
    return obj
  }

  /**
   * 执行 BFS。
   * 使用 engine.bfs() 方法从 startNode 出发。
   * 将 Map 转换为序列化友好的格式。
   */
  private async runBFS(): Promise<Record<string, { distance: number; parent: number | null }>> {
    const startNode = this.config.startNode!
    const result = await this.engine.bfs(startNode)

    const obj: Record<string, { distance: number; parent: number | null }> = {}
    for (const [nodeId, info] of result) {
      obj[String(nodeId)] = {
        distance: info.distance,
        parent: info.parent,
      }
    }
    return obj
  }

  /**
   * 执行中介中心性（Betweenness Centrality）。
   *
   * 使用 Brandes 算法。如果提供了 sample 参数，
   * 则随机采样 vertices 的子集（approximate加速）。
   */
  private async runBetweenness(): Promise<Record<string, number>> {
    const allNodeIds = Array.from(this.engine['_nodeIds'] || [])
    if (allNodeIds.length === 0) {
      return {}
    }

    // 收集所有节点列表
    const vertices = allNodeIds as number[]

    // 采样（如果设置）
    const sample = this.config.sample
    let sampledVertices: number[]
    if (sample && sample < vertices.length) {
      // 随机采样
      const shuffled = [...vertices].sort(() => Math.random() - 0.5)
      sampledVertices = shuffled.slice(0, sample)
    } else {
      sampledVertices = vertices
    }

    // 构建邻接表
    const adjList = new Map<number, number[]>()
    for (const v of vertices) {
      const neighbors = this.engine.neighbors(v)
      adjList.set(v, neighbors.edges.map(e => e.dst))
    }

    // 导入 Brandes 算法
    const { betweennessCentrality: brandes } = await import('../algorithms/betweenness')
    const result = brandes(sampledVertices, adjList, true)

    return result as Record<string, number>
  }

  /**
   * 执行 Louvain 社区发现。
   *
   * 从 engine 获取所有节点和边，构建 edge 列表，
   * 调用 louvainCommunity 算法。
   */
  private async runLouvain(): Promise<{
    communities: Record<string, number>
    modularity: number
    levels: number
  }> {
    const allNodeIds = Array.from(this.engine['_nodeIds'] || []) as number[]
    if (allNodeIds.length === 0) {
      return { communities: {}, modularity: 0, levels: 0 }
    }

    // 构建边列表
    const edges: Array<{ src: number; dst: number; weight: number }> = []
    const visited = new Set<string>()
    for (const v of allNodeIds) {
      const neighbors = this.engine.neighbors(v)
      for (const edge of neighbors.edges) {
        const key = `${Math.min(v, edge.dst)}-${Math.max(v, edge.dst)}`
        if (!visited.has(key)) {
          visited.add(key)
          edges.push({ src: v, dst: edge.dst, weight: 1 })
        }
      }
    }

    const { louvainCommunity } = await import('../algorithms/louvain')
    const resolution = this.config.resolution ?? 1.0
    const result = louvainCommunity(allNodeIds, edges)

    // Map → 普通对象
    const communities: Record<string, number> = {}
    for (const [nodeId, community] of result.communities) {
      communities[String(nodeId)] = community
    }

    return {
      communities,
      modularity: result.modularity,
      levels: result.levels,
    }
  }

  /**
   * 执行度中心性。
   * 使用 engine.degreeCentrality() 方法。
   */
  private async runDegreeCentrality(): Promise<Record<string, number>> {
    const result = await this.engine.degreeCentrality({
      normalized: true,
      direction: 'all',
    })

    const scores: Record<string, number> = {}
    for (const [nodeId, score] of result.scores) {
      scores[String(nodeId)] = score
    }
    return scores
  }
}
