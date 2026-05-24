/**
 * Louvain 社区发现算法
 *
 * 基于模块度优化的贪心层次聚簇算法。
 * Phase 1: 局部模块度优化（每个节点尝试移动到邻接社区）
 * Phase 2: 将社区聚合成超节点，重复 Phase 1
 *
 * 时间复杂度: O(E log V) (典型)
 */
export interface LouvainResult {
    /** 每个顶点的社区编号 (最终) */
    communities: Map<number, number>;
    /** 各层级的模块度 */
    modularity: number;
    /** 层级数 (如果 >1 说明做了 agglomeration) */
    levels: number;
    /** 每层的社区分配 */
    levelCommunities?: Array<Map<number, number>>;
}
export interface CommunityLevel {
    level: number;
    communities: Map<number, number>;
    modularity: number;
}
export declare function louvainCommunity(vertices: number[], edges: Array<{
    src: number;
    dst: number;
    weight: number;
}>): LouvainResult;
//# sourceMappingURL=louvain.d.ts.map