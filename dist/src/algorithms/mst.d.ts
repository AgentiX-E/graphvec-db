/**
 * 最小生成树 (MST) — Kruskal 算法
 *
 * 输入: 加权无向图的边列表
 * 输出: 最小生成树的边集合
 * 时间复杂度: O(E log E)
 */
export interface MSTEdge {
    src: number;
    dst: number;
    weight: number;
}
export interface MSTResult {
    edges: MSTEdge[];
    totalWeight: number;
}
export declare function minimumSpanningTree(vertices: number[], edges: MSTEdge[]): MSTResult;
//# sourceMappingURL=mst.d.ts.map