import { RangeInstance } from './range-instance';
import { ShardRouter } from './shard-router';
import { HlcClock } from '../replication/hlc-clock';
import { NodeId, NodeRecord, EdgeRecord, UpsertNodeOptions, UpsertEdgeOptions, VectorSearchOptions, VectorSearchResult, ShardMap } from '../types';
/**
 * ShardManager — 全局分片管理器
 *
 * 职责：
 * 1. 管理所有 RangeInstance 的生命周期
 * 2. 单 key 操作直接路由到对应 Range
 * 3. 跨 Range 操作（向量搜索）执行 fan-out
 *
 * 路由一致性：
 * - 所有节点操作统一按名称（prefixedName）路由
 * - 维护 _nodeIdToName 缓存将 NodeId 映射回名称
 * - upsertNode 写入后更新缓存
 * - getNode/deleteNode/neighbors 先查缓存，按名称路由
 * - upsertEdge 按源节点名称路由
 */
export declare class ShardManager {
    private ranges;
    private router;
    private clock;
    private shardMap;
    private telemetry;
    private metrics;
    /** nodeId → prefixedName 缓存（LRU），确保按名称路由一致性 */
    private _nodeIdToName;
    /**
     * Smart Sharding: range 亲和度计数器
     * Map<rangeId, Map<typeId, count>>
     * 统计每个 range 上各类型的数据量，用于智能路由决策
     */
    private _rangeTypeAffinity;
    constructor(shardMap: ShardMap, clock: HlcClock);
    /**
     * 根据节点 ID 获取目标 Range
     * 优先使用缓存的名称路由，回退到 String(id) 路由
     * 缓存 miss 概率很低：upsertNode 写入缓存 + 持久化 _rangeKey 到 props，
     * getNode 在每次读取后会从 _rangeKey 恢复缓存。
     */
    private _getRangeForNodeId;
    /** 获取节点名称缓存（用于测试/诊断） */
    getNodeName(id: NodeId): string | undefined;
    /** 获取亲和度计数器（用于测试/诊断） */
    getRangeAffinity(rangeId: string): Map<number, number> | undefined;
    /**
     * Smart Routing（智能路由）
     *
     * 为新节点选择最佳的 Range。
     * 如果有 Range 已经拥有该 typeId 的数据，优先选择数据最多的 Range，
     * 以尽量减少跨 Range 查询。如果没有任何 Range 有该 typeId 的数据，
     * 则回退到一致性哈希路由。
     */
    private _smartRoute;
    /** 递增指定 range 上某 typeId 的亲和度计数 */
    private _incrementAffinity;
    start(): Promise<void>;
    stop(): Promise<void>;
    getRange(rangeId: string): RangeInstance;
    getRouter(): ShardRouter;
    /** 写入节点 — 一致性哈希路由（自动添加租户前缀） */
    upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): Promise<NodeId>;
    /** 写入边 — 跟随源节点（按名称）路由 */
    upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): Promise<void>;
    /** Batch 写入多个节点 — 按 shard 分组并行写入（自动添加租户前缀） */
    batchUpsertNodes(inputs: Array<{
        typeId: number;
        name: string;
        opts?: UpsertNodeOptions;
    }>): Promise<number[]>;
    /** Batch 写入多条边 — 按源节点 shard 分组并行写入 */
    batchUpsertEdges(inputs: Array<{
        src: NodeId;
        dst: NodeId;
        typeId: number;
        opts?: UpsertEdgeOptions;
    }>): Promise<void>;
    /** 读取节点 — 按名称路由（通过 nodeId→name 缓存） */
    getNode(id: NodeId): Promise<NodeRecord | null>;
    /** 删除节点 — 按名称路由 */
    deleteNode(id: NodeId): Promise<void>;
    /** 按类型查找节点 — fan-out 到所有 Range */
    findNodesByType(typeId: number): Promise<number[]>;
    /** 按属性查找节点 — fan-out 到所有 Range */
    findNodesByProperty(typeId: number, propKey: string, propValue: unknown): Promise<number[]>;
    /** 邻居遍历 */
    neighbors(id: NodeId, opts?: {
        maxDepth?: number;
        edgeTypeFilter?: number[];
    }): Promise<{
        edges: EdgeRecord[];
        nodes: NodeRecord[];
    }>;
    /** 向量搜索 — fan-out 到所有 Range */
    vectorSearch(query: VectorSearchOptions): Promise<VectorSearchResult[]>;
    /** 图算法 — 跨所有 Range 执行 */
    personalizedPageRank(opts: {
        sourceNode: NodeId;
        topK?: number;
    }): Promise<{
        nodeId: number;
        score: number;
    }[]>;
    /** 获取分片状态 */
    getShardStatus(): {
        rangeId: string;
        raftRole: string;
        nodeCount: number;
    }[];
    /** 获取所有 Range 实例（用于 Resharding） */
    getAllRanges(): Map<string, RangeInstance>;
    /** 添加 Range（用于 Resharding 双写阶段） */
    addRange(rangeId: string, instance: RangeInstance): void;
    /** 移除 Range（用于 Resharding 清理阶段） */
    removeRange(rangeId: string): void;
    /** 重建路由表 */
    rebuildRouter(shardMap: ShardMap): void;
}
//# sourceMappingURL=shard-manager.d.ts.map