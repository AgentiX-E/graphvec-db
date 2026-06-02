// ============================================================
// AgentiX GraphVec — 全局共享类型定义
// ============================================================

// ──────────────────────────────────────────
// 节点 & 边 核心类型
// ──────────────────────────────────────────

export type NodeId = number

export enum EdgeType {
  RELATED = 10,
  DEPENDS_ON = 11,
  REFERENCES = 12,
  HAS_PROPERTY = 13,
  SEQUENCE = 14,
  USER_DEFINED = 100,
}

export enum NodeType {
  GENERIC = 1,
  USER = 2,
  AGENT = 3,
  CONVERSATION = 4,
  DOCUMENT = 5,
  ENTITY = 6,
  USER_DEFINED = 100,
}

export interface NodeProperties {
  [key: string]: string | number | boolean | null | string[] | number[]
}

export interface TemporalValidity {
  start?: number
  end?: number
}

export interface UpsertNodeOptions {
  props?: NodeProperties
  denseVector?: Float32Array | number[]
  sparseVector?: Record<number, number>
  temporalValidity?: TemporalValidity
  decayFactor?: number
  ttlSeconds?: number
  /** 如果为 true，跳过 Multi-Leader 复制广播 */
  skipReplication?: boolean
  /** MVCC 版本号（内部使用，由事务系统传入） */
  _mvccVersion?: number
  /** 简单事务 ID（内部使用，由 SimpleTxnManager 传入） */
  _txId?: string
}

export interface UpsertEdgeOptions {
  props?: NodeProperties
  temporalValidity?: TemporalValidity
  weight?: number
  /** 如果为 true，跳过 Multi-Leader 复制广播 */
  skipReplication?: boolean
  /** 简单事务 ID（内部使用，由 SimpleTxnManager 传入） */
  _txId?: string
}

export interface NodeRecord {
  id: NodeId
  type: number
  name: string
  props: NodeProperties
  createdAt?: number
  degree?: number
  /** MVCC 版本号（由事务系统设置，用于快照可见性检查） */
  mvccVersion?: number
}

export interface EdgeRecord {
  src: NodeId
  dst: NodeId
  type: number
  props: NodeProperties
  timestamp?: number
}

// ──────────────────────────────────────────
// 地理空间类型
// ──────────────────────────────────────────

/** 地理坐标点 */
export interface GeoPoint {
  latitude: number
  longitude: number
}

// ──────────────────────────────────────────
// 向量搜索类型
// ──────────────────────────────────────────

export interface VectorSearchResult {
  node: NodeRecord
  score: number
  distance?: number
}

export interface VectorSearchOptions {
  denseQuery?: Float32Array | number[]
  sparseQuery?: Record<number, number>
  k?: number
  hybrid?: boolean | { text: string; strategy?: 'rrf' | 'weighted'; vectorWeight?: number; textWeight?: number }
  hybridWeights?: { dense: number; sparse: number }
  scope?: {
    edgeTypeFilter?: EdgeType[]
    maxDepth?: number
    startNodeId?: NodeId
  }
  minScore?: number
}

// ──────────────────────────────────────────
// 图算法类型
// ──────────────────────────────────────────

export interface PersonalizedPageRankOptions {
  sourceNode: NodeId
  maxIter?: number
  alpha?: number
  tolerance?: number
  topK?: number
}

export interface ShortestPathOptions {
  source: NodeId
  target: NodeId
  edgeTypeFilter?: EdgeType[]
  maxDepth?: number
}

export interface ConnectedComponentsOptions {
  edgeTypeFilter?: EdgeType[]
}

export interface PatternMatchOptions {
  sourceNode?: NodeId
  sourceType?: NodeType
  depth: 1 | 2 | 3
  edgeFilters?: EdgeType[][]
  nodeFilters?: NodeType[][]
  propFilters?: Record<string, string | number | boolean>
  limit?: number
}

// ──────────────────────────────────────────
// Raft 共识类型
// ──────────────────────────────────────────

export interface RaftNodeConfig {
  nodeId: string
  peers: { id: string; address: string }[]
  storagePath: string
  electionTimeoutMinMs?: number
  electionTimeoutMaxMs?: number
  heartbeatIntervalMs?: number
  preVote?: boolean
  checkQuorum?: boolean
}

export type RaftRole = 'leader' | 'follower' | 'candidate' | 'standalone'

export interface RaftStatus {
  role: RaftRole
  leaderId: string | null
  term: number
  committed: number
  applied: number
  lastIndex: number
  snapshotIndex: number
}

export interface MembershipChange {
  type: 'add' | 'remove'
  peerId: string
  peerAddress?: string
  term: number
}

export interface RaftOperation {
  id: string
  type: 'upsert_node' | 'upsert_edge' | 'delete_node' | 'delete_edge' | 'batch_upsert' | 'batch_edge' | 'admin' | 'optimistic_upsert_node' | 'optimistic_upsert_edge' | 'install_snapshot'
  payload: unknown
  hlcTimestamp?: Uint8Array
  /** 乐观锁：期望的版本号，用于检测写冲突 */
  expectedVersion?: number | Record<string, number>
}

// ──────────────────────────────────────────
// 分片类型
// ──────────────────────────────────────────

export interface RangeConfig {
  rangeId: string
  dataDir: string
  raftConfig: RaftNodeConfig
  overgraphConfig: OverGraphConfig
}

export interface OverGraphConfig {
  path: string
  /** 存储后端类型，默认 'lmdb'（通过 overgraph 实现） */
  backend?: 'lmdb' | 'classic-level'
  denseVector?: { dimension: number }
  defaultRetention?: { nodes?: string; edges?: string }
  cacheSize?: number
  /** Node cache max entries (Gap 12), default 1000 */
  nodeCacheSize?: number
  /** Edge cache max entries (Gap 12), default 500 */
  edgeCacheSize?: number
  /** 邻里查询缓存 TTL（毫秒），默认 5000 */
  neighborCacheTTLMs?: number
  /** OverGraph 存储内核调优参数 */
  overgraph?: {
    compactAfterNFlushes?: number
    memtableFlushThreshold?: number
    memtableHardCapBytes?: number
  }
  /**
   * 启用存储层属性压缩。
   * 当设置为 true 时，节点/边的属性将使用 msgpackr 进行二进制序列化，
   * 代替 JSON 字符串，可节省约 20-30% 空间。
   * 默认为 false（不压缩）。
   */
  storageCompression?: boolean
  /** 查询超时毫秒数（默认 30000，0 表示不超时） */
  queryTimeoutMs?: number
  /** 是否持久化内存索引（LabelEngine + FullTextIndex），默认 true */
  persistIndexes?: boolean
}

export interface ShardMap {
  version: number
  ranges: RangeConfig[]
  hashRing: {
    virtualNodes: number
    nodes: { hash: string; rangeId: string }[]
  }
}

// ──────────────────────────────────────────
// 跨 DC 复制类型
// ──────────────────────────────────────────

export interface DCSyncConfig {
  dcId: string
  peers: { dcId: string; address: string; port: number }[]
  zmqPubAddress: string
  zmqSubAddress: string
  syncIntervalMs?: number
  batchSize?: number
  conflictStrategy?: 'lww' | 'ignore' | 'crdt'
}

export interface DeltaMessage {
  dcId: string
  hlcTimestamp: Uint8Array
  delta: unknown
  batchId: string
  /** 创建时间戳（毫秒），用于 TTL 清理 */
  timestamp?: number
}

// ──────────────────────────────────────────
// 安全类型
// ──────────────────────────────────────────

export enum Role {
  ADMIN = 'admin',
  READER = 'reader',
  WRITER = 'writer',
  OPERATOR = 'operator',
}

/**
 * mTLS 授权 DN → 角色映射
 * 每个条目定义了一个被授权客户的 CN 及其数据库级权限。
 *
 * databases: 该 CN 被授权访问的数据库列表，空数组或无此字段表示全部数据库
 */
export interface AuthorizedIdentity {
  /** 证书 CN */
  cn: string
  /** 全局角色 */
  role: Role
  /** 限定可访问的数据库，空数组或 undefined = 所有数据库 */
  databases?: string[]
}

/**
 * mTLS 认证配置
 * 只支持 mTLS，不支持 JWT/Basic/API Key
 */
export interface AuthConfig {
  mode: 'mtls'
  tlsCert: string   // 服务端证书路径
  tlsKey: string    // 服务端私钥路径
  tlsCA?: string    // CA 证书路径（可选，如不指定则用系统 CA）

  /** 授权身份列表 */
  identities?: AuthorizedIdentity[]

  /** 授权身份配置文件路径（JSON 格式），支持运行时热加载（文件 watch） */
  identitiesFile?: string

  /** 未授权 CN 默认角色，undefined = 拒绝访问 */
  defaultRole?: Role

  /** 默认可访问数据库（用于 defaultRole 生效的场景），空数组或 undefined = 所有数据库 */
  defaultDatabases?: string[]
}

export interface AuthResult {
  user: string
  role: Role
  /** 限定可访问的数据库列表 */
  databases?: string[]
}

export class AuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * 子图权限 — 控制用户对特定子图的访问
 */
export interface SubgraphPermission {
  /** 用户标识 */
  userId: string
  /** 子图名称 */
  subgraph: string
  /** 允许的操作 */
  actions: ('read' | 'write' | 'admin')[]
}

export interface AuditEntry {
  timestamp: string
  hlcTimestamp?: string
  operation: string
  user: string
  role: Role
  resource: string
  result: 'success' | 'denied' | 'error'
  latencyMs?: number
  details?: string
}

// ──────────────────────────────────────────
// 物化视图类型
// ──────────────────────────────────────────

export interface MaterializedViewConfig {
  name: string
  pattern: PatternMatchOptions
  refreshPolicy: 'periodic' | 'on_write' | 'manual'
  refreshIntervalSeconds?: number
  keepHistory?: boolean
  retentionSeconds?: number
}

export interface MaterializedViewStatus {
  name: string
  nodeCount: number
  edgeCount: number
  lastRefreshed: number | null
  nextRefresh: number | null
  sizeBytes: number
}

// ──────────────────────────────────────────
// Resharding 类型
// ──────────────────────────────────────────

export interface ReshardingPlan {
  planId: string
  version: number
  splits: ReshardSplit[]
  createdAt: number
  estimatedDurationMs: number
}

export interface ReshardSplit {
  sourceRangeId: string
  targetRangeId: string
  hashRangeStart: number
  hashRangeEnd: number
  targetNodeId: string
  targetDataDir: string
}

export interface ReshardingStatus {
  planId: string
  state: 'pending' | 'dual_write' | 'migrating' | 'switching' | 'preparing' | 'committing' | 'cleaning' | 'completed' | 'failed'
  progressPercent: number
  startedAt: number
  completedAt: number | null
  errors: string[]
}

// ──────────────────────────────────────────
// 运维类型
// ──────────────────────────────────────────

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime: number
  raft: { hasLeader: boolean; nodeCount: number; role: RaftRole }
  shards: { total: number; healthy: number }
  storage: { diskFree: number; diskUsed: number }
  latency: { p50: number; p99: number }
  lastError: string | null
}

export interface MetricsSnapshot {
  timestamp: number
  opsPerSecond: number
  readLatencyP50: number
  readLatencyP99: number
  writeLatencyP50: number
  writeLatencyP99: number
  raftCommitLatencyP99: number
  activeSessions: number
  shardCount: number
}
