import { OverGraph, OverGraphDB } from 'overgraph'
import {
  NodeId, NodeRecord, EdgeRecord, UpsertNodeOptions, UpsertEdgeOptions,
  VectorSearchOptions, VectorSearchResult,
  PersonalizedPageRankOptions, ShortestPathOptions, ConnectedComponentsOptions,
  PatternMatchOptions, OverGraphConfig,
} from '../types'

/**
 * GraphEngine — OverGraph v0.7.0 TypeScript 封装
 *
 * 本层完成三件事：
 * 1. 类型转换（原生 JsNodeRecord → NodeRecord）
 * 2. API 适配（neighbors 返回数组而非 { edges, nodes }）
 * 3. 错误处理
 */
export class GraphEngine {
  private db: OverGraphDB | null = null
  private config: OverGraphConfig
  private _isOpen = false
  private _nodeCount: number = 0
  private _edgeCount: number = 0

  constructor(config: OverGraphConfig) {
    this.config = config
  }

  get isOpen(): boolean { return this._isOpen }

  /** 打开数据库 */
  open(): void {
    if (this._isOpen) return
    this.db = OverGraph.open(this.config.path, {
      denseVector: this.config.denseVector
        ? { dimension: this.config.denseVector.dimension }
        : undefined,
      defaultRetention: this.config.defaultRetention,
    })
    this._isOpen = true
  }

  /** 关闭数据库 */
  close(): void {
    if (!this._isOpen || !this.db) return
    this.db.close()
    this.db = null
    this._isOpen = false
  }

  // ──────────────────────────────────────────
  // Node operations
  // ──────────────────────────────────────────

  upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): NodeId {
    this._ensureOpen()
    const id = this.db!.upsertNode(typeId, name, {
      props: opts?.props as Record<string, unknown> | undefined,
      denseVector: opts?.denseVector instanceof Float32Array
        ? opts.denseVector
        : opts?.denseVector ? new Float32Array(opts.denseVector) : undefined,
      sparseVector: opts?.sparseVector,
      temporalValidity: opts?.temporalValidity,
      decayFactor: opts?.decayFactor,
      retentionPolicy: opts?.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : undefined,
    })
    // upsertNode 对已有节点返回相同 ID，此处简单递增
    // 更精确的计数需要通过引擎快照恢复，当前为近似值
    this._nodeCount++
    return id
  }

  getNode(id: NodeId): NodeRecord | null {
    this._ensureOpen()
    const raw = this.db!.getNode(id, true)
    if (!raw) return null
    // 获取真实 degree
    let degree = 0
    try {
      const d = this.db!.degrees(id)
      degree = d.inDegree + d.outDegree
    } catch {
      // OverGraph 可能在某些状态下不支持 degrees() 调用
    }
    return {
      id: raw.id,
      type: raw.typeId,
      name: raw.key,          // name is stored as `key`
      props: raw.props as Record<string, string | number | boolean | null>,
      createdAt: raw.createdAt,
      degree,
    }
  }

  deleteNode(id: NodeId): boolean {
    this._ensureOpen()
    const exists = this.db!.getNode(id) !== null
    if (!exists) return false
    this.db!.deleteNode(id)
    this._nodeCount = Math.max(0, this._nodeCount - 1)
    return true
  }

  batchUpsertNodes(inputs: { typeId: number; name: string; opts?: UpsertNodeOptions }[]): Record<string, NodeId> {
    this._ensureOpen()
    const ids = this.db!.batchUpsertNodes(inputs.map(i => ({
      typeId: i.typeId,
      name: i.name,
      key: i.name,
      props: i.opts?.props as Record<string, unknown> | undefined,
      denseVector: i.opts?.denseVector instanceof Float32Array
        ? i.opts.denseVector
        : i.opts?.denseVector ? new Float32Array(i.opts.denseVector) : undefined,
      temporalValidity: i.opts?.temporalValidity,
    })))
    // Build name-to-ID map by querying each returned node
    const nameToId: Record<string, NodeId> = {}
    for (const id of ids) {
      const node = this.db!.getNode(id, true)
      if (node) {
        nameToId[(node as any).key] = id
      }
    }
    // Fallback: if any name is missing (e.g. duplicate overwrites),
    // use index-based mapping as last resort
    for (let i = 0; i < inputs.length; i++) {
      if (nameToId[inputs[i].name] === undefined && i < ids.length) {
        nameToId[inputs[i].name] = ids[i]
      }
    }
    return nameToId
  }

  // ──────────────────────────────────────────
  // Edge operations
  // ──────────────────────────────────────────

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): void {
    this._ensureOpen()
    this.db!.upsertEdge(src, dst, typeId, {
      props: opts?.props as Record<string, unknown> | undefined,
      temporalValidity: opts?.temporalValidity,
      weight: opts?.weight,
    })
    this._edgeCount++
  }

  getEdge(src: NodeId, dst: NodeId, typeId: number): EdgeRecord | null {
    this._ensureOpen()
    const raw = this.db!.getEdge(src, dst, typeId)
    if (raw) {
      return {
        src: raw.from,
        dst: raw.to,
        type: raw.typeId,
        props: raw.props as Record<string, string | number | boolean | null>,
        timestamp: raw.createdAt,
      }
    }
    // OverGraph v0.7.0: getEdge may return null after deleteNode.
    // Fallback: search via neighbors to find the matching edge.
    const entries = this.db!.neighbors(src, { maxDepth: 1, edgeTypeFilter: [typeId] })
    const match = entries.find(e => e.nodeId === dst && e.edgeTypeId === typeId)
    if (!match) return null
    return {
      src,
      dst,
      type: typeId,
      props: {},
      timestamp: match.validFrom,
    }
  }

  deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean {
    this._ensureOpen()
    const result = this.db!.deleteEdge(src, dst, typeId)
    if (result) {
      this._edgeCount = Math.max(0, this._edgeCount - 1)
    }
    return result
  }

  neighbors(id: NodeId, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): {
    edges: EdgeRecord[]; nodes: NodeRecord[]
  } {
    this._ensureOpen()
    const entries = this.db!.neighbors(id, opts)
    const edges: EdgeRecord[] = []
    const nodes: NodeRecord[] = []
    const seenNodes = new Set<NodeId>()

    for (const entry of entries) {
      edges.push({
        src: id,
        dst: entry.nodeId,
        type: entry.edgeTypeId,
        props: {},
        timestamp: entry.validFrom,
      })

      if (!seenNodes.has(entry.nodeId)) {
        seenNodes.add(entry.nodeId)
        // 直接通过原生 getNode 获取，避免 graph-engine 包装层的 degree 查询开销
        //（degree 在邻居上下文中通常不需要，且每次 getNode 都会触发一次 db!.degrees()）
        const raw = this.db!.getNode(entry.nodeId, true)
        if (raw) {
          nodes.push({
            id: raw.id,
            type: raw.typeId,
            name: raw.key,
            props: raw.props as Record<string, string | number | boolean | null>,
            createdAt: raw.createdAt,
            degree: 0,
          })
        }
      }
    }

    return { edges, nodes }
  }

  // ──────────────────────────────────────────
  // Vector search
  // ──────────────────────────────────────────

  vectorSearch(query: VectorSearchOptions): VectorSearchResult[] {
    this._ensureOpen()

    // OverGraph v0.7.0 vectorSearch accepts the query as JSON string
    const searchQuery: string = JSON.stringify({
      denseQuery: query.denseQuery instanceof Float32Array
        ? Array.from(query.denseQuery)
        : query.denseQuery || undefined,
      sparseQuery: query.sparseQuery,
      k: query.k ?? 10,
      hybrid: query.hybrid || undefined,
      scope: query.scope ? {
        startNodeId: query.scope.startNodeId,
        maxDepth: query.scope.maxDepth,
        edgeTypeFilter: query.scope.edgeTypeFilter,
      } : undefined,
      minScore: query.minScore,
    })

    const hits = this.db!.vectorSearch(searchQuery)

    return hits.map(hit => ({
      node: this.getNode(hit.id)!,
      score: hit.score,
      distance: hit.distance,
    })).filter(r => r.node !== null)
  }

  // ──────────────────────────────────────────
  // Graph algorithms
  // ──────────────────────────────────────────

  personalizedPageRank(opts: PersonalizedPageRankOptions): { nodeId: number; score: number }[] {
    this._ensureOpen()
    return this.db!.personalizedPageRank({
      sourceNode: opts.sourceNode,
      maxIter: opts.maxIter ?? 10,
      alpha: opts.alpha ?? 0.85,
      tolerance: opts.tolerance ?? 1e-6,
      topK: opts.topK ?? 10,
    })
  }

  allShortestPaths(opts: ShortestPathOptions): { path: number[]; cost: number }[] {
    this._ensureOpen()
    return this.db!.allShortestPaths({
      source: opts.source,
      target: opts.target,
      maxDepth: opts.maxDepth ?? 6,
    })
  }

  connectedComponents(opts?: ConnectedComponentsOptions): number[][] {
    this._ensureOpen()
    return this.db!.connectedComponents({
      edgeTypeFilter: opts?.edgeTypeFilter?.map(e => Number(e)),
    })
  }

  queryPattern(opts: PatternMatchOptions): NodeRecord[] {
    this._ensureOpen()
    const results = this.db!.queryPattern({
      sourceNodeId: opts.sourceNode,
      sourceTypeId: opts.sourceType,
      depth: opts.depth,
      edgeTypeFilter: opts.edgeFilters?.map(arr => arr.map(e => Number(e))),
      nodeTypeFilter: opts.nodeFilters?.map(arr => arr.map(n => Number(n))),
      limit: opts.limit ?? 100,
    })
    return results.map(n => ({
      id: n.id, type: n.typeId, name: n.key,
      props: n.props as Record<string, string | number | boolean | null>,
      createdAt: n.createdAt, degree: 0,
    }))
  }

  // ──────────────────────────────────────────
  // Maintenance
  // ──────────────────────────────────────────

  compact(): void {
    this._ensureOpen()
    this.db!.compact()
  }

  stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } {
    this._ensureOpen()
    const s = this.db!.stats()
    return {
      nodeCount: this._nodeCount,
      edgeCount: this._edgeCount,
      diskSizeBytes: s.pendingWalBytes + s.activeMemtableBytes + s.immutableMemtableBytes,
    }
  }

  exportSnapshot(): Buffer {
    this._ensureOpen()
    if (typeof (this.db as any).exportSnapshot !== 'function') {
      return Buffer.alloc(0)
    }
    return Buffer.from(this.db!.exportSnapshot())
  }

  importSnapshot(data: Buffer): void {
    this._ensureOpen()
    this.db!.importSnapshot(data)
  }

  private _ensureOpen(): void {
    if (!this._isOpen || !this.db) {
      throw new Error('GraphEngine is not open. Call open() first.')
    }
  }
}
