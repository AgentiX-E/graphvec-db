/**
 * 中介中心性 — Brandes 算法
 *
 * 计算每个顶点的中介中心性 (Betweenness Centrality)。
 * 时间复杂度: O(V * E) (未加权) / O(V * (E + V log V)) (加权)
 */
export interface BetweennessResult {
    /** nodeId → betweenness centrality score */
    [nodeId: number]: number;
}
export declare function betweennessCentrality(vertices: number[], adjList: Map<number, number[]>, normalized?: boolean): BetweennessResult;
//# sourceMappingURL=betweenness.d.ts.map