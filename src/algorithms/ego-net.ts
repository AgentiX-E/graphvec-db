/**
 * Ego Network 提取
 *
 * 从一个指定节点出发，提取其 N 跳内的子图（Ego Network）。
 * Ego Network 常用于社交网络分析、推荐系统、局部图特征提取。
 *
 * 实现方式：
 *   1. 从 ego 节点开始 BFS（或 DFS），深度不超过 N
 *   2. 收集所有访问到的节点和它们之间的所有边
 *   3. 返回子图结构（节点集 + 边集）
 *
 * 支持方向性选择：
 *   - directed = false: 将图视为无向，双向扩展
 *   - directed = true: 只沿出边扩展
 *
 * 时间复杂度: O(B^n) 最坏，但 N 通常很小（2~3跳）
 * 空间复杂度: O(V_sub + E_sub)
 */

import { NodeId } from '../types'

export interface EgoNetOptions {
  /** 跳数半径，默认 1 */
  depth?: number
  /** 是否考虑有向图的出边，默认 false（无向） */
  directed?: boolean
  /** 是否包含 ego 节点自身，默认 true */
  includeEgo?: boolean
  /** 是否输出边（如果为 false，只输出节点集），默认 true */
  includeEdges?: boolean
}

export interface EgoNetResult {
  /** 子图中包含的Node ID */
  nodes: Set<NodeId>
  /**
   * 子图中的边 (src, dst, weight?)
   * 无向模式下每条边只记录一次
   */
  edges: Array<{ src: NodeId; dst: NodeId; weight?: number }>
  /** 实际扩展到的跳数（可能小于请求的 depth） */
  actualDepth: number
}

/**
 * 提取 Ego Network
 *
 * @param getNeighbors - 返回某节点的邻居 ID 列表
 * @param getWeightedNeighbors - Optional：返回加权邻居，用于保留边权重
 * @param egoNode - 中心节点
 * @param options - 配置项
 * @returns 子图结构
 */
export function egoNet(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  getWeightedNeighbors?: (nodeId: NodeId) => Array<{ nodeId: NodeId; weight: number }>,
  egoNode: NodeId = 0,
  options?: EgoNetOptions,
): EgoNetResult {
  const depth = options?.depth ?? 1
  const directed = options?.directed ?? false
  const includeEgo = options?.includeEgo ?? true
  const includeEdges = options?.includeEdges ?? true

  if (depth < 0) {
    return { nodes: new Set<NodeId>(), edges: [], actualDepth: -1 }
  }

  if (depth === 0) {
    return {
      nodes: includeEgo ? new Set([egoNode]) : new Set<NodeId>(),
      edges: [],
      actualDepth: 0,
    }
  }

  // BFS 扩展
  const visited = new Set<NodeId>()
  const depthMap = new Map<NodeId, number>()
  const queue: NodeId[] = []

  visited.add(egoNode)
  depthMap.set(egoNode, 0)
  queue.push(egoNode)

  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    const curDepth = depthMap.get(current)!

    // 到达最大深度时不再扩展邻居
    if (curDepth >= depth) continue

    const neighbors = getNeighbors(current)
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        depthMap.set(neighbor, curDepth + 1)
        queue.push(neighbor)
      }
    }
  }

  // 移除 ego 节点（如果不包含）
  if (!includeEgo) {
    visited.delete(egoNode)
  }

  // 收集边
  const edges: Array<{ src: NodeId; dst: NodeId; weight?: number }> = []
  if (includeEdges) {
    for (const node of visited) {
      const rawNeighbors = getWeightedNeighbors
        ? getWeightedNeighbors(node).map((n) => n.nodeId)
        : getNeighbors(node)

      for (const neighbor of rawNeighbors) {
        if (visited.has(neighbor)) {
          const weight = getWeightedNeighbors
            ? getWeightedNeighbors(node).find((n) => n.nodeId === neighbor)?.weight
            : undefined

          if (!directed) {
            // 无向图：只记录 src < dst 以避免重复
            if (node < neighbor) {
              edges.push({ src: node, dst: neighbor, weight })
            }
          } else {
            edges.push({ src: node, dst: neighbor, weight })
          }
        }
      }
    }
  }

  const actualDepth = Math.min(
    depth,
    Math.max(...Array.from(depthMap.values()), 0),
  )

  return {
    nodes: visited,
    edges,
    actualDepth,
  }
}
