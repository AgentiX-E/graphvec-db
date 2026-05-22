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
}

export interface UpsertEdgeOptions {
  props?: NodeProperties
  temporalValidity?: TemporalValidity
  weight?: number
}

export interface NodeRecord {
  id: NodeId
  type: number
  name: string
  props: NodeProperties
  createdAt?: number
  degree?: number
}

export interface EdgeRecord {
  src: NodeId
  dst: NodeId
  type: number
  props: NodeProperties
  timestamp?: number
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
  hybrid?: boolean
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

export interface RaftOperation {
  id: string
  type: 'upsert_node' | 'upsert_edge' | 'delete_node' | 'delete_edge' | 'batch_upsert' | 'batch_edge' | 'admin'
  payload: unknown
  hlcTimestamp?: Uint8Array
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
  denseVector?: { dimension: number }
  defaultRetention?: { nodes?: string; edges?: string }
  cacheSize?: number
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

export interface AuthConfig {
  mode: 'jwt' | 'basic' | 'apikey' | 'mtls'
  jwtSecret?: string
  jwtExpiryMs?: number
  apiKeys?: Record<string, Role>
  tlsCert?: string
  tlsKey?: string
  tlsCA?: string
  tlsNodeWhitelist?: string[]  // mTLS 节点白名单
}

export interface AuthResult {
  user: string
  role: Role
}

export class AuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message)
    this.name = 'AuthError'
  }
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
