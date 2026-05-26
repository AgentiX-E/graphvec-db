/**
 * ScatterGather — 跨分片 scatter-gather 查询
 *
 * 将查询广播到所有 Range 实例，收集结果后合并。
 * 用于跨分片查询：向量搜索、全文搜索、图算法等。
 */
import type { RangeInstance } from './range-instance';
import type { NodeRecord, VectorSearchOptions, VectorSearchResult } from '../types';
export interface ScatterGatherOptions {
    timeoutMs?: number;
}
export declare class ScatterGather {
    private _getRanges;
    constructor(getRanges: () => RangeInstance[]);
    /**
     * 向量搜索 — 广播到所有 Range
     */
    vectorSearch(query: VectorSearchOptions, options?: ScatterGatherOptions): Promise<VectorSearchResult[]>;
    /**
     * 获取所有节点（带可选分页）
     */
    getAllNodes(page?: number, pageSize?: number): Promise<Array<{
        id: number;
        record: NodeRecord;
    }>>;
    /**
     * 跨分片个性化 PageRank
     *
     * 多 range 的 PPR 结果合并：
     * 1. 每个 range 内部归一化（概率分布和为 1）
     * 2. 按 range 节点数加权合并
     * 3. 排序取 topK
     */
    personalizedPageRank(opts: {
        sourceNode: number;
        k?: number;
    }): Promise<Array<{
        nodeId: number;
        score: number;
    }>>;
}
//# sourceMappingURL=scatter-gather.d.ts.map