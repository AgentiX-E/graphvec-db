"use strict";
/**
 * 中介中心性 — Brandes 算法
 *
 * 计算每个顶点的中介中心性 (Betweenness Centrality)。
 * 时间复杂度: O(V * E) (未加权) / O(V * (E + V log V)) (加权)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.betweennessCentrality = betweennessCentrality;
function betweennessCentrality(vertices, adjList, normalized = true) {
    const result = {};
    const vertexSet = new Set(vertices);
    const n = vertices.length;
    for (const v of vertices) {
        result[v] = 0;
    }
    for (const s of vertices) {
        // BFS from s
        const stack = [];
        const pred = new Map();
        const sigma = new Map();
        const dist = new Map();
        for (const v of vertices) {
            pred.set(v, []);
            sigma.set(v, 0);
            dist.set(v, -1);
        }
        sigma.set(s, 1);
        dist.set(s, 0);
        const queue = [s];
        while (queue.length > 0) {
            const v = queue.shift();
            stack.push(v);
            for (const w of adjList.get(v) || []) {
                if (!vertexSet.has(w))
                    continue;
                // w found for the first time?
                if (dist.get(w) === -1) {
                    dist.set(w, dist.get(v) + 1);
                    queue.push(w);
                }
                // shortest path to w via v
                if (dist.get(w) === dist.get(v) + 1) {
                    sigma.set(w, sigma.get(w) + sigma.get(v));
                    pred.get(w).push(v);
                }
            }
        }
        // accumulation
        const delta = new Map();
        for (const v of vertices) {
            delta.set(v, 0);
        }
        while (stack.length > 0) {
            const w = stack.pop();
            for (const v of pred.get(w) || []) {
                delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
            }
            if (w !== s) {
                result[w] += delta.get(w);
            }
        }
    }
    // 归一化
    if (normalized && n > 2) {
        const norm = (n - 1) * (n - 2);
        for (const v of vertices) {
            result[v] /= norm;
        }
    }
    return result;
}
//# sourceMappingURL=betweenness.js.map