/**
 * GraphAlgorithms — 跨 Range 图算法模块
 *
 * 提供基于内存遍历的图算法实现，支持 PPR、双向 BFS、Union-Find 连通分量、Dijkstra。
 * crossRangeMode='fan-out' 时可通过 shardRouter 进行跨 Range 查询。
 *
 * 适用场景：
 * - 在单 Range 或跨 Range 模式下运行标准图算法
 * - 不依赖底层存储引擎的图算法
 */
export interface AlgorithmConfig {
    /** 最大迭代次数 */
    maxIterations?: number;
    /** 收敛阈值 */
    convergenceThreshold?: number;
    /** 跨 Range 模式 */
    crossRangeMode?: 'single' | 'fan-out';
    /** 用于跨 Range 的 shardRouter 回掉 */
    shardRouter?: {
        routeNode(nodeId: number): string;
        fanOut(op: string, payload: unknown): Promise<unknown[]>;
    };
}
interface NeighborResult {
    edge: {
        src: number;
        dst: number;
        type?: number;
    };
    node: {
        id: number;
        [key: string]: unknown;
    } | null;
}
interface EngineLike {
    getNode(id: number): {
        id: number;
        [key: string]: unknown;
    } | null;
    neighbors(id: number): NeighborResult[];
    upsertNode(...args: unknown[]): number;
    upsertEdge(...args: unknown[]): void;
}
interface DijkstraEntry {
    distance: number;
    path: number[];
}
export declare class GraphAlgorithms {
    private engine;
    private config;
    constructor(engine: EngineLike, config?: AlgorithmConfig);
    /**
     * 个性化 PageRank — 从 sourceId 出发的 PPR 分数
     *
     * 使用幂迭代法计算 PPR。每次迭代收集当前可抵达的所有节点，
     * 按公式分配分数，直到收敛或达到最大迭代次数。
     *
     * @param sourceId 源节点 ID
     * @param alpha    随机游走中重置概率（默认 0.85）
     * @param topK     返回的 topK 结果数（默认 10）
     * @returns Map<nodeId, rankScore>
     * @remarks 当配置了 shardRouter 且 crossRangeMode='fan-out' 时，
     * 会通过 `_collectReachableCrossRange` 收集远程节点信息。
     * 但跨 Range 的 PPR 分数是近似值，因为幂迭代需要在所有节点间同步状态。
     * 精确的跨 Range PPR 需要后续迭代优化。
     */
    ppr(sourceId: number, alpha?: number, topK?: number): Map<number, number>;
    /**
     * 双向 BFS 最短路径
     *
     * 同时从 source 和 target 出发展开搜索，每次扩展较小的 frontier，
     * 在相遇时重建完整路径。
     *
     * @param sourceId 起始节点 ID
     * @param targetId 目标节点 ID
     * @returns nodeId 数组（含两端），如不可达则返回 null
     * @remarks 当配置了 shardRouter 且 crossRangeMode='fan-out' 时，
     * 在本地 BFS 耗尽 frontier 后会 fan-out 收集远程节点的邻居。
     * 跨 Range 路径可能不是全局最优，因为远程 Range 返回的邻居信息
     * 受限于各 Range 的本地视图。
     */
    shortestPath(sourceId: number, targetId: number): number[] | null;
    /**
     * 连通分量标记（Union-Find）
     *
     * 遍历所有节点与边，使用并查集合并同一连通分量中的节点。
     *
     * @returns Map<nodeId, componentRoot>
     */
    connectedComponents(): Map<number, number>;
    /**
     * 单源最短路径（Dijkstra）
     *
     * 计算从 sourceId 到所有可达节点的最短路径距离。
     * 可选边权重字段。
     *
     * @param sourceId    源节点 ID
     * @param weightField 边属性中的权重字段名（可选，默认等权=1）
     * @returns Map<nodeId, { distance, path }>
     * @remarks 当配置了 shardRouter 且 crossRangeMode='fan-out' 时，
     * 会在本地松弛步骤结束后 fan-out 收集远程节点邻居信息，
     * 以支持跨 Range 最短路径发现。跨 Range 路径的构建受限于
     * 各 Range 的本地视图可见性。
     */
    dijkstra(sourceId: number, weightField?: string): Map<number, DijkstraEntry>;
    /** 检查是否启用了跨 Range fan-out 模式 */
    private _isCrossRangeEnabled;
    /**
     * 收集从给定节点出发可到达的所有节点（本地 BFS）
     */
    private _collectReachable;
    /**
     * 收集从给定节点出发可到达的所有节点（跨 Range 版本）
     *
     * 在本地 BFS 遍历完成后，通过 engine.neighbors() 再次扫描
     * 已发现的节点，以捕获通过存储层 bridge 注入的跨 Range 邻居。
     *
     * @remarks 跨 Range 节点收集是"尽力而为"的——依赖于存储层
     * 将远程邻居注入到 engine.neighbors() 返回值中。
     */
    private _collectReachableCrossRange;
    /**
     * BFS 单层扩展
     * @param queue   当前层队列
     * @param myParent 本方 parent 映射
     * @param otherParent 对方 parent 映射
     * @param isForward 是否为前向搜索
     * @param visited 全局已访问集合
     * @returns 相遇节点 ID，或 null
     */
    private _bfsExpand;
    /**
     * 跨 Range BFS 扩展
     *
     * 当一方 frontier 耗尽时，从对侧已发现的节点中取节点，
     * 通过 engine.neighbors() 获取其远程邻居（需存储层 bridge 注入），
     * 并将新节点注入到本方队列中。
     *
     * @param sourceQueue     本方的 frontier 队列（将被填充）
     * @param myParent        本方 parent 映射（将被写入）
     * @param otherParent     对方 parent 映射（用于相遇检测）
     * @param targetQueue     要填充的队列引用
     * @param visited         全局访问集合
     */
    private _fanOutExpand;
    /**
     * 重建双向 BFS 路径
     */
    private _reconstructPath;
    /**
     * 重建 Dijkstra 路径
     */
    private _buildPath;
}
export {};
//# sourceMappingURL=graph-algorithms.d.ts.map