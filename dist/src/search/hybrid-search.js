"use strict";
/**
 * Hybrid Search — BM25 全文 + HNSW 向量融合搜索
 *
 * 支持两种融合策略:
 * - RRF (Reciprocal Rank Fusion): 基于排名的融合
 * - Weighted Sum: 加权分数融合
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hybridSearch = hybridSearch;
/**
 * 如果传入 BM25 和 HNSW 索引，执行 hybrid 融合搜索。
 *
 * @param hnsw - HNSW 索引 (可选)
 * @param bm25Search - BM25 搜索函数 (text: string, topK: number) => Array<{id: number; score: number}>
 * @param query - 搜索参数
 * @returns 融合后的结果列表
 */
function hybridSearch(hnsw, bm25Search, query) {
    const topK = query.topK ?? 10;
    const strategy = query.strategy ?? 'rrf';
    const rrfK = query.rrfK ?? 60;
    const vectorWeight = query.vectorWeight ?? 0.5;
    const textWeight = query.textWeight ?? 0.5;
    // 并行获取两部分结果
    const fetchSize = topK * 3; // 多取一些确保融合后有足够结果
    let vectorResults = [];
    let textResults = [];
    if (hnsw && query.vector) {
        const hits = hnsw.search(query.vector, fetchSize);
        // 归一化 distance → score (0~1)
        const maxDist = hits.length > 0 ? Math.max(...hits.map(h => h.distance), 1) : 1;
        vectorResults = hits.map(h => ({ id: h.id, score: 1 - h.distance / maxDist }));
    }
    if (bm25Search && query.text && query.text.length > 0) {
        textResults = bm25Search(query.text, fetchSize);
        // BM25 score 通常不是 0~1, 归一化
        const maxScore = textResults.length > 0 ? Math.max(...textResults.map(r => r.score), 1) : 1;
        textResults = textResults.map(r => ({ id: r.id, score: r.score / maxScore }));
    }
    // 如果只有一种结果，直接返回
    if (vectorResults.length === 0) {
        return textResults.slice(0, topK).map(r => ({ id: r.id, score: r.score, textScore: r.score, vectorScore: 0 }));
    }
    if (textResults.length === 0) {
        return vectorResults.slice(0, topK).map(r => ({ id: r.id, score: r.score, textScore: 0, vectorScore: r.score }));
    }
    // 构建 id → score 映射
    const vectorMap = new Map(vectorResults.map(r => [r.id, r.score]));
    const textMap = new Map(textResults.map(r => [r.id, r.score]));
    // 构建 id → rank 映射
    const vectorRank = new Map(vectorResults.map((r, i) => [r.id, i + 1]));
    const textRank = new Map(textResults.map((r, i) => [r.id, i + 1]));
    // 收集所有唯一的 ID
    const allIds = new Set();
    for (const r of vectorResults)
        allIds.add(r.id);
    for (const r of textResults)
        allIds.add(r.id);
    const results = [];
    for (const id of allIds) {
        const vr = vectorMap.get(id) ?? 0;
        const tr = textMap.get(id) ?? 0;
        const vRank = vectorRank.get(id) ?? Infinity;
        const tRank = textRank.get(id) ?? Infinity;
        let score;
        if (strategy === 'rrf') {
            // RRF: score = sum(1 / (k + rank))
            const rrfScore = (vRank !== Infinity ? 1 / (rrfK + vRank) : 0) +
                (tRank !== Infinity ? 1 / (rrfK + tRank) : 0);
            score = rrfScore;
        }
        else {
            // Weighted sum
            score = vr * vectorWeight + tr * textWeight;
        }
        results.push({ id, score, textScore: tr, vectorScore: vr });
    }
    // 按分数降序排列
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
//# sourceMappingURL=hybrid-search.js.map