"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HnswIndex = void 0;
const DEFAULT_CONFIG = {
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    mL: 1 / Math.log(16),
    distance: 'cosine',
};
class HnswIndex {
    config;
    /** 所有插入的向量条目, id → VectorEntry */
    entries = new Map();
    /** 每层的邻接表: layer → Map<nodeId, neighborIds[]> */
    layers = new Map();
    /** 每层节点的额外距离缓存 (加速搜索) */
    _maxLayer = 0;
    /** entry point 所在层 */
    entryPoint = null;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /** 当前索引中的向量数量 */
    get size() { return this.entries.size; }
    /** 获取配置 */
    getConfig() { return { ...this.config }; }
    /**
     * 插入一个向量
     */
    insert(id, vector) {
        this.entries.set(id, { id, vector });
        const level = this._randomLevel();
        this._maxLayer = Math.max(this._maxLayer, level);
        // 确保所有层有邻接表
        for (let lc = 0; lc <= level; lc++) {
            if (!this.layers.has(lc)) {
                this.layers.set(lc, new Map());
            }
        }
        if (this.entryPoint === null) {
            // 第一个节点
            this.entryPoint = id;
            for (let lc = 0; lc <= level; lc++) {
                this.layers.get(lc).set(id, []);
            }
            return;
        }
        // 从最高层向下搜索插入点
        let ep = this.entryPoint;
        for (let lc = this._maxLayer; lc > level; lc--) {
            const layer = this.layers.get(lc);
            if (!layer || !layer.has(ep))
                continue;
            ep = this._searchLayer(ep, vector, 1, lc)[0] || ep;
        }
        // 从 level 向下逐层插入
        for (let lc = Math.min(level, this._maxLayer); lc >= 0; lc--) {
            const candidates = this._searchLayer(ep, vector, this.config.efConstruction, lc);
            const neighbors = candidates.slice(0, this.config.M);
            const layerMap = this.layers.get(lc);
            layerMap.set(id, neighbors);
            // 双向连接
            for (const neighborId of neighbors) {
                const neighborList = layerMap.get(neighborId);
                if (neighborList) {
                    neighborList.push(id);
                    // 剪枝: 只保留 M 个最近邻
                    if (neighborList.length > this.config.M) {
                        const sorted = this._sortByDistance(neighborId, neighborList, this.entries.get(neighborId).vector, lc);
                        layerMap.set(neighborId, sorted.slice(0, this.config.M));
                    }
                }
            }
            ep = candidates[0] || ep;
        }
        // 如果 level > 当前 entry 所在层，更新 entry point
        if (level > this._maxLayer) {
            this.entryPoint = id;
        }
    }
    /**
     * 搜索 topK 个最近邻
     */
    search(query, topK) {
        if (this.entryPoint === null || this.entries.size === 0)
            return [];
        const ef = Math.max(topK, this.config.efSearch);
        let ep = this.entryPoint;
        // 从最高层向下搜索
        for (let lc = this._maxLayer; lc > 0; lc--) {
            const layer = this.layers.get(lc);
            if (!layer || !layer.has(ep))
                continue;
            ep = this._searchLayer(ep, query, 1, lc)[0] || ep;
        }
        // 在 0 层执行 ef 宽度搜索
        const result = this._searchLayer(ep, query, ef, 0);
        return result.slice(0, topK).map(id => ({
            id,
            distance: this._distance(query, this.entries.get(id).vector),
        }));
    }
    /**
     * 批量插入
     */
    batchInsert(vectors) {
        for (const v of vectors) {
            this.insert(v.id, v.vector);
        }
    }
    /**
     * 删除单条向量
     */
    delete(id) {
        if (!this.entries.has(id))
            return false;
        this.entries.delete(id);
        // 从所有层的邻接表中移除
        for (const [, layerMap] of this.layers) {
            layerMap.delete(id);
            for (const [nid, neighbors] of layerMap) {
                const idx = neighbors.indexOf(id);
                if (idx !== -1) {
                    neighbors.splice(idx, 1);
                }
            }
        }
        if (this.entryPoint === id) {
            // 选择新的 entry point
            this.entryPoint = this.entries.size > 0 ? this.entries.keys().next().value : null;
        }
        return true;
    }
    // ── 内部方法 ──
    /** 在指定层搜索 ef 个最近邻 */
    _searchLayer(ep, query, ef, layer) {
        const layerMap = this.layers.get(layer);
        if (!layerMap)
            return [ep];
        // visited set
        const visited = new Set([ep]);
        // 候选集 (用数组模拟最小堆，按 dist 升序)
        const candidates = [];
        // 结果集 (用数组模拟最小堆，按 dist 升序)
        const results = [];
        const firstDist = this._distance(query, this.entries.get(ep).vector);
        candidates.push({ id: ep, dist: firstDist });
        results.push({ id: ep, dist: firstDist });
        while (candidates.length > 0) {
            // 取最远候选 (candidates 中 dist 最大)
            let furthestCandidate = candidates[0];
            let furthestIdx = 0;
            for (let i = 1; i < candidates.length; i++) {
                if (candidates[i].dist > furthestCandidate.dist) {
                    furthestCandidate = candidates[i];
                    furthestIdx = i;
                }
            }
            // 取结果集中最远的
            const furthestResult = results[results.length - 1].dist;
            if (furthestCandidate.dist > furthestResult)
                break;
            // 移除当前候选
            candidates.splice(furthestIdx, 1);
            const neighbors = layerMap.get(furthestCandidate.id) || [];
            for (const nid of neighbors) {
                if (visited.has(nid))
                    continue;
                visited.add(nid);
                const dist = this._distance(query, this.entries.get(nid).vector);
                const furthestResultDist = results[results.length - 1].dist;
                if (results.length < ef || dist < furthestResultDist) {
                    candidates.push({ id: nid, dist });
                    results.push({ id: nid, dist });
                    results.sort((a, b) => a.dist - b.dist);
                    if (results.length > ef) {
                        results.pop();
                    }
                }
            }
        }
        return results.sort((a, b) => a.dist - b.dist).map(r => r.id);
    }
    /** 按到目标节点的距离排序邻居列表 */
    _sortByDistance(targetId, neighborIds, _targetVec, _layer) {
        const targetVec = this.entries.get(targetId)?.vector;
        if (!targetVec)
            return neighborIds;
        return [...neighborIds].sort((a, b) => {
            const va = this.entries.get(a)?.vector;
            const vb = this.entries.get(b)?.vector;
            if (!va || !vb)
                return 0;
            return this._distance(targetVec, va) - this._distance(targetVec, vb);
        });
    }
    /** 随机层数 (指数分布) */
    _randomLevel() {
        let level = 0;
        while (Math.random() < this.config.mL && level < 16) {
            level++;
        }
        return level;
    }
    /** 距离计算 */
    _distance(a, b) {
        if (a.length !== b.length)
            return Infinity;
        let sum = 0;
        let aNorm = 0;
        let bNorm = 0;
        switch (this.config.distance) {
            case 'cosine':
                for (let i = 0; i < a.length; i++) {
                    sum += a[i] * b[i];
                    aNorm += a[i] * a[i];
                    bNorm += b[i] * b[i];
                }
                const norm = Math.sqrt(aNorm) * Math.sqrt(bNorm);
                return norm === 0 ? 1 : 1 - sum / norm;
            case 'euclidean':
                for (let i = 0; i < a.length; i++) {
                    const d = a[i] - b[i];
                    sum += d * d;
                }
                return Math.sqrt(sum);
            case 'dot':
                for (let i = 0; i < a.length; i++) {
                    sum += a[i] * b[i];
                }
                return 1 - sum; // negate so smaller = more similar
        }
    }
}
exports.HnswIndex = HnswIndex;
//# sourceMappingURL=hnsw.js.map