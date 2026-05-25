import {
  NodeId, NodeRecord, EdgeRecord, NodeProperties,
  UpsertNodeOptions, UpsertEdgeOptions,
  VectorSearchOptions, VectorSearchResult,
  PersonalizedPageRankOptions, ShortestPathOptions, ConnectedComponentsOptions,
  PatternMatchOptions, OverGraphConfig,
} from '../types'
import { StorageProvider, StorageConfig, NeighborsOptions, NeighborEntry } from './storage-provider'
import { OverGraphStorage } from './overgraph-storage'

import { LabelEngine } from './label-engine'
import { getEventBus } from './event-bus'
import { EventStream } from './event-stream'
import { MultiLeaderReplication } from './multi-leader-replication'
import { SchemaDef, ValidationResult } from '../schema/schema-types'
import { validateNodeType, validateEdgeType } from '../schema/schema-validator'

/** Event for EventStream emit */
interface StreamEvent { type: string; data: Record<string, unknown> }

// ──────────────────────────────────────────
// LRU Cache with per-entry TTL
// ──────────────────────────────────────────

interface LRUNode<K, V> {
  key: K
  value: V
  expiresAt: number
  prev: LRUNode<K, V> | null
  next: LRUNode<K, V> | null
}

/**
 * LRU cache with per-entry TTL expiry.
 * Uses a Map (key → node) + doubly-linked list (head=MRU, tail=LRU).
 * Not thread-safe.
 */
class LRUCache<K, V> {
  private readonly _map = new Map<K, LRUNode<K, V>>()
  private _head: LRUNode<K, V> | null = null
  private _tail: LRUNode<K, V> | null = null
  private readonly _maxSize: number
  private readonly _defaultTTLMs: number

  constructor(maxSize: number = 1000, defaultTTLSec: number = 60) {
    this._maxSize = maxSize
    this._defaultTTLMs = defaultTTLSec * 1000
  }

  /** 获取缓存条目，过期则返回 null 并删除 */
  get(key: K): V | undefined {
    const node = this._map.get(key)
    if (!node) return undefined

    // 检查过期
    if (Date.now() > node.expiresAt) {
      this._removeNode(node)
      this._map.delete(key)
      return undefined
    }

    // 移到链表头部（MRU）
    this._moveToHead(node)
    return node.value
  }

  /** 设置缓存条目（使用默认 TTL） */
  set(key: K, value: V, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this._defaultTTLMs)

    const existing = this._map.get(key)
    if (existing) {
      existing.value = value
      existing.expiresAt = expiresAt
      this._moveToHead(existing)
      return
    }

    // 如果已满，淘汰 LRU（尾部）
    if (this._map.size >= this._maxSize) {
      this._evictOne()
    }

    const node: LRUNode<K, V> = { key, value, expiresAt, prev: null, next: null }
    this._map.set(key, node)
    this._prepend(node)
  }

  /** 删除指定 key */
  delete(key: K): boolean {
    const node = this._map.get(key)
    if (!node) return false
    this._removeNode(node)
    this._map.delete(key)
    return true
  }

  /** 清空全部缓存 */
  clear(): void {
    this._map.clear()
    this._head = null
    this._tail = null
  }

  get size(): number {
    return this._map.size
  }

  // ── 内部方法 ──

  private _prepend(node: LRUNode<K, V>): void {
    node.prev = null
    node.next = this._head
    if (this._head) {
      this._head.prev = node
    }
    this._head = node
    if (!this._tail) {
      this._tail = node
    }
  }

  private _removeNode(node: LRUNode<K, V>): void {
    if (node.prev) {
      node.prev.next = node.next
    } else {
      this._head = node.next
    }
    if (node.next) {
      node.next.prev = node.prev
    } else {
      this._tail = node.prev
    }
    node.prev = null
    node.next = null
  }

  private _moveToHead(node: LRUNode<K, V>): void {
    if (node === this._head) return
    this._removeNode(node)
    this._prepend(node)
  }

  private _evictOne(): void {
    if (!this._tail) return
    const tail = this._tail
    this._removeNode(tail)
    this._map.delete(tail.key)
  }

  /** 清理所有过期条目并返回已清理个数 */
  evictExpired(): number {
    let count = 0
    // 从尾部扫描，因为 LRU 节点很可能也已经过期
    let node = this._tail
    while (node) {
      const prev = node.prev
      if (Date.now() > node.expiresAt) {
        this._removeNode(node)
        this._map.delete(node.key)
        count++
      }
      node = prev
    }
    return count
  }
}

/**
 * GraphEngine — 存储无关的图引擎核心
 *
 * 所有数据操作通过 StorageProvider 接口完成，不直接依赖任何具体存储后端。
 * 默认使用 OverGraph 后端，可切换为任何实现了 StorageProvider 的实现。
 */
export class GraphEngine {
  private storage: StorageProvider
  private config: OverGraphConfig
  private _isOpen = false
  private _nodeCount: number = 0
  private _edgeCount: number = 0
  private _nodeIds: Set<number> = new Set()
  private _edgeKeys: Set<string> = new Set()
  private _labelIndex: LabelEngine = new LabelEngine()
  private _eventStream: EventStream | null = null
  /** Multi-Leader 同步复制层（可选） */
  private _mlReplication: MultiLeaderReplication | null = null

  // ── LRU Cache for neighbors ──
  private _neighborCache: LRUCache<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>
  private _cacheEnabled = false
  private _cacheMaxSize: number
  private _cacheDefaultTTLSec: number

  /** Schema 类型定义（可选） */
  private _schema?: SchemaDef

  /**
   * 可选的回调：当节点/边发生变更时被调用
   * 用于 DeltaSync 捕捉变更
   */
  public onRecordChange?: (name: string, fields: Record<string, any>) => void

  constructor(config: OverGraphConfig, storage?: StorageProvider, eventStream?: EventStream, mlReplication?: MultiLeaderReplication) {
    this.storage = storage ?? new OverGraphStorage()
    this.config = config
    this._eventStream = eventStream ?? null
    this._mlReplication = mlReplication ?? null
    this._cacheMaxSize = config.cacheSize ?? 1000
    this._cacheDefaultTTLSec = 60
    this._neighborCache = new LRUCache<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>(
      this._cacheMaxSize,
      this._cacheDefaultTTLSec,
    )
  }

  /** 设置 Schema 定义 */
  setSchema(schema: SchemaDef): void {
    this._schema = schema
  }

  /** 获取当前 Schema */
  getSchema(): SchemaDef | undefined {
    return this._schema
  }

  /** 检查数据库是否已打开 */
  get isOpen(): boolean { return this._isOpen }

  /** 通过 EventStream（可靠）或 EventBus（fire-and-forget）发布变更事件 */
  private _emit(event: { type: string; data: Record<string, unknown> }): void {
    if (this._eventStream) {
      this._eventStream.emit(event)
    } else {
      try { getEventBus().emit({ ...event, timestamp: Date.now() } as import('./event-bus').GraphEvent) } catch { /* bus not initialized */ }
    }
  }

  /** 打开数据库 */
  open(): void {
    if (this._isOpen) return
    this.storage.open({
      path: this.config.path,
      denseVector: this.config.denseVector
        ? { dimension: this.config.denseVector.dimension }
        : undefined,
      defaultRetention: this.config.defaultRetention,
    })

    // 注册远程事件应用回调 — 收到集群内其他节点的变更事件时持久化到本地
    if (this._eventStream) {
      this._eventStream.registerApplyHandler(async (msg) => {
        switch (msg.type) {
          case 'node:created':
          case 'node:updated': {
            const id = msg.data.id as number
            const typeId = msg.data.typeId as number
            const name = msg.data.name as string
            const props = msg.data.props as Record<string, string | number | boolean | string[] | number[] | null> | undefined
            await this.upsertNode(typeId, name, { props, skipReplication: true })
            break
          }
          case 'node:deleted': {
            const id = msg.data.id as number
            await this.deleteNode(id, true)
            break
          }
          case 'edge:created':
          case 'edge:updated': {
            const src = msg.data.src as number
            const dst = msg.data.dst as number
            const typeId = msg.data.typeId as number
            const props = msg.data.props as Record<string, string | number | boolean | string[] | number[] | null> | undefined
            await this.upsertEdge(src, dst, typeId, { props, skipReplication: true })
            break
          }
          case 'edge:deleted': {
            const src = msg.data.src as number
            const dst = msg.data.dst as number
            const typeId = msg.data.typeId as number
            await this.deleteEdge(src, dst, typeId, true)
            break
          }
        }
      })
    }

    this._isOpen = true
  }

  /** 关闭数据库 */
  close(): void {
    if (!this._isOpen) return
    this.storage.close()
    this._isOpen = false
  }

  // ──────────────────────────────────────────
  // Node operations
  // ──────────────────────────────────────────

  /**
   * 插入或更新一个节点（Multi-Leader 模式：同步等待所有远程节点 ACK）
   *
   * @param typeId - 节点类型 ID
   * @param name - 节点名称
   * @param opts - 可选参数（属性、向量、有效期、衰减因子、TTL）
   * @returns 新插入或已有节点的 ID
   * @throws {Error} 如果 GraphEngine 未 open() 或同步复制超时
   */
  async upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): Promise<NodeId> {
    this._ensureOpen()

    if (this._schema) {
      const result = validateNodeType(typeId, opts?.props ?? {}, this._schema)
      if (!result.valid) {
        throw new Error(`Schema 校验失败: ${result.errors.join('; ')}`)
      }
    }

    const id = this.storage.upsertNode(typeId, name, opts)
    if (!this._nodeIds.has(id)) {
      this._nodeIds.add(id)
      this._nodeCount++
    }
    this._labelIndex.addNode(typeId, id)
    this.onRecordChange?.(name, { typeId, ...(opts?.props ?? {}) })

    if (this._mlReplication && !opts?.skipReplication) {
      const result = await this._mlReplication.replicate('node:created', { id, typeId, name, props: opts?.props })
      if (!result.success) {
        console.error(`[GraphEngine] Multi-Leader replication: ${result.acksReceived}/${result.expectedAcks} ACKs`)
      }
    }

    this._emit({ type: 'node:created', data: { id, typeId, name, props: opts?.props } })
    return id
  }

  /**
   * 根据节点 ID 获取节点记录
   *
   * @param id - 节点 ID
   * @returns NodeRecord 或 null（节点不存在时）
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  getNode(id: NodeId): NodeRecord | null {
    this._ensureOpen()
    const raw = this.storage.getNode(id, true)
    if (!raw) return null
    let degree = 0
    try {
      const d = this.storage.degrees(id)
      degree = d.inDegree + d.outDegree
    } catch {
      // storage 可能在某些状态下不支持 degrees() 调用
    }
    return {
      id: raw.id,
      type: raw.typeId,
      name: raw.key,
      props: raw.props as NodeProperties,
      createdAt: raw.createdAt,
      degree,
    }
  }

  /**
   * 删除指定 ID 的节点
   *
   * @param id - 要删除的节点 ID
   * @returns true 如果节点存在且被删除，false 如果节点不存在
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  async deleteNode(id: NodeId, skipReplication = false): Promise<boolean> {
    this._ensureOpen()
    const node = this.storage.getNode(id, true)
    if (!node) return false
    this._labelIndex.removeNode(node.typeId, id)
    this.storage.deleteNode(id)
    this._nodeIds.delete(id)
    this._nodeCount = Math.max(0, this._nodeCount - 1)
    this.onRecordChange?.(node.key, { _deleted: true, typeId: node.typeId })

    if (this._mlReplication && !skipReplication) {
      const result = await this._mlReplication.replicate('node:deleted', { id, typeId: node.typeId, name: node.key })
      if (!result.success) {
        console.error(`[GraphEngine] Multi-Leader replication: ${result.acksReceived}/${result.expectedAcks} ACKs`)
      }
    }

    this._emit({ type: 'node:deleted', data: { id, typeId: node.typeId, name: node.key } })
    return true
  }

  /**
   * 批量插入或更新多个节点
   *
   * @param inputs - 节点输入数组
   * @returns 节点名称到 ID 的映射表
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  batchUpsertNodes(inputs: { typeId: number; name: string; opts?: UpsertNodeOptions }[]): Record<string, NodeId> {
    this._ensureOpen()
    const ids = this.storage.batchUpsertNodes(inputs.map(i => ({
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
      const node = this.storage.getNode(id, true)
      if (node) {
        nameToId[node.key] = id
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

  /**
   * 插入或更新一条边（Multi-Leader 模式：同步等待所有远程节点 ACK）
   *
   * @param src - 源节点 ID
   * @param dst - 目标节点 ID
   * @param typeId - 边类型 ID
   * @param opts - 可选参数
   * @throws {Error} 如果 GraphEngine 未 open() 或同步复制超时
   */
  async upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): Promise<void> {
    this._ensureOpen()

    if (this._schema) {
      const result = validateEdgeType(typeId, opts?.props ?? {}, this._schema)
      if (!result.valid) {
        throw new Error(`Schema 校验失败: ${result.errors.join('; ')}`)
      }
    }

    this.storage.upsertEdge(src, dst, typeId, {
      props: opts?.props as Record<string, unknown> | undefined,
      temporalValidity: opts?.temporalValidity,
      weight: opts?.weight,
    })
    const ek = `${src}:${dst}:${typeId}`
    if (!this._edgeKeys.has(ek)) {
      this._edgeKeys.add(ek)
      this._edgeCount++
    }
    this.onRecordChange?.(`edge:${src}->${dst}`, { typeId, src, dst, ...(opts?.props ?? {}) })

    if (this._mlReplication && !opts?.skipReplication) {
      const result = await this._mlReplication.replicate('edge:created', { src, dst, typeId, props: opts?.props })
      if (!result.success) {
        console.error(`[GraphEngine] Multi-Leader replication: ${result.acksReceived}/${result.expectedAcks} ACKs`)
      }
    }

    this._emit({ type: 'edge:created', data: { src, dst, typeId, props: opts?.props } })
  }

  /**
   * 获取指定边的记录
   *
   * @param src - 源节点 ID
   * @param dst - 目标节点 ID
   * @param typeId - 边类型 ID
   * @returns EdgeRecord 或 null（边不存在时）
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  getEdge(src: NodeId, dst: NodeId, typeId: number): EdgeRecord | null {
    this._ensureOpen()
    const raw = this.storage.getEdge(src, dst, typeId)
    if (raw) {
      return {
        src: raw.from,
        dst: raw.to,
        type: raw.typeId,
        props: raw.props as NodeProperties,
        timestamp: raw.createdAt,
      }
    }
    // Fallback: search via neighbors to find the matching edge
    const entries = this.storage.neighbors(src, { maxDepth: 1, edgeTypeFilter: [typeId] })
    const match = entries.find(e => e.nodeId === dst && e.edgeTypeId === typeId)
    if (!match) return null
    return {
      src, dst, type: typeId, props: {}, timestamp: match.validFrom,
    }
  }

  /**
   * 删除指定边
   *
   * @param src - 源节点 ID
   * @param dst - 目标节点 ID
   * @param typeId - 边类型 ID
   * @returns true 如果边存在且被删除
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  async deleteEdge(src: NodeId, dst: NodeId, typeId: number, skipReplication = false): Promise<boolean> {
    this._ensureOpen()
    const result = this.storage.deleteEdge(src, dst, typeId)
    if (result) {
      this._edgeCount = Math.max(0, this._edgeCount - 1)
    }
    this.onRecordChange?.(`edge:${src}->${dst}:${typeId}`, { _deleted: true, src, dst, typeId })

    if (this._mlReplication && result && !skipReplication) {
      const r = await this._mlReplication.replicate('edge:deleted', { src, dst, typeId })
      if (!r.success) {
        console.error(`[GraphEngine] Multi-Leader replication: ${r.acksReceived}/${r.expectedAcks} ACKs`)
      }
    }

    this._emit({ type: 'edge:deleted', data: { src, dst, typeId } })
    return result
  }

  /**
   * 获取指定节点的所有邻居
   *
   * @param id - 节点 ID
   * @param opts - 可选参数（maxDepth, edgeTypeFilter）
   * @returns 包含 edges 和 nodes 数组的对象
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  neighbors(id: NodeId, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): {
    edges: EdgeRecord[]; nodes: NodeRecord[]
  } {
    this._ensureOpen()
    const entries = this.storage.neighbors(id, opts)
    const edges: EdgeRecord[] = []
    const nodes: NodeRecord[] = []
    const seenNodes = new Set<NodeId>()

    for (const entry of entries) {
      edges.push({
        src: id, dst: entry.nodeId, type: entry.edgeTypeId, props: {}, timestamp: entry.validFrom,
      })
      if (!seenNodes.has(entry.nodeId)) {
        seenNodes.add(entry.nodeId)
        const raw = this.storage.getNode(entry.nodeId, true)
        if (raw) {
          nodes.push({
            id: raw.id, type: raw.typeId, name: raw.key,
            props: raw.props as Record<string, string | number | boolean | null>,
            createdAt: raw.createdAt, degree: 0,
          })
        }
      }
    }
    return { edges, nodes }
  }

  /**
   * 批量邻居查询（带 LRU 缓存）
   *
   * 输入 N 个 nodeId，一次返回所有邻居，重复查询走缓存。
   * 适合用于图算法（PageRank、社区检测等）需要反复查邻居的热点路径。
   *
   * @param ids - 节点 ID 数组（batch）
   * @param opts - 查询选项（同 neighbors()）
   * @returns Map<NodeId, { edges; nodes }>
   */
  batchNeighbors(ids: NodeId[], opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Map<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }> {
    this._ensureOpen()
    const result = new Map<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>()
    const miss: NodeId[] = []

    for (const id of ids) {
      const cached = this._neighborCache.get(id)
      if (cached !== undefined) {
        result.set(id, cached)
      } else {
        miss.push(id)
      }
    }

    if (miss.length > 0) {
      for (const id of miss) {
        const data = this.neighbors(id, opts)
        this._neighborCache.set(id, data)
        result.set(id, data)
      }
    }

    return result
  }

  // ──────────────────────────────────────────
  // Vector search
  // ──────────────────────────────────────────

  /**
   * 向量搜索
   *
   * @param query - 搜索参数
   * @returns 按分数降序排列的搜索结果数组
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  vectorSearch(query: VectorSearchOptions): VectorSearchResult[] {
    this._ensureOpen()

    // 构造存储层搜索查询（所有路径都走下层引擎的 vectorSearch）
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
    const hits = this.storage.vectorSearch(searchQuery)
    return hits.map(hit => ({
      node: this.getNode(hit.id)!,
      score: hit.score,
      distance: hit.distance,
    })).filter(r => r.node !== null)
  }

  // ──────────────────────────────────────────
  // Graph algorithms
  // ──────────────────────────────────────────

  /**
   * 个性化 PageRank
   *
   * @param opts - 算法参数
   * @returns 节点 ID 和对应分数的数组
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  personalizedPageRank(opts: PersonalizedPageRankOptions): { nodeId: number; score: number }[] {
    this._ensureOpen()
    return this.storage.personalizedPageRank({
      sourceNode: opts.sourceNode,
      maxIter: opts.maxIter ?? 10,
      alpha: opts.alpha ?? 0.85,
      tolerance: opts.tolerance ?? 1e-6,
      topK: opts.topK ?? 10,
    })
  }

  /**
   * 计算两点之间的所有最短路径
   *
   * @param opts - 路径参数
   * @returns 路径数组
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  allShortestPaths(opts: ShortestPathOptions): { path: number[]; cost: number }[] {
    this._ensureOpen()
    return this.storage.allShortestPaths({
      source: opts.source,
      target: opts.target,
      maxDepth: opts.maxDepth ?? 6,
    })
  }

  /**
   * 计算连通分量
   *
   * @param opts - 可选参数
   * @returns 连通分量数组
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  connectedComponents(opts?: ConnectedComponentsOptions): number[][] {
    this._ensureOpen()
    return this.storage.connectedComponents({
      edgeTypeFilter: opts?.edgeTypeFilter?.map(e => Number(e)),
    })
  }

  /**
   * 模式匹配
   *
   * @param opts - 匹配参数
   * @returns 匹配的节点记录数组
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  queryPattern(opts: PatternMatchOptions): NodeRecord[] {
    this._ensureOpen()
    const results = this.storage.queryPattern({
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

  /**
   * 按节点类型查找所有节点 ID
   *
   * @param typeId - 节点类型 ID
   * @returns 该类型的所有节点 ID 数组
   */
  findNodesByType(typeId: number): number[] {
    this._ensureOpen()
    return this._labelIndex.getNodeIds(typeId)
  }

  /**
   * 按节点属性查找节点 ID
   *
   * @param typeId - 节点类型 ID
   * @param propKey - 属性键名
   * @param propValue - 属性值
   * @returns 匹配的节点 ID 数组
   */
  findNodesByProperty(typeId: number, propKey: string, propValue: unknown): number[] {
    this._ensureOpen()
    const typeNodes = this._labelIndex.getNodeIds(typeId)
    return typeNodes.filter(id => {
      const node = this.storage.getNode(id, false)
      return node && node.props?.[propKey] === propValue
    })
  }

  /**
   * 执行存储引擎压缩
   */
  compact(): void {
    this._ensureOpen()
    this.storage.compact()
  }

  /**
   * 聚合计数
   * @param typeFilter - 可选，按 typeId 过滤（节点类型）
   * @returns 符合条件的节点数量
   */
  countNodes(typeFilter?: number[]): number {
    this._ensureOpen()
    if (!typeFilter || typeFilter.length === 0) {
      return this._nodeCount
    }
    // 通过 searchNodes 或 label index 按类型过滤
    let count = 0
    for (const id of this._nodeIds) {
      const raw = this.storage.getNode(id, true)
      if (raw && typeFilter.includes(raw.typeId)) {
        count++
      }
    }
    return count
  }

  /**
   * 统计节点属性之和
   * @param field - 属性字段名（必须是数字类型）
   * @param typeFilter - 可选，按 typeId 过滤
   * @returns 属性值的总和
   */
  sumNodeProperty(field: string, typeFilter?: number[]): number {
    this._ensureOpen()
    let sum = 0
    for (const id of this._nodeIds) {
      const raw = this.storage.getNode(id, true)
      if (!raw) continue
      if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(raw.typeId)) continue
      const val = raw.props?.[field]
      if (typeof val === 'number') {
        sum += val
      }
    }
    return sum
  }

  /**
   * 统计节点属性平均值
   * @param field - 属性字段名（必须是数字类型）
   * @param typeFilter - 可选，按 typeId 过滤
   * @returns 属性值的平均值，无匹配节点时返回 0
   */
  avgNodeProperty(field: string, typeFilter?: number[]): number {
    this._ensureOpen()
    let sum = 0
    let count = 0
    for (const id of this._nodeIds) {
      const raw = this.storage.getNode(id, true)
      if (!raw) continue
      if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(raw.typeId)) continue
      const val = raw.props?.[field]
      if (typeof val === 'number') {
        sum += val
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }

  /**
   * 获取引擎统计信息
   *
   * @returns 包含节点数、边数和磁盘占用字节的对象
   */
  stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } {
    this._ensureOpen()
    const s = this.storage.stats()
    return {
      nodeCount: this._nodeCount,
      edgeCount: this._edgeCount,
      diskSizeBytes: s.diskSizeBytes,
    }
  }

  /**
   * 导出当前数据快照
   *
   * @returns 快照数据的 Buffer
   */
  exportSnapshot(): Buffer {
    this._ensureOpen()
    if (!this.storage.exportSnapshot) return Buffer.alloc(0)
    return this.storage.exportSnapshot()
  }

  /**
   * 导入快照数据
   *
   * @param data - 之前由 exportSnapshot() 导出的快照数据
   */
  importSnapshot(data: Buffer): void {
    this._ensureOpen()
    if (this.storage.importSnapshot) {
      this.storage.importSnapshot(data)
    }
  }

  private _ensureOpen(): void {
    if (!this._isOpen) {
      throw new Error('GraphEngine is not open. Call open() first.')
    }
  }
}
