"use strict";
// ============================================================
// AgentiX GraphVec — 统一入口
// ============================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NAME = exports.VERSION = exports.waitFor = exports.withTimeout = exports.parallelLimit = exports.retry = exports.IdEncoder = exports.QuerySlowLog = exports.Backup = exports.Health = exports.Logger = exports.Metrics = exports.ReshardManager = exports.ReshardWorker = exports.ReshardPlan = exports.MaterializedView = exports.AuditLogger = exports.TLSConfig = exports.RBAC = exports.Authenticator = exports.DCSync = exports.DeltaSync = exports.HlcClock = exports.ShardManager = exports.ShardRouter = exports.RangeInstance = exports.TcpTransport = exports.MockTransport = exports.RaftLogicConsensus = exports.SimulatedRaftConsensus = exports.StandaloneConsensus = exports.RaftCluster = exports.RaftNode = exports.GraphConfig = exports.GraphEngine = void 0;
// Core
var graph_engine_1 = require("./core/graph-engine");
Object.defineProperty(exports, "GraphEngine", { enumerable: true, get: function () { return graph_engine_1.GraphEngine; } });
var graph_config_1 = require("./core/graph-config");
Object.defineProperty(exports, "GraphConfig", { enumerable: true, get: function () { return graph_config_1.GraphConfig; } });
// Consensus (abstracted)
var raft_node_1 = require("./consensus/raft-node");
Object.defineProperty(exports, "RaftNode", { enumerable: true, get: function () { return raft_node_1.RaftNode; } });
var raft_cluster_1 = require("./consensus/raft-cluster");
Object.defineProperty(exports, "RaftCluster", { enumerable: true, get: function () { return raft_cluster_1.RaftCluster; } });
var standalone_consensus_1 = require("./consensus/standalone-consensus");
Object.defineProperty(exports, "StandaloneConsensus", { enumerable: true, get: function () { return standalone_consensus_1.StandaloneConsensus; } });
var simulated_raft_1 = require("./consensus/simulated-raft");
Object.defineProperty(exports, "SimulatedRaftConsensus", { enumerable: true, get: function () { return simulated_raft_1.SimulatedRaftConsensus; } });
var raft_logic_consensus_1 = require("./consensus/raft-logic-consensus");
Object.defineProperty(exports, "RaftLogicConsensus", { enumerable: true, get: function () { return raft_logic_consensus_1.RaftLogicConsensus; } });
var transport_1 = require("./consensus/transport");
Object.defineProperty(exports, "MockTransport", { enumerable: true, get: function () { return transport_1.MockTransport; } });
Object.defineProperty(exports, "TcpTransport", { enumerable: true, get: function () { return transport_1.TcpTransport; } });
// Shard
var range_instance_1 = require("./shard/range-instance");
Object.defineProperty(exports, "RangeInstance", { enumerable: true, get: function () { return range_instance_1.RangeInstance; } });
var shard_router_1 = require("./shard/shard-router");
Object.defineProperty(exports, "ShardRouter", { enumerable: true, get: function () { return shard_router_1.ShardRouter; } });
var shard_manager_1 = require("./shard/shard-manager");
Object.defineProperty(exports, "ShardManager", { enumerable: true, get: function () { return shard_manager_1.ShardManager; } });
// Replication
var hlc_clock_1 = require("./replication/hlc-clock");
Object.defineProperty(exports, "HlcClock", { enumerable: true, get: function () { return hlc_clock_1.HlcClock; } });
var delta_sync_1 = require("./replication/delta-sync");
Object.defineProperty(exports, "DeltaSync", { enumerable: true, get: function () { return delta_sync_1.DeltaSync; } });
var dc_sync_1 = require("./replication/dc-sync");
Object.defineProperty(exports, "DCSync", { enumerable: true, get: function () { return dc_sync_1.DCSync; } });
// Security
var auth_1 = require("./security/auth");
Object.defineProperty(exports, "Authenticator", { enumerable: true, get: function () { return auth_1.Authenticator; } });
var rbac_1 = require("./security/rbac");
Object.defineProperty(exports, "RBAC", { enumerable: true, get: function () { return rbac_1.RBAC; } });
var tls_1 = require("./security/tls");
Object.defineProperty(exports, "TLSConfig", { enumerable: true, get: function () { return tls_1.TLSConfig; } });
var audit_1 = require("./security/audit");
Object.defineProperty(exports, "AuditLogger", { enumerable: true, get: function () { return audit_1.AuditLogger; } });
// Materialized View
var materialized_view_1 = require("./materialized-view/materialized-view");
Object.defineProperty(exports, "MaterializedView", { enumerable: true, get: function () { return materialized_view_1.MaterializedView; } });
// Resharding
var reshard_plan_1 = require("./reshard/reshard-plan");
Object.defineProperty(exports, "ReshardPlan", { enumerable: true, get: function () { return reshard_plan_1.ReshardPlan; } });
var reshard_worker_1 = require("./reshard/reshard-worker");
Object.defineProperty(exports, "ReshardWorker", { enumerable: true, get: function () { return reshard_worker_1.ReshardWorker; } });
var reshard_manager_1 = require("./reshard/reshard-manager");
Object.defineProperty(exports, "ReshardManager", { enumerable: true, get: function () { return reshard_manager_1.ReshardManager; } });
// Ops
var metrics_1 = require("./ops/metrics");
Object.defineProperty(exports, "Metrics", { enumerable: true, get: function () { return metrics_1.Metrics; } });
var logger_1 = require("./ops/logger");
Object.defineProperty(exports, "Logger", { enumerable: true, get: function () { return logger_1.Logger; } });
var health_1 = require("./ops/health");
Object.defineProperty(exports, "Health", { enumerable: true, get: function () { return health_1.Health; } });
var backup_1 = require("./ops/backup");
Object.defineProperty(exports, "Backup", { enumerable: true, get: function () { return backup_1.Backup; } });
var query_slow_log_1 = require("./ops/query-slow-log");
Object.defineProperty(exports, "QuerySlowLog", { enumerable: true, get: function () { return query_slow_log_1.QuerySlowLog; } });
// Types
__exportStar(require("./types"), exports);
// Utils
var id_encoder_1 = require("./utils/id-encoder");
Object.defineProperty(exports, "IdEncoder", { enumerable: true, get: function () { return id_encoder_1.IdEncoder; } });
var retry_1 = require("./utils/retry");
Object.defineProperty(exports, "retry", { enumerable: true, get: function () { return retry_1.retry; } });
var promise_utils_1 = require("./utils/promise-utils");
Object.defineProperty(exports, "parallelLimit", { enumerable: true, get: function () { return promise_utils_1.parallelLimit; } });
Object.defineProperty(exports, "withTimeout", { enumerable: true, get: function () { return promise_utils_1.withTimeout; } });
Object.defineProperty(exports, "waitFor", { enumerable: true, get: function () { return promise_utils_1.waitFor; } });
/**
 * AgentiX GraphVec — 版本信息
 */
exports.VERSION = '0.1.0';
exports.NAME = 'agentiX-graphvec';
//# sourceMappingURL=index.js.map