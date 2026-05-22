// ============================================================
// AgentiX GraphVec — 统一入口
// ============================================================

// Core
export { GraphEngine } from './core/graph-engine'
export { GraphConfig } from './core/graph-config'

// Consensus (abstracted)
export { RaftNode } from './consensus/raft-node'
export { RaftCluster } from './consensus/raft-cluster'
export { StandaloneConsensus } from './consensus/standalone-consensus'
export { SimulatedRaftConsensus } from './consensus/simulated-raft'
export { RaftLogicConsensus } from './consensus/raft-logic-consensus'
export { MockTransport, TcpTransport } from './consensus/raft-transport'
export type { ConsensusProvider, ConsensusConfig, ConsensusRole } from './consensus/consensus-provider'

// Shard
export { RangeInstance } from './shard/range-instance'
export { ShardRouter } from './shard/shard-router'
export { ShardManager } from './shard/shard-manager'

// Replication
export { HlcClock } from './replication/hlc-clock'
export { DeltaSync } from './replication/delta-sync'
export { DCSync } from './replication/dc-sync'

// Security
export { Authenticator } from './security/auth'
export { RBAC } from './security/rbac'
export { TLSConfig } from './security/tls'
export { AuditLogger } from './security/audit'

// Materialized View
export { MaterializedView } from './materialized-view/materialized-view'

// Resharding
export { ReshardPlan } from './reshard/reshard-plan'
export { ReshardWorker } from './reshard/reshard-worker'
export { ReshardManager } from './reshard/reshard-manager'

// Ops
export { Metrics } from './ops/metrics'
export { Logger } from './ops/logger'
export { Health } from './ops/health'
export { Backup } from './ops/backup'
export { QuerySlowLog } from './ops/query-slow-log'

// Types
export * from './types'

// Utils
export { IdEncoder } from './utils/id-encoder'
export { retry } from './utils/retry'
export { parallelLimit, withTimeout, waitFor } from './utils/promise-utils'

/**
 * AgentiX GraphVec — 版本信息
 */
export const VERSION = '0.1.0'
export const NAME = 'agentiX-graphvec'
