import { ShardMap, ReshardingPlan, ReshardSplit } from '../types';
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
export declare class ReshardPlan {
    /**
     * 生成 Resharding 计划
     * @returns ReshardingPlan | null（null = 无需 Resharding）
     */
    generatePlan(shardMap: ShardMap, ranges: {
        rangeId: string;
        nodeCount: number;
        opsPerSec?: number;
    }[], threshold?: {
        maxNodes?: number;
        maxOpsPerSec?: number;
    }): ReshardingPlan | null;
    /**
     * 估算迁移成本
     */
    estimateCost(split: ReshardSplit, sourceNodeCount: number): {
        estimatedBytes: number;
        estimatedDurationMs: number;
    };
}
//# sourceMappingURL=reshard-plan.d.ts.map