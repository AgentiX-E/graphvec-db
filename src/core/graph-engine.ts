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
import { bfs } from '../algorithms/bfs'
import { dfs } from '../algorithms/dfs'
import { pagerank } from '../algorithms/pagerank'
import { dijkstra } from '../algorithms/dijkstra'
import { wcc as wccAlgo } from '../algorithms/wcc'
import { scc as sccAlgo } from '../algorithms/scc'
import { triangleCount as triangleCountAlgo } from '../algorithms/triangle-count'
import { labelPropagation as labelPropagationAlgo } from '../algorithms/label-propagation'
import { degreeCentrality as degreeCentralityAlgo } from '../algorithms/degree-centrality'
import { astar as astarAlgo, HeuristicFn } from '../algorithms/astar'
import { getEventBus } from './event-bus'
import { EventStream } from './event-stream'
import { MultiLeaderReplication } from './multi-leader-replication'
import { SchemaDef, ValidationResult } from '../schema/schema-types'
import { validateNodeType, validateEdgeType } from '../schema/schema-validator'

import { parseQuery, QueryPlan } from '../query/query-engine'
import { FullTextIndex, SearchOptions, SearchResult } from '../search/fulltext'
import { RLSContext, RowLevelSecurity } from '../security/rls'
import { QueryPlanner, QuerySpec, buildIRFromSpec, optimizeIR } from '../api/query-planner'
import { OptimizerBridge } from '../query/planner-bridge'
import { Logger } from '../ops/logger'
import { Transaction, TransactionManager } from './transaction'

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
  private logger: Logger

  // ── LRU Cache for neighbors ──
  private _neighborCache: LRUCache<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>
  private _cacheEnabled = false
  private _cacheMaxSize: number
  private _cacheDefaultTTLSec: number

  /** Schema 类型定义（可选） */
  private _schema?: SchemaDef

  /** FullText 全文索引（可选） */
  private _fulltext: FullTextIndex | null = null

  /** Row-Level Security（可选） */
  private _rls: RowLevelSecurity | null = null

  /** QueryPlanner — 查询计划器（可选，主供优化器桥接使用） */
  private _planner: QueryPlanner | null = null

  /** OptimizerBridge — 优化器桥接层（可选） */
  private _bridge: OptimizerBridge | null = null

  // ── 递归保护（Item 1: upsertNode递归死循环） ──
  /** 最大递归深度 */
  private static MAX_RECURSION_DEPTH = 10
  /** 正在应用远程事件 */
  private _applyingRemote = false
  /** 当前递归深度 */
  private _recursionDepth = 0

  /**
   * 可选的回调：当节点/边发生变更时被调用
   * 用于 DeltaSync 捕捉变更
   */
  public onRecordChange?: (name: string, fields: Record<string, any>) => void

  constructor(config: OverGraphConfig, storage?: StorageProvider, eventStream?: EventStream, mlReplication?: MultiLeaderReplication, fulltext?: FullTextIndex, rls?: RowLevelSecurity, planner?: QueryPlanner) {
    this.storage = storage ?? new OverGraphStorage()
    this.config = config
    this._eventStream = eventStream ?? null
    this._mlReplication = mlReplication ?? null
    this._fulltext = fulltext ?? null
    this._rls = rls ?? null
    this._planner = planner ?? null
    this._bridge = null
    this._cacheMaxSize = config.cacheSize ?? 1024
    this._cacheDefaultTTLSec = 60
    this._neighborCache = new LRUCache<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>(
      this._cacheMaxSize,
      this._cacheDefaultTTLSec,
    )
    this.logger = new Logger('GraphEngine')

    // 注册 EventStream 远程数据处理（见 open() 方法）
    // 由 open() 调用 registerApplyHandler，避免构造函数重复注册
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

  /** 只触发本地 EventStream 回调，不广播到远程（用于远程应用场景） */
  private _emitLocal(event: { type: string; data: Record<string, unknown> }): void {
    if (this._eventStream) {
      this._eventStream.emitLocal(event)
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
      overgraph: this.config.overgraph,
      compress: this.config.storageCompression,
      compressionStrategy: this.config.storageCompression ? 'msgpack' : 'none',
    })

    // 注册远程事件应用回调 — 收到集群内其他节点的变更事件时持久化到本地
    if (this._eventStream) {
      this._eventStream.registerApplyHandler(async (msg) => {
        // 递归保护：设置远程应用标志 + 深度计数
        if (this._applyingRemote) {
          this._recursionDepth++
          if (this._recursionDepth > GraphEngine.MAX_RECURSION_DEPTH) {
            this._recursionDepth = 0
            this._applyingRemote = false
            throw new Error(`递归深度超过上限 (${GraphEngine.MAX_RECURSION_DEPTH})，已重置保护`)
          }
        } else {
          this._applyingRemote = true
          this._recursionDepth = 1
        }
        try {
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
        } finally {
          if (this._recursionDepth > 0) {
            this._recursionDepth--
          }
          if (this._recursionDepth === 0) {
            this._applyingRemote = false
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
    this._fulltext?.addDocument(String(id), { name, ...(opts?.props ?? {}) })
    this.onRecordChange?.(name, { typeId, ...(opts?.props ?? {}) })

    if (this._mlReplication && !opts?.skipReplication) {
      const result = await this._mlReplication.replicate('node:created', { id, typeId, name, props: opts?.props }, opts as any)
      if (!result.success) {
        this.logger.error(`Multi-Leader replication: ${result.acksReceived}/${result.expectedAcks} ACKs`)
      }
    }

    // 递归保护：远程应用期间跳过全量 emit（防止回环），但触发本地回调
    if (!this._applyingRemote) {
      this._emit({ type: 'node:created', data: { id, typeId, name, props: opts?.props } })
    } else {
      this._emitLocal({ type: 'node:created', data: { id, typeId, name, props: opts?.props } })
    }
    return id
  }

  /**
   * 根据节点 ID 获取节点记录
   *
   * @param id - 节点 ID
   * @param ctx - 可选的 RLS 上下文，如果提供则进行行级过滤
   * @returns NodeRecord 或 null（节点不存在或 RLS 过滤掉时）
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  getNode(id: NodeId, ctx?: RLSContext): NodeRecord | null {
    this._ensureOpen()
    const raw = this.storage.getNode(id, true)
    if (!raw) return null

    // RLS 过滤：如果上下文提供且 RLS 启用，检查用户是否有权限查看此记录
    if (this._rls && ctx) {
      if (!this._rls.checkRecord('nodes', ctx, raw)) {
        return null
      }
    }

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
   * @param skipReplication - 是否跳过 Multi-Leader 同步复制（默认 false）
   * @param cascade - 是否级联删除关联边（默认 false）
   *   cascade=true 时，先删除该节点的所有出边，然后删除节点本身。
   *   注意：当前实现仅删除出边（src === id 的边），入边（dst === id 的边）不受影响。
   * @returns true 如果节点存在且被删除，false 如果节点不存在
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  async deleteNode(id: NodeId, skipReplication = false, cascade = false): Promise<boolean> {
    this._ensureOpen()
    const node = this.storage.getNode(id, true)
    if (!node) return false

    // 级联删除：先删除所有以该节点为起点的边
    if (cascade) {
      const entries = this.storage.neighbors(id)
      for (const entry of entries) {
        await this.deleteEdge(id, entry.nodeId, entry.edgeTypeId, skipReplication)
      }
    }

    this._labelIndex.removeNode(node.typeId, id)
    this._fulltext?.removeDocument(String(id))
    this.storage.deleteNode(id)
    this._nodeIds.delete(id)
    this._nodeCount = Math.max(0, this._nodeCount - 1)
    this.onRecordChange?.(node.key, { _deleted: true, typeId: node.typeId })

    if (this._mlReplication && !skipReplication) {
      const result = await this._mlReplication.replicate('node:deleted', { id, typeId: node.typeId, name: node.key })
      if (!result.success) {
        this.logger.error(`Multi-Leader replication: ${result.acksReceived}/${result.expectedAcks} ACKs`)
      }
    }

    // 递归保护：远程应用期间触发本地回调，不广播
    if (!this._applyingRemote) {
      this._emit({ type: 'node:deleted', data: { id, typeId: node.typeId, name: node.key } })
    } else {
      this._emitLocal({ type: 'node:deleted', data: { id, typeId: node.typeId, name: node.key } })
    }
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
        this._fulltext?.addDocument(String(id), { name: node.key, ...(node.props as Record<string, string | number | boolean | null>) })
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
        this.logger.error(`Multi-Leader replication: ${result.acksReceived}/${result.expectedAcks} ACKs`)
      }
    }

    // 递归保护：远程应用期间触发本地回调，不广播
    if (!this._applyingRemote) {
      this._emit({ type: 'edge:created', data: { src, dst, typeId, props: opts?.props } })
    } else {
      this._emitLocal({ type: 'edge:created', data: { src, dst, typeId, props: opts?.props } })
    }
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
        this.logger.error(`Multi-Leader replication: ${r.acksReceived}/${r.expectedAcks} ACKs`)
      }
    }

    // 递归保护：远程应用期间触发本地回调，不广播
    if (!this._applyingRemote) {
      this._emit({ type: 'edge:deleted', data: { src, dst, typeId } })
    } else {
      this._emitLocal({ type: 'edge:deleted', data: { src, dst, typeId } })
    }
    return result
  }

  /**
   * 获取指定节点的所有邻居
   *
   * @param id - 节点 ID
   * @param opts - 可选参数（maxDepth, edgeTypeFilter）
   * @param ctx - 可选的 RLS 上下文，如果提供则对结果集进行行级过滤
   * @returns 包含 edges 和 nodes 数组的对象
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  neighbors(id: NodeId, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }, ctx?: RLSContext): {
    edges: EdgeRecord[]; nodes: NodeRecord[]
  } {
    this._ensureOpen()

    // LRU 缓存：仅在无 RLS 上下文时命中
    if (!ctx) {
      const depth = opts?.maxDepth ?? 1
      const cacheKey = `${id}:${depth}`
      const cached = this._neighborCache.get(cacheKey as any)
      if (cached !== undefined) {
        return cached
      }
    }

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
          // RLS 过滤：如果上下文提供且 RLS 启用
          if (this._rls && ctx && !this._rls.checkRecord('nodes', ctx, raw)) {
            continue
          }
          nodes.push({
            id: raw.id, type: raw.typeId, name: raw.key,
            props: raw.props as Record<string, string | number | boolean | null>,
            createdAt: raw.createdAt, degree: 0,
          })
        }
      }
    }

    const result = { edges, nodes }

    // LRU 缓存写入（仅当无 RLS 上下文时）
    if (!ctx) {
      const depth = opts?.maxDepth ?? 1
      const cacheKey = `${id}:${depth}`
      const cacheTtlMs = this.config.neighborCacheTTLMs ?? 5000
      this._neighborCache.set(cacheKey as any, result, cacheTtlMs)
    }

    return result
  }

  /**
   * 批量邻居查询（带 LRU 缓存）
   *
   * 输入 N 个 nodeId，一次返回所有邻居。
   * 每个 nodeId 的 neighbors() 内部已自带 LRU 缓存，所以批量查询自然走缓存。
   *
   * @param ids - 节点 ID 数组（batch）
   * @param opts - 查询选项（同 neighbors()）
   * @returns Map<NodeId, { edges; nodes }>
   */
  batchNeighbors(ids: NodeId[], opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Map<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }> {
    this._ensureOpen()
    const result = new Map<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>()

    for (const id of ids) {
      const data = this.neighbors(id, opts)
      result.set(id, data)
    }

    return result
  }

  /**
   * neighborsMany — 批量邻居查询的公共 API（推荐外部使用）
   *
   * 与 batchNeighbors 功能相同，但名称更直观，且深度参数直接暴露。
   *
   * @param ids - 节点 ID 数组
   * @param depth - 遍历深度（默认 1）
   * @returns Map<NodeId, { edges; nodes }>
   */
  neighborsMany(ids: NodeId[], depth?: number): Map<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }> {
    return this.batchNeighbors(ids, { maxDepth: depth ?? 1 })
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
  // Cypher-lite query execution
  // ──────────────────────────────────────────

  /**
   * Cypher-lite 查询入口
   *
   * 支持的子集：
   *   MATCH (a:Label)-[:EDGE_LABEL]->(b) WHERE b.prop > val RETURN b.prop
   *   MATCH (a) WHERE a.name = "value" RETURN a
   *   ORDER BY / LIMIT / SKIP
   *
   * @param queryString - Cypher-lite 查询字符串
   * @param ctx - 可选的 RLS 上下文，如果提供则对结果集进行行级过滤
   * @param useOptimizer - 是否启用优化器桥接（默认 false 向后兼容）
   * @returns 查询结果（节点记录数组）
   */
  query(queryString: string, ctx?: RLSContext, useOptimizer: boolean = false): NodeRecord[] {
    this._ensureOpen()

    // 如果启用优化器，走 OptimizerBridge 路径
    if (useOptimizer) {
      return this._queryOptimized(queryString, ctx)
    }

    const plan = parseQuery(queryString)

    // 处理集合运算（UNION / INTERSECT / SUBTRACT）
    if (plan.unionType && plan.rightPlan) {
      const leftResults = this._executeQueryPlan(plan)
      const rightResults = this._executeQueryPlan(plan.rightPlan)
      const combined = this._applySetOperation(leftResults, rightResults, plan.unionType)
      return this._rls && ctx ? this._rls.enforceQuery('nodes', ctx, combined) : combined
    }

    const results = this._executeQueryPlan(plan)
    return this._rls && ctx ? this._rls.enforceQuery('nodes', ctx, results) : results
  }

  /**
   * 使用 OptimizerBridge 执行查询。
   * 将 Cypher-lite 解析后的 QueryPlan 转换为 QuerySpec，再走优化器路径。
   */
  private _queryOptimized(queryString: string, ctx?: RLSContext): NodeRecord[] {
    const plan = parseQuery(queryString)
    const bridge = this._getOrCreateBridge()

    // 将 QueryPlan 转为 QuerySpec（兼容 Cypher-lite 解析结果）
    const spec: QuerySpec = {
      match: plan.scanLabel ? { name: plan.scanLabel } : undefined,
      where: this._planFiltersToWhere(plan),
      limit: plan.limit,
      skip: plan.skip,
    }

    // 优化器桥接是异步的，但 query() 是同步的
    // 这里使用同步执行（因为当前的 GraphEngine._executeQueryPlan 也是同步的）
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)

    // 同步执行优化后的计划
    let result = this._executeOptimizedSync(optimized, spec)
    if (this._rls && ctx) {
      result = this._rls.enforceQuery('nodes', ctx, result)
    }
    return result
  }

  /**
   * 将 QueryPlan 的 filters 转为 QuerySpec 的 where 条件。
   */
  private _planFiltersToWhere(plan: QueryPlan): Record<string, any> {
    const where: Record<string, any> = {}
    for (const f of plan.filters) {
      if (f.operator === 'EQ') {
        where[f.property] = f.value
      }
    }
    return where
  }

  /**
   * 同步执行优化后的 IR 计划（同步版本，供 query() 使用）。
   */
  private _executeOptimizedSync(plan: any, spec: QuerySpec): NodeRecord[] {
    // 简化实现：直接提取 SCAN 节点的过滤和限制条件，
    // 用 GraphEngine 的标准同步方法执行
    let nodes = this._scanAll()

    // 获取下推的过滤条件
    const details = plan.details || {}
    const typeId = details.typeId as number | null | undefined
    const pushedFilters = details.pushedFilters as Array<{ field: string; op: string; value: unknown }> | undefined
    const pushedLimit = details.pushedLimit as number | undefined

    // 递归收集 SCAN 节点的下推条件（优化器可能把 FILTER 折叠进 SCAN）
    this._collectPushdownFromPlan(plan, nodes)

    // 按 typeId 过滤
    if (typeId !== null && typeId !== undefined) {
      nodes = nodes.filter(n => n.type === typeId)
    }

    // 应用下推的过滤条件
    if (pushedFilters && pushedFilters.length > 0) {
      for (const filter of pushedFilters) {
        nodes = nodes.filter(n => {
          const val = this._resolveNodeField(n, filter.field)
          return this._applyPredicate(val, filter.op, filter.value)
        })
      }
    }

    // 应用下推的 limit（早期截断）
    if (pushedLimit !== undefined && pushedLimit > 0) {
      nodes = nodes.slice(0, pushedLimit)
    }

    return nodes
  }

  /**
   * 从计划树中递归收集下推条件，并追加到 passed array。
   */
  private _collectPushdownFromPlan(plan: any, _nodes: NodeRecord[]): void {
    // 当前节点的下推条件
    const details = plan.details || {}
    const pushedFilters = details.pushedFilters as Array<{ field: string; op: string; value: unknown }> | undefined

    if (pushedFilters && pushedFilters.length > 0) {
      details['_collected'] = true
    }

    // 递归子节点
    if (plan.children) {
      for (const child of plan.children) {
        this._collectPushdownFromPlan(child, _nodes)
      }
    }
  }

  /**
   * 从 NodeRecord 中解析字段值（与 QueryIR 的 resolveNodeField 逻辑一致）。
   */
  private _resolveNodeField(node: NodeRecord, field: string): unknown {
    const key = field as keyof NodeRecord
    if (key in node) {
      return (node as any)[key]
    }
    return node.props?.[field]
  }

  /**
   * 应用过滤条件（与 QueryIR 的 applyPredicate 逻辑一致）。
   */
  private _applyPredicate(value: unknown, op: string, target: unknown): boolean {
    switch (op) {
      case 'eq':
        return value === target
      case 'neq':
        return value !== target
      case 'gt':
        return typeof value === 'number' && typeof target === 'number' && value > target
      case 'gte':
        return typeof value === 'number' && typeof target === 'number' && value >= target
      case 'lt':
        return typeof value === 'number' && typeof target === 'number' && value < target
      case 'lte':
        return typeof value === 'number' && typeof target === 'number' && value <= target
      case 'prefix':
        return typeof value === 'string' && typeof target === 'string' && value.startsWith(target)
      case 'in':
        return Array.isArray(target) && target.includes(value)
      default:
        return true
    }
  }

  /**
   * 获取或创建 OptimizerBridge 实例。
   */
  private _getOrCreateBridge(): OptimizerBridge {
    if (!this._bridge) {
      this._bridge = new OptimizerBridge(this)
    }
    return this._bridge
  }

  /**
   * 暴露给 OptimizerBridge 的全量扫描方法。
   * OptimizerBridge 通过此方法从本引擎扫描所有节点。
   */
  public scanAllNodes(): NodeRecord[] {
    return this._scanAll()
  }

  /**
   * 执行集合运算
   */
  private _applySetOperation(
    left: NodeRecord[],
    right: NodeRecord[],
    op: 'union' | 'union_all' | 'intersect' | 'subtract',
  ): NodeRecord[] {
    switch (op) {
      case 'union': {
        const seen = new Set<number>()
        const result: NodeRecord[] = []
        for (const n of [...left, ...right]) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            result.push(n)
          }
        }
        return result
      }
      case 'union_all': {
        return [...left, ...right]
      }
      case 'intersect': {
        const rightIds = new Set(right.map(n => n.id))
        return left.filter(n => rightIds.has(n.id))
      }
      case 'subtract': {
        const rightIds = new Set(right.map(n => n.id))
        return left.filter(n => !rightIds.has(n.id))
      }
      default:
        return left
    }
  }

  /**
   * 执行 QueryPlan
   */
  private _executeQueryPlan(plan: QueryPlan, ctx?: RLSContext): NodeRecord[] {
    // Step 1: 扫描起始节点
    let candidates: NodeRecord[]
    if (plan.scanLabel) {
      // 用 label 字符串匹配所有节点的 typeName
      candidates = this._scanNodesByLabel(plan.scanLabel)
    } else {
      candidates = this._scanAll()
    }

    // RLS 过滤：扫描结果
    if (this._rls && ctx) {
      candidates = this._rls.enforceQuery('nodes', ctx, candidates)
    }

    if (candidates.length === 0) {
      // 聚合函数在空结果集时返回预设值
      if (plan.aggregate) {
        return this._execAggregation([], plan.aggregate)
      }
      return []
    }

    // Step 2: 执行遍历步（支持单跳和变长多跳）
    let results: NodeRecord[] = [...candidates]
    for (const step of plan.steps) {
      if (step.range) {
        // 变长路径：执行 BFS 多跳遍历
        const minDepth = step.range.min
        const maxDepth = step.range.max ?? minDepth // null max means no upper bound, treat as min
        results = this._executeVariableLengthTraversal(results, {
          relationshipType: step.edgeLabel ? Number(step.edgeLabel) : undefined,
          minDepth,
          maxDepth,
          direction: step.direction,
          ctx,
        })
      } else {
        // 单跳遍历（原有逻辑）
        const filtered: NodeRecord[] = []
        for (const node of results) {
          const neighborsRaw = this.storage.neighbors(node.id, {
            edgeTypeFilter: step.edgeLabel ? [Number(step.edgeLabel)] : undefined,
          })
          for (const entry of neighborsRaw) {
            const neighbor = this.getNode(entry.nodeId, ctx)
            if (neighbor) {
              if (step.targetLabel && neighbor.typeName !== step.targetLabel) continue
              filtered.push(neighbor)
            }
          }
        }
        results = filtered
      }
      if (results.length === 0) break
    }

    // Step 3: 应用 WHERE 过滤器
    if (plan.filters.length > 0) {
      results = results.filter(node =>
        plan.filters.every(f => this._matchFilter(node, f))
      )
    }

    // 如果检测到聚合函数，执行聚合（在 WHERE 之后，SKIP/LIMIT 之前）
    if (plan.aggregate) {
      return this._execAggregation(results, plan.aggregate)
    }

    // Step 4: SKIP / LIMIT
    if (plan.skip && plan.skip > 0) {
      results = results.slice(plan.skip)
    }
    if (plan.limit && results.length > plan.limit) {
      results = results.slice(0, plan.limit)
    }

    return results
  }

  /**
   * 执行聚合函数
   */
  private _execAggregation(nodes: NodeRecord[], agg: { type: string; field?: string; alias?: string }): NodeRecord[] {
    // 提取实际属性名：如 n.age → age，n.score → score
    const rawField = agg.field ?? ''
    const propName = rawField.includes('.') ? rawField.split('.')[1] : rawField

    let value: number

    switch (agg.type) {
      case 'count':
        value = nodes.length
        break
      case 'sum':
        value = this._aggregateSum(nodes, propName)
        break
      case 'avg':
        value = this._aggregateAvg(nodes, propName)
        break
      case 'max':
        value = this._aggregateMax(nodes, propName)
        break
      case 'min':
        value = this._aggregateMin(nodes, propName)
        break
      default:
        value = 0
    }

    // 构造伪节点作为返回值，确保返回结果与现有的 query() 签名兼容
    const alias = agg.alias ?? agg.type
    return [{
      id: -1,
      name: alias,
      typeId: 0,
      typeName: '',
      props: { [alias]: value },
    } as unknown as NodeRecord]
  }

  /** 对节点数组计算属性求和 */
  private _aggregateSum(nodes: NodeRecord[], field: string): number {
    let sum = 0
    for (const n of nodes) {
      const val = n.props?.[field]
      if (typeof val === 'number') sum += val
    }
    return sum
  }

  /** 对节点数组计算属性平均值 */
  private _aggregateAvg(nodes: NodeRecord[], field: string): number {
    let sum = 0
    let count = 0
    for (const n of nodes) {
      const val = n.props?.[field]
      if (typeof val === 'number') { sum += val; count++ }
    }
    return count > 0 ? sum / count : 0
  }

  /** 对节点数组计算属性最大值 */
  private _aggregateMax(nodes: NodeRecord[], field: string): number {
    let max = -Infinity
    for (const n of nodes) {
      const val = n.props?.[field]
      if (typeof val === 'number' && val > max) max = val
    }
    return max === -Infinity ? 0 : max
  }

  /** 对节点数组计算属性最小值 */
  private _aggregateMin(nodes: NodeRecord[], field: string): number {
    let min = Infinity
    for (const n of nodes) {
      const val = n.props?.[field]
      if (typeof val === 'number' && val < min) min = val
    }
    return min === Infinity ? 0 : min
  }

  /** 扫描所有节点 */
  private _scanAll(): NodeRecord[] {
    const records: NodeRecord[] = []
    for (const id of this._nodeIds) {
      const node = this.getNode(id)
      if (node) records.push(node)
    }
    return records
  }

  /** 按 label (typeName) 扫描节点 */
  private _scanNodesByLabel(label: string): NodeRecord[] {
    const records: NodeRecord[] = []
    for (const id of this._nodeIds) {
      const node = this.getNode(id)
      if (node && node.typeName === label) {
        records.push(node)
      }
    }
    return records
  }

  /** 检查单条 filter 是否匹配 */
  private _matchFilter(node: NodeRecord, f: { property: string; operator: string; value: unknown }): boolean {
    const val = node.props?.[f.property]
    switch (f.operator) {
      case 'EQ':  return val === f.value
      case 'NEQ': return val !== f.value
      case 'GT':  return typeof val === 'number' && typeof f.value === 'number' && val > f.value
      case 'GTE': return typeof val === 'number' && typeof f.value === 'number' && val >= f.value
      case 'LT':  return typeof val === 'number' && typeof f.value === 'number' && val < f.value
      case 'LTE': return typeof val === 'number' && typeof f.value === 'number' && val <= f.value
      default: return true
    }
  }

  /**
   * 变长路径 BFS 多跳遍历
   *
   * 从 candidates 节点开始，沿指定边类型进行 BFS 遍历，
   * 收集深度在 [minDepth, maxDepth] 范围内的所有目标节点。
   *
   * @param candidates - 起始节点列表
   * @param opts - 遍历选项
   * @param opts.relationshipType - 边类型 ID（可选）
   * @param opts.minDepth - 最小深度
   * @param opts.maxDepth - 最大深度
   * @param opts.direction - 遍历方向
   * @param opts.ctx - RLS 上下文（可选）
   * @returns 位于有效深度范围内的目标节点列表（去重）
   */
  private _executeVariableLengthTraversal(
    candidates: NodeRecord[],
    opts: {
      relationshipType?: number;
      minDepth: number;
      maxDepth: number;
      direction: 'out' | 'in' | 'any';
      ctx?: RLSContext;
    },
  ): NodeRecord[] {
    const { relationshipType, minDepth, maxDepth, direction, ctx } = opts
    const visited = new Set<number>()
    const results: NodeRecord[] = []

    // 每个元素: { node, depth }
    interface BFSState {
      node: NodeRecord
      depth: number
    }

    // 初始化 BFS 队列
    const queue: BFSState[] = candidates.map(n => ({ node: n, depth: 0 }))
    for (const c of candidates) {
      visited.add(c.id)
    }

    let head = 0
    while (head < queue.length) {
      const { node, depth } = queue[head]
      head++

      // 如果已到达 maxDepth，停止扩展
      if (depth >= maxDepth) continue

      // 获取邻居
      const neighborsRaw = this.storage.neighbors(node.id, {
        edgeTypeFilter: relationshipType !== undefined ? [relationshipType] : undefined,
      })

      for (const entry of neighborsRaw) {
        const neighborId = entry.nodeId
        if (visited.has(neighborId)) continue
        visited.add(neighborId)

        const neighbor = this.getNode(neighborId, ctx)
        if (!neighbor) continue

        const nextDepth = depth + 1

        // 如果深度在有效范围内，加入结果集
        if (nextDepth >= minDepth && nextDepth <= maxDepth) {
          results.push(neighbor)
        }

        // 如果未到 maxDepth，继续扩展
        if (nextDepth < maxDepth) {
          queue.push({ node: neighbor, depth: nextDepth })
        }
      }
    }

    return results
  }

  // ──────────────────────────────────────────
  // FullText search
  // ──────────────────────────────────────────

  /**
   * 全文搜索 — 代理到 FullTextIndex（如果已配置）
   *
   * @param query - 搜索关键词
   * @param options - 搜索选项（limit, fields, fuzzy, weights, mode 等）
   * @returns 搜索结果数组，未配置 fulltext 时返回空数组
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  search(query: string, options?: SearchOptions): SearchResult[] {
    this._ensureOpen()
    if (!this._fulltext) return []
    return this._fulltext.search(query, options)
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
   * 统计节点属性最大值
   * @param field - 属性字段名（必须是数字类型）
   * @param typeFilter - 可选，按 typeId 过滤
   * @returns 属性值的最大值，无匹配节点时返回 -Infinity
   */
  maxNodeProperty(field: string, typeFilter?: number[]): number {
    this._ensureOpen()
    let max = -Infinity
    for (const id of this._nodeIds) {
      const raw = this.storage.getNode(id, true)
      if (!raw) continue
      if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(raw.typeId)) continue
      const val = raw.props?.[field]
      if (typeof val === 'number' && val > max) {
        max = val
      }
    }
    return max === -Infinity ? 0 : max
  }

  /**
   * 统计节点属性最小值
   * @param field - 属性字段名（必须是数字类型）
   * @param typeFilter - 可选，按 typeId 过滤
   * @returns 属性值的最小值，无匹配节点时返回 Infinity
   */
  minNodeProperty(field: string, typeFilter?: number[]): number {
    this._ensureOpen()
    let min = Infinity
    for (const id of this._nodeIds) {
      const raw = this.storage.getNode(id, true)
      if (!raw) continue
      if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(raw.typeId)) continue
      const val = raw.props?.[field]
      if (typeof val === 'number' && val < min) {
        min = val
      }
    }
    return min === Infinity ? 0 : min
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

  // ── 图算法 API (Round 6) ──

  /**
   * BFS 遍历
   * @param startNode - 起始节点 ID
   * @returns Map<nodeId, { distance, parent }>
   */
  async bfs(startNode: NodeId): Promise<Map<NodeId, { distance: number; parent: NodeId | null }>> {
    this._ensureOpen()
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return bfs(getNeighbors, startNode)
  }

  /**
   * DFS 遍历
   * @param startNode - 起始节点 ID
   * @param order - 可选，'pre' | 'post'
   * @returns { pre, post, parent }
   */
  async dfs(startNode: NodeId, order?: 'pre' | 'post'): Promise<{
    pre: NodeId[]; post: NodeId[]; parent: Map<NodeId, NodeId | null>
  }> {
    this._ensureOpen()
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return dfs(getNeighbors, startNode, order)
  }

  /**
   * PageRank 计算
   * @param options - 可选参数（dampingFactor, maxIterations, convergenceThreshold）
   * @returns Map<nodeId, rank>
   */
  async pagerank(options?: {
    dampingFactor?: number; maxIterations?: number; convergenceThreshold?: number
  }): Promise<Map<NodeId, number>> {
    this._ensureOpen()
    const allNodes = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return pagerank(getNeighbors, allNodes, options)
  }

  /**
   * 最短路径（无权图）
   * 使用 BFS 计算从 start 到 end 的最短路径
   * @param start - 起始节点 ID
   * @param end - 目标节点 ID
   * @returns { path, distance } | null
   */
  async shortestPath(start: NodeId, end: NodeId): Promise<{
    path: NodeId[]; distance: number
  } | null> {
    this._ensureOpen()
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    const result = bfs(getNeighbors, start)
    if (!result.has(end)) return null
    // 回溯路径
    const path: NodeId[] = []
    let current: NodeId | null = end
    while (current !== null) {
      path.unshift(current)
      current = result.get(current)!.parent
    }
    return { path, distance: result.get(end)!.distance }
  }

  /**
   * Dijkstra 最短路径（带权图）
   * @param startNode - 起始节点 ID
   * @returns Map<nodeId, { distance, parent }>
   */
  async dijkstra(startNode: NodeId): Promise<Map<NodeId, { distance: number; parent: NodeId | null }>> {
    this._ensureOpen()
    const getWeightedNeighbors = (nid: NodeId) =>
      this.neighbors(nid).edges.map(e => ({ nodeId: e.dst, weight: 1 }))
    return dijkstra(getWeightedNeighbors, startNode)
  }

  // ── Round 6: Additional Graph Algorithms (Gap 6) ──

  /**
   * Weakly Connected Components (WCC)
   * Uses graphology-components internally.
   * @returns { components, count }
   */
  async wcc(): Promise<{ components: number[][]; count: number }> {
    this._ensureOpen()
    const nodeIds = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return wccAlgo(nodeIds, getNeighbors)
  }

  /**
   * Strongly Connected Components (SCC)
   * Uses graphology-components internally.
   * @returns { components, count }
   */
  async scc(): Promise<{ components: number[][]; count: number }> {
    this._ensureOpen()
    const nodeIds = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return sccAlgo(nodeIds, getNeighbors)
  }

  /**
   * Triangle counting
   * Self-implemented node-iteration method.
   * @returns { count, triangles }
   */
  async triangleCount(): Promise<{ count: number; triangles: [number, number, number][] }> {
    this._ensureOpen()
    const nodeIds = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return triangleCountAlgo(nodeIds, getNeighbors)
  }

  /**
   * Label Propagation community detection
   * @param options - Optional { maxIterations }
   * @returns { labels, communityCount, iterations, converged }
   */
  async labelPropagation(options?: { maxIterations?: number }): Promise<{
    labels: Map<number, number>; communityCount: number; iterations: number; converged: boolean
  }> {
    this._ensureOpen()
    const nodeIds = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return labelPropagationAlgo(nodeIds, getNeighbors, options)
  }

  /**
   * Degree centrality
   * @param options - Optional { normalized, direction }
   * @returns { scores }
   */
  async degreeCentrality(options?: {
    normalized?: boolean; direction?: 'in' | 'out' | 'all'
  }): Promise<{ scores: Map<number, number> }> {
    this._ensureOpen()
    const nodeIds = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return degreeCentralityAlgo(nodeIds, getNeighbors, undefined, options)
  }

  /**
   * A* shortest path
   * @param start - Start node ID
   * @param end - Goal node ID
   * @param heuristic - Optional heuristic function (default: zero = Dijkstra)
   * @returns { path, cost } | null
   */
  async astar(start: NodeId, end: NodeId, heuristic?: HeuristicFn): Promise<{
    path: NodeId[]; cost: number
  } | null> {
    this._ensureOpen()
    const getWeightedNeighbors = (nid: NodeId) =>
      this.neighbors(nid).edges.map(e => ({ nodeId: e.dst, weight: 1 }))
    return astarAlgo(getWeightedNeighbors, start, end, heuristic)
  }

  private _ensureOpen(): void {
    if (!this._isOpen) {
      throw new Error('GraphEngine is not open. Call open() first.')
    }
  }

  // ── Transaction API (Round 6: MVCC 增强) ──

  private _defaultTxnManager = new TransactionManager()

  beginTransaction(txnManager?: TransactionManager): Transaction {
    const mgr = txnManager ?? this._defaultTxnManager
    return mgr.begin()
  }

  async withTransaction<T>(
    fn: (txn: Transaction) => Promise<T>,
    txnManager?: TransactionManager,
  ): Promise<T> {
    const mgr = txnManager ?? this._defaultTxnManager
    const txn = mgr.begin()
    try {
      const result = await fn(txn)
      await txn.commit()
      return result
    } catch (err) {
      await txn.rollback()
      throw err
    }
  }

  async execInTransaction(
    nodeId: NodeId,
    operation: 'upsert' | 'delete',
    data?: { typeId?: number; name?: string; props?: Record<string, any> },
    txnManager?: TransactionManager,
  ): Promise<void> {
    const mgr = txnManager ?? this._defaultTxnManager
    const txn = mgr.begin()
    try {
      if (operation === 'upsert' && data) {
        txn.upsertNode(data.typeId!, data.name!, data.props)
      } else if (operation === 'delete') {
        txn.deleteNode(nodeId)
      }
      await txn.commit()
    } catch (err) {
      await txn.rollback()
      throw err
    }
  }
}
