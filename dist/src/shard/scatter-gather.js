"use strict";
/**
 * ScatterGather — 跨分片 scatter-gather 查询
 *
 * 将查询广播到所有 Range 实例，收集结果后合并。
 * 用于跨分片查询：向量搜索、全文搜索、图算法等。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScatterGather = void 0;
class ScatterGather {
    _getRanges;
    constructor(getRanges) {
        this._getRanges = getRanges;
    }
    /**
     * 向量搜索 — 广播到所有 Range
     */
    async vectorSearch(query, options) {
        const ranges = this._getRanges();
        const results = await Promise.all(ranges.map(async (range) => {
            try {
                // 通过 Raft 读确保线性一致性
                return await range.read(engine => engine.vectorSearch(query));
            }
            catch {
                return [];
            }
        }));
        // 合并
        const merged = results.flat();
        merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        return merged.slice(0, query.k ?? 10);
    }
    /**
     * 获取所有节点（带可选分页）
     */
    async getAllNodes(page = 0, pageSize = 100) {
        const ranges = this._getRanges();
        const results = await Promise.all(ranges.map(range => range.read(engine => {
            // 简单扫描
            const nodes = [];
            // 获取所有节点 (存储层假设有 scanNodes)
            const allIds = engine['_nodeIds'];
            if (allIds) {
                for (const id of allIds) {
                    const rec = engine.getNode(id);
                    if (rec)
                        nodes.push({ id, record: rec });
                }
            }
            return nodes;
        })));
        const all = results.flat();
        const start = page * pageSize;
        return all.slice(start, start + pageSize);
    }
    /**
     * 跨分片个性化 PageRank
     *
     * 多 range 的 PPR 结果合并：
     * 1. 每个 range 内部归一化（概率分布和为 1）
     * 2. 按 range 节点数加权合并
     * 3. 排序取 topK
     */
    async personalizedPageRank(opts) {
        const ranges = this._getRanges();
        const results = await Promise.all(ranges.map(range => range.read(engine => {
            return engine.personalizedPageRank({ sourceNode: opts.sourceNode, topK: opts.k });
        })));
        // 收集每个 range 的节点数（用于加权）
        const rangeSizes = await Promise.all(ranges.map(range => range.read(engine => engine.stats().nodeCount)));
        const totalNodes = rangeSizes.reduce((a, b) => a + b, 0);
        if (totalNodes === 0)
            return [];
        // 多 range 的 PPR 结果合并 — 每 range 内部归一化后按节点数加权
        const scoreMap = new Map();
        for (let i = 0; i < results.length; i++) {
            const list = results[i];
            const rangeWeight = rangeSizes[i] / totalNodes;
            // range 内部归一化
            const listTotal = list.reduce((s, { score }) => s + score, 0);
            if (listTotal <= 0)
                continue;
            // 归一化后乘以 range 权重，加入全局分数
            for (const { nodeId, score } of list) {
                const normalized = (score / listTotal) * rangeWeight;
                scoreMap.set(nodeId, (scoreMap.get(nodeId) ?? 0) + normalized);
            }
        }
        const merged = Array.from(scoreMap.entries())
            .map(([nodeId, score]) => ({ nodeId, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, opts.k ?? 10);
        return merged;
    }
}
exports.ScatterGather = ScatterGather;
//# sourceMappingURL=scatter-gather.js.map