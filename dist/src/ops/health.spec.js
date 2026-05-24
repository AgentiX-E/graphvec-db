"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const health_1 = require("./health");
const shard_manager_1 = require("../shard/shard-manager");
const hlc_clock_1 = require("../replication/hlc-clock");
jest.mock('../shard/shard-manager', () => {
    return {
        ShardManager: jest.fn().mockImplementation(() => ({
            getShardStatus: jest.fn().mockReturnValue([]),
            getRange: jest.fn(),
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined),
        })),
    };
});
jest.mock('../core/graph-engine', () => {
    return {
        GraphEngine: jest.fn().mockImplementation(() => ({
            open: jest.fn(),
            close: jest.fn(),
            upsertNode: jest.fn().mockReturnValue(999999),
            deleteNode: jest.fn().mockReturnValue(true),
            stats: jest.fn().mockReturnValue({
                nodeCount: 0,
                edgeCount: 0,
                diskSizeBytes: 0,
            }),
            isOpen: true,
        })),
    };
});
const graph_engine_1 = require("../core/graph-engine");
describe('Health', () => {
    let shardManager;
    let health;
    beforeEach(() => {
        const shardMap = {
            version: 1,
            ranges: [],
            hashRing: { virtualNodes: 100, nodes: [] },
        };
        const clock = new hlc_clock_1.HlcClock();
        shardManager = new shard_manager_1.ShardManager(shardMap, clock);
        const engine = new graph_engine_1.GraphEngine();
        health = new health_1.Health(shardManager, engine);
    });
    test('should start with unhealthy status when no shards', () => {
        const status = health.getStatus();
        expect(status.status).toBe('unhealthy'); // no leader, so unhealthy
        expect(status.uptime).toBeGreaterThanOrEqual(0);
    });
    test('should report healthy when all shards have leader', () => {
        // Override mock to return shards with leader
        ;
        shardManager.getShardStatus.mockReturnValue([
            { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
            { rangeId: 'r2', raftRole: 'follower', nodeCount: 100 },
        ]);
        const status = health.getStatus();
        expect(status.status).toBe('healthy');
        expect(status.shards.total).toBe(2);
        expect(status.shards.healthy).toBe(2);
    });
    test('should report degraded when some shards are unhealthy', () => {
        ;
        shardManager.getShardStatus.mockReturnValue([
            { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
            { rangeId: 'r2', raftRole: 'candidate', nodeCount: 50 },
        ]);
        const status = health.getStatus();
        expect(status.status).toBe('degraded');
        expect(status.shards.healthy).toBe(1); // only leader is healthy
    });
    test('should report unhealthy when no leader', () => {
        ;
        shardManager.getShardStatus.mockReturnValue([
            { rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 },
            { rangeId: 'r2', raftRole: 'follower', nodeCount: 100 },
        ]);
        const status = health.getStatus();
        expect(status.status).toBe('unhealthy');
    });
    test('should return summary string', () => {
        ;
        shardManager.getShardStatus.mockReturnValue([
            { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
        ]);
        const summary = health.getSummary();
        expect(typeof summary).toBe('string');
        expect(summary).toContain('healthy');
        expect(summary).toContain('leader');
    });
    describe('check() — engine probe', () => {
        test('should detect healthy engine', async () => {
            ;
            shardManager.getShardStatus.mockReturnValue([
                { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
            ]);
            const result = await health.check();
            expect(result.status).toBe('healthy');
            expect(result.lastError).toBeNull();
        });
        test('should detect engine failure', async () => {
            ;
            shardManager.getShardStatus.mockReturnValue([
                { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
            ]);
            // Create a health instance with a failing engine
            const failingEngine = new graph_engine_1.GraphEngine();
            failingEngine.upsertNode = jest.fn().mockImplementation(() => {
                throw new Error('Engine crash');
            });
            const h = new health_1.Health(shardManager, failingEngine);
            const result = await h.check();
            expect(result.status).toBe('degraded');
            expect(result.lastError).toContain('Engine crash');
        });
    });
});
//# sourceMappingURL=health.spec.js.map