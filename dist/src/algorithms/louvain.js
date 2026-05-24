"use strict";
/**
 * Louvain 社区发现算法
 *
 * 基于模块度优化的贪心层次聚簇算法。
 * Phase 1: 局部模块度优化（每个节点尝试移动到邻接社区）
 * Phase 2: 将社区聚合成超节点，重复 Phase 1
 *
 * 时间复杂度: O(E log V) (典型)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.louvainCommunity = louvainCommunity;
function louvainCommunity(vertices, edges) {
    const n = vertices.length;
    if (n === 0) {
        return { communities: new Map(), modularity: 0, levels: 0 };
    }
    // 建立邻接表
    const adj = new Map();
    for (const v of vertices)
        adj.set(v, new Map());
    let totalWeight = 0;
    for (const e of edges) {
        adj.get(e.src).set(e.dst, (adj.get(e.src).get(e.dst) || 0) + e.weight);
        adj.get(e.dst).set(e.src, (adj.get(e.dst).get(e.src) || 0) + e.weight);
        totalWeight += e.weight * 2;
    }
    // Phase 1: 局部优化
    const community = new Map();
    for (const v of vertices)
        community.set(v, v);
    // 每个节点邻接社区的权重和
    const sumTot = new Map();
    for (const v of vertices) {
        let s = 0;
        for (const [, w] of adj.get(v)) {
            s += w;
        }
        sumTot.set(v, s);
    }
    const ki = new Map(sumTot); // 节点度数
    const kiIn = new Map(); // 内部边权重
    for (const v of vertices)
        kiIn.set(v, 0);
    // 计算社区内部边权重
    const communityEdges = new Map();
    for (const e of edges) {
        const key = e.src < e.dst ? `${e.src}:${e.dst}` : `${e.dst}:${e.src}`;
        communityEdges.set(key, (communityEdges.get(key) || 0) + e.weight);
    }
    // 初始更新 kiIn
    for (const [key, w] of communityEdges) {
        const [a, b] = key.split(':').map(Number);
        if (a === b) {
            kiIn.set(a, (kiIn.get(a) || 0) + w);
        }
    }
    let improved = true;
    let iterations = 0;
    const maxIter = 50;
    while (improved && iterations < maxIter) {
        improved = false;
        iterations++;
        for (const v of vertices) {
            // 找最佳的社区移动
            const neighbors = adj.get(v);
            const currentComm = community.get(v);
            let bestComm = currentComm;
            let bestDelta = 0;
            // 计算到每个相邻社区的权重
            const commWeights = new Map();
            for (const [neighbor, w] of neighbors) {
                const nc = community.get(neighbor);
                commWeights.set(nc, (commWeights.get(nc) || 0) + w);
            }
            // 尝试移动到邻居社区
            for (const [comm, weight] of commWeights) {
                if (comm === currentComm)
                    continue;
                // 计算模块度增量
                const sumTotComm = sumTot.get(comm) || 0;
                const sumTotSelf = sumTot.get(currentComm) || 0;
                const kiNode = ki.get(v) || 0;
                // ΔQ = [Σin + 2*ki_in]/(2*m) - [(Σtot + ki)/(2*m)]^2
                //      - [Σin/(2*m) - (Σtot/(2*m))^2 - (ki/(2*m))^2]
                const m = totalWeight / 2;
                const kiToComm = weight;
                const sumTotComm2 = sumTotComm;
                const deltaRemove = m > 0 ? (kiNode * sumTotSelf) / (2 * m * m) : 0;
                const deltaAdd = m > 0 ? (kiToComm / m) - (kiNode * sumTotComm2) / (2 * m * m) : 0;
                const deltaQ = deltaAdd - deltaRemove;
                if (deltaQ > bestDelta) {
                    bestDelta = deltaQ;
                    bestComm = comm;
                }
            }
            if (bestComm !== currentComm) {
                // 移动
                community.set(v, bestComm);
                improved = true;
            }
        }
    }
    // Phase 2 (简化版): 计算模块度
    const m = totalWeight / 2;
    let modularity = 0;
    // 计算模块度 Q = 1/(2m) * Σ[w_ij - ki*kj/(2m)] * δ(ci, cj)
    for (const e of edges) {
        if (community.get(e.src) === community.get(e.dst)) {
            modularity += (e.weight - (ki.get(e.src) * ki.get(e.dst)) / (2 * m));
        }
    }
    modularity = m > 0 ? modularity / (2 * m) : 0;
    return {
        communities: community,
        modularity,
        levels: 1,
    };
}
//# sourceMappingURL=louvain.js.map