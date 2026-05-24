"use strict";
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMockEngine = createMockEngine;
exports.createNodeConfig = createNodeConfig;
exports.createClusterWithNodes = createClusterWithNodes;
/**
 * raft-test-utils — Raft 测试共享工具
 *
 * 提供：
 * - createMockEngine(): 创建模拟 GraphEngine（避免依赖原生 OverGraph 模块）
 * - createNodeConfig(): 快速创建 RaftNodeConfig
 * - createClusterWithNodes(): 快速创建带 N 个节点的 RaftCluster
 */
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const hlc_clock_1 = require("../replication/hlc-clock");
const raft_cluster_1 = require("./raft-cluster");
/**
 * 创建一个模拟的 GraphEngine
 * GraphEngine 依赖原生 OverGraph 模块，测试时需要 mock
 */
function createMockEngine() {
    return {
        constructor: jest.fn(),
        open: jest.fn(),
        close: jest.fn(),
        upsertNode: jest.fn().mockReturnValue(BigInt(1)),
        upsertEdge: jest.fn(),
        deleteNode: jest.fn(),
        deleteEdge: jest.fn(),
        batchUpsertNodes: jest.fn().mockReturnValue([]),
        queryPattern: jest.fn().mockReturnValue([]),
        neighbors: jest.fn().mockReturnValue({ edges: [], nodes: [] }),
        getNode: jest.fn(),
        getEdge: jest.fn(),
        stats: jest.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }),
        compact: jest.fn(),
        isOpen: false,
    };
}
/**
 * 创建测试用的 RaftNodeConfig
 */
function createNodeConfig(nodeId, peerIds = [], instanceId) {
    const memSuffix = instanceId ? `-${instanceId}` : '';
    return {
        nodeId,
        peers: peerIds.map(id => ({ id, address: `127.0.0.1:0` })),
        storagePath: `:memory:${nodeId}${memSuffix}`,
        electionTimeoutMinMs: 100,
        electionTimeoutMaxMs: 200,
        heartbeatIntervalMs: 50,
    };
}
/**
 * 创建一个 RaftCluster（每个节点拥有独立引擎），并添加指定数量的节点
 * 明确设置 CONSENSUS_MODE=standalone 避免网络依赖
 *
 * @param nodeCount 节点数量
 * @param engine （已弃用，保留参数仅为兼容旧调用方）每个节点会自动创建独立引擎
 * @param clock 时钟（可选，默认创建新的 HlcClock）
 * @param timerProvider 计时器提供者（可选，用于测试注入 MockTimer）
 * @param dataDir 数据目录（可选，默认使用临时目录）
 */
function createClusterWithNodes(nodeCount, engine, clock, timerProvider, dataDir) {
    const dir = dataDir || path.join(os.tmpdir(), `raft-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const actualClock = clock ?? new hlc_clock_1.HlcClock();
    const cluster = new raft_cluster_1.RaftCluster(dir, actualClock);
    if (timerProvider)
        cluster.setTimerProvider(timerProvider);
    if (nodeCount > 0) {
        const instanceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node-${i}`);
        for (let i = 0; i < nodeIds.length; i++) {
            const nodeId = nodeIds[i];
            const peers = nodeIds.filter(id => id !== nodeId);
            // 每个节点显著偏移 election timeout，避免多节点 split vote 死锁
            // node-0: 100~200ms, node-1: 300~500ms, node-2: 600~900ms
            // instanceId 保证 WAL 跨 test 隔离
            cluster.addNode({
                ...createNodeConfig(nodeId, peers, instanceId),
                electionTimeoutMinMs: 100 + i * 200,
                electionTimeoutMaxMs: 200 + i * 300,
                heartbeatIntervalMs: 50,
            });
        }
    }
    return cluster;
}
//# sourceMappingURL=raft-test-utils.js.map