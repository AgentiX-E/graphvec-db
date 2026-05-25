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
import type { GraphEngine } from '../core/graph-engine'

export interface GraphAdapterOptions {
  directed?: boolean
  nodeLimit?: number
  includeEdgeProps?: boolean
  includeNodeProps?: boolean
}

export interface GraphAdapterResult {
  graph: any
  nodeCount: number
  edgeCount: number
}

/**
 * 从 GraphEngine 构建 graphology Graph（异步，分批读取）
 *
 * @param engine - GraphEngine 实例
 * @param options - 适配选项
 * @returns GraphAdapterResult
 */
export async function toGraphologyGraph(
  engine: GraphEngine,
  options: GraphAdapterOptions = {},
): Promise<GraphAdapterResult> {
  const { default: Graph } = await import('graphology')
  const graph = new Graph({
    type: options.directed === false ? 'undirected' : 'directed',
    allowSelfLoops: false,
    multi: false,
  })

  const nodeLimit = options.nodeLimit ?? 100_000
  const seenEdges = new Set<string>()

  // 遍历所有节点：通过 _labelIndex.getNodeIds 获取全量节点 ID
  // 遍历所有可能的 typeId（1 到 10000）查询
  for (let typeId = 1; typeId <= 1000; typeId++) {
    const nodeIds = (engine as any)._labelIndex?.getNodeIds(typeId) ?? []
    for (const id of nodeIds) {
      if (graph.order >= nodeLimit) break
      const node = engine.getNode(id)
      if (!node) continue
      const idStr = String(id)
      const attrs: Record<string, unknown> = { typeId: node.type, name: node.name }
      if (options.includeNodeProps && node.props) {
        Object.assign(attrs, node.props)
      }
      try {
        graph.addNode(idStr, attrs)
      } catch {
        // skip dup
      }
    }
    if (graph.order >= nodeLimit) break
  }

  // 遍历所有节点，查询邻居构建 edge
  if (graph.order > 0) {
    for (const nodeId of graph.nodes()) {
      const { edges, nodes } = engine.neighbors(Number(nodeId))
      for (const edge of edges) {
        const neighborId = String(edge.dst)
        const edgeKey = `${nodeId}->${neighborId}`
        if (seenEdges.has(edgeKey)) continue
        seenEdges.add(edgeKey)
        const typeLabel = String(edge.type ?? '')
        try {
          graph.addEdgeWithKey(
            edgeKey,
            nodeId,
            neighborId,
            options.includeEdgeProps ? { type: typeLabel } : undefined,
          )
        } catch {
          // edge already exists
        }
      }
    }
  }

  return { graph, nodeCount: graph.order, edgeCount: graph.size }
}

/**
 * 仅加载节点（无机边，更快）
 */
export async function toGraphologyGraphNodesOnly(
  engine: GraphEngine,
  options: GraphAdapterOptions = {},
): Promise<GraphAdapterResult> {
  const { default: Graph } = await import('graphology')
  const graph = new Graph({
    type: options.directed === false ? 'undirected' : 'directed',
    allowSelfLoops: false,
    multi: false,
  })

  const nodeLimit = options.nodeLimit ?? 100_000

  for (let typeId = 1; typeId <= 1000; typeId++) {
    const nodeIds = (engine as any)._labelIndex?.getNodeIds(typeId) ?? []
    for (const id of nodeIds) {
      if (graph.order >= nodeLimit) break
      const node = engine.getNode(id)
      if (!node) continue
      try {
        graph.addNode(String(id), {
          typeId: node.type,
          name: node.name,
          ...(options.includeNodeProps && node.props ? node.props : {}),
        })
      } catch {
        // skip dup
      }
    }
    if (graph.order >= nodeLimit) break
  }

  return { graph, nodeCount: graph.order, edgeCount: graph.size }
}

/**
 * 从两个 GraphEngine 实例比较图结构差异
 */
export async function compareGraphs(
  source: GraphEngine,
  target: GraphEngine,
): Promise<{ matched: boolean; missingNodes: string[]; extraNodes: string[] }> {
  const { graph: g1 } = await toGraphologyGraphNodesOnly(source)
  const { graph: g2 } = await toGraphologyGraphNodesOnly(target)

  const nodes1 = new Set(g1.nodes())
  const nodes2 = new Set(g2.nodes())

  const missingNodes = g1.nodes().filter((n: string) => !nodes2.has(n))
  const extraNodes = g2.nodes().filter((n: string) => !nodes1.has(n))

  return {
    matched: missingNodes.length === 0 && extraNodes.length === 0,
    missingNodes,
    extraNodes,
  }
}
