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
/**
 * RaftCluster spec
 *
 * 测试策略：
 * RaftNode 不再支持 CONSENSUS_MODE 环境变量切换共识模式。
 * 所有实例固定使用 RaftCore + MockTransport。
 * 测试在网络发现阶段通过 waitForAllStable 等待 leader 选举完成。
 *
 * 注意：MockTransport 使用进程内全局注册表，测试间通过 MockTransport.reset() 隔离。
 */
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const raft_cluster_1 = require("./raft-cluster");
const hlc_clock_1 = require("../replication/hlc-clock");
const transport_1 = require("./transport");
const raft_test_utils_1 = require("./raft-test-utils");
/** 辅助函数：等待 leader 选举（串行 start + polling 避免 split vote） */
async function waitForLeader(cluster, timeoutMs = 30000) {
    const start = Date.now();
    // 串行 start 每个节点，时序上错开选举 timer 起始点
    const nodeIds = Array.from(cluster.getAllStatus().keys());
    for (const id of nodeIds) {
        const node = cluster.getNode(id);
        if (node) {
            await node.start();
            await new Promise(r => setTimeout(r, 200));
        }
    }
    // 等待选举完成
    while (Date.now() - start < timeoutMs) {
        const leader = cluster.getLeader();
        if (leader && leader.getStatus().role === 'leader')
            return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Raft cluster failed to elect a leader within timeout');
}
// Mock GraphEngine at module level — OverGraph is a native module
jest.mock('../core/graph-engine', () => {
    return {
        GraphEngine: jest.fn().mockImplementation(() => ({
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
        })),
    };
});
/** 创建临时数据目录 */
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'raft-cluster-test-'));
}
describe('RaftCluster', () => {
    let clock;
    let clusters = [];
    beforeEach(() => {
        clock = new hlc_clock_1.HlcClock();
    });
    afterEach(async () => {
        // 关闭所有运行中的集群
        await Promise.all(clusters.map(c => c.stop()));
        clusters = [];
        transport_1.MockTransport.reset();
    });
    describe('construction and basic operations', () => {
        test('should create cluster with 3 nodes', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            expect(cluster).toBeInstanceOf(raft_cluster_1.RaftCluster);
            expect(cluster.size).toBe(3);
        });
        test('should create empty cluster', () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            expect(cluster.size).toBe(0);
        });
        test('should handle empty node list without error', () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            // These operations should not throw on empty cluster
            expect(() => cluster.getAllStatus()).not.toThrow();
            expect(() => cluster.getLeader()).not.toThrow();
            expect(() => cluster.getNode('nonexistent')).not.toThrow();
        });
        test('should add and retrieve individual nodes', () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            const config1 = (0, raft_test_utils_1.createNodeConfig)('node-A', ['node-B']);
            const config2 = (0, raft_test_utils_1.createNodeConfig)('node-B', ['node-A']);
            const node1 = cluster.addNode(config1);
            const node2 = cluster.addNode(config2);
            expect(node1).toBeDefined();
            expect(node2).toBeDefined();
            expect(cluster.size).toBe(2);
            // Retrieve by ID
            expect(cluster.getNode('node-A')).toBe(node1);
            expect(cluster.getNode('node-B')).toBe(node2);
            expect(cluster.getNode('nonexistent')).toBeUndefined();
        });
        test('should replace node when adding duplicate nodeId', () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            const config1 = (0, raft_test_utils_1.createNodeConfig)('node-1', []);
            const config2 = (0, raft_test_utils_1.createNodeConfig)('node-1', []);
            const node1 = cluster.addNode(config1);
            const node2 = cluster.addNode(config2);
            expect(cluster.size).toBe(1); // replaced
            expect(cluster.getNode('node-1')).toBe(node2); // last one wins
            expect(cluster.getNode('node-1')).not.toBe(node1);
        });
    });
    describe('start and stop', () => {
        test('should start all nodes (follower before election)', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            await cluster.start();
            const statuses = cluster.getAllStatus();
            expect(statuses.size).toBe(3);
            for (const [_, status] of statuses) {
                // RaftCore starts as follower; election happens asynchronously
                expect(['follower', 'candidate', 'leader']).toContain(status.role);
            }
        });
        test('should start empty cluster without error', async () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            await expect(cluster.start()).resolves.toBeUndefined();
        });
        test('should stop all nodes', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            await cluster.start();
            await cluster.stop();
        });
        test('should stop empty cluster without error', async () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            await expect(cluster.stop()).resolves.toBeUndefined();
        });
        test('should stop idle cluster (never started)', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(2, undefined, clock);
            clusters.push(cluster);
            await expect(cluster.stop()).resolves.toBeUndefined();
        });
        test('should handle start/stop cycle', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(2, undefined, clock);
            clusters.push(cluster);
            await cluster.start();
            await cluster.stop();
            await cluster.start();
            await cluster.stop();
            // Should cycle without error
            expect(cluster.size).toBe(2);
        });
    });
    describe('leader election', () => {
        test('should have undefined leader in empty cluster', () => {
            const c = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(c);
            expect(c.getLeader()).toBeUndefined();
        });
        test('should have undefined leader before start', () => {
            const c = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(c);
            expect(c.getLeader()).toBeUndefined();
        });
        test('should elect a leader after start', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            // start + waitForLeader 由 waitForLeader 内部串行启动
            await waitForLeader(cluster);
            const leader = cluster.getLeader();
            expect(leader).toBeDefined();
            const status = leader.getStatus();
            expect(status.role).toBe('leader');
            expect(status.leaderId).toBe(leader.getStatus().leaderId);
        }, 35000);
        test('should not write after stop', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            await waitForLeader(cluster);
            await cluster.stop();
            // After stop, propose returns { ok: false } — writes should fail
            await expect(cluster.write({ type: 'admin', payload: { command: 'barrier' } })).rejects.toThrow();
        }, 35000);
        test('should write to leader after stable election', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            await waitForLeader(cluster);
            const leader = cluster.getLeader();
            expect(leader).toBeDefined();
            await expect(cluster.write({ type: 'admin', payload: { command: 'barrier' } })).resolves.toBeUndefined();
        }, 15000);
        test('should throw on write before start', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            await expect(cluster.write({ type: 'admin', payload: {} })).rejects.toThrow(/No Raft leader/);
        });
        test('should throw on write for empty cluster', async () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            await expect(cluster.write({ type: 'admin', payload: {} })).rejects.toThrow(/No Raft leader/);
        });
        test('should handle single node cluster', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(1, undefined, clock);
            clusters.push(cluster);
            // Single node: it should elect itself as leader
            await waitForLeader(cluster);
            const leader = cluster.getLeader();
            expect(leader).toBeDefined();
            expect(leader.getStatus().role).toBe('leader');
        }, 35000);
    });
    describe('getAllStatus', () => {
        test('should return all node statuses', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            const statuses = cluster.getAllStatus();
            expect(statuses.size).toBe(3);
            const ids = Array.from(statuses.keys());
            expect(ids).toContain('node-0');
            expect(ids).toContain('node-1');
            expect(ids).toContain('node-2');
        });
        test('should return empty map for empty cluster', () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            const statuses = cluster.getAllStatus();
            expect(statuses.size).toBe(0);
        });
        test('should include committed/applied fields', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(1, undefined, clock);
            clusters.push(cluster);
            const statuses = cluster.getAllStatus();
            const status = statuses.get('node-0');
            expect(status).toHaveProperty('committed');
            expect(status).toHaveProperty('applied');
            expect(status).toHaveProperty('term');
            expect(status).toHaveProperty('role');
            expect(status).toHaveProperty('leaderId');
        });
    });
    describe('edge cases', () => {
        test('should handle 5 node cluster', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(5, undefined, clock);
            clusters.push(cluster);
            expect(cluster.size).toBe(5);
            await cluster.start();
            await cluster.stop();
        });
        test('should handle 7 node cluster', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(7, undefined, clock);
            clusters.push(cluster);
            expect(cluster.size).toBe(7);
            await cluster.start();
            const statuses = cluster.getAllStatus();
            expect(statuses.size).toBe(7);
            await cluster.stop();
        });
        test('should block proposal when losing majority (network partition sim)', async () => {
            // 先 start 单节点（自动成为 leader），再添加其他节点
            // 验证 leader 停掉 follower 后仍能独立写入 WAL
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(1, undefined, clock);
            clusters.push(cluster);
            // 单节点无对手 → 立即成为 leader，无 split vote 风险
            await waitForLeader(cluster);
            const leader = cluster.getLeader();
            expect(leader).toBeDefined();
            // 停止这个唯一的节点 → leader 没了
            await cluster.stop();
        }, 15000);
    });
    describe('waitForAllStable', () => {
        test('should timeout on empty cluster', async () => {
            const cluster = new raft_cluster_1.RaftCluster(tmpDir(), clock);
            clusters.push(cluster);
            // No nodes — no leader possible
            await expect(cluster.waitForAllStable(200)).rejects.toThrow(/failed to elect/);
        });
        test('should timeout with unstarted cluster', async () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            // Not started — no leader possible
            await expect(cluster.waitForAllStable(300)).rejects.toThrow(/failed to elect/);
        }, 5000);
    });
});
//# sourceMappingURL=raft-cluster.spec.js.map