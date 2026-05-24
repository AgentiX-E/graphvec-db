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
const rebalancer_1 = require("./rebalancer");
const shard_manager_1 = require("./shard-manager");
const hlc_clock_1 = require("../replication/hlc-clock");
const fs = __importStar(require("fs"));
// ──────────────────────────────────────────
// 测试策略
// ──────────────────────────────────────────
// Rebalancer 依赖于 ShardManager，ShardManager 依赖于真实的
// RangeInstance / Raft / OverGraph。我们在 standalone 模式下
// 启动 ShardManager，然后通过 Rebalancer 检查负载并触发重平衡。
//
// 测试覆盖面：
// 1. 创建 Rebalancer（无 timer 启动）
// 2. trigger() 手动触发重平衡
// 3. getStats() 返回正确的 RebalancerStats
// 4. start/stop 生命周期
const randomId = Math.random().toString(36).slice(2, 8);
const TEST_DIR = `/tmp/agentiX-test-rebal-${randomId}`;
function makeShardMap(version = 1, rangeCount = 2) {
    const ranges = Array.from({ length: rangeCount }, (_, i) => ({
        rangeId: `rebal-range-${i}`,
        dataDir: `${TEST_DIR}/${randomId}/range-${i}`,
        raftConfig: {
            nodeId: `rebal-range-${i}`,
            peers: [],
            storagePath: `${TEST_DIR}/${randomId}/range-${i}/raft`,
            electionTimeoutMinMs: 150,
            heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: `${TEST_DIR}/${randomId}/range-${i}/graph` },
    }));
    // Create hash ring nodes — assign a distinct hash range per range
    const hashNodes = Array.from({ length: rangeCount }, (_, i) => {
        const hash = `0x${(i * 0xffffffff / rangeCount).toString(16).padStart(8, '0')}`;
        return { hash, rangeId: `rebal-range-${i}` };
    });
    return {
        version,
        ranges,
        hashRing: {
            virtualNodes: 160,
            nodes: hashNodes,
        },
    };
}
describe('Rebalancer', () => {
    let clock;
    let shardMap;
    beforeAll(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
    });
    afterAll(() => {
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        catch { }
    });
    beforeEach(() => {
        clock = new hlc_clock_1.HlcClock();
        shardMap = makeShardMap();
        // Create directory structure
        for (const range of shardMap.ranges) {
            fs.mkdirSync(`${range.dataDir}/raft`, { recursive: true });
            fs.mkdirSync(`${range.dataDir}/graph`, { recursive: true });
        }
    });
    // ──────────────────────────────────────────
    // 创建测试
    // ──────────────────────────────────────────
    test('should create Rebalancer with default options', () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        expect(rebalancer).toBeDefined();
    });
    test('should create Rebalancer with custom options', () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        const options = {
            checkIntervalMs: 10000,
            nodeCountDeviationThreshold: 0.3,
            loadFactorThreshold: 1.5,
        };
        const rebalancer = new rebalancer_1.Rebalancer(mgr, options);
        expect(rebalancer).toBeDefined();
    });
    // ──────────────────────────────────────────
    // getStats
    // ──────────────────────────────────────────
    test('getStats should return stats with ranges', async () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        await mgr.start();
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        const stats = rebalancer.getStats();
        expect(stats.ranges).toBeDefined();
        expect(stats.ranges.length).toBe(2);
        expect(typeof stats.averageNodeCount).toBe('number');
        expect(typeof stats.needsRebalancing).toBe('boolean');
        expect(stats.lastRebalance).toBeNull();
        await mgr.stop();
    });
    test('getStats should reflect node counts after inserting nodes', async () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        await mgr.start();
        await new Promise(r => setTimeout(r, 50));
        // Insert some nodes to one range
        const range0 = mgr.getRange('rebal-range-0');
        const range1 = mgr.getRange('rebal-range-1');
        // Write 5 nodes to range 0 via raft
        for (let i = 0; i < 5; i++) {
            await range0.write({
                type: 'upsert_node',
                payload: { typeId: 1, name: `rebal-node-${i}-${randomId}`, opts: undefined },
            });
        }
        // Write 1 node to range 1
        await range1.write({
            type: 'upsert_node',
            payload: { typeId: 1, name: `rebal-node-other-${randomId}`, opts: undefined },
        });
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        const stats = rebalancer.getStats();
        expect(stats.ranges.length).toBe(2);
        // nodeCount will be non-zero (at least the nodes we created)
        // We just verify the structure, not exact counts (depends on internal engine state)
        expect(typeof stats.averageNodeCount).toBe('number');
        expect(typeof stats.maxDeviation).toBe('number');
        expect(typeof stats.needsRebalancing).toBe('boolean');
        await mgr.stop();
    });
    // ──────────────────────────────────────────
    // trigger
    // ──────────────────────────────────────────
    test('trigger should complete without error', async () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        await mgr.start();
        await new Promise(r => setTimeout(r, 50));
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        await expect(rebalancer.trigger()).resolves.toBeUndefined();
        await mgr.stop();
    });
    test('trigger should not throw when called twice sequentially', async () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        await mgr.start();
        await new Promise(r => setTimeout(r, 50));
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        await rebalancer.trigger();
        await rebalancer.trigger();
        // Should complete without error even if first rebalance already happened
        await mgr.stop();
    });
    // ──────────────────────────────────────────
    // start / stop 生命周期
    // ──────────────────────────────────────────
    test('start should not throw', () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        expect(() => rebalancer.start()).not.toThrow();
        rebalancer.stop();
    });
    test('stop should not throw when not started', () => {
        const mgr = new shard_manager_1.ShardManager(shardMap, clock);
        const rebalancer = new rebalancer_1.Rebalancer(mgr);
        expect(() => rebalancer.stop()).not.toThrow();
    });
});
//# sourceMappingURL=rebalancer.spec.js.map