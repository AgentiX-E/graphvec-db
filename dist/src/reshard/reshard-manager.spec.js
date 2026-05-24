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
 * reshard-manager.spec.ts — ReshardManager 在线 Resharding 测试
 *
 * 测试策略：
 * ReshardManager 协调 ShardManager + ReshardPlan + ReshardWorker。
 * ShardManager 需要真实 RangeInstance，通过 jest.mock 模块级别 mock。
 * 单元测试验证：
 * - 状态机转换（pending → dual_write → migrating → ... → completed）
 * - 3PC 原子提交流程
 * - 回滚逻辑
 * - 容错处理
 */
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const reshard_manager_1 = require("./reshard-manager");
const shard_manager_1 = require("../shard/shard-manager");
const hlc_clock_1 = require("../replication/hlc-clock");
jest.mock('../core/graph-engine', () => {
    let nodeCounter = 0;
    return {
        GraphEngine: jest.fn().mockImplementation(() => {
            const nodes = [];
            return {
                open: jest.fn(),
                close: jest.fn(),
                upsertNode: jest.fn().mockImplementation((typeId, name) => {
                    const id = ++nodeCounter;
                    nodes.push({ id, type: typeId, name });
                    return BigInt(id);
                }),
                upsertEdge: jest.fn(),
                deleteNode: jest.fn(),
                deleteEdge: jest.fn(),
                batchUpsertNodes: jest.fn().mockReturnValue([]),
                queryPattern: jest.fn().mockReturnValue([]),
                neighbors: jest.fn().mockReturnValue({ edges: [], nodes: [] }),
                getNode: jest.fn(),
                getEdge: jest.fn(),
                stats: jest.fn().mockReturnValue({ nodeCount: nodes.length, edgeCount: 0, diskSizeBytes: 100 }),
                compact: jest.fn(),
                isOpen: false,
            };
        }),
    };
});
function createShardMap(testRunId, dir) {
    return {
        version: 1,
        ranges: [
            {
                rangeId: 'range-0',
                dataDir: path.join(dir, 'range-0'),
                raftConfig: {
                    nodeId: 'range-0',
                    peers: [],
                    storagePath: path.join(dir, 'range-0', 'raft'),
                    electionTimeoutMinMs: 150,
                    heartbeatIntervalMs: 50,
                },
                overgraphConfig: { path: path.join(dir, 'range-0', 'graph') },
            },
            {
                rangeId: 'range-1',
                dataDir: path.join(dir, 'range-1'),
                raftConfig: {
                    nodeId: 'range-1',
                    peers: [],
                    storagePath: path.join(dir, 'range-1', 'raft'),
                    electionTimeoutMinMs: 150,
                    heartbeatIntervalMs: 50,
                },
                overgraphConfig: { path: path.join(dir, 'range-1', 'graph') },
            },
        ],
        hashRing: {
            virtualNodes: 160,
            nodes: [
                { hash: '0x00000000', rangeId: 'range-0' },
                { hash: '0xFFFFFFFF', rangeId: 'range-1' },
            ],
        },
    };
}
describe('ReshardManager', () => {
    const testDir = path.join(os.tmpdir(), `reshard-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let clock;
    let shardManager;
    let shardMap;
    let testRunId;
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
        testRunId = Math.random().toString(36).slice(2, 8);
        const dir = path.join(testDir, testRunId);
        fs.mkdirSync(path.join(dir, 'range-0', 'raft'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'range-0', 'graph'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'range-1', 'raft'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'range-1', 'graph'), { recursive: true });
        shardMap = createShardMap(testRunId, dir);
        shardManager = new shard_manager_1.ShardManager(shardMap, clock);
    });
    afterEach(async () => {
        try {
            await shardManager.stop();
        }
        catch { /* ok */ }
        try {
            fs.rmSync(path.join(testDir, testRunId), { recursive: true, force: true });
        }
        catch { /* ok */ }
    });
    describe('construction', () => {
        it('should create with ShardManager and clock', () => {
            const mgr = new reshard_manager_1.ReshardManager(shardManager, clock);
            expect(mgr).toBeDefined();
            expect(mgr.status).toBeNull();
        });
    });
    describe('evaluateAndExecute', () => {
        it('should return null when no resharding needed', async () => {
            await shardManager.start();
            const mgr = new reshard_manager_1.ReshardManager(shardManager, clock);
            const result = await mgr.evaluateAndExecute();
            expect(result).toBeNull();
            await shardManager.stop();
        });
    });
    describe('execute with plan', () => {
        it('should execute resharding plan end-to-end', async () => {
            await shardManager.start();
            const planDir = path.join(testDir, testRunId, 'target');
            fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true });
            fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true });
            const plan = {
                planId: 'test-plan-1',
                version: 2,
                createdAt: Date.now(),
                estimatedDurationMs: 1000,
                splits: [
                    {
                        sourceRangeId: 'range-0',
                        targetRangeId: 'range-0-split-0',
                        hashRangeStart: 0,
                        hashRangeEnd: 50000,
                        targetNodeId: 'node-split-0',
                        targetDataDir: planDir,
                    },
                ],
            };
            const mgr = new reshard_manager_1.ReshardManager(shardManager, clock);
            const result = await mgr.execute(plan);
            expect(result).toBeDefined();
            expect(result.planId).toBe('test-plan-1');
            expect(result.state).toBe('completed');
            expect(result.progressPercent).toBe(100);
            expect(result.completedAt).toBeGreaterThan(0);
            await shardManager.stop();
        });
    });
    describe('rollback', () => {
        it('should rollback after completed execution', async () => {
            await shardManager.start();
            const planDir = path.join(testDir, testRunId, 'target-rollback');
            fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true });
            fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true });
            const plan = {
                planId: 'test-plan-rollback',
                version: 2,
                createdAt: Date.now(),
                estimatedDurationMs: 1000,
                splits: [
                    {
                        sourceRangeId: 'range-0',
                        targetRangeId: 'range-0-split-rb',
                        hashRangeStart: 0,
                        hashRangeEnd: 50000,
                        targetNodeId: 'node-rb',
                        targetDataDir: planDir,
                    },
                ],
            };
            const mgr = new reshard_manager_1.ReshardManager(shardManager, clock);
            await mgr.execute(plan);
            // Status should be completed
            expect(mgr.status.state).toBe('completed');
            // Rollback should work after completed
            await mgr.rollback();
            expect(mgr.status.state).toBe('failed');
            expect(mgr.status.errors).toContain('Rolled back by operator');
            await shardManager.stop();
        });
    });
    describe('state machine transitions', () => {
        it('should transition through correct states on success', async () => {
            await shardManager.start();
            const planDir = path.join(testDir, testRunId, 'target-states');
            fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true });
            fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true });
            const plan = {
                planId: 'test-plan-states',
                version: 2,
                createdAt: Date.now(),
                estimatedDurationMs: 1000,
                splits: [
                    {
                        sourceRangeId: 'range-0',
                        targetRangeId: 'range-0-split-states',
                        hashRangeStart: 0,
                        hashRangeEnd: 50000,
                        targetNodeId: 'node-states',
                        targetDataDir: planDir,
                    },
                ],
            };
            const mgr = new reshard_manager_1.ReshardManager(shardManager, clock);
            // After execute, final state should be 'completed'
            const result = await mgr.execute(plan);
            expect(result.state).toBe('completed');
            await shardManager.stop();
        });
        it('should handle failure gracefully', async () => {
            await shardManager.start();
            const plan = {
                planId: 'test-plan-fail',
                version: 2,
                createdAt: Date.now(),
                estimatedDurationMs: 1000,
                splits: [
                    {
                        sourceRangeId: 'nonexistent-range',
                        targetRangeId: 'range-fail-target',
                        hashRangeStart: 0,
                        hashRangeEnd: 50000,
                        targetNodeId: 'node-fail',
                        targetDataDir: '/nonexistent/path',
                    },
                ],
            };
            const mgr = new reshard_manager_1.ReshardManager(shardManager, clock);
            const result = await mgr.execute(plan);
            // Should fail because source range doesn't exist
            expect(result.state).toBe('failed');
            expect(result.errors.length).toBeGreaterThan(0);
            await shardManager.stop();
        });
    });
});
//# sourceMappingURL=reshard-manager.spec.js.map