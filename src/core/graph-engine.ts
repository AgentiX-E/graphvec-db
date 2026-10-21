import {
  NodeId, NodeRecord, EdgeRecord, NodeProperties,
  UpsertNodeOptions, UpsertEdgeOptions,
  VectorSearchOptions, VectorSearchResult,
  PersonalizedPageRankOptions, ShortestPathOptions, ConnectedComponentsOptions,
  PatternMatchOptions, OverGraphConfig,
} from '../types'
import { StorageProvider, StorageConfig, NeighborsOptions, NeighborEntry } from './storage-provider'
import { OverGraphStorage } from './overgraph-storage'
import { ClassicLevelStorageProvider } from './storage-classic-level'
import { EncryptionAtRest, CipherConfig } from './cipher'

import { LabelEngine } from './label-engine'
import { bfs } from '../algorithms/bfs'
import { dfs } from '../algorithms/dfs'
import { pagerank } from '../algorithms/pagerank'
import { dijkstra } from '../algorithms/dijkstra'
import { GraphProjection } from '../algorithms/graph-projection'
import { StreamingPageRank } from '../algorithms/streaming-pagerank'
import { wcc as wccAlgo } from '../algorithms/wcc'
import { scc as sccAlgo } from '../algorithms/scc'
import { triangleCount as triangleCountAlgo } from '../algorithms/triangle-count'
import { labelPropagation as labelPropagationAlgo } from '../algorithms/label-propagation'
import { degreeCentrality as degreeCentralityAlgo } from '../algorithms/degree-centrality'
import { astar as astarAlgo, HeuristicFn } from '../algorithms/astar'
import { closeness } from '../algorithms/closeness'
import { kCore } from '../algorithms/k-core'
import { leidenCommunity } from '../algorithms/leiden'
import { egoNet } from '../algorithms/ego-net'
import { LinkPredictor } from '../algorithms/link-prediction'
import { getEventBus } from './event-bus'
import { EventStream } from './event-stream'
import { MultiLeaderReplication } from './multi-leader-replication'
import { QueryResultCache, makeQueryCacheKey } from './query-cache'
import { SchemaDef, ValidationResult } from '../schema/schema-types'
import { validateNodeType, validateEdgeType } from '../schema/schema-validator'

import { parseQuery, QueryPlan } from '../query/query-engine'
import { AggregateClause } from '../query/query-types'
import { FullTextIndex, SearchOptions, SearchResult } from '../search/fulltext'
import { RLSContext, RowLevelSecurity } from '../security/rls'
import { QueryPlanner, QuerySpec, buildIRFromSpec, optimizeIR } from '../api/query-planner'
import { OptimizerBridge } from '../query/planner-bridge'
import { _compareOrderByValue } from '../query/expression-engine'
import { Logger } from '../ops/logger'
import * as path from 'path'
import { Transaction, TransactionManager } from './transaction'
import { SimpleTxnManager } from './simple-txn-manager'

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
  /** MVCC 版本跟踪：nodeId → 最后修改该节点的事务 snapshotId */
  private _mvccVersions: Map<NodeId, number> = new Map()
  private _eventStream: EventStream | null = null
  /** Multi-Leader 同步复制层（Optional） */
  private _mlReplication: MultiLeaderReplication | null = null
  /** 备份写冻结 */
  private _writesFrozen = false
  private _frozenWrites: Array<{ resolve: () => void }> = []
  /** 字符串标签 → typeId 注册表（惰性分配） */
  private _labelRegistry: Map<string, number> = new Map()
  /** 字符串标签 → nodeId 索引（用于快速 _scanNodesByLabel） */
  private _labelStrIndex: Map<string, Set<NodeId>> = new Map()
  /** 字符串 edge 类型名 → typeId 注册表 */
  private _edgeTypeRegistry: Map<string, number> = new Map()
  private logger: Logger

  // ── 索引持久化 ──
  private _persistIndexes: boolean
  private _indexesDir: string

  // ── LRU Cache for neighbors ──
  private _neighborCache: LRUCache<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }>
  private _cacheEnabled = false
  private _cacheMaxSize: number
  private _cacheDefaultTTLSec: number

  // ── 度数缓存（D-07） ──
  private _inDegrees: Map<NodeId, number> = new Map()
  private _outDegrees: Map<NodeId, number> = new Map()

  // ── LRU Cache for individual nodes/edges (Gap 12) ──
  private _nodeCache: LRUCache<NodeId, NodeRecord>
  private _edgeCache: LRUCache<string, EdgeRecord>
  private _nodeCacheSize: number
  private _edgeCacheSize: number
  private _nodeCacheHits = 0
  /** 查询超时毫秒数（0 表示不超时） */
  readonly queryTimeoutMs: number
  private _nodeCacheMisses = 0
  private _edgeCacheHits = 0
  private _edgeCacheMisses = 0

  // ── QueryResultCache (GAP-24) ──
  /** 查询结果缓存 */
  private _queryCache: QueryResultCache | null = null

  /** Schema type definitions（Optional） */
  private _schema?: SchemaDef

  /** FullText 全文索引（Optional） */
  private _fulltext: FullTextIndex | null = null

  /** Row-Level Security（Optional） */
  private _rls: RowLevelSecurity | null = null

  /** QueryPlanner — 查询计划器（Optional，主供优化器桥接使用） */
  private _planner: QueryPlanner | null = null

  /** OptimizerBridge — 优化器桥接层（Optional） */
  private _bridge: OptimizerBridge | null = null

  // ── Degree Cache ──
  private _inDegreeCounts: Map<NodeId, number> = new Map()
  private _outDegreeCounts: Map<NodeId, number> = new Map()

  // ── 写冻结（备份一致性） ─────────────────

  /**
   * 暂停所有写入操作（用于一致性备份）。
   * 返回一个函数，调用后恢复写入。
   * 当前正在执行的写入不受影响，新写入会排队等待。
   */
  async pauseWrites(): Promise<() => void> {
    this._writesFrozen = true
    // 等待所有正在执行的写入完成
    await Promise.resolve()
    return () => this.resumeWrites()
  }

  private resumeWrites(): void {
    this._writesFrozen = false
    const pending = this._frozenWrites.splice(0)
    for (const p of pending) p.resolve()
  }

  private _ensureNotFrozen(): void {
    if (this._writesFrozen) {
      throw new Error('Writes are frozen for backup. Retry after backup completes.')
    }
  }

  // ── 递归保护（Item 1: upsertNode递归死循环） ──
  /** 最大递归深度 */
  private static MAX_RECURSION_DEPTH = 10
  /** 正在应用远程事件 */
  private _applyingRemote = false
  /** 当前递归深度 */
  private _recursionDepth = 0

  /**
   * Optional的回调：当节点/边发生变更时被调用
   * 用于 DeltaSync 捕捉变更
   */
  public onRecordChange?: (name: string, fields: Record<string, any>) => void

  constructor(config: OverGraphConfig, storage?: StorageProvider, eventStream?: EventStream, mlReplication?: MultiLeaderReplication, fulltext?: FullTextIndex, rls?: RowLevelSecurity, planner?: QueryPlanner, cipherConfig?: CipherConfig) {
    // Create cipher if config provided
    let cipher: EncryptionAtRest | undefined
    if (cipherConfig) {
      cipher = new EncryptionAtRest(cipherConfig)
      // Note: ready() must be called before open() — it's an async operation
      // The caller should await cipher.ready() before using the engine
      // For AES-256-GCM, initSync() can be used instead
    }
    this.storage = storage ?? new OverGraphStorage(cipher)
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
    // ── 初始化 node/edge 缓存 (Gap 12) ──
    this._nodeCacheSize = config.nodeCacheSize ?? 1000
    this._edgeCacheSize = config.edgeCacheSize ?? 500
    this._nodeCache = new LRUCache<NodeId, NodeRecord>(this._nodeCacheSize, 60)
    this._edgeCache = new LRUCache<string, EdgeRecord>(this._edgeCacheSize, 60)
    this.logger = new Logger('GraphEngine')
    this.queryTimeoutMs = config.queryTimeoutMs ?? 30000
    this._persistIndexes = config.persistIndexes ?? true
    this._indexesDir = path.join(config.path, 'indexes')

    // 注册 EventStream 远程数据处理（见 open() 方法）
    // 由 open() 调用 registerApplyHandler，避免构造函数重复注册
  }

  /** Set Schema definition */
  setSchema(schema: SchemaDef): void {
    this._schema = schema
  }

  /** Get current Schema */
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

    // 如果未注入 StorageProvider，根据 backend 配置自动选择
    if (this.config.backend === 'classic-level' && !(this.storage instanceof ClassicLevelStorageProvider)) {
      // 只有在经典后端模式下才替换，且仅在外部未注入时
      this.storage = new ClassicLevelStorageProvider()
    }

    const storageConfig: StorageConfig = {
      path: this.config.path,
      backend: this.config.backend,
      denseVector: this.config.denseVector
        ? { dimension: this.config.denseVector.dimension }
        : undefined,
      defaultRetention: this.config.defaultRetention,
      overgraph: this.config.overgraph,
      compress: this.config.storageCompression,
      // Default to msgpack so property insertion order is preserved across
      // Rust persistence (order is a correctness requirement, not compression).
      compressionStrategy: 'msgpack',
    }
    this.storage.open(storageConfig)

    // 恢复持久化内存索引
    if (this._persistIndexes) {
      try {
        this._labelIndex.load(this._indexesDir)
      } catch (e) {
        this.logger.warn('LabelIndex load failed, starting empty:', { error: e })
      }
      if (this._fulltext) {
        try {
          this._fulltext.load(this._indexesDir)
        } catch (e) {
          this.logger.warn('FullTextIndex load failed, starting empty:', { error: e })
        }
      }
    }

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

    // 从已恢复的存储层重建节点索引
    this._rebuildIndexesFromStorage()

    this._isOpen = true
  }

  /**
   * open() 后从 storage 重建内存索引（_nodeIds, _nodeCount）
   * 支持 persistence 恢复：second open 时扫描已有数据重建索引
   */
  private _rebuildIndexesFromStorage(): void {
    try {
      const ids = this.storage.getAllNodeIds()
      if (ids && ids.length > 0) {
        for (const id of ids) {
          if (!this._nodeIds.has(id)) {
            this._nodeIds.add(id)
            this._nodeCount++
          }
        }
      }
    } catch {
      // 部分 storage 实现可能不支持 getAllNodeIds
    }
  }

  /** Close database */
  close(): void {
    if (!this._isOpen) return

    // 持久化内存索引
    this.saveIndexes()

    this.storage.close()
    this._isOpen = false
  }

  /**
   * 手动保存内存索引到磁盘（用于备份等场景的同步点）。
   * 不要求引擎处于 open 状态即可调用。
   */
  saveIndexes(): void {
    if (!this._persistIndexes) return
    try {
      this._labelIndex.save(this._indexesDir)
    } catch (e) {
      this.logger.warn('LabelIndex save failed:', { error: e })
    }
    if (this._fulltext) {
      try {
        this._fulltext.save(this._indexesDir)
      } catch (e) {
        this.logger.warn('FullTextIndex save failed:', { error: e })
      }
    }
  }

/**
 * 启用查询结果缓存（GAP-24）
 *
 * @param config 缓存配置
 */
enableQueryCache(config?: { maxSize?: number; ttlSec?: number }): void {
  this._queryCache = new QueryResultCache({
    maxSize: config?.maxSize ?? 500,
    ttlSec: config?.ttlSec ?? 30,
  })
  this.logger.info('QueryResultCache enabled', { maxSize: config?.maxSize ?? 500, ttlSec: config?.ttlSec ?? 30 })
}

/**
 * 获取查询结果缓存实例（如果已启用）
 */
getQueryCache(): QueryResultCache | null {
  return this._queryCache
}

/**
 * 在写入操作后失效查询缓存
 * 供 upsertNode / deleteNode / upsertEdge / deleteEdge 调用
 */
private _invalidateQueryCache(typeId?: number, nodeId?: number): void {
  if (!this._queryCache) return
  const tags: import('./query-cache').CacheTag[] = []
  if (typeId !== undefined) tags.push(typeId)
  if (nodeId !== undefined) tags.push(String(nodeId))
  this._queryCache.onWrite(tags.length > 0 ? tags : undefined)
}

// ──────────────────────────────────────────
// Node operations
// ──────────────────────────────────────────

  /**
   * 插入或更新一个节点（Multi-Leader 模式：同步等待所有远程节点 ACK）
   *
   * @param typeId - 节点类型 ID
   * @param name - 节点名称
   * @param opts - Optional参数（属性、向量、有效期、衰减因子、TTL）
   * @returns 新插入或已有节点的 ID
   * @throws {Error} 如果 GraphEngine 未 open() 或同步复制超时
   */
  async upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): Promise<NodeId> {
    this._ensureOpen()
    this._ensureNotFrozen()

    // 简单事务缓冲：如果提供了 _txId，将操作缓冲到 SimpleTxnManager 中
    if (opts?._txId) {
      this.simpleTxnMgr.addOp(opts._txId, {
        type: 'upsertNode',
        args: [typeId, name, { ...opts, _txId: undefined }],
      })
      // 返回一个占位 ID（真正的 ID 在 commit 时由 storage 返回）
      return -1
    }

    if (this._schema) {
      const result = validateNodeType(typeId, opts?.props ?? {}, this._schema)
      if (!result.valid) {
        throw new Error(`Schema 校验失败: ${result.errors.join('; ')}`)
      }
    }

    const id = this.storage.upsertNode(typeId, name, opts)
    // 清除节点缓存（Gap 12）
    this._nodeCache.delete(id)
    // 查询结果缓存失效（GAP-24）
    this._invalidateQueryCache(typeId, id)
    if (!this._nodeIds.has(id)) {
      this._nodeIds.add(id)
      this._nodeCount++
    }
    // MVCC 版本跟踪
    if (opts?._mvccVersion !== undefined) {
      this._mvccVersions.set(id, opts._mvccVersion)
    }
    this._labelIndex.addNode(typeId, id)
    // 维护字符串 label 索引（用于 _scanNodesByLabel 的 props._label 匹配路径）
    const strLabel = opts?.props?._label ?? name
    if (strLabel) {
      if (!this._labelStrIndex.has(String(strLabel))) this._labelStrIndex.set(String(strLabel), new Set())
      this._labelStrIndex.get(String(strLabel))!.add(id)
    }
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
   * 根据Node ID 获取节点记录
   *
   * @param id - Node ID
   * @param ctx - Optional的 RLS 上下文，如果提供则进行行级过滤
   * @returns NodeRecord 或 null（节点不存在或 RLS 过滤掉时）
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  getNode(id: NodeId, ctx?: RLSContext): NodeRecord | null {
    this._ensureOpen()

    // LRU cache hit — only when no RLS context
    if (!ctx) {
      const cached = this._nodeCache.get(id)
      if (cached !== undefined) {
        this._nodeCacheHits++
        return cached
      }
    }
    this._nodeCacheMisses++

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
      const inDeg = this._inDegreeCounts.get(id) ?? 0
      const outDeg = this._outDegreeCounts.get(id) ?? 0
      if (inDeg > 0 || outDeg > 0) {
        degree = inDeg + outDeg
      } else {
        // Fallback to storage for unknown nodes
        const d = this.storage.degrees(id)
        // OverGraph 0.11.0 的 degree() 只返回总度数，inDegree/outDegree 都等于 total
        degree = d.inDegree
        this._inDegreeCounts.set(id, d.inDegree)
        this._outDegreeCounts.set(id, d.outDegree)
      }
    } catch {
      // storage 可能在某些状态下不支持 degrees() 调用
    }

    const record: NodeRecord = {
      id: raw.id,
      type: raw.typeId,
      name: raw.key,
      props: raw.props as NodeProperties,
      createdAt: raw.createdAt,
      degree,
      mvccVersion: this._mvccVersions.get(id),
    } as NodeRecord
    // 从 props._label 填充 typeName（用于 TCK label 匹配）
    const rawLabel = (raw.props as NodeProperties)?._label
    record.typeName = typeof rawLabel === 'string' ? rawLabel : ''

    // Populate cache on miss (only when no RLS context)
    if (!ctx) {
      this._nodeCache.set(id, record)
    }

    return record
  }

  /**
   * 删除指定 ID 的节点
   *
   * @param id - 要删除的Node ID
   * @param skipReplication - 是否跳过 Multi-Leader 同步复制（默认 false）
   * @param cascade - 是否级联删除关联边（默认 false）
   *   cascade=true 时，先删除该节点的所有出边，然后删除节点本身。
   *   Note: 当前实现仅删除出边（src === id 的边），入边（dst === id 的边）不受影响。
   * @param opts - Optional参数（如 _txId 事务 ID）
   * @returns true 如果节点存在且被删除，false 如果节点不存在
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  async deleteNode(id: NodeId, skipReplication = false, cascade = false, opts?: { _txId?: string }): Promise<boolean> {
    this._ensureOpen()
    this._ensureNotFrozen()

    // 简单事务缓冲：如果提供了 _txId，将操作缓冲到 SimpleTxnManager 中
    if (opts?._txId) {
      this.simpleTxnMgr.addOp(opts._txId, {
        type: 'deleteNode',
        args: [id, skipReplication, cascade],
      })
      return true
    }

    const node = this.storage.getNode(id, true)
    if (!node) return false

    // 总是删除该节点的所有关联边（入边和出边）
    const outEntries = this.storage.neighbors(id)
    for (const entry of outEntries) {
      await this.deleteEdge(id, entry.nodeId, entry.edgeTypeId, skipReplication)
    }
    // 删除入边：通过 OverGraph 入边查询
    try {
      const inOpts = { direction: 'in' as const }
      const inEntries = this.storage.neighbors(id, inOpts as any)
      for (const entry of inEntries) {
        await this.deleteEdge(entry.nodeId, id, entry.edgeTypeId, skipReplication)
      }
    } catch {
      // 部分 storage 实现不支持 direction 参数，跳过
    }
    // 级联删除 cascade 模式下递归删除关联边
    if (cascade) {
      // 入边（其他节点指向本节点的边）在 deleteEdge 中已清理
    }

    this._labelIndex.removeNode(node.typeId, id)
    // 清除字符串 label 索引
    const nodeLabel = node.props?._label ?? ''
    if (nodeLabel && this._labelStrIndex.has(String(nodeLabel))) {
      this._labelStrIndex.get(String(nodeLabel))!.delete(id)
      if (this._labelStrIndex.get(String(nodeLabel))!.size === 0) this._labelStrIndex.delete(String(nodeLabel))
    }
    // 清除节点缓存（Gap 12）
    this._nodeCache.delete(id)
    this._fulltext?.removeDocument(String(id))
    this.storage.deleteNode(id)
    this._nodeIds.delete(id)
    this._nodeCount = Math.max(0, this._nodeCount - 1)
    // 清除度数缓存（D-07）
    this._inDegrees.delete(id)
    this._outDegrees.delete(id)
    // 清除邻居缓存
    this._neighborCache.clear()
    this.onRecordChange?.(node.key, { _deleted: true, typeId: node.typeId })
    // 查询结果缓存失效（GAP-24）
    this._invalidateQueryCache(node.typeId, id)

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
      if (!this._nodeIds.has(id)) {
        this._nodeIds.add(id)
        this._nodeCount++
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

  /**
   * 批量插入边（利用 OverGraph 0.11 的 batchUpsertEdges）
   * 自动分块提交（默认 5000 条/批，通过 OVERGRAPH_BATCH_EDGE_CHUNK 环境变量控制）
   *
   * @param inputs - 边输入数组
   * @returns Float64Array 边 ID 数组
   */
  batchUpsertEdges(inputs: Array<{
    src: NodeId; dst: NodeId; typeId: number
    props?: Record<string, unknown>
    weight?: number
  }>): Float64Array {
    this._ensureOpen()
    if (typeof (this.storage as any).batchUpsertEdges !== 'function') {
      // fallback: 无批量 API 时逐条插入（upsertEdge 返回 void，无法回传 edge id）
      for (const i of inputs) {
        this.storage.upsertEdge(i.src, i.dst, i.typeId, { props: i.props, weight: i.weight })
      }
      return new Float64Array(0)
    }
    return (this.storage as any).batchUpsertEdges(inputs)
  }

  // ──────────────────────────────────────────
  // Edge operations
  // ──────────────────────────────────────────

  /**
   * 插入或更新一条边（Multi-Leader 模式：同步等待所有远程节点 ACK）
   *
   * @param src - 源Node ID
   * @param dst - 目标Node ID
   * @param typeId - 边类型 ID
   * @param opts - Optional参数
   * @throws {Error} 如果 GraphEngine 未 open() 或同步复制超时
   */
  async upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): Promise<void> {
    this._ensureOpen()
    this._ensureNotFrozen()

    // 简单事务缓冲：如果提供了 _txId，将操作缓冲到 SimpleTxnManager 中
    if (opts?._txId) {
      this.simpleTxnMgr.addOp(opts._txId, {
        type: 'upsertEdge',
        args: [src, dst, typeId, { ...opts, _txId: undefined }],
      })
      return
    }

    if (this._schema) {
      const result = validateEdgeType(typeId, opts?.props ?? {}, this._schema)
      if (!result.valid) {
        throw new Error(`Schema 校验失败: ${result.errors.join('; ')}`)
      }
    }

    // Idempotent upsert: only increment degrees for truly new edges
    const ek = `${src}:${dst}:${typeId}`
    const isNewEdge = !this._edgeKeys.has(ek)
    // 清除边缓存（Gap 12）
    this._edgeCache.delete(ek)
    if (isNewEdge) {
      this.storage.upsertEdge(src, dst, typeId, {
        props: opts?.props as Record<string, unknown> | undefined,
        temporalValidity: opts?.temporalValidity,
        weight: opts?.weight,
      })
      this._edgeKeys.add(ek)
      this._edgeCount++
      this._outDegreeCounts.set(src, (this._outDegreeCounts.get(src) ?? 0) + 1)
      this._inDegreeCounts.set(dst, (this._inDegreeCounts.get(dst) ?? 0) + 1)
      this._outDegrees.set(src, (this._outDegrees.get(src) ?? 0) + 1)
      this._inDegrees.set(dst, (this._inDegrees.get(dst) ?? 0) + 1)
    } else {
      // Re-upsert: delete + re-create to avoid duplicate edges in OverGraph
      this.storage.deleteEdge(src, dst, typeId)
      this.storage.upsertEdge(src, dst, typeId, {
        props: opts?.props as Record<string, unknown> | undefined,
        temporalValidity: opts?.temporalValidity,
        weight: opts?.weight,
      })
    }
    this.onRecordChange?.(`edge:${src}->${dst}`, { typeId, src, dst, ...(opts?.props ?? {}) })
    // 查询结果缓存失效（GAP-24）
    this._invalidateQueryCache(typeId)

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
   * @param src - 源Node ID
   * @param dst - 目标Node ID
   * @param typeId - 边类型 ID
   * @returns EdgeRecord 或 null（边不存在时）
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  getEdge(src: NodeId, dst: NodeId, typeId: number): EdgeRecord | null {
    this._ensureOpen()
    const edgeKey = `${src}:${dst}:${typeId}`

    // Edge cache check
    const cached = this._edgeCache.get(edgeKey)
    if (cached !== undefined) {
      this._edgeCacheHits++
      return cached
    }
    this._edgeCacheMisses++

    const raw = this.storage.getEdge(src, dst, typeId)
    if (raw) {
      const record: EdgeRecord = {
        src: raw.from,
        dst: raw.to,
        type: raw.typeId,
        props: raw.props as NodeProperties,
        timestamp: raw.createdAt,
      }
      this._edgeCache.set(edgeKey, record)
      return record
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
   * @param src - 源Node ID
   * @param dst - 目标Node ID
   * @param typeId - 边类型 ID
   * @param skipReplication - 是否跳过 Multi-Leader 同步复制（默认 false）
   * @param opts - Optional参数（如 _txId 事务 ID）
   * @returns true 如果边存在且被删除
   * @throws {Error} 如果 GraphEngine 未 open()
   */
  async deleteEdge(src: NodeId, dst: NodeId, typeId: number, skipReplication = false, opts?: { _txId?: string }): Promise<boolean> {
    this._ensureOpen()
    this._ensureNotFrozen()

    // 简单事务缓冲：如果提供了 _txId，将操作缓冲到 SimpleTxnManager 中
    if (opts?._txId) {
      this.simpleTxnMgr.addOp(opts._txId, {
        type: 'deleteEdge',
        args: [src, dst, typeId, skipReplication],
      })
      return true
    }

    const result = this.storage.deleteEdge(src, dst, typeId)
    // 清除边缓存（Gap 12）
    this._edgeCache.delete(`${src}:${dst}:${typeId}`)
    if (result) {
      this._edgeCount = Math.max(0, this._edgeCount - 1)
      // Update degree cache
      this._outDegreeCounts.set(src, Math.max(0, (this._outDegreeCounts.get(src) ?? 0) - 1))
      this._inDegreeCounts.set(dst, Math.max(0, (this._inDegreeCounts.get(dst) ?? 0) - 1))
    }
    // 更新度数缓存（D-07）— 无论 result 是否为 true，都递减缓存
    // Note: OverGraph 原生层 deleteEdge 返回 undefined，不依赖返回值
    this._outDegrees.set(src, Math.max(0, (this._outDegrees.get(src) ?? 0) - 1))
    this._inDegrees.set(dst, Math.max(0, (this._inDegrees.get(dst) ?? 0) - 1))
    this.onRecordChange?.(`edge:${src}->${dst}:${typeId}`, { _deleted: true, src, dst, typeId })
    // 查询结果缓存失效（GAP-24）
    this._invalidateQueryCache(typeId)
    // 清除邻居缓存
    this._neighborCache.clear()

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

  // ── 批量删除 (GAP-22) ─────────────────────

  /**
   * 批量删除节点
   *
   * Note: 默认实现采用循环逐条调用 storage.deleteNode。
   * 如果后端存储支持原生批量删除（如实现了 batchDeleteNodes 接口），
   * 则将委托给后端获得更高性能。
   *
   * @param ids 要删除的Node ID 列表
   * @returns 实际删除的节点数
   */
  async batchDeleteNodes(ids: NodeId[], skipReplication = false): Promise<number> {
    this._ensureOpen()
    this._ensureNotFrozen()

    if (ids.length === 0) return 0

    let deletedCount = 0

    // 如果存储后端支持原生批量删除，使用它
    if (typeof (this.storage as any).batchDeleteNodes === 'function') {
      deletedCount = (this.storage as any).batchDeleteNodes(ids)

      // 即便原批量 API 成功了，仍需维护引擎层状态
      for (const id of ids) {
        this._nodeCache.delete(id)
        this._fulltext?.removeDocument(String(id))
        this._nodeIds.delete(id)
        this._inDegrees.delete(id)
        this._outDegrees.delete(id)
      }
      // Note: batchDeleteNodes 内部不会逐条递减计数
      // 无法精确知道哪些被真正删除了，从总数中安全递减
      this._nodeCount = Math.max(0, this._nodeCount - ids.length)

      if (this._mlReplication && !skipReplication && deletedCount > 0) {
        for (const id of ids) {
          const node = this.storage.getNode(id, false)
          if (node) {
            await this._mlReplication.replicate('node:deleted', { id, typeId: node.typeId, name: node.key })
          }
        }
      }

      return deletedCount
    }

    // 回退方案：逐条删除
    for (const id of ids) {
      const ok = await this.deleteNode(id, skipReplication)
      if (ok) deletedCount++
    }
    return deletedCount
  }

  /**
   * 批量删除边
   *
   * @param keys 要删除的边列表（src, dst, typeId 三元组）
   * @returns 实际删除的边数
   */
  async batchDeleteEdges(
    keys: Array<{ src: NodeId; dst: NodeId; typeId: number }>,
    skipReplication = false,
  ): Promise<number> {
    this._ensureOpen()
    this._ensureNotFrozen()

    if (keys.length === 0) return 0

    let deletedCount = 0

    // 如果存储后端支持原生批量删除，使用它
    if (typeof (this.storage as any).batchDeleteEdges === 'function') {
      deletedCount = (this.storage as any).batchDeleteEdges(keys)

      // 维护引擎层状态
      for (const { src, dst, typeId } of keys) {
        this._edgeCache.delete(`${src}:${dst}:${typeId}`)
        this._outDegreeCounts.set(src, Math.max(0, (this._outDegreeCounts.get(src) ?? 0) - 1))
        this._inDegreeCounts.set(dst, Math.max(0, (this._inDegreeCounts.get(dst) ?? 0) - 1))
        this._outDegrees.set(src, Math.max(0, (this._outDegrees.get(src) ?? 0) - 1))
        this._inDegrees.set(dst, Math.max(0, (this._inDegrees.get(dst) ?? 0) - 1))
      }
      this._edgeCount = Math.max(0, this._edgeCount - keys.length)
      this._invalidateQueryCache(0) // 无法精确知道 typeId，失效全部

      if (this._mlReplication && !skipReplication && deletedCount > 0) {
        for (const { src, dst, typeId } of keys) {
          await this._mlReplication.replicate('edge:deleted', { src, dst, typeId })
        }
      }

      return deletedCount
    }

    // 回退方案：逐条删除
    for (const { src, dst, typeId } of keys) {
      const ok = await this.deleteEdge(src, dst, typeId, skipReplication)
      if (ok) deletedCount++
    }
    return deletedCount
  }

  /**
   * 获取指定节点的所有邻居
   *
   * @param id - Node ID
   * @param opts - Optional参数（maxDepth, edgeTypeFilter）
   * @param ctx - Optional的 RLS 上下文，如果提供则对结果集进行行级过滤
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
   * @param ids - Node ID 数组（batch）
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
   * @param ids - Node ID 数组
   * @param depth - 遍历深度（默认 1）
   * @returns Map<NodeId, { edges; nodes }>
   */
  neighborsMany(ids: NodeId[], depth?: number): Map<NodeId, { edges: EdgeRecord[]; nodes: NodeRecord[] }> {
    return this.batchNeighbors(ids, { maxDepth: depth ?? 1 })
  }

  // ──────────────────────────────────────────
  // 度数缓存（D-07）
  // ──────────────────────────────────────────

  /**
   * 获取节点的入度（从度数缓存中读取，O(1) 性能）
   * 如果缓存中没有，尝试从 storage 获取并缓存（取数代价较大）。
   */
  getInDegree(id: NodeId): number {
    const cached = this._inDegrees.get(id)
    if (cached !== undefined) return cached
    try {
      const d = this.storage.degrees(id)
      // OverGraph 0.11.0 的 degree() 只返回总度数，不能区分 in/out
      // fallback 时假设缓存没有数据，存储层也无法区分方向
      // 所以不写缓存，返回 0，走手动 LRU 计数
      return 0
    } catch {
      return 0
    }
  }

  /**
   * 获取节点的出度（O(1) 性能）
   */
  getOutDegree(id: NodeId): number {
    const cached = this._outDegrees.get(id)
    if (cached !== undefined) return cached
    try {
      const d = this.storage.degrees(id)
      // OverGraph 0.11.0 的 degree() 只返回总度数，不能区分 in/out
      return 0
    } catch {
      return 0
    }
  }

  /**
   * 获取节点总度数（入度 + 出度），O(1) 性能
   */
  getDegree(id: NodeId): number {
    return this.getInDegree(id) + this.getOutDegree(id)
  }

  /**
   * 获取度数分布统计
   * @returns { min, max, avg, totalNodes }
   */
  degreeDistribution(): { min: number; max: number; avg: number; totalNodes: number } {
    const ids = Array.from(this._nodeIds)
    if (ids.length === 0) {
      return { min: 0, max: 0, avg: 0, totalNodes: 0 }
    }

    // 确保所有节点度数已被缓存
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let cachedCount = 0

    for (const id of ids) {
      const inDeg = this.getInDegree(id)
      const outDeg = this.getOutDegree(id)
      const total = inDeg + outDeg
      if (total < min) min = total
      if (total > max) max = total
      sum += total
      cachedCount++
    }

    return {
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 0 : max,
      avg: cachedCount > 0 ? sum / cachedCount : 0,
      totalNodes: cachedCount,
    }
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
   * @param ctx - Optional的 RLS 上下文，如果提供则对结果集进行行级过滤
   * @param useOptimizer - 是否启用优化器桥接（默认 false 向后兼容）
   * @returns 查询结果（节点记录数组）
   */
  query(queryString: string, ctx?: RLSContext, useOptimizer: boolean = false): NodeRecord[] {
    this._ensureOpen()

    // 如果启用优化器，走 OptimizerBridge 路径
    if (useOptimizer) {
      return this._queryOptimized(queryString, ctx)
    }

    let plan: QueryPlan
    try {
      plan = parseQuery(queryString)
    } catch (e: any) {
      throw new Error(`GraphEngine query parse error: ${(e as Error).message}`)
    }

    // Handle CALL subquery
    if (plan.type === 'CALL' && plan.callQuery) {
      return this._executeQueryPlan(plan.callQuery)
    }

    // 处理集合运算（UNION / INTERSECT / SUBTRACT）
    if (plan.unionType && plan.rightPlan) {
      const leftResults = this._executeQueryPlan(plan)
      const rightResults = this._executeQueryPlan(plan.rightPlan)
      const combined = this._applySetOperation(leftResults, rightResults, plan.unionType)
      return this._rls && ctx ? this._rls.enforceQuery('nodes', ctx, combined) : combined
    }

    // Execute the main query plan
    let results = this._executeQueryPlan(plan)

    // Handle OPTIONAL MATCH: for each result row, attempt additional pattern match
    if (plan.optionalMatchSteps && plan.optionalMatchSteps.length > 0) {
      results = this._executeOptionalMatches(results, plan.optionalMatchSteps, ctx)
    }

    // Handle WITH clause: pipeline projection/aggregation
    if (plan.with) {
      results = this._executeWithClause(results, plan)
    }

    // Handle UNWIND clause: expand list into rows
    if (plan.unwind) {
      results = this._executeUnwind(plan.unwind, results)
    }

    // Handle RETURN projection after WITH/OPTIONAL MATCH/UNWIND
    if (plan.returnColumns && plan.returnColumns.length > 0 && (plan.with || plan.optionalMatchSteps || plan.unwind)) {
      results = this._projectReturnColumns(results, plan)
    }

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
    let nodes = this._scanAll(spec.skip && spec.limit ? spec.skip + spec.limit : spec.limit)

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
   * 支持 LIMIT/SKIP 下推：在扫描和每一步遍历后做早期截断，避免全量收集后再 slice
   */
  private _executeQueryPlan(plan: QueryPlan, ctx?: RLSContext): NodeRecord[] {
    // For standalone UNWIND / OPTIONAL MATCH / WITH (without MATCH prefix) — skip the scan
    if (!plan.scanLabel && plan.steps.length === 0 && plan.filters.length === 0) {
      // 没有 MATCH 扫描时，纯 WITH/UNWIND/OPTIONAL MATCH 从空行开始投影
      if (!plan.hasMatch && (plan.with || plan.unwind || (plan.optionalMatchSteps && plan.optionalMatchSteps.length > 0))) {
        return [this._makeNullNode()]
      }
    }

    // 计算下推 limit：在 SKIP 的基础上取需要的最大值
    const effectiveLimit = plan.limit !== undefined ? (plan.skip || 0) + plan.limit : undefined

    // Step 1: 扫描起始节点（带早期截断）
    let candidates: NodeRecord[]
    if (plan.scanLabel) {
      candidates = this._scanNodesByLabel(plan.scanLabel, effectiveLimit)
    } else {
      candidates = this._scanAll(effectiveLimit)
    }

    // RLS 过滤：扫描结果
    if (this._rls && ctx) {
      candidates = this._rls.enforceQuery('nodes', ctx, candidates)
    }

    if (candidates.length === 0) {
      if (plan.aggregate) {
        return this._execAggregation([], plan.aggregate, plan.groupBy)
      }
      return []
    }

    // Step 2: 执行遍历步（带早期截断）
    let results: NodeRecord[] = [...candidates]
    for (const step of plan.steps) {
      if (step.range) {
        const minDepth = step.range.min
        const maxDepth = step.range.max ?? minDepth
        results = this._executeVariableLengthTraversal(results, {
          relationshipType: step.edgeLabel ? this._resolveEdgeType(step.edgeLabel) : undefined,
          minDepth,
          maxDepth,
          direction: step.direction,
          ctx,
        })
      } else {
        // 单跳遍历（带早期截断）
        const filtered: NodeRecord[] = []
        for (const node of results) {
          if (effectiveLimit !== undefined && filtered.length >= effectiveLimit) break
          const neighborsRaw = this.storage.neighbors(node.id, {
            edgeTypeFilter: step.edgeLabel ? [this._resolveEdgeType(step.edgeLabel)] : undefined,
          })
          for (const entry of neighborsRaw) {
            if (effectiveLimit !== undefined && filtered.length >= effectiveLimit) break
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

    // Step 3: 应用 WHERE 过滤器（此时结果集已因早期截断而很小）
    if (plan.filters.length > 0) {
      results = results.filter(node =>
        plan.filters.every(f => this._matchFilter(node, f))
      )
    }

    // Step 3b: 应用 EXISTS 过滤器（需要运行时边存在性检查）
    if (plan.existsFilters && plan.existsFilters.length > 0) {
      results = this._applyExistsFilters(results, plan.existsFilters)
    }

    // 聚合函数在 WHERE 之后、SKIP/LIMIT 之前
    if (plan.aggregate) {
      return this._execAggregation(results, plan.aggregate, plan.groupBy)
    }

    // Evaluate CASE expressions in RETURN columns (if any)
    if (plan.caseColumns && plan.caseColumns.length > 0) {
      results = this._execCaseColumns(results, plan)
    }

    // Step 4: 应用 SKIP / LIMIT（此时大部分数据已在下推阶段截断）
    if (plan.skip && plan.skip > 0) {
      results = results.slice(plan.skip)
    }
    if (plan.limit && results.length > plan.limit) {
      results = results.slice(0, plan.limit)
    }

    return results
  }

  /**
   * Execute OPTIONAL MATCH clauses.
   * For each result row, attempt the optional pattern match.
   * If no match, inject a null sentinel node.
   */
  private _executeOptionalMatches(
    rows: NodeRecord[],
    optSteps: NonNullable<QueryPlan['optionalMatchSteps']>,
    ctx?: RLSContext,
  ): NodeRecord[] {
    // OPTIONAL MATCH 语义：即使 MATCH 无结果，外部查询仍应产生一行 null 结果。
    // 但只有当 query 中有 OPTIONAL MATCH 前缀时才补 null（无 MATCH 的情况）。
    // 如果 MATCH 返回空结果但有 OPTIONAL MATCH 跟随，MATCH 的空结果应保持（非空结果才触发 OPTIONAL）
    // 例外：查询以 OPTIONAL MATCH 开头（无前置 MATCH）
    if (rows.length === 0) {
      rows = [this._makeNullNode()]
    }

    for (const optStep of optSteps) {
      const newRows: NodeRecord[] = []

      for (const row of rows) {
        // Try to match the optional pattern from this row
        const matched = this._executeOptionalStep(row, optStep, ctx)

        if (matched.length === 0) {
          // No match — produce a row with null bindings
          newRows.push(this._mergeRowWithNull(row, optStep))
        } else {
          // One or more matches — create a row for each
          for (const match of matched) {
            newRows.push(this._mergeRows(row, match))
          }
        }
      }

      rows = newRows
    }

    return rows
  }

  /**
   * Merge two NodeRecord arrays from an optional match into a single row.
   */
  private _mergeRows(original: NodeRecord, additional: NodeRecord): NodeRecord {
    return {
      id: additional.id,
      type: additional.type,
      name: additional.name || original.name,
      props: { ...(original.props || {}), ...(additional.props || {}) },
    }
  }

  /**
   * Merge original row with null placeholder for unmatched optional pattern.
   */
  private _mergeRowWithNull(original: NodeRecord, optStep: any): NodeRecord {
    return {
      id: original.id,
      type: original.type,
      name: original.name,
      props: {
        ...(original.props || {}),
      },
    }
  }

  /**
   * Execute a single optional match step against a source node.
   * Returns matched nodes or empty array.
   */
  private _executeOptionalStep(
    source: NodeRecord,
    optStep: { scanLabel: string | null; steps: any[]; filters: any[] },
    ctx?: RLSContext,
  ): NodeRecord[] {
    // If there's a scanLabel in optStep, scan for those nodes
    let candidates: NodeRecord[]

    if (optStep.scanLabel) {
      candidates = this._scanNodesByLabel(optStep.scanLabel)
    } else if (optStep.steps.length === 0) {
      // Just a node label match — no traversal
      return []
    } else {
      // Start from the source node
      candidates = [source]
    }

    // Execute traversal steps from the optStep
    let results = [...candidates]
    for (const step of optStep.steps) {
      const filtered: NodeRecord[] = []
      for (const node of results) {
        if (node.id == null || node.id < 0) continue // null or sentinel node — cannot traverse
        const neighborsRaw = this.storage.neighbors(node.id, {
          edgeTypeFilter: step.edgeLabel ? [this._resolveEdgeType(step.edgeLabel)] : undefined,
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
      if (results.length === 0) break
    }

    // Apply filters
    if (optStep.filters.length > 0) {
      results = results.filter(node =>
        optStep.filters.every((f: any) => this._matchFilter(node, f))
      )
    }

    return results
  }

  /**
   * Execute WITH clause: project, aggregate, filter, order, limit
   */
  private _executeWithClause(
    rows: NodeRecord[],
    plan: QueryPlan,
  ): NodeRecord[] {
    const withClause = plan.with!
    const columns = withClause.columns || []
    const hasAgg = withClause.aggregate !== undefined

    if (hasAgg) {
      // Aggregation WITH
      let value: number
      const aggField = withClause.aggregate!.field ?? '*'
      const aggType = (withClause.aggregate!.type || 'count').toLowerCase()
      const aggDistinct = withClause.aggregate!.distinct === true

      if (aggField === '*') {
        value = rows.length
      } else {
        const propName = aggField.includes('.') ? aggField.split('.').pop()! : aggField
        switch (aggType) {
          case 'count':
            if (aggDistinct) {
              // COUNT(DISTINCT x): count unique non-null property values.
              const seen = new Set<unknown>()
              for (const r of rows) {
                const v = r.props?.[propName]
                if (v !== null && v !== undefined) seen.add(v)
              }
              value = seen.size
            } else {
              value = rows.filter(r => {
                const v = r.props?.[propName]
                return v !== null && v !== undefined
              }).length
            }
            break
          case 'sum':
            value = rows.reduce((sum, r) => sum + (Number(r.props?.[propName]) || 0), 0)
            break
          case 'avg':
            {
              const vals = rows.map(r => Number(r.props?.[propName])).filter(v => !isNaN(v))
              value = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
            }
            break
          case 'max':
            value = Math.max(...rows.map(r => Number(r.props?.[propName]) || 0), 0)
            break
          case 'min':
            value = Math.min(...rows.map(r => {
              const v = r.props?.[propName]
              return v !== undefined ? Number(v) : Infinity
            }))
            break
          default:
            value = rows.length
        }
      }

      const alias = withClause.aggregate!.alias ?? withClause.aggregate!.type ?? 'value'
      return [this._makeResultNode(alias, { [alias]: value })]
    }

    // Non-aggregation WITH: project the columns
    const projected: NodeRecord[] = rows.map(row => {
      const props: Record<string, unknown> = { ...row.props }

      for (const col of columns) {
        const expr = col.expression
        const alias = col.alias

        // A list literal (e.g. {type:'LIST', items:[1,2]}) is materialised as an
        // AST object by the parser; everything else remains raw text.
        if (typeof expr === 'object' && expr !== null && expr.type === 'LIST') {
          const key = alias ?? 'value'
          // Resolve list items: unwrap NUMBER/STRING/BOOLEAN wrappers
          props[key] = (expr.items || []).map((item) => this._unwrapItem(item))
          continue
        }
        if (typeof expr !== 'string') continue
        if (expr === '*') continue

        // Handle expression like "n.name" → extract property from node
        if (expr.includes('.')) {
          const parts = expr.split('.')
          const varName = parts[0] // n
          const propName = parts.slice(1).join('.') // name

          // The whole row represents the variable
          const val = this._getNodeProp(row, propName)
          const key = alias ?? propName
          props[key] = val
        } else if (expr.includes('(') && expr.includes(')')) {
          // Aggregate function — handle at WITH level not here
          continue
        } else {
          // Simple expression (just a variable name like "n")
          const key = alias ?? expr
          props[key] = row
        }
      }

      return this._makeResultNode(row.name, props, row.id)
    })

    // Apply WITH WHERE (post-projection filter) — simplified implementation
    if (withClause.filters && withClause.filters.length > 0) {
      // Simplified: filter props by exact match
      // This handles simple conditions like "age > 25"
      let filtered = projected
      for (const f of withClause.filters) {
        filtered = filtered.filter(node => {
          const val = node.props?.[f.property]
          if (val === undefined) return false
          switch (f.operator) {
            case 'GT': return Number(val) > Number(f.value)
            case 'GTE': return Number(val) >= Number(f.value)
            case 'LT': return Number(val) < Number(f.value)
            case 'LTE': return Number(val) <= Number(f.value)
            case 'EQ': return val === f.value
            case 'NEQ': return val !== f.value
            default: return true
          }
        })
      }
      return filtered
    }

    // Apply WITH ORDER BY
    if (withClause.orderBy && withClause.orderBy.length > 0) {
      const orderCol = withClause.orderBy[0]
      propSort(projected, orderCol.property, orderCol.direction)
    }

    // Apply WITH LIMIT / SKIP
    let result = projected
    if (withClause.skip && withClause.skip > 0) {
      result = result.slice(withClause.skip)
    }
    if (withClause.limit !== undefined) {
      result = result.slice(0, withClause.limit)
    }

    return result
  }

  /**
   * Execute UNWIND clause: expand a list into rows
   */
  private _executeUnwind(
    unwind: { name: string; list: any[]; var?: string },
    rows: NodeRecord[],
  ): NodeRecord[] {
    const list = unwind.list || []
    const name = unwind.name

    if (rows.length === 0) {
      // Standalone UNWIND (no preceding MATCH/WITH)
      if (list.length > 0) {
        return list.map((item: any) => {
          const val = this._unwrapItem(item)
          return this._makeResultNode(name, { [name]: val })
        })
      }
      // UNWIND with variable reference but no rows — nothing to expand
      return []
    }

    // For each existing row, expand the UNWIND list
    const results: NodeRecord[] = []
    for (const row of rows) {
      // Resolve the unwind source: literal list or variable from current row
      let unwindList = list
      if (unwind.var && row.props && row.props[unwind.var]) {
        const source = row.props[unwind.var]
        if (Array.isArray(source)) {
          unwindList = source
        }
      }
      for (const item of (unwindList || [])) {
        const val = this._unwrapItem(item)
        const props = { ...(row.props || {}), [name]: val }
        results.push(this._makeResultNode(row.name, props, row.id))
      }
    }

    return results.length > 0 ? results : rows
  }

  /**
   * Unwrap an UNWIND item (which might be {type:'NUMBER',value:1} etc.)
   */
  private _unwrapItem(item: any): unknown {
    if (item && typeof item === 'object' && 'type' in item) {
      if (item.type === 'NUMBER') return item.value
      if (item.type === 'STRING') return item.value
      if (item.type === 'BOOLEAN') return item.value
      if (item.type === 'IDENTIFIER') return item.name
    }
    return item
  }

  /**
   * Project RETURN columns after WITH/OPTIONAL MATCH/UNWIND
   */
  private _projectReturnColumns(
    rows: NodeRecord[],
    plan: QueryPlan,
  ): NodeRecord[] {
    if (plan.returnColumns.length === 0) return rows

    // Handle CASE expressions in RETURN columns
    if (plan.caseColumns && plan.caseColumns.length > 0) {
      return this._execCaseColumns(rows, plan)
    }

    // For simple column projections from props
    if (plan.returnColumns.length === 1 && plan.returnColumns[0] in (rows[0]?.props || {})) {
      return rows
    }

    return rows
  }

  /**
   * Execute CASE expressions in RETURN columns
   */
  private _execCaseColumns(rows: NodeRecord[], plan: QueryPlan): NodeRecord[] {
    return rows.map(row => {
      const newProps = { ...(row.props || {}) }
      for (const cc of (plan.caseColumns || [])) {
        newProps[cc.alias] = this._evaluateCaseExpr(cc.expression, row)
      }
      return { ...row, props: newProps }
    })
  }

  /**
   * Evaluate a CASE expression AST against a data row
   */
  private _evaluateCaseExpr(expr: any, row: NodeRecord): NodeProperties[string] | null {
    const caseExpr = expr.caseExpr  // null for search CASE, value for simple CASE
    const whens = expr.whens || []
    const elseExpr = expr.elseExpr

    for (const w of whens) {
      let matched: boolean
      if (caseExpr) {
        // Simple CASE: CASE expr WHEN value -> expr === value
        const left = this._resolvePrimaryExpr(caseExpr, row)
        const right = this._resolvePrimaryExpr(w.condition, row)
        matched = left === right
      } else {
        // Search CASE: CASE WHEN condition THEN result
        matched = this._evaluateCondition(w.condition, row)
      }
      if (matched) {
        return this._resolvePrimaryExpr(w.result, row)
      }
    }

    // No WHEN matched: return ELSE or null
    if (elseExpr) {
      return this._resolvePrimaryExpr(elseExpr, row)
    }
    return null
  }

  /**
   * Evaluate a boolean condition (WHERE-like expression) against a row
   */
  private _evaluateCondition(cond: any, row: NodeRecord): boolean {
    if (!cond) return true

    switch (cond.type) {
      case 'COMPARISON': {
        const left = this._resolvePrimaryExpr(cond.left, row)
        const right = this._resolvePrimaryExpr(cond.right, row)
        switch (cond.operator) {
          case 'EQ':  return left === right
          case 'NEQ': return left !== right
          case 'GT':  return typeof left === 'number' && typeof right === 'number' && left > right
          case 'GTE': return typeof left === 'number' && typeof right === 'number' && left >= right
          case 'LT':  return typeof left === 'number' && typeof right === 'number' && left < right
          case 'LTE': return typeof left === 'number' && typeof right === 'number' && left <= right
          default: return true
        }
      }
      case 'IN_EXPRESSION': {
        const left = this._resolvePrimaryExpr(cond.left, row)
        const list = cond.list?.type === 'LIST' ? (cond.list.items || []).map((i: any) => this._resolvePrimaryExpr(i, row)) : []
        return list.includes(left)
      }
      case 'STRING_PREDICATE': {
        const left = this._resolvePrimaryExpr(cond.left, row)
        const right = this._resolvePrimaryExpr(cond.right, row)
        if (typeof left !== 'string' || typeof right !== 'string') return false
        switch (cond.operator) {
          case 'STARTS_WITH': return left.startsWith(right)
          case 'ENDS_WITH':   return left.endsWith(right)
          case 'CONTAINS':    return left.includes(right)
          default: return false
        }
      }
      case 'AND': {
        // flatten right
        const rights = Array.isArray(cond.right) ? cond.right : [cond.right]
        return this._evaluateCondition(cond.left, row) && rights.every((r: any) => this._evaluateCondition(r, row))
      }
      case 'OR': {
        const rights = Array.isArray(cond.right) ? cond.right : [cond.right]
        return this._evaluateCondition(cond.left, row) || rights.some((r: any) => this._evaluateCondition(r, row))
      }
      default: return true
    }
  }

  /**
   * Resolve a PrimaryAST value from a data row (supports PROP_REF, STRING, NUMBER, BOOLEAN, IDENTIFIER)
   */
  private _resolvePrimaryExpr(primary: any, row: NodeRecord): NodeProperties[string] | null {
    if (!primary) return null
    switch (primary.type) {
      case 'PROP_REF':
        return row.props?.[primary.property] ?? null
      case 'STRING':
        return primary.value
      case 'NUMBER':
        return primary.value
      case 'BOOLEAN':
        return primary.value
      case 'IDENTIFIER':
        return primary.name
      default:
        return null
    }
  }

  /**
   * Create a result node with given name and properties
   */
  private _makeResultNode(name: string, props: Record<string, unknown>, id: number = -1): NodeRecord {
    return {
      id,
      type: 0,
      name,
      props,
    } as unknown as NodeRecord
  }

  /**
   * Create a null sentinel node for unmatched OPTIONAL MATCH
   */
  private _makeNullNode(): NodeRecord {
    return this._makeResultNode('__null__', {})
  }

  /**
   * Get a property from a node record (checking both props and name fields)
   */
  private _getNodeProp(node: NodeRecord, propName: string): unknown {
    if (node.props && propName in node.props) {
      return node.props[propName]
    }
    if (propName === 'name' || propName === 'id') {
      return (node as any)[propName]
    }
    return undefined
  }

  /**
   * Execute the main QueryPlan (MATCH + WHERE + aggregation)
   * 支持 COUNT, SUM, AVG, MAX, MIN
   * 如果 plan.groupBy 存在，执行 GROUP BY 分组聚合
   */
  private _execAggregation(
    nodes: NodeRecord[],
    agg: AggregateClause,
    groupBy?: string[],
  ): NodeRecord[] {
    // If any GROUP BY 列，执行分组聚合
    if (groupBy && groupBy.length > 0) {
      return this._execGroupByAggregation(nodes, agg, groupBy)
    }

    // 提取实际属性名：如 n.age → age，n.score → score
    const rawField = agg.field ?? ''
    // percentileDisc/percentileCont take two arguments: `percentileDisc(v, p)`.
    // Split on the last top-level comma so the value expression and the scalar
    // percentile argument are separated (the value expression may itself contain
    // commas inside a nested call).
    const _pctComma = _lastTopLevelCommaIdx(rawField)
    const _valField = _pctComma >= 0 ? rawField.slice(0, _pctComma).trim() : rawField
    const _pctText = _pctComma >= 0 ? rawField.slice(_pctComma + 1).trim() : ''
    const propName = _valField.includes('.') ? _valField.split('.')[1] : _valField

    let value: unknown

    switch (agg.type) {
      case 'count':
        // Pass the *full* value expression (e.g. `a.name`) so `_aggregateCount`
        // can distinguish a property reference (`.name` → count non-null values,
        // yielding 0 when the property is absent) from a bare variable reference
        // (`n` → count nodes).  Stripping the `var.` prefix here to `name` would
        // collapse that distinction and wrongly fall back to the node count.
        value = this._aggregateCount(nodes, _valField, agg.distinct === true)
        break
      case 'collect':
        value = this._aggregateCollect(nodes, _valField, agg.distinct === true)
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
      case 'percentiledisc':
      case 'percentilecont':
        value = this._aggregatePercentile(agg.type, nodes, propName, _pctText)
        break
      default:
        value = 0
    }

    // 构造伪节点作为返回值，确保返回结果与现有的 query() 签名兼容
    const alias = agg.alias ?? (agg.column && agg.column !== agg.type ? agg.column : agg.type) ?? ''
    return [{
      id: -1,
      name: alias,
      type: 0,
      typeName: '',
      props: { [alias]: value },
    } as unknown as NodeRecord]
  }

  /**
   * 执行 GROUP BY 分组聚合
   * 按 groupBy 列分组，对每组分别执行聚合函数
   */
  private _execGroupByAggregation(
    nodes: NodeRecord[],
    agg: AggregateClause,
    groupBy: string[],
  ): NodeRecord[] {
    // 按 GROUP BY 列分组
    const groups = new Map<string, NodeRecord[]>()
    for (const node of nodes) {
      const key = groupBy.map(gb => {
        const val = node.props?.[gb] ?? node.name
        return String(val ?? '__NULL__')
      }).join('||')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(node)
    }

    // 提取属性名
    const rawField = agg.field ?? ''
    const propName = rawField.includes('.') ? rawField.split('.')[1] : rawField

    const results: NodeRecord[] = []
    let idx = 0
    for (const [key, groupNodes] of groups.entries()) {
      let aggValue: unknown

      switch (agg.type) {
        case 'count':
          // Preserve the full value expression so a property reference
          // (`a.name`) is counted as non-null values (0 when absent) rather
          // than falling back to the node count.
          aggValue = this._aggregateCount(groupNodes, rawField, agg.distinct === true)
          break
        case 'collect':
          aggValue = this._aggregateCollect(groupNodes, rawField, agg.distinct === true)
          break
        case 'sum':
          aggValue = this._aggregateSum(groupNodes, propName)
          break
        case 'avg':
          aggValue = this._aggregateAvg(groupNodes, propName)
          break
        case 'max':
          aggValue = this._aggregateMax(groupNodes, propName)
          break
        case 'min':
          aggValue = this._aggregateMin(groupNodes, propName)
          break
        default:
          aggValue = 0
      }

      // 构造分组节点，包含 GROUP BY 键和聚合值
      const keyParts = key.split('||')
      const props: Record<string, unknown> = {}
      for (let i = 0; i < groupBy.length; i++) {
        props[groupBy[i]!] = keyParts[i] === '__NULL__' ? null : keyParts[i]
      }
      const alias = agg.alias ?? (agg.column && agg.column !== agg.type ? agg.column : agg.type) ?? ''
      props[alias] = aggValue

      const firstNode = groupNodes[0]
      results.push({
        id: -(idx + 1),
        name: alias,
        type: firstNode?.type ?? 0,
        typeName: firstNode?.typeName ?? '',
        props,
      } as unknown as NodeRecord)
      idx++
    }

    return results
  }

  /** Collect the non-null values of `field` across `nodes` into an array.
   *  `collect(x)` filters out null/undefined so a null binding (`OPTIONAL MATCH`
   *  that matched nothing) contributes nothing, yielding `[]` for an empty or
   *  all-null group.  When `distinct` is set, duplicates are removed. */
  private _aggregateCollect(nodes: NodeRecord[], field?: string, distinct = false): unknown[] {
    const values: unknown[] = []
    const seen = new Set<unknown>()
    for (const n of nodes) {
      let val: unknown
      if (!field || field === '*' || field === '') {
        // collect(*) — collect whole node records (identity)
        val = n
      } else if (field.includes('.')) {
        const propName = field.split('.')[1]
        val = n.props?.[propName]
      } else {
        val = n.props?.[field]
      }
      if (val === null || val === undefined) continue
      if (distinct) {
        if (seen.has(val)) continue
        seen.add(val)
      }
      values.push(val)
    }
    return values
  }

  /** 对节点数组计数 */
  private _aggregateCount(nodes: NodeRecord[], field?: string, distinct = false): number {
    if (!field || field === '' || field === '*') {
      if (distinct) {
        // COUNT(DISTINCT *) — count unique nodes (identity); fall back to total.
        return nodes.length
      }
      return nodes.length
    }
    // 若 field 包含 '.'（如 n.age），提取属性名后进行非 null 统计
    if (field.includes('.')) {
      const propName = field.split('.')[1]
      if (!propName) return nodes.length
      if (distinct) {
        const seen = new Set<unknown>()
        for (const n of nodes) {
          const val = n.props?.[propName]
          if (val !== null && val !== undefined) seen.add(val)
        }
        return seen.size
      }
      let count = 0
      for (const n of nodes) {
        const val = n.props?.[propName]
        if (val !== null && val !== undefined) count++
      }
      return count
    }
    // count(n) / count(name) — 检查节点是否有该属性
    let hasProp = false
    for (const n of nodes) {
      if (n.props && field in n.props) {
        hasProp = true
        break
      }
    }
    if (hasProp) {
      if (distinct) {
        // COUNT(DISTINCT col) semantics: count distinct non-null values
        const seen = new Set<unknown>()
        for (const n of nodes) {
          const val = n.props?.[field]
          if (val !== null && val !== undefined) seen.add(val)
        }
        return seen.size
      }
      // 按 COUNT(col) 语义：统计该属性非空的节点数
      let count = 0
      for (const n of nodes) {
        const val = n.props?.[field]
        if (val !== null && val !== undefined) count++
      }
      return count
    }
    // 否则视为节点引用（如 count(n)），返回节点总数
    return nodes.length
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
  private _aggregateAvg(nodes: NodeRecord[], field: string): number | null {
    let sum = 0
    let count = 0
    for (const n of nodes) {
      const val = n.props?.[field]
      if (typeof val === 'number') { sum += val; count++ }
    }
    // openCypher: avg over an empty set is null (not 0).
    return count > 0 ? sum / count : null
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

  /** Compute a percentile aggregate (`percentiledisc` / `percentilecont`)
   *  over the numeric values of `field` across `nodes`, for the scalar
   *  percentile argument `pctText` (a bare numeric literal).  A percentile
   *  outside [0, 1] raises an ArgumentError carrying
   *  `tckError: 'NumberOutOfRange'` to match the openCypher TCK. */
  private _aggregatePercentile(fnType: string, nodes: NodeRecord[], field: string, pctText: string): number {
    const nums: number[] = []
    for (const n of nodes) {
      const val = n.props?.[field]
      if (typeof val === 'number' && !isNaN(val)) nums.push(val)
    }
    if (!nums.length) return 0
    nums.sort((a, b) => a - b)

    const p = Number(pctText)
    if (isNaN(p) || p < 0 || p > 1) {
      throw Object.assign(new Error('ArgumentError: NumberOutOfRange'), { tckError: 'NumberOutOfRange' })
    }

    if (fnType === 'percentiledisc') {
      const idx = Math.ceil(p * nums.length) - 1
      return nums[Math.max(0, Math.min(idx, nums.length - 1))]
    }
    // percentilecont: linear interpolation between the two surrounding ranks
    const pos = p * (nums.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    if (lo === hi) return nums[lo]
    const frac = pos - lo
    return nums[lo] + frac * (nums[hi] - nums[lo])
  }

  /** 扫描所有节点 */
  /** 全量扫描所有节点，Optional limit 早期截断 */
  private _scanAll(limit?: number): NodeRecord[] {
    const records: NodeRecord[] = []
    for (const id of this._nodeIds) {
      const node = this.getNode(id)
      if (node) {
        records.push(node)
        if (limit !== undefined && records.length >= limit) break
      }
    }
    return records
  }

  /** 按 label (typeName) 扫描节点，Optional limit 早期截断 */
  private _scanNodesByLabel(label: string, limit?: number): NodeRecord[] {
    const records: NodeRecord[] = []
    // 优先：使用字符串 label 索引（O(1) 查询，仅适用于 props._label 模式）
    if (this._labelStrIndex.has(label)) {
      for (const id of this._labelStrIndex.get(label)!) {
        const node = this.getNode(id)
        if (!node) continue
        records.push(node)
        if (limit !== undefined && records.length >= limit) break
      }
      return records
    }
    // 回退：全量扫描（数字 typeId 模式或无索引时）
    for (const id of this._nodeIds) {
      const node = this.getNode(id)
      if (!node) continue
      // 优先：typeName 精确匹配（现有数字 typeId 模式）
      if (node.typeName === label) {
        records.push(node)
        if (limit !== undefined && records.length >= limit) break
        continue
      }
      // 兼容：props._label 匹配（Cypher TCK 字符串标签模式）
      if (node.props && node.props._label === label) {
        records.push(node)
        if (limit !== undefined && records.length >= limit) break
      }
    }
    return records
  }

  /**
   * 缓存并返回字符串 edge label → 数字 typeId 的映射。
   * 如果 label 已是纯数字字符串，直接返回其数值。
   */
  private _resolveEdgeType(label: string): number {
    const num = Number(label)
    if (!isNaN(num)) return num
    if (!this._edgeTypeRegistry.has(label)) {
      this._edgeTypeRegistry.set(label, this._edgeTypeRegistry.size + 1000)
    }
    return this._edgeTypeRegistry.get(label)!
  }

  /**
   * 基于游标的分页扫描——从指定的 lastSeenId（上一页最后一个节点的 ID）开始，
   * 最多返回 `limit` 个节点。用于实现 REST API 的游标分页。
   *
   * @param opts 扫描选项
   * @param opts.limit 每页最大节点数（默认 100）
   * @param opts.cursor base64 编码的上一页最后一个Node ID；null 或 undefined 从头部开始
   * @returns { nodes: NodeRecord[], nextCursor: string | null }
   *   nextCursor 为 null 表示已到最后一页
   */
  scanNodesWithCursor(opts: { limit?: number; cursor?: string | null }): {
    nodes: NodeRecord[]
    nextCursor: string | null
  } {
    const limit = opts.limit ?? 100
    const lastSeenId = opts.cursor
      ? Number(Buffer.from(opts.cursor, 'base64').toString('utf-8'))
      : null

    // 将Node ID 排序，按序分页
    const sortedIds = Array.from(this._nodeIds).sort((a, b) => a - b)

    // 找到游标位置
    const startIndex = lastSeenId !== null ? sortedIds.indexOf(lastSeenId) + 1 : 0

    // 最多取 limit 个
    const pageIds = sortedIds.slice(startIndex, startIndex + limit)

    const nodes: NodeRecord[] = []
    for (const id of pageIds) {
      const node = this.getNode(id)
      if (node) {
        nodes.push(node)
      }
    }

    // 计算下一个游标
    const nextIndex = startIndex + limit
    const nextCursor = nextIndex < sortedIds.length && pageIds.length > 0
      ? Buffer.from(String(sortedIds[nextIndex - 1])).toString('base64')
      : null

    return { nodes, nextCursor }
  }

  /**
   * 应用 EXISTS 过滤器：对每条结果，检查是否存在指定模式的边。
   */
  private _applyExistsFilters(
    nodes: NodeRecord[],
    existsFilters: Array<{
      source: string
      edgeLabel: string | null
      direction: 'out' | 'in' | 'any'
      target: string
    }>,
  ): NodeRecord[] {
    return nodes.filter(node => {
      return existsFilters.every(ef => {
        // 检查 source 是否匹配当前节点名
        const srcName = ef.source
        if (node.name !== srcName) {
          // source 不匹配 — 跳过（但后面尝试匹配 target）
          return this._checkExistsDirection(node, ef)
        }
        return this._checkExistsDirection(node, ef)
      })
    })
  }

  /**
   * 检查节点在指定方向是否有邻居
   */
  private _checkExistsDirection(
    node: NodeRecord,
    ef: {
      source: string
      edgeLabel: string | null
      direction: 'out' | 'in' | 'any'
      target: string
    },
  ): boolean {
    let typeFilter: number[] | undefined
    if (ef.edgeLabel) {
      const typeId = this._resolveEdgeType(ef.edgeLabel)
      typeFilter = [typeId]
    }

    try {
      const result = this.neighbors(node.id, { maxDepth: 1, edgeTypeFilter: typeFilter })
      if (!result) return false

      // 检查方向
      return ef.direction === 'any' || result.edges.some(edge => {
          if (ef.direction === 'out') return edge.src === node.id
          if (ef.direction === 'in') return edge.dst === node.id
          return true
        })
    } catch {
      return false
    }
  }

  /** 检查单条 filter 是否匹配 */
  private _matchFilter(node: NodeRecord, f: { property: string; operator: string; value: unknown; negated?: boolean }): boolean {
    let val = node.props?.[f.property]
    const originalVal = val
    // 解包 typed 格式：{type: 'STRING', value: 'xxx'} → 'xxx'
    if (val && typeof val === 'object' && 'value' in (val as any) && (val as any).type) {
      val = (val as any).value
    }
    let result: boolean
    let fv = f.value
    // 解包 typed 格式的 filter value
    if (fv && typeof fv === 'object' && 'value' in (fv as any) && (fv as any).type) {
      fv = (fv as any).value
    }
    switch (f.operator) {
      case 'EQ':  result = val === fv; break
      case 'NEQ': result = val !== fv; break
      case 'GT':  result = typeof val === 'number' && typeof fv === 'number' && val > fv; break
      case 'GTE': result = typeof val === 'number' && typeof fv === 'number' && val >= fv; break
      case 'LT':  result = typeof val === 'number' && typeof fv === 'number' && val < fv; break
      case 'LTE': result = typeof val === 'number' && typeof fv === 'number' && val <= fv; break
      case 'IN': {
        if (!Array.isArray(fv)) { result = true; break }
        result = fv.includes(val); break
      }
      case 'STARTS_WITH': {
        if (typeof val !== 'string' || typeof fv !== 'string') { return false; break }
        result = val.startsWith(fv as string)
        break
      }
      case 'ENDS_WITH': {
        if (typeof val !== 'string' || typeof fv !== 'string') { return false; break }
        result = val.endsWith(fv as string); break
      }
      case 'CONTAINS': {
        if (typeof val !== 'string' || typeof fv !== 'string') { return false; break }
        result = val.includes(fv as string); break
      }
      default: result = true; break
    }
    const finalResult = f.negated ? !result : result
    return finalResult
  }

  /**
   * 变长路径 BFS 多跳遍历
   *
   * 从 candidates 节点开始，沿指定边类型进行 BFS 遍历，
   * 收集深度在 [minDepth, maxDepth] 范围内的所有目标节点。
   *
   * @param candidates - 起始节点列表
   * @param opts - 遍历选项
   * @param opts.relationshipType - 边类型 ID（Optional）
   * @param opts.minDepth - 最小深度
   * @param opts.maxDepth - 最大深度
   * @param opts.direction - 遍历方向
   * @param opts.ctx - RLS 上下文（Optional）
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
   * @returns Node ID 和对应分数的数组
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
   * @param opts - Optional参数
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
   * 按节点类型查找所有Node ID
   *
   * @param typeId - 节点类型 ID
   * @returns 该类型的所有Node ID 数组
   */
  findNodesByType(typeId: number): number[] {
    this._ensureOpen()
    return this._labelIndex.getNodeIds(typeId)
  }

  /**
   * 按节点属性查找Node ID
   *
   * @param typeId - 节点类型 ID
   * @param propKey - 属性键名
   * @param propValue - 属性值
   * @returns 匹配的Node ID 数组
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

  // ── 复合索引 ──────────────────────────────

  /**
   * 创建复合索引。
   * 代理到 storage 的实现。
   */
  createCompositeIndex(fields: string[], name: string, options?: { unique?: boolean }): void {
    this._ensureOpen()
    if (this.storage.createCompositeIndex) {
      this.storage.createCompositeIndex(fields, name, options)
    }
  }

  /**
   * 删除复合索引。
   * 代理到 storage 的实现。
   */
  dropCompositeIndex(name: string): void {
    this._ensureOpen()
    if (this.storage.dropCompositeIndex) {
      this.storage.dropCompositeIndex(name)
    }
  }

  /**
   * 聚合计数
   * @param typeFilter - Optional，按 typeId 过滤（节点类型）
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
   * @param typeFilter - Optional，按 typeId 过滤
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
   * @param typeFilter - Optional，按 typeId 过滤
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
   * @param typeFilter - Optional，按 typeId 过滤
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
   * @param typeFilter - Optional，按 typeId 过滤
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
   * 获取引擎统计Info
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
   * @param startNode - 起始Node ID
   * @returns Map<nodeId, { distance, parent }>
   */
  async bfs(startNode: NodeId): Promise<Map<NodeId, { distance: number; parent: NodeId | null }>> {
    this._ensureOpen()
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return bfs(getNeighbors, startNode)
  }

  /**
   * DFS 遍历
   * @param startNode - 起始Node ID
   * @param order - Optional，'pre' | 'post'
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
   * @param options - Optional参数（dampingFactor, maxIterations, convergenceThreshold）
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
   * @param start - 起始Node ID
   * @param end - 目标Node ID
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
   * @param startNode - 起始Node ID
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

  // ── Gap 7: Streaming Algorithm Engine with Graph Projection ──

  /**
   * 创建子图投影（GraphProjection）
   *
   * 从当前引擎中提取子图，以 CSR 格式存储邻接表。
   * 适用于大图上的内存高效计算。
   *
   * @param options - 投影选项（nodeFilter, edgeFilter, maxDepth, maxNodes, seedNodes）
   * @returns GraphProjection 实例
   */
  async createProjection(options?: {
    nodeFilter?: (node: import('../types').NodeRecord) => boolean
    edgeFilter?: (edge: import('../types').EdgeRecord) => boolean
    maxDepth?: number
    maxNodes?: number
    seedNodes?: import('../types').NodeId[]
  }): Promise<GraphProjection> {
    this._ensureOpen()
    return GraphProjection.create(this, options)
  }

  /**
   * 在子图投影上执行 PageRank
   *
   * 使用 GraphProjection 的 streamBatches() 进行内存高效的流式 PageRank 计算。
   * 适用于 10M+ 节点图上的 PageRank。
   *
   * @param options - 算法参数（damping, iterations, batchSize, nodeFilter, edgeFilter, maxDepth, maxNodes, seedNodes）
   * @param onProgress - 进度回调
   * @returns Map<nodeId, score>
   */
  async projectionPageRank(
    options?: {
      damping?: number
      iterations?: number
      batchSize?: number
      nodeFilter?: (node: import('../types').NodeRecord) => boolean
      edgeFilter?: (edge: import('../types').EdgeRecord) => boolean
      maxDepth?: number
      maxNodes?: number
      seedNodes?: import('../types').NodeId[]
    },
    onProgress?: (progress: { iteration: number; totalIterations: number; batchIndex: number; totalBatches: number }) => void,
  ): Promise<Map<import('../types').NodeId, number>> {
    this._ensureOpen()

    const projection = await GraphProjection.create(this, {
      nodeFilter: options?.nodeFilter,
      edgeFilter: options?.edgeFilter,
      maxDepth: options?.maxDepth,
      maxNodes: options?.maxNodes,
      seedNodes: options?.seedNodes,
    })

    return StreamingPageRank.compute(projection, {
      damping: options?.damping,
      iterations: options?.iterations,
      batchSize: options?.batchSize,
      onProgress,
    })
  }

  private _ensureOpen(): void {
    if (!this._isOpen) {
      throw new Error('GraphEngine is not open. Call open() first.')
    }
  }

  // ── Node/Edge cache API (Gap 12) ──

  /**
   * Get node/edge cache hit/miss statistics plus current cache sizes.
   */
  getNodeCacheStats(): {
    nodeHits: number
    nodeMisses: number
    edgeHits: number
    edgeMisses: number
    nodeSize: number
    edgeSize: number
  } {
    return {
      nodeHits: this._nodeCacheHits,
      nodeMisses: this._nodeCacheMisses,
      edgeHits: this._edgeCacheHits,
      edgeMisses: this._edgeCacheMisses,
      nodeSize: this._nodeCache.size,
      edgeSize: this._edgeCache.size,
    }
  }

  /**
   * Clear the node cache entirely.
   */
  clearNodeCache(): void {
    this._nodeCache.clear()
  }

  /**
   * Clear the edge cache entirely.
   */
  clearEdgeCache(): void {
    this._edgeCache.clear()
  }

  /**
   * Reset the engine to an empty graph, removing every node and edge from both
   * the in-memory indexes and the backing storage.  This is used by the query
   * executor's connection pool to guarantee isolation between independent query
   * executions — the engine is a per-execution scratch container, so any node
   * seeded by a prior run must not leak into the next one.
   */
  clearAllData(): void {
    // Remove every node from storage (this also drops their edges).
    for (const id of this._nodeIds) {
      try { this.storage.deleteNode(id) } catch { /* best-effort */ }
    }
    // Drop edges that are not reachable through node deletion (defensive).
    this.storage.clearEdgeCache?.()
    // Reset node bookkeeping.
    this._nodeIds.clear()
    this._nodeCount = 0
    // Reset label indexes.
    this._labelIndex.clear()
    this._labelStrIndex.clear()
    // Reset degree maps.
    this._inDegrees.clear()
    this._outDegrees.clear()
    // Reset caches.
    this._nodeCache.clear()
    this._edgeCache.clear()
    this._neighborCache.clear()
  }

  // ── Transaction API (Round 6: MVCC 增强) ──

  private _defaultTxnManager = new TransactionManager()

  /**
   * SimpleTxnManager — 轻量级写入缓冲事务管理器
   * 与 MVCC Transaction 系统独立，用于 REST API 的 begin/commit/rollback 流程
   */
  readonly simpleTxnMgr: SimpleTxnManager = new SimpleTxnManager()

  beginTransaction(txnManager?: TransactionManager): Transaction {
    const mgr = txnManager ?? this._defaultTxnManager
    const txn = mgr.begin()
    // 将 engine 绑定到事务，使 commit() 可以 flush 写入
    txn.setEngine(this)
    return txn
  }

  async withTransaction<T>(
    fn: (txn: Transaction) => Promise<T>,
    txnManager?: TransactionManager,
  ): Promise<T> {
    const mgr = txnManager ?? this._defaultTxnManager
    const txn = mgr.begin()
    txn.setEngine(this)
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
    txn.setEngine(this)
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

  // ── MVCC 集成方法 ──

  /**
   * 获取节点的 MVCC 版本号
   * 返回 undefined 表示节点没有版本Info（非 MVCC 写入）
   */
  getNodeVersion(nodeId: NodeId): number | undefined {
    return this._mvccVersions.get(nodeId)
  }

  /**
   * MVCC-aware 获取节点
   * 在事务上下文中，只返回对事务快照可见的节点（版本 <= 事务 snapshotId）
   * 返回 null 表示节点对当前事务不可见
   */
  getNodeWithTxn(nodeId: NodeId, txn: Transaction): NodeRecord | null {
    this._ensureOpen()

    // 先检查可见性
    if (txn.isolation === 'snapshot' || txn.isolation === 'serializable') {
      const version = this._mvccVersions.get(nodeId)
      if (version !== undefined && version > txn.snapshotId) {
        return null
      }
    }

    return this.getNode(nodeId)
  }

  /**
   * MVCC-aware 批量获取节点
   * 过滤掉对事务不可见的节点
   */
  getNodesWithTxn(nodeIds: NodeId[], txn: Transaction): Map<NodeId, NodeRecord> {
    const result = new Map<NodeId, NodeRecord>()
    for (const id of nodeIds) {
      const node = this.getNodeWithTxn(id, txn)
      if (node) {
        result.set(id, node)
      }
    }
    return result
  }

  // ── Geospatial Queries (Gap 5) ──

  /**
   * Query nodes within a given radius from a geographic point.
   * Requires nodes to have been indexed with `_lat`/`_lng` props.
   *
   * @param lat - Center latitude
   * @param lng - Center longitude
   * @param radiusKm - Search radius in kilometers
   * @returns Array of matching NodeIds
   */
  async geoNearby(lat: number, lng: number, radiusKm: number): Promise<number[]> {
    this._ensureOpen()
    if (this.storage instanceof OverGraphStorage) {
      return (this.storage as OverGraphStorage).geoNearby(lat, lng, radiusKm)
    }
    throw new Error('Geo queries require OverGraphStorage')
  }

  /**
   * K-Nearest Neighbors geospatial query.
   * Finds the k closest nodes to a given geographic point.
   *
   * @param lat - Center latitude
   * @param lng - Center longitude
   * @param k - Number of nearest neighbors to return
   * @param maxRadiusKm - Optional maximum search radius (for performance)
   * @returns Array of matching NodeIds sorted by distance (closest first)
   */
  async geoKnn(
    lat: number, lng: number,
    k: number,
    maxRadiusKm?: number,
  ): Promise<number[]> {
    this._ensureOpen()
    if (this.storage instanceof OverGraphStorage) {
      return (this.storage as OverGraphStorage).geoKnn(lat, lng, k, maxRadiusKm)
    }
    throw new Error('Geo queries require OverGraphStorage')
  }

  // ── Centrality & Community Algorithms ──

  /**
   * Closeness centrality — measures by average shortest path length
   * @param options - Optional { normalized }
   * @returns Map<nodeId, closenessScore>
   */
  async closeness(options?: { normalize?: boolean }): Promise<Map<NodeId, number>> {
    this._ensureOpen()
    const allNodes = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return closeness(getNeighbors, allNodes, options)
  }

  /**
   * k-Core decomposition — find maximal subgraph where each node has degree >= k
   * @param k - Minimum degree
   * @returns Set of node IDs in the k-core
   */
  async kCore(k: number): Promise<Set<NodeId>> {
    this._ensureOpen()
    const allNodes = Array.from(this._nodeIds)
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    return kCore(getNeighbors, allNodes, k)
  }

  /**
   * Leiden community detection — fast, high-quality community detection
   * @param options - Optional { resolution, seed }
   * @returns Map<nodeId, communityId>
   */
  async leidenCommunity(options?: { resolution?: number; seed?: number }): Promise<Map<NodeId, number>> {
    this._ensureOpen()
    const allNodes = Array.from(this._nodeIds)
    // Build the undirected edge list (deduplicated by src<dst) that the Leiden
    // implementation expects (LeidenEdge[]), mirroring the wcc/scc projection.
    const seen = new Set<string>()
    const edges: Array<{ src: number; dst: number; weight: number }> = []
    for (const id of allNodes) {
      for (const e of this.neighbors(id).edges) {
        const [a, b] = e.src < e.dst ? [e.src, e.dst] : [e.dst, e.src]
        const key = `${a}:${b}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ src: a, dst: b, weight: 1 })
      }
    }
    const result = leidenCommunity(allNodes, edges)
    return result.communities
  }

  /**
   * Ego-network extraction — get the subgraph centered on a node
   * @param center - Center node ID
   * @param radius - Ego network radius (default: 1 = immediate neighbors)
   */
  async egoNet(center: NodeId, radius: number = 1): Promise<{
    nodes: Set<NodeId>; edges: Array<{ src: NodeId; dst: NodeId; type: number }>
  }> {
    this._ensureOpen()
    const getNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => e.dst)
    // Carry the edge type through the ego-net algorithm's `weight` channel so
    // the subgraph edges can report their original type back to the caller.
    const getWeightedNeighbors = (nid: NodeId) => this.neighbors(nid).edges.map(e => ({
      nodeId: e.dst, weight: e.type,
    }))
    const result = egoNet(getNeighbors, getWeightedNeighbors, center, { depth: radius })
    return {
      nodes: result.nodes,
      edges: result.edges.map(e => ({ src: e.src, dst: e.dst, type: e.weight ?? 0 })),
    }
  }

  // ── Link Prediction ──

  /**
   * 创建 LinkPredictor 实例，用于链接预测离线评估
   *
   * 支持四种相似度方法 + GNN 推理
   *
   * @param seed Optional随机种子（用于可复现的负采样和划分）
   */
  createLinkPredictor(seed?: number): LinkPredictor {
    this._ensureOpen()
    const allNodes = Array.from(this._nodeIds)
    const adjacency = new Map<NodeId, Set<NodeId>>()
    for (const nid of this._nodeIds) {
      adjacency.set(nid, new Set(this.neighbors(nid).edges.map(e => e.dst)))
    }
    return new LinkPredictor(allNodes, adjacency, seed)
  }
}

/**
 * Sort an array of NodeRecords by a property in props.
 */
function propSort(
  arr: NodeRecord[],
  prop: string,
  direction: 'ASC' | 'DESC',
): void {
  arr.sort((a, b) => {
    const va = a.props?.[prop]
    const vb = b.props?.[prop]
    if (va === undefined && vb === undefined) return 0
    if (va === undefined) return 1
    if (vb === undefined) return -1
    // Delegate to the shared Cypher total-order comparator so heterogeneous
    // values (maps, nodes, relationships, lists, paths, strings, booleans,
    // numbers, NaN, null) sort by the openCypher type order instead of JS
    // `va < vb` (which yields `false` for every object pair and therefore
    // never reorders composite values).
    const cmp = _compareOrderByValue(va, vb)
    return direction === 'DESC' ? -cmp : cmp
  })
}

/** Index of the last top-level comma (depth 0, outside parentheses) in `s`, or -1. */
function _lastTopLevelCommaIdx(s: string): number {
  let depth = 0
  let last = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) last = i
  }
  return last
}
