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
 * raft-node.spec.ts — RaftNode 固化共识测试
 *
 * 测试策略：
 * RaftNode 封装了 RaftCore + GraphEngine，提供 write/read 高层 API。
 * MockTransport 进程内通信，无需网络。
 * GraphEngine 是 native 模块，通过 jest.mock 模块层级 mock。
 */
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const raft_node_1 = require("./raft-node");
const transport_1 = require("./transport");
const graph_engine_1 = require("../core/graph-engine");
const hlc_clock_1 = require("../replication/hlc-clock");
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
function createConfig(storageDir, nodeId = 'test-node', peerIds = []) {
    return {
        nodeId,
        peers: peerIds.map(id => ({ id, address: '127.0.0.1:0' })),
        storagePath: path.join(storageDir, nodeId),
        electionTimeoutMinMs: 100,
        electionTimeoutMaxMs: 200,
        heartbeatIntervalMs: 50,
    };
}
describe('RaftNode', () => {
    const testDir = path.join(os.tmpdir(), `raft-node-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let clock;
    let runningNodes = [];
    beforeAll(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });
    afterAll(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        catch { /* ok */ }
    });
    beforeEach(() => {
        clock = new hlc_clock_1.HlcClock();
        transport_1.MockTransport.reset();
    });
    afterEach(async () => {
        await Promise.all(runningNodes.map(n => n.stop().catch(() => { })));
        runningNodes = [];
        transport_1.MockTransport.reset();
    });
    describe('construction', () => {
        it('should create with default MockTransport', () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            expect(node).toBeInstanceOf(raft_node_1.RaftNode);
            expect(node.isStarted).toBe(false);
        });
        it('should create with custom transport', () => {
            const transport = new transport_1.MockTransport('custom-node');
            const node = new raft_node_1.RaftNode(createConfig(testDir, 'custom-node'), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock, undefined, transport);
            runningNodes.push(node);
            expect(node).toBeInstanceOf(raft_node_1.RaftNode);
            expect(node.isStarted).toBe(false);
        });
        it('should expose engine reference', () => {
            const engine = new graph_engine_1.GraphEngine({ path: ':memory:' });
            const node = new raft_node_1.RaftNode(createConfig(testDir), engine, clock);
            runningNodes.push(node);
            expect(node.engine_).toBe(engine);
        });
    });
    describe('start/stop lifecycle', () => {
        it('should start and become ready', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            expect(node.isStarted).toBe(true);
        });
        it('should stop cleanly', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            expect(node.isStarted).toBe(true);
            await node.stop();
            expect(node.isStarted).toBe(false);
        });
        it('should handle double start gracefully', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.start(); // second start should be idempotent
            expect(node.isStarted).toBe(true);
        });
        it('should handle double stop gracefully', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.stop();
            await node.stop(); // second stop should be idempotent
            expect(node.isStarted).toBe(false);
        });
        it('should be fully stopped (start=false) after stop', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            expect(node.isStarted).toBe(false);
            await node.start();
            expect(node.isStarted).toBe(true);
            await node.stop();
            expect(node.isStarted).toBe(false);
        });
        it('should handle stop before start', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            // stop() on not-started node — should noop
            await expect(node.stop()).resolves.toBeUndefined();
        });
    });
    describe('propose (write)', () => {
        it('should write upsert_node operation', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            const result = await node.write({
                type: 'upsert_node',
                payload: { typeId: 1, name: 'test-node' },
            });
            expect(result).toBe(BigInt(1));
        });
        it('should write admin barrier', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            await expect(node.barrier()).resolves.toBeUndefined();
        });
        it('should reject write on unstarted node', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await expect(node.write({ type: 'admin', payload: { command: 'barrier' } })).rejects.toThrow();
        });
        it('should reject write on stopped node', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            await node.stop();
            await expect(node.write({ type: 'upsert_node', payload: { typeId: 1, name: 'after-stop' } })).rejects.toThrow();
        });
        it('should write batch_upsert operation', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            const result = await node.write({
                type: 'batch_upsert',
                payload: {
                    inputs: [
                        { typeId: 1, name: 'batch-1' },
                        { typeId: 2, name: 'batch-2' },
                    ],
                },
            });
            expect(result).toEqual([]);
        });
    });
    describe('readIndex (linearizable read)', () => {
        it('should read from engine after start', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            // Use barrier to wait for leader readiness
            await node.barrier();
            const result = await node.read((engine) => {
                return engine.stats();
            });
            expect(result).toBeDefined();
            expect(result).toHaveProperty('nodeCount');
        });
    });
    describe('getStatus', () => {
        it('should return status with role after start', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            const status = node.getStatus();
            expect(status).toHaveProperty('role');
            expect(status).toHaveProperty('leaderId');
            expect(status).toHaveProperty('term');
            expect(status).toHaveProperty('committed');
            expect(status).toHaveProperty('applied');
            expect(status).toHaveProperty('lastIndex');
            expect(status).toHaveProperty('snapshotIndex');
        });
        it('should return leader role', async () => {
            const node = new raft_node_1.RaftNode(createConfig(testDir), new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node);
            await node.start();
            await node.waitForLeader(3000);
            const status = node.getStatus();
            expect(status.role).toBe('leader');
            expect(status.leaderId).toBe('test-node');
        });
    });
    describe('node restart simulation', () => {
        it('should persist across start-stop-start cycle', async () => {
            const nodeConfig = createConfig(testDir, 'restart-node');
            // First cycle: start, write, stop
            const node1 = new raft_node_1.RaftNode(nodeConfig, new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node1);
            await node1.start();
            await node1.waitForLeader(3000);
            await node1.write({ type: 'admin', payload: { command: 'barrier' } });
            const statusBefore = node1.getStatus();
            await node1.stop();
            // Remove from running list (don't stop twice)
            runningNodes = runningNodes.filter(n => n !== node1);
            // Second cycle: create new node with same config, start, verify
            const node2 = new raft_node_1.RaftNode(nodeConfig, new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(node2);
            await node2.start();
            await node2.waitForLeader(3000);
            // After restart, it should become leader again
            const statusAfter = node2.getStatus();
            expect(statusAfter.role).toBe('leader');
            // Term should have advanced after restart
            expect(statusAfter.term).toBeGreaterThanOrEqual(statusBefore.term);
        });
        it('should handle multi-cycle restart', async () => {
            const nodeConfig = createConfig(testDir, 'multi-cycle-node');
            for (let cycle = 0; cycle < 3; cycle++) {
                const node = new raft_node_1.RaftNode(nodeConfig, new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
                runningNodes.push(node);
                await node.start();
                await node.waitForLeader(5000);
                // Write each cycle
                const result = await node.write({
                    type: 'upsert_node',
                    payload: { typeId: 1, name: `cycle-${cycle}` },
                });
                await node.stop();
                // Remove from running list
                runningNodes = runningNodes.filter(n => n !== node);
            }
            // Final restart — verify it still works
            const finalNode = new raft_node_1.RaftNode(nodeConfig, new graph_engine_1.GraphEngine({ path: ':memory:' }), clock);
            runningNodes.push(finalNode);
            await finalNode.start();
            await finalNode.waitForLeader(3000);
            const status = finalNode.getStatus();
            expect(status.role).toBe('leader');
        }, 30000);
    });
});
//# sourceMappingURL=raft-node.spec.js.map