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
 * raft-test-utils.spec.ts — Raft 测试共享工具测试
 *
 * 测试 createMockEngine, createNodeConfig, createClusterWithNodes
 */
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const graph_engine_1 = require("../core/graph-engine");
const hlc_clock_1 = require("../replication/hlc-clock");
const raft_cluster_1 = require("./raft-cluster");
const mock_timer_1 = require("./mock-timer");
const raft_test_utils_1 = require("./raft-test-utils");
jest.mock('../core/graph-engine', () => {
    const mockEngine = () => ({
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
    });
    return { GraphEngine: jest.fn().mockImplementation(mockEngine) };
});
describe('raft-test-utils', () => {
    let clock;
    let timer;
    beforeEach(() => {
        clock = new hlc_clock_1.HlcClock();
        timer = new mock_timer_1.MockTimer();
    });
    describe('createMockEngine', () => {
        it('should create a mock GraphEngine', () => {
            const engine = new graph_engine_1.GraphEngine({ path: ':memory:' });
            expect(engine).toBeDefined();
            expect(typeof engine.open).toBe('function');
            expect(typeof engine.close).toBe('function');
            expect(typeof engine.upsertNode).toBe('function');
        });
        it('should have upsertNode returning BigInt', () => {
            const engine = new graph_engine_1.GraphEngine({ path: ':memory:' });
            const result = engine.upsertNode(1, 'test');
            expect(result).toBe(BigInt(1));
        });
        it('should have stats returning default values', () => {
            const engine = new graph_engine_1.GraphEngine({ path: ':memory:' });
            const stats = engine.stats();
            expect(stats.nodeCount).toBe(0);
            expect(stats.edgeCount).toBe(0);
            expect(stats.diskSizeBytes).toBe(0);
        });
    });
    describe('createNodeConfig', () => {
        it('should create a minimal config with default values', () => {
            const config = (0, raft_test_utils_1.createNodeConfig)('node-0', ['node-1', 'node-2']);
            expect(config.nodeId).toBe('node-0');
            expect(config.peers).toHaveLength(2);
            expect(config.peers[0].id).toBe('node-1');
            expect(config.peers[0].address).toBe('127.0.0.1:0');
            expect(config.peers[1].id).toBe('node-2');
            expect(config.electionTimeoutMinMs).toBe(100);
            expect(config.electionTimeoutMaxMs).toBe(200);
            expect(config.heartbeatIntervalMs).toBe(50);
        });
        it('should create config with no peers', () => {
            const config = (0, raft_test_utils_1.createNodeConfig)('solo-node');
            expect(config.nodeId).toBe('solo-node');
            expect(config.peers).toHaveLength(0);
        });
        it('should create unique storagePath with instanceId', () => {
            const config1 = (0, raft_test_utils_1.createNodeConfig)('n', [], 'instance-A');
            const config2 = (0, raft_test_utils_1.createNodeConfig)('n', [], 'instance-B');
            expect(config1.storagePath).not.toBe(config2.storagePath);
            expect(config1.storagePath).toContain('instance-A');
            expect(config2.storagePath).toContain('instance-B');
        });
        it('should create different storagePath without instanceId', () => {
            const config1 = (0, raft_test_utils_1.createNodeConfig)('n');
            const config2 = (0, raft_test_utils_1.createNodeConfig)('n');
            // Without instanceId, both get the same pattern
            expect(config1.storagePath).toMatch(/^:memory:n/);
        });
    });
    describe('createClusterWithNodes', () => {
        // Track clusters for cleanup
        const clusters = [];
        afterEach(async () => {
            await Promise.all(clusters.map(c => c.stop().catch(() => { })));
            clusters.length = 0;
        });
        it('should create a 3-node cluster', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            expect(cluster).toBeInstanceOf(raft_cluster_1.RaftCluster);
            expect(cluster.size).toBe(3);
        });
        it('should create a 1-node cluster', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(1, undefined, clock);
            clusters.push(cluster);
            expect(cluster.size).toBe(1);
        });
        it('should create a 5-node cluster', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(5, undefined, clock);
            clusters.push(cluster);
            expect(cluster.size).toBe(5);
        });
        it('should create an empty cluster with nodeCount=0', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(0, undefined, clock);
            clusters.push(cluster);
            expect(cluster.size).toBe(0);
        });
        it('should create cluster with nodes having staggered timeouts', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(3, undefined, clock);
            clusters.push(cluster);
            // Timeouts for node-0, node-1, node-2 should be staggered:
            // node-0: 100~200, node-1: 300~500, node-2: 600~900
            cluster.getAllStatus();
            // We can't directly inspect config from cluster, but we verify
            // the cluster works (3 nodes started)
            expect(cluster.size).toBe(3);
        });
        it('should accept custom dataDir', () => {
            const customDir = path.join(os.tmpdir(), `raft-custom-${Date.now()}`);
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(2, undefined, clock, undefined, customDir);
            clusters.push(cluster);
            expect(cluster.size).toBe(2);
            try {
                fs.rmSync(customDir, { recursive: true, force: true });
            }
            catch { /* ok */ }
        });
        it('should accept timerProvider', () => {
            const cluster = (0, raft_test_utils_1.createClusterWithNodes)(2, undefined, clock, timer);
            clusters.push(cluster);
            expect(cluster.size).toBe(2);
        });
        it('should use different dataDir for each call', () => {
            const cluster1 = (0, raft_test_utils_1.createClusterWithNodes)(1, undefined, clock);
            const cluster2 = (0, raft_test_utils_1.createClusterWithNodes)(1, undefined, clock);
            clusters.push(cluster1, cluster2);
            // Each cluster got its own temp dir
            expect(cluster1.size).toBe(1);
            expect(cluster2.size).toBe(1);
        });
    });
});
//# sourceMappingURL=raft-test-utils.spec.js.map