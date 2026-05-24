"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const reshard_plan_1 = require("./reshard-plan");
describe('ReshardPlan', () => {
    let plan;
    let shardMap;
    beforeEach(() => {
        plan = new reshard_plan_1.ReshardPlan();
        shardMap = {
            version: 1,
            ranges: [
                {
                    rangeId: 'range-1',
                    dataDir: '/data/r1',
                    raftConfig: {
                        nodeId: 'node-1',
                        peers: [],
                        storagePath: '/data/r1/raft',
                    },
                    overgraphConfig: {
                        path: '/data/r1',
                    },
                },
                {
                    rangeId: 'range-2',
                    dataDir: '/data/r2',
                    raftConfig: {
                        nodeId: 'node-2',
                        peers: [],
                        storagePath: '/data/r2/raft',
                    },
                    overgraphConfig: {
                        path: '/data/r2',
                    },
                },
            ],
            hashRing: {
                virtualNodes: 100,
                nodes: [
                    { hash: '0x0000', rangeId: 'range-1' },
                    { hash: '0x7FFF', rangeId: 'range-2' },
                ],
            },
        };
    });
    test('should create ReshardPlan', () => {
        expect(plan).toBeDefined();
    });
    test('should return null when no ranges exceed threshold', () => {
        const ranges = [
            { rangeId: 'range-1', nodeCount: 100, opsPerSec: 500 },
            { rangeId: 'range-2', nodeCount: 200, opsPerSec: 300 },
        ];
        const result = plan.generatePlan(shardMap, ranges);
        expect(result).toBeNull();
    });
    test('should generate plan when node count exceeds maxNodes', () => {
        const ranges = [
            { rangeId: 'range-1', nodeCount: 15000, opsPerSec: 500 },
        ];
        const result = plan.generatePlan(shardMap, ranges);
        expect(result).not.toBeNull();
        expect(result.planId).toBeDefined();
        expect(result.splits.length).toBeGreaterThan(0);
        expect(result.version).toBe(shardMap.version + 1);
    });
    test('should generate plan when opsPerSec exceeds maxOpsPerSec', () => {
        const ranges = [
            { rangeId: 'range-1', nodeCount: 1000, opsPerSec: 50000 },
        ];
        const result = plan.generatePlan(shardMap, ranges);
        expect(result).not.toBeNull();
        expect(result.splits.length).toBeGreaterThan(0);
    });
    test('should use custom thresholds', () => {
        const ranges = [
            { rangeId: 'range-1', nodeCount: 500, opsPerSec: 100 },
        ];
        // Custom low threshold
        const result = plan.generatePlan(shardMap, ranges, { maxNodes: 100, maxOpsPerSec: 50 });
        expect(result).not.toBeNull();
        expect(result.splits.length).toBeGreaterThan(0);
    });
    test('should estimate migration cost', () => {
        const split = {
            sourceRangeId: 'range-1',
            targetRangeId: 'range-1-split',
            hashRangeStart: 0,
            hashRangeEnd: 1000000,
            targetNodeId: 'node-target',
            targetDataDir: './data/target',
        };
        const cost = plan.estimateCost(split, 10000);
        expect(cost.estimatedBytes).toBeGreaterThan(0);
        expect(cost.estimatedDurationMs).toBeGreaterThan(0);
    });
    test('should estimate cost based on node count', () => {
        const split = {
            sourceRangeId: 'range-1',
            targetRangeId: 'range-1-split',
            hashRangeStart: 0,
            hashRangeEnd: 1000000,
            targetNodeId: 'node-target',
            targetDataDir: './data/target',
        };
        const costSmall = plan.estimateCost(split, 100);
        const costLarge = plan.estimateCost(split, 10000);
        expect(costLarge.estimatedBytes).toBeGreaterThan(costSmall.estimatedBytes);
        expect(costLarge.estimatedDurationMs).toBeGreaterThan(costSmall.estimatedDurationMs);
    });
    test('should create unique plan IDs', async () => {
        const ranges = [{ rangeId: 'range-1', nodeCount: 15000 }];
        // Use setTimeout to ensure different timestamps
        const result1 = plan.generatePlan(shardMap, ranges);
        await new Promise(r => setTimeout(r, 5));
        const result2 = plan.generatePlan(shardMap, ranges);
        expect(result1.planId).not.toBe(result2.planId);
    });
});
//# sourceMappingURL=reshard-plan.spec.js.map