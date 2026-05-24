/**
 * 最大流 — Dinic 算法
 *
 * 输入: 有向加权图的邻接表 (每条边有权重作为容量)
 * 输出: 从 source 到 sink 的最大流值及每条边上的流量
 * 时间复杂度: O(E * V²)
 */
export interface FlowEdge {
    src: number;
    dst: number;
    capacity: number;
    flow: number;
}
export interface MaxFlowResult {
    maxFlow: number;
    edges: FlowEdge[];
}
export declare function maxFlow(vertices: number[], edges: Array<{
    src: number;
    dst: number;
    capacity: number;
}>, source: number, sink: number): MaxFlowResult;
//# sourceMappingURL=dinic-flow.d.ts.map