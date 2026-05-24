import { ShardManager } from './shard-manager';
export interface RebalancerOptions {
    checkIntervalMs?: number;
    nodeCountDeviationThreshold?: number;
    loadFactorThreshold?: number;
}
export interface RangeLoad {
    rangeId: string;
    nodeCount: number;
    edgeCount: number;
    operationCount: number;
}
export interface RebalancerStats {
    ranges: RangeLoad[];
    averageNodeCount: number;
    averageOperationCount: number;
    maxDeviation: number;
    maxLoadFactor: number;
    needsRebalancing: boolean;
    lastRebalance: number | null;
}
/**
 * Rebalancer — 自动范围重平衡
 *
 * 通过对所有 Range 定期采集负载统计，检测节点数偏差或负载不均衡，
 * 将节点从负载超标的源 Range 迁移到负载最低的目标 Range。
 *
 * 安全保证：
 * - 🔴 S10: 节点迁移时同时迁移关联边，防止边断裂
 * - 🔴 S11: 迁移期间设置 draining 标记，拒绝新的写入，防止"先写后删"窗口期数据丢失
 */
export declare class Rebalancer {
    private manager;
    private logger;
    private options;
    private timerId;
    private rebalancing;
    private _lastRebalance;
    private _opCounts;
    constructor(manager: ShardManager, options?: RebalancerOptions);
    /** 启动自动检查 */
    start(): void;
    /** 停止 */
    stop(): void;
    /** 手动触发一次 rebalance */
    trigger(): Promise<void>;
    /** 获取当前负载统计 */
    getStats(): RebalancerStats;
    /** 采集所有 Range 的统计信息 */
    private _collectLoads;
    private _checkAndRebalance;
    /**
     * 执行重平衡
     *
     * 算法：
     * 1. 采集所有 Range 负载
     * 2. 找出节点数最多的源 Range（按节点数降序）
     * 3. 找出节点数最少的目标 Range
     * 4. 获取节点数最多的 Range 中超过平均值的节点
     * 5. 逐个迁移节点
     */
    private _doRebalance;
    /** 检查节点数是否已平衡（所有 range 偏差在阈值内） */
    private _isNodeCountBalanced;
    /**
     * 找出指定 Range 中最热的节点
     * 这里的"热"通过 operationCount 判断，但实际场景中我们不具备每个节点的 op count。
     * 作为简化实现，我们用节点 ID 的哈希值（均匀分布假设）来选择最靠近末尾的节点。
     */
    private _findHotNodes;
    /**
     * 执行节点迁移：从源 Range 迁移指定节点到目标 Range
     *
     * 安全保证：
     * 🔴 S11: 迁移前设置源 Range draining，拒绝新的写入，防止窗口期数据丢失
     * 🔴 S10: 迁移节点时同时迁移关联边
     *
     * 流程：
     * 1. 设置源 Range draining=true
     * 2. 逐个迁移节点（带关联边）
     * 3. 解除源 Range draining
     */
    private _doRebalanceNodes;
    /**
     * 迁移单个节点 + 关联边到目标 Range（S10 修复）
     *
     * 只做"写入目标"部分。删除源由 _migrateCleanup 完成。
     *
     * 流程：
     * 1. 从源 Range 读取节点数据
     * 2. 从源 Range 读取所有 outgoing edges
     * 3. 写入目标 Range（节点 + 边）
     * 4. 验证写入成功
     */
    private _migrateNode;
    /**
     * 清理源 Range 的已迁移节点（在 draining 解除后执行）
     *
     * 先删除边再删除节点，防止级联删除不完整
     */
    private _migrateCleanup;
}
//# sourceMappingURL=rebalancer.d.ts.map