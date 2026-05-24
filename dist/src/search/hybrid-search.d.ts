/**
 * Hybrid Search — BM25 全文 + HNSW 向量融合搜索
 *
 * 支持两种融合策略:
 * - RRF (Reciprocal Rank Fusion): 基于排名的融合
 * - Weighted Sum: 加权分数融合
 */
import { HnswIndex } from './hnsw';
export interface HybridSearchQuery {
    /** 文本查询 (用于 BM25) */
    text?: string;
    /** 向量查询 (用于 HNSW) */
    vector?: Float32Array;
    /** 融合策略 (默认 'rrf') */
    strategy?: 'rrf' | 'weighted';
    /** RRF 常数 k (默认 60) */
    rrfK?: number;
    /** 向量搜索权重 (weighted 策略用, 默认 0.5) */
    vectorWeight?: number;
    /** 文本搜索权重 (weighted 策略用, 默认 0.5) */
    textWeight?: number;
    /** 返回 topK 结果 (默认 10) */
    topK?: number;
}
export interface HybridSearchResult {
    id: number;
    score: number;
    textScore: number;
    vectorScore: number;
}
/**
 * 如果传入 BM25 和 HNSW 索引，执行 hybrid 融合搜索。
 *
 * @param hnsw - HNSW 索引 (可选)
 * @param bm25Search - BM25 搜索函数 (text: string, topK: number) => Array<{id: number; score: number}>
 * @param query - 搜索参数
 * @returns 融合后的结果列表
 */
export declare function hybridSearch(hnsw: HnswIndex | null, bm25Search: ((text: string, topK: number) => Array<{
    id: number;
    score: number;
}>) | null, query: HybridSearchQuery): HybridSearchResult[];
//# sourceMappingURL=hybrid-search.d.ts.map