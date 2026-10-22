// ============================================================
// StorageProvider — 存储层抽象接口
//
// 定义 GraphEngine 所需的全部存储操作协议。
// 所有具体存储后端（OverGraph、LevelDB、RocksDB、FoundationDB
// 等）都必须实现本接口。
// ============================================================

import {
  NodeId, NodeRecord, EdgeRecord, NodeProperties,
  UpsertNodeOptions, UpsertEdgeOptions,
  VectorSearchOptions, VectorSearchResult,
  PersonalizedPageRankOptions, ShortestPathOptions,
  ConnectedComponentsOptions, PatternMatchOptions,
} from '../types'

/**
 * 存储后端配置
 */
export interface StorageConfig {
  path: string
  /** 存储后端类型，默认 'lmdb'（通过 overgraph 实现） */
  backend?: 'lmdb' | 'classic-level'
  denseVector?: { dimension: number }
  defaultRetention?: { nodes?: string; edges?: string }
  /** OverGraph 存储优化参数 */
  overgraph?: {
    /** 自动 compaction 的 flush 次数阈值。0=禁用（推荐生产），默认 5 */
    compactAfterNFlushes?: number
    /** memtable 刷盘阈值（条目数），默认 10000 */
    memtableFlushThreshold?: number
    /** memtable 硬上限（字节），默认 64MB */
    memtableHardCapBytes?: number
  }

  /**
   * Enable property compression (msgpackr).
   * Property serialization defaults to msgpack even when compress is false,
   * because msgpack is the only format that preserves property insertion order
   * across the Rust persistence layer (see compressionStrategy).
   */
  compress?: boolean

  /**
   * Serialization strategy. 'msgpack' (default) encodes props as a single
   * msgpack blob keyed under `__c`, which preserves property insertion order
   * across flush/reopen — a correctness requirement. 'none' stores props as a
   * bare JSON object, which Rust may reorder (HashMap) after persistence.
   */
  compressionStrategy?: 'none' | 'msgpack'

  /**
   * 地理索引配置
   * geoSpatial: 启用地理空间 R-tree 索引
   * geoLatField: 纬度属性名（默认 '_lat'）
   * geoLngField: 经度属性名（默认 '_lng'）
   */
  geoSpatial?: boolean
  geoLatField?: string
  geoLngField?: string

  /**
   * LMDB 静态加密密钥
   * 如果设置，LMDB 数据库将使用此密钥进行静态加密（AES-256-GCM）。
   * 密钥应为 256-bit (32 bytes) Buffer 或 hex 编码字符串。
   * 只对 LMDB 后端生效。
   */
  encryptionKey?: string | Buffer

  /**
   * 列式索引配置
   * 对频繁查询的属性列构建独立 B-Tree 索引，
   * 加速属性范围扫描，避免全节点反序列化。
   */
  colIndex?: {
    /** 是否启用列索引 */
    enable: boolean
    /** 要索引的属性列名列表 */
    columns: string[]
    /** 索引Storage path，默认 {storagePath}/col-index/ */
    indexPath?: string
    /** 是否在写入时同步维护索引，默认 true */
    syncOnWrite?: boolean
  }
}

/**
 * 邻居查询的输入参数
 */
export interface NeighborsOptions {
  maxDepth?: number
  edgeTypeFilter?: number[]
}

/**
 * 邻居查询的返回条目（OverGraph 兼容格式）
 */
export interface NeighborEntry {
  nodeId: NodeId
  edgeTypeId: number
  validFrom: number
}

/**
 * 存储后端统计Info
 */
export interface StorageStats {
  nodeCount: number
  edgeCount: number
  diskSizeBytes: number
  pendingWalBytes: number
  activeMemtableBytes: number
  immutableMemtableBytes: number
}

/**
 * StorageProvider — 存储层抽象接口
 *
 * 所有具体存储实现必须提供此接口的全部方法。
 * GraphEngine 只通过此接口访问数据，不直接依赖任何具体后端。
 */
export interface StorageProvider {
  /** 打开存储后端 */
  open(config: StorageConfig): void

  /** 关闭存储后端 */
  close(): void

  /** 后端是否已打开 */
  readonly isOpen: boolean

  // ── 节点操作 ──────────────────────────────

  upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): NodeId

  getNode(id: NodeId, includeProps: boolean): {
    id: NodeId
    typeId: number
    key: string
    props?: Record<string, unknown>
    createdAt: number
  } | null

  deleteNode(id: NodeId): boolean

  batchUpsertNodes(inputs: Array<{
    typeId: number
    name: string
    key: string
    props?: Record<string, unknown>
    denseVector?: Float32Array
    temporalValidity?: { start?: number; end?: number }
  }>): NodeId[]

  degrees(id: NodeId): { inDegree: number; outDegree: number }

  // ── 边操作 ────────────────────────────────

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: {
    props?: Record<string, unknown>
    temporalValidity?: { start?: number; end?: number }
    weight?: number
  }): void

  getEdge(src: NodeId, dst: NodeId, typeId: number): {
    from: NodeId
    to: NodeId
    typeId: number
    props?: Record<string, unknown>
    createdAt: number
  } | null

  deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean

  neighbors(id: NodeId, opts?: NeighborsOptions): NeighborEntry[]

  /** 获取所有Node ID（用于 persistence 恢复重建索引） */
  getAllNodeIds(): number[]

  // ── 批量操作 ──────────────────────────────

  /**
   * 批量删除节点
   * @param ids - 要删除的Node ID 列表
   * @returns 实际删除的节点数
   */
  batchDeleteNodes?(ids: NodeId[]): number

  /**
   * 批量删除边
   * @param keys - 要删除的边列表（src, dst, typeId 三元组）
   * @returns 实际删除的边数
   */
  batchDeleteEdges?(keys: Array<{ src: NodeId; dst: NodeId; typeId: number }>): number

  /**
   * 清除边缓存（可选）。实现有边缓存时用于 `clearAllData` 兜底清理。
   */
  clearEdgeCache?(): void

  // ── 复合索引 ──────────────────────────────

  /**
   * 创建复合索引
   * @param fields - 参与索引的字段名列表
   * @param name - 索引名称（唯一标识）
   * @param options - Optional的索引选项（如 unique: true 表示唯一约束）
   */
  createCompositeIndex?(fields: string[], name: string, options?: { unique?: boolean }): void

  /**
   * 删除复合索引
   * @param name - 索引名称
   */
  dropCompositeIndex?(name: string): void

  // ── 搜索 ──────────────────────────────────

  vectorSearch(searchQuery: string): Array<{ id: NodeId; score: number; distance: number }>

  // ── 图算法 ────────────────────────────────

  personalizedPageRank(opts: {
    sourceNode: NodeId
    maxIter: number
    alpha: number
    tolerance: number
    topK: number
  }): { nodeId: NodeId; score: number }[]

  allShortestPaths(opts: {
    source: NodeId
    target: NodeId
    maxDepth: number
  }): { path: NodeId[]; cost: number }[]

  connectedComponents(opts?: { edgeTypeFilter?: number[] }): NodeId[][]

  queryPattern(opts: {
    sourceNodeId?: NodeId
    sourceTypeId?: number
    depth: number
    edgeTypeFilter?: number[][]
    nodeTypeFilter?: number[][]
    limit: number
  }): Array<{ id: NodeId; typeId: number; key: string; props?: Record<string, unknown>; createdAt: number }>

  // ── 维护 ──────────────────────────────────

  compact(): void

  stats(): StorageStats

  exportSnapshot?(): Buffer

  importSnapshot?(data: Buffer): void
}
