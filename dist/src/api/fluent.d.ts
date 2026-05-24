import { ShardManager } from '../shard/shard-manager';
import { NodeRecord } from '../types';
/**
 * GraphQuery — 流式图查询接口
 *
 * 支持链式调用：match → where → neighbors → return
 * 内部维护查询状态，return() 最终执行查询，调用 ShardManager 接口。
 *
 * 使用示例：
 *   const q = new GraphQuery(manager)
 *   const nodes = await q.match(1).where(n => n.name.startsWith('A')).neighbors(2).return()
 */
export declare class GraphQuery {
    private manager;
    private currentTypeId;
    private predicates;
    private maxDepth;
    private edgeFilter;
    private limit_;
    private skip_;
    private orderField_;
    private orderDir_;
    private projectFields_;
    private vector_;
    /**
     * 是否启用查询优化器（QueryIR）。
     * 启用后，execute() 会通过 QueryIR (buildIRFromSpec → optimizeIR → executeIR) 执行。
     * 默认禁用以保持向后兼容。
     */
    private useOptimizer_;
    constructor(manager: ShardManager);
    /**
     * 启用或禁用查询优化器
     * @param enabled 是否启用
     */
    enableOptimizer(enabled?: boolean): GraphQuery;
    /**
     * 设置节点类型过滤（起点）
     */
    match(typeId?: number): GraphQuery;
    /**
     * 条件过滤（AND 语义，可多次调用）
     */
    where(predicate: (node: NodeRecord) => boolean): GraphQuery;
    /**
     * 遍历邻居节点
     * @param depth 遍历深度（默认 1）
     * @param edgeTypeFilter 边类型过滤
     */
    neighbors(depth?: number, edgeTypeFilter?: number[]): GraphQuery;
    /**
     * 限制返回数量
     */
    limit(n: number): GraphQuery;
    /**
     * 跳过前 n 个结果
     */
    skip(n: number): GraphQuery;
    /**
     * 自定义属性投影（只保留指定字段）
     */
    project(fields: string[]): GraphQuery;
    /**
     * 排序
     * @param field 排序字段（支持 name、id、createdAt、或 props 中的字段）
     * @param direction 排序方向
     */
    orderBy(field: string, direction?: 'asc' | 'desc'): GraphQuery;
    /**
     * 向量相似度搜索
     * @param vector 查询向量
     * @param k 返回 Top-K 结果
     */
    vectorSimilarity(vector: number[], k?: number): GraphQuery;
    /**
     * 执行查询并返回节点结果
     */
    return(): Promise<NodeRecord[]>;
    /**
     * 执行查询并返回计数
     */
    count(): Promise<number>;
    /**
     * 输出当前查询的调试表示
     */
    toString(): string;
    /**
     * plan — 输出当前查询的优化计划（EXPLAIN），不实际执行
     *
     * 使用 QueryIR 构建计划树，应用优化，然后返回可读的计划描述。
     * 适用于调试、性能分析、查询调优。
     *
     * @returns 查询计划的可读字符串描述
     */
    plan(): string;
    /**
     * 构建当前查询的 QuerySpec（供 IR 使用）
     */
    private buildQuerySpec;
    /**
     * 内部执行逻辑
     *
     * 当 useOptimizer_ 启用时，通过 QueryIR 执行：
     *   buildIRFromSpec → optimizeIR → executeIR
     *
     * 未启用时，保持原始执行路径。
     *
     * 流程（原始路径）：
     * 1. 如果是向量搜索路径（有 vector_），优先做向量搜索
     * 2. 如果是 match(typeId) 路径，从存储中按 typeId 获取所有节点
     * 3. 邻居遍历（如果设置了 maxDepth）
     * 4. 应用 predicates（AND 过滤）
     * 5. 排序（orderBy）
     * 6. Skip & Limit
     * 7. 投影（project）
     */
    private execute;
    /**
     * 邻居展开：从当前节点集出发，按 maxDepth 展开邻居
     */
    private expandNeighbors;
    /**
     * 递归收集邻居
     */
    private collectNeighbors;
    /**
     * 扫描所有 Range 获取候选节点
     *
     * 标记为 protected 以便测试时通过继承覆盖。
     * 产品中可以通过注入外部扫描器或通过 PatternMatch API 实现。
     */
    protected scanAllRanges(): Promise<NodeRecord[]>;
    /**
     * 应用排序
     */
    private applyOrder;
    /**
     * 从节点中解析字段值（支持 props 中的嵌套字段）
     */
    private resolveField;
    /**
     * 应用投影：只保留指定字段
     */
    private applyProjection;
}
//# sourceMappingURL=fluent.d.ts.map