import { NodeId, NodeRecord, EdgeRecord, UpsertNodeOptions, UpsertEdgeOptions, VectorSearchOptions, VectorSearchResult, PersonalizedPageRankOptions, ShortestPathOptions, ConnectedComponentsOptions, PatternMatchOptions, OverGraphConfig } from '../types';
import { StorageProvider } from './storage-provider';
import { type HnswConfig } from '../search/hnsw';
import { EventStream } from './event-stream';
/**
 * GraphEngine — 存储无关的图引擎核心
 *
 * 所有数据操作通过 StorageProvider 接口完成，不直接依赖任何具体存储后端。
 * 默认使用 OverGraph 后端，可切换为任何实现了 StorageProvider 的实现。
 */
export declare class GraphEngine {
    private storage;
    private config;
    private _isOpen;
    private _nodeCount;
    private _edgeCount;
    private _nodeIds;
    private _edgeKeys;
    private _labelIndex;
    private _eventStream;
    private _hnsw;
    /**
     * 可选的回调：当节点/边发生变更时被调用
     * 用于 DeltaSync 捕捉变更
     */
    onRecordChange?: (name: string, fields: Record<string, any>) => void;
    constructor(config: OverGraphConfig, storage?: StorageProvider, eventStream?: EventStream, hnswConfig?: Partial<HnswConfig>);
    /** 检查数据库是否已打开 */
    get isOpen(): boolean;
    /** 通过 EventStream（可靠）或 EventBus（fire-and-forget）发布变更事件 */
    private _emit;
    /** 打开数据库 */
    open(): void;
    /** 关闭数据库 */
    close(): void;
    /**
     * 插入或更新一个节点
     *
     * @param typeId - 节点类型 ID
     * @param name - 节点名称
     * @param opts - 可选参数（属性、向量、有效期、衰减因子、TTL）
     * @returns 新插入或已有节点的 ID
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): NodeId;
    /**
     * 根据节点 ID 获取节点记录
     *
     * @param id - 节点 ID
     * @returns NodeRecord 或 null（节点不存在时）
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    getNode(id: NodeId): NodeRecord | null;
    /**
     * 删除指定 ID 的节点
     *
     * @param id - 要删除的节点 ID
     * @returns true 如果节点存在且被删除，false 如果节点不存在
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    deleteNode(id: NodeId): boolean;
    /**
     * 批量插入或更新多个节点
     *
     * @param inputs - 节点输入数组
     * @returns 节点名称到 ID 的映射表
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    batchUpsertNodes(inputs: {
        typeId: number;
        name: string;
        opts?: UpsertNodeOptions;
    }[]): Record<string, NodeId>;
    /**
     * 插入或更新一条边
     *
     * @param src - 源节点 ID
     * @param dst - 目标节点 ID
     * @param typeId - 边类型 ID
     * @param opts - 可选参数
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: UpsertEdgeOptions): void;
    /**
     * 获取指定边的记录
     *
     * @param src - 源节点 ID
     * @param dst - 目标节点 ID
     * @param typeId - 边类型 ID
     * @returns EdgeRecord 或 null（边不存在时）
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    getEdge(src: NodeId, dst: NodeId, typeId: number): EdgeRecord | null;
    /**
     * 删除指定边
     *
     * @param src - 源节点 ID
     * @param dst - 目标节点 ID
     * @param typeId - 边类型 ID
     * @returns true 如果边存在且被删除
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean;
    /**
     * 获取指定节点的所有邻居
     *
     * @param id - 节点 ID
     * @param opts - 可选参数（maxDepth, edgeTypeFilter）
     * @returns 包含 edges 和 nodes 数组的对象
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    neighbors(id: NodeId, opts?: {
        maxDepth?: number;
        edgeTypeFilter?: number[];
    }): {
        edges: EdgeRecord[];
        nodes: NodeRecord[];
    };
    /**
     * 向量搜索
     *
     * @param query - 搜索参数
     * @returns 按分数降序排列的搜索结果数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    vectorSearch(query: VectorSearchOptions): VectorSearchResult[];
    /**
     * 个性化 PageRank
     *
     * @param opts - 算法参数
     * @returns 节点 ID 和对应分数的数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    personalizedPageRank(opts: PersonalizedPageRankOptions): {
        nodeId: number;
        score: number;
    }[];
    /**
     * 计算两点之间的所有最短路径
     *
     * @param opts - 路径参数
     * @returns 路径数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    allShortestPaths(opts: ShortestPathOptions): {
        path: number[];
        cost: number;
    }[];
    /**
     * 计算连通分量
     *
     * @param opts - 可选参数
     * @returns 连通分量数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    connectedComponents(opts?: ConnectedComponentsOptions): number[][];
    /**
     * 模式匹配
     *
     * @param opts - 匹配参数
     * @returns 匹配的节点记录数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    queryPattern(opts: PatternMatchOptions): NodeRecord[];
    /**
     * 按节点类型查找所有节点 ID
     *
     * @param typeId - 节点类型 ID
     * @returns 该类型的所有节点 ID 数组
     */
    findNodesByType(typeId: number): number[];
    /**
     * 按节点属性查找节点 ID
     *
     * @param typeId - 节点类型 ID
     * @param propKey - 属性键名
     * @param propValue - 属性值
     * @returns 匹配的节点 ID 数组
     */
    findNodesByProperty(typeId: number, propKey: string, propValue: unknown): number[];
    /**
     * 执行存储引擎压缩
     */
    compact(): void;
    /**
     * 获取引擎统计信息
     *
     * @returns 包含节点数、边数和磁盘占用字节的对象
     */
    stats(): {
        nodeCount: number;
        edgeCount: number;
        diskSizeBytes: number;
    };
    /**
     * 导出当前数据快照
     *
     * @returns 快照数据的 Buffer
     */
    exportSnapshot(): Buffer;
    /**
     * 导入快照数据
     *
     * @param data - 之前由 exportSnapshot() 导出的快照数据
     */
    importSnapshot(data: Buffer): void;
    private _ensureOpen;
}
//# sourceMappingURL=graph-engine.d.ts.map