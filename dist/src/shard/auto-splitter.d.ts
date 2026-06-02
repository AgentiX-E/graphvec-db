/**
 * AutoSplitter — 自动 Range 分裂触发器
 *
 * 定期检查 Range 数据量，当超过阈值时自动生成 split 计划并执行。
 *
 * 设计原则:
 * - 无侵入：通过 shardManager 检测，Splitter 只触发不执行迁移
 * - 可配置：maxNodesPerRange、checkIntervalMs
 * - 安全：预留 min check 间隔，避免 split 风暴
 */
import type { RangeInstance } from './range-instance';
export interface AutoSplitterConfig {
    /** 每个 Range 的最大节点数阈值（默认 100000） */
    maxNodesPerRange?: number;
    /** 检查间隔（毫秒，默认 30000 = 30s） */
    checkIntervalMs?: number;
    /** 最小分裂间隔（毫秒，同一个 Range 两次 split 之间，默认 60000 = 1min） */
    minSplitIntervalMs?: number;
    /** 每个检查周期最大分裂次数，超过此数则跳过后续 split（默认 2，防止 split 风暴） */
    maxSplitsPerCycle?: number;
}
/**
 * SplitSuggestion — AutoSplitter 传递给外部 ReshardManager 的 split 建议
 *
 * 包含触发原因、当前负载和建议的分片数量，使 ReshardManager 无需二次计算即可决策。
 */
export interface SplitSuggestion {
    rangeId: string;
    nodeCount: number;
    edgeCount: number;
    diskSizeBytes: number;
    suggestedSplitKey?: number;
    suggestedTargetCount: number;
    reason: string;
}
/**
 * ReshardCallback — 触发 rebalance 的回调签名
 * - suggestion 可选：传递时不破坏向后兼容，ReshardManager 可选择忽略或使用建议。
 */
export type ReshardCallback = (suggestion?: SplitSuggestion) => void;
export declare class AutoSplitter {
    private _config;
    private _getRangeInstances;
    private _onReshard;
    private _timer;
    private _lastSplit;
    private _running;
    constructor(getRangeInstances: () => RangeInstance[], onReshard: ReshardCallback, config?: AutoSplitterConfig);
    /** 启动自动分裂检查 */
    start(): void;
    /** 停止自动分裂检查 */
    stop(): void;
    get running(): boolean;
    /** 立即执行一次检查 */
    checkNow(): Promise<number>;
    private _check;
}
//# sourceMappingURL=auto-splitter.d.ts.map