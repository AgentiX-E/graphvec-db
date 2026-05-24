"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReshardPlan = void 0;
/**
 * ReshardPlan — 分片计划生成器
 *
 * 扫描所有 Range 的大小和负载，决定是否需要拆分
 * 触发条件：
 * - Range 节点数 > 10,000（可配）
 * - 吞吐量 > 10K ops/s（可配）
 *
 * 计划生成：
 * 1. 对超过阈值的 Range 进行 split
 * 2. 在一致性哈希环插入新虚拟节点
 * 3. 计算数据范围
 */
class ReshardPlan {
    /**
     * 生成 Resharding 计划
     * @returns ReshardingPlan | null（null = 无需 Resharding）
     */
    generatePlan(shardMap, ranges, threshold = {}) {
        const maxNodes = threshold.maxNodes ?? 10000;
        const splits = [];
        for (const r of ranges) {
            if (r.nodeCount > maxNodes || (r.opsPerSec && r.opsPerSec > (threshold.maxOpsPerSec ?? 10000))) {
                // 此 Range 需要拆分
                const targetRangeId = `${r.rangeId}-split-${Date.now()}`;
                splits.push({
                    sourceRangeId: r.rangeId,
                    targetRangeId,
                    hashRangeStart: 0,
                    hashRangeEnd: Math.floor(2147483647 / (splits.length + 1)),
                    targetNodeId: `node-${targetRangeId}`,
                    targetDataDir: `./data/${targetRangeId}`,
                });
            }
        }
        if (splits.length === 0)
            return null;
        return {
            planId: `plan-${Date.now()}`,
            version: shardMap.version + 1,
            splits,
            createdAt: Date.now(),
            estimatedDurationMs: splits.length * 30000, // ~30s per split
        };
    }
    /**
     * 估算迁移成本
     */
    estimateCost(split, sourceNodeCount) {
        // 假设每个节点 ~200 bytes (包括向量)
        const avgNodeSize = 200;
        const targetNodes = Math.floor(sourceNodeCount / 2); // 近似
        return {
            estimatedBytes: targetNodes * avgNodeSize,
            estimatedDurationMs: targetNodes * 0.5, // ~0.5ms per node
        };
    }
}
exports.ReshardPlan = ReshardPlan;
//# sourceMappingURL=reshard-plan.js.map