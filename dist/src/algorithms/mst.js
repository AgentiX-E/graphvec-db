"use strict";
/**
 * 最小生成树 (MST) — Kruskal 算法
 *
 * 输入: 加权无向图的边列表
 * 输出: 最小生成树的边集合
 * 时间复杂度: O(E log E)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.minimumSpanningTree = minimumSpanningTree;
function minimumSpanningTree(vertices, edges) {
    if (vertices.length === 0)
        return { edges: [], totalWeight: 0 };
    // 按权重排序
    const sorted = [...edges].sort((a, b) => a.weight - b.weight);
    // Union-Find
    const parent = new Map();
    const rank = new Map();
    for (const v of vertices) {
        parent.set(v, v);
        rank.set(v, 0);
    }
    function find(x) {
        if (parent.get(x) !== x) {
            parent.set(x, find(parent.get(x)));
        }
        return parent.get(x);
    }
    function union(a, b) {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb)
            return false;
        const rankA = rank.get(ra);
        const rankB = rank.get(rb);
        if (rankA < rankB) {
            parent.set(ra, rb);
        }
        else if (rankA > rankB) {
            parent.set(rb, ra);
        }
        else {
            parent.set(rb, ra);
            rank.set(ra, rankA + 1);
        }
        return true;
    }
    const result = [];
    let totalWeight = 0;
    for (const edge of sorted) {
        if (result.length === vertices.length - 1)
            break;
        // 只处理两个端点都在顶点集合中的边
        if (!parent.has(edge.src) || !parent.has(edge.dst))
            continue;
        if (union(edge.src, edge.dst)) {
            result.push(edge);
            totalWeight += edge.weight;
        }
    }
    return { edges: result, totalWeight };
}
//# sourceMappingURL=mst.js.map