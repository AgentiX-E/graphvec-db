"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.toGraphologyGraph = toGraphologyGraph;
exports.toGraphologyGraphNodesOnly = toGraphologyGraphNodesOnly;
exports.compareGraphs = compareGraphs;
/**
 * 从 GraphEngine 构建 graphology Graph（异步，分批读取）
 *
 * @param engine - GraphEngine 实例
 * @param options - 适配选项
 * @returns GraphAdapterResult
 */
async function toGraphologyGraph(engine, options = {}) {
    const { default: Graph } = await Promise.resolve().then(() => __importStar(require('graphology')));
    const graph = new Graph({
        type: options.directed === false ? 'undirected' : 'directed',
        allowSelfLoops: false,
        multi: false,
    });
    const nodeLimit = options.nodeLimit ?? 100_000;
    const seenEdges = new Set();
    // 遍历所有节点：通过 _labelIndex.getNodeIds 获取全量节点 ID
    // 遍历所有可能的 typeId（1 到 10000）查询
    for (let typeId = 1; typeId <= 1000; typeId++) {
        const nodeIds = engine._labelIndex?.getNodeIds(typeId) ?? [];
        for (const id of nodeIds) {
            if (graph.order >= nodeLimit)
                break;
            const node = engine.getNode(id);
            if (!node)
                continue;
            const idStr = String(id);
            const attrs = { typeId: node.type, name: node.name };
            if (options.includeNodeProps && node.props) {
                Object.assign(attrs, node.props);
            }
            try {
                graph.addNode(idStr, attrs);
            }
            catch {
                // skip dup
            }
        }
        if (graph.order >= nodeLimit)
            break;
    }
    // 遍历所有节点，查询邻居构建 edge
    if (graph.order > 0) {
        for (const nodeId of graph.nodes()) {
            const { edges, nodes } = engine.neighbors(Number(nodeId));
            for (const edge of edges) {
                const neighborId = String(edge.dst);
                const edgeKey = `${nodeId}->${neighborId}`;
                if (seenEdges.has(edgeKey))
                    continue;
                seenEdges.add(edgeKey);
                const typeLabel = String(edge.type ?? '');
                try {
                    graph.addEdgeWithKey(edgeKey, nodeId, neighborId, options.includeEdgeProps ? { type: typeLabel } : undefined);
                }
                catch {
                    // edge already exists
                }
            }
        }
    }
    return { graph, nodeCount: graph.order, edgeCount: graph.size };
}
/**
 * 仅加载节点（无机边，更快）
 */
async function toGraphologyGraphNodesOnly(engine, options = {}) {
    const { default: Graph } = await Promise.resolve().then(() => __importStar(require('graphology')));
    const graph = new Graph({
        type: options.directed === false ? 'undirected' : 'directed',
        allowSelfLoops: false,
        multi: false,
    });
    const nodeLimit = options.nodeLimit ?? 100_000;
    for (let typeId = 1; typeId <= 1000; typeId++) {
        const nodeIds = engine._labelIndex?.getNodeIds(typeId) ?? [];
        for (const id of nodeIds) {
            if (graph.order >= nodeLimit)
                break;
            const node = engine.getNode(id);
            if (!node)
                continue;
            try {
                graph.addNode(String(id), {
                    typeId: node.type,
                    name: node.name,
                    ...(options.includeNodeProps && node.props ? node.props : {}),
                });
            }
            catch {
                // skip dup
            }
        }
        if (graph.order >= nodeLimit)
            break;
    }
    return { graph, nodeCount: graph.order, edgeCount: graph.size };
}
/**
 * 从两个 GraphEngine 实例比较图结构差异
 */
async function compareGraphs(source, target) {
    const { graph: g1 } = await toGraphologyGraphNodesOnly(source);
    const { graph: g2 } = await toGraphologyGraphNodesOnly(target);
    const nodes1 = new Set(g1.nodes());
    const nodes2 = new Set(g2.nodes());
    const missingNodes = g1.nodes().filter((n) => !nodes2.has(n));
    const extraNodes = g2.nodes().filter((n) => !nodes1.has(n));
    return {
        matched: missingNodes.length === 0 && extraNodes.length === 0,
        missingNodes,
        extraNodes,
    };
}
//# sourceMappingURL=graph-adapter.js.map