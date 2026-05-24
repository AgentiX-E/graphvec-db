import { ShardManager } from '../shard/shard-manager';
import { NodeRecord } from '../types';
export declare enum PlanNodeType {
    SCAN = "scan",
    FILTER = "filter",
    NEIGHBORS = "neighbors",
    INDEX_LOOKUP = "index_lookup",
    LIMIT = "limit",
    SORT = "sort",
    PROJECT = "project",
    VECTOR_SEARCH = "vector_search",
    JOIN = "join",
    AGGREGATE = "aggregate",
    SHORTEST_PATH = "shortest_path",
    PERSONALIZED_PAGE_RANK = "personalized_page_rank",
    CONNECTED_COMPONENTS = "connected_components",
    PARALLEL_UNION = "parallel_union"
}
export interface PlanNode {
    type: PlanNodeType;
    estimatedCost: number;
    estimatedRows: number;
    children: PlanNode[];
    details: Record<string, unknown>;
}
export interface ExecutionStats {
    totalRows: number;
    elapsedMs: number;
    nodesScanned: number;
}
export interface ColumnStat {
    columnName: string;
    distinctCount: number;
    nullCount: number;
    minValue?: unknown;
    maxValue?: unknown;
}
export interface TableStats {
    rowCount: number;
    columnStats: Map<string, ColumnStat>;
}
export declare class QueryPlanner {
    private shardManager;
    private stats;
    constructor(shardManager: ShardManager);
    /**
     * 构建查询计划
     */
    plan(query: {
        typeId?: number;
        predicates?: Array<{
            field: string;
            op: string;
            value: unknown;
        }>;
        neighbors?: {
            depth: number;
            edgeFilter?: number[];
        };
        limit?: number;
        orderBy?: {
            field: string;
            dir: 'asc' | 'desc';
        };
        project?: string[];
        useIndex?: string;
    }): PlanNode;
    /**
     * 输出 EXPLAIN 形式的计划描述
     */
    explain(query: {
        typeId?: number;
        predicates?: Array<{
            field: string;
            op: string;
            value: unknown;
        }>;
        neighbors?: {
            depth: number;
            edgeFilter?: number[];
        };
        limit?: number;
        orderBy?: {
            field: string;
            dir: 'asc' | 'desc';
        };
        project?: string[];
    }): string;
    /**
     * 估算谓词选择性
     */
    estimateSelectivity(columnStats: ColumnStat | undefined, op: string, value: unknown): number;
    /**
     * 优化计划树——下推过滤条件
     */
    pushDownFilter(plan: PlanNode): PlanNode;
    /**
     * 选择最佳索引
     */
    chooseIndex(predicates: Array<{
        field: string;
        op: string;
        value: unknown;
    }>, availableIndexes: string[]): string | null;
    /**
     * 完整优化——应用所有规则
     */
    optimize(query: {
        typeId?: number;
        predicates?: Array<{
            field: string;
            op: string;
            value: unknown;
        }>;
        neighbors?: {
            depth: number;
            edgeFilter?: number[];
        };
        limit?: number;
        orderBy?: {
            field: string;
            dir: 'asc' | 'desc';
        };
        project?: string[];
        useIndex?: string;
    }): PlanNode;
    /**
     * 收集统计信息
     */
    collectStats(): Promise<void>;
    getStats(): Map<string, TableStats>;
    private buildPlanTree;
    private assignCosts;
    private calculateNodeCost;
    private formatExplain;
    private estimateEqualitySelectivity;
    private estimateRangeSelectivity;
    private estimatePrefixSelectivity;
}
/**
 * QuerySpec — Fluent API 与 QueryIR 之间的标准化接口
 * 描述一次完整的查询意图
 */
export interface QuerySpec {
    match?: {
        typeId?: number;
        name?: string;
    };
    where?: Record<string, any>;
    predicates?: Array<(node: NodeRecord) => boolean>;
    return?: string[];
    orderBy?: {
        field: string;
        direction: 'asc' | 'desc';
    };
    limit?: number;
    skip?: number;
    neighbors?: {
        id: number;
        edgeType?: number;
        maxDepth?: number;
    };
    vectorSearch?: {
        vector: number[];
        topK: number;
    };
}
/**
 * buildIRFromSpec — 将 Fluent API 的 QuerySpec 转换为 Planner 可优化的计划树
 *
 * 转换规则：
 * - match → SCAN（带 typeId）
 * - where → FILTER（带 predicates，或转换为 Record 过滤）
 * - neighbors → NEIGHBORS
 * - orderBy → SORT
 * - limit / skip → LIMIT（skip 合并到 limit 节点中）
 * - return → PROJECT（字段投影）
 * - vectorSearch → VECTOR_SEARCH
 */
export declare function buildIRFromSpec(spec: QuerySpec): PlanNode;
/**
 * limitPushdown — 如果 LIMIT 节点的下级是 SCAN 或 NEIGHBORS，
 * 将 limit 值推入 SCAN/NEIGHBORS 的 details 中。
 * 对 LIMIT → SORT → SCAN 链同样有效：会将 limit 下推到 SCAN。
 */
export declare function limitPushdown(plan: PlanNode): PlanNode;
/**
 * optimizeIR — 应用已知的优化规则
 *
 * 优化流程：
 * 1. pushDownFilter — 将 FILTER 推入 SCAN/NEIGHBORS
 * 2. limitPushdown — 将 LIMIT 推入 SCAN/NEIGHBORS 作为早期截断
 * 3. predicatePushdown — 将 WHERE 条件压入扫描层
 * 4. eliminateDeadBranches — 消除不可能产生结果的节点
 */
export declare function optimizeIR(plan: PlanNode): PlanNode;
/**
 * executeIR — 执行优化后的计划树
 *
 * 按照计划树从叶子到根的顺序执行各个节点。
 * 通过 ShardManager 与图存储交互。
 *
 * 支持的节点类型：
 * - SCAN: 按 typeId 扫描节点
 * - NEIGHBORS: 获取邻居节点
 * - FILTER: 对已加载的结果应用谓词过滤
 * - SORT: 按字段排序
 * - LIMIT: 截断结果（含 skip）
 * - PROJECT: 字段投影
 * - VECTOR_SEARCH: 向量相似度搜索
 */
export declare function executeIR(plan: PlanNode, shardManager: ShardManager, fnPredicates?: Array<(node: NodeRecord) => boolean>): Promise<NodeRecord[]>;
/**
 * formatPlanExplain — 将 PlanNode 树格式化为可读的 EXPLAIN 字符串
 * 供 Fluent API 的 plan() 方法使用
 */
export declare function formatPlanExplain(node: PlanNode, depth?: number): string;
//# sourceMappingURL=query-planner.d.ts.map