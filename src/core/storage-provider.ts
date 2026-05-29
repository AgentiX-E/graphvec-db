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
   * 启用属性压缩（使用 msgpackr）
   * 当 compress 为 true 时，节点/边的 props 使用 MsgPack 二进制格式存储
   * 而非 JSON 字符串，可节省 20-30% 空间。
   */
  compress?: boolean

  /**
   * 压缩策略。'none' = 不压缩（JSON），'msgpack' = 使用 msgpackr 压缩
   * 仅在 compress: true 时生效。默认 'msgpack'。
   */
  compressionStrategy?: 'none' | 'msgpack'

  /**
   * 地理索引配置
   * geoSpatial: 启用地理空间 R-tree 索引
   * geoLatField: 纬度属性名（默认 '_lat'）
   * geoLatField: 经度属性名（默认 '_lng'）
   */
  geoSpatial?: boolean
  geoLatField?: string
  geoLatField?: string
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
 * 存储后端统计信息
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

  // ── 复合索引 ──────────────────────────────

  /**
   * 创建复合索引
   * @param fields - 参与索引的字段名列表
   * @param name - 索引名称（唯一标识）
   * @param options - 可选的索引选项（如 unique: true 表示唯一约束）
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
