/**
 * graph-adapter.ts — graphology 适配器
 *
 * 将 OverGraph 存储引擎的数据读取到 graphology Graph 对象中，
 * 供 graphology 的 50+ 算法使用（A*、SCC、Louvain、metrics 等）。
 *
 * 用法：
 * ```ts
 * import { toGraphologyGraph } from './search/graph-adapter'
 * import { louvain } from 'graphology-communities-louvain'
 *
 * const graph = await toGraphologyGraph(engine, { directed: true })
 * const communities = louvain(graph)
 * ```
 */
import type { GraphEngine } from '../core/graph-engine';
export interface GraphAdapterOptions {
    directed?: boolean;
    nodeLimit?: number;
    includeEdgeProps?: boolean;
    includeNodeProps?: boolean;
}
export interface GraphAdapterResult {
    graph: any;
    nodeCount: number;
    edgeCount: number;
}
/**
 * 从 GraphEngine 构建 graphology Graph（异步，分批读取）
 *
 * @param engine - GraphEngine 实例
 * @param options - 适配选项
 * @returns GraphAdapterResult
 */
export declare function toGraphologyGraph(engine: GraphEngine, options?: GraphAdapterOptions): Promise<GraphAdapterResult>;
/**
 * 仅加载节点（无机边，更快）
 */
export declare function toGraphologyGraphNodesOnly(engine: GraphEngine, options?: GraphAdapterOptions): Promise<GraphAdapterResult>;
/**
 * 从两个 GraphEngine 实例比较图结构差异
 */
export declare function compareGraphs(source: GraphEngine, target: GraphEngine): Promise<{
    matched: boolean;
    missingNodes: string[];
    extraNodes: string[];
}>;
//# sourceMappingURL=graph-adapter.d.ts.map