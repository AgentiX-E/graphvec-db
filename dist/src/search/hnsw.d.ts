/**
 * HNSW (Hierarchical Navigable Small World) 向量索引
 *
 * 实现标准 HNSW 算法，用于近似最近邻搜索 (ANN)。
 * 主要参数:
 * - M: 每层最大连接数 (默认 16)
 * - efConstruction: 构建时的搜索宽度 (默认 200)
 * - mL: 归一化因子，控制层数分布 (默认 1/ln(M))
 *
 * 参考: Malkov & Yashunin (2016) — "Efficient and robust approximate
 *       nearest neighbor search using Hierarchical Navigable Small World graphs"
 */
export interface HnswConfig {
    /** 每层最大连接数 (默认 16) */
    M: number;
    /** 构建时的 ef 参数 (默认 200) */
    efConstruction: number;
    /** 搜索时的 ef 参数 (默认 50) */
    efSearch: number;
    /** 归一化因子 mL = 1/ln(M) (由 M 自动计算) */
    mL: number;
    /** 距离度量 (默认 'cosine') */
    distance: 'cosine' | 'euclidean' | 'dot';
}
export interface VectorEntry {
    id: number;
    vector: Float32Array;
}
export declare class HnswIndex {
    private config;
    /** 所有插入的向量条目, id → VectorEntry */
    private entries;
    /** 每层的邻接表: layer → Map<nodeId, neighborIds[]> */
    private layers;
    /** 每层节点的额外距离缓存 (加速搜索) */
    private _maxLayer;
    /** entry point 所在层 */
    private entryPoint;
    constructor(config?: Partial<HnswConfig>);
    /** 当前索引中的向量数量 */
    get size(): number;
    /** 获取配置 */
    getConfig(): HnswConfig;
    /**
     * 插入一个向量
     */
    insert(id: number, vector: Float32Array): void;
    /**
     * 搜索 topK 个最近邻
     */
    search(query: Float32Array, topK: number): Array<{
        id: number;
        distance: number;
    }>;
    /**
     * 批量插入
     */
    batchInsert(vectors: Array<{
        id: number;
        vector: Float32Array;
    }>): void;
    /**
     * 删除单条向量
     */
    delete(id: number): boolean;
    /** 在指定层搜索 ef 个最近邻 */
    private _searchLayer;
    /** 按到目标节点的距离排序邻居列表 */
    private _sortByDistance;
    /** 随机层数 (指数分布) */
    private _randomLevel;
    /** 距离计算 */
    private _distance;
}
//# sourceMappingURL=hnsw.d.ts.map