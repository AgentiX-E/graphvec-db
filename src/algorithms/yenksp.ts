/**
 * Yen's K-Shortest Paths 算法
 *
 * 在带权有向图中寻找从源节点到目标节点的前 K 条最短简单路径。
 * 基于已知的 Dijkstra 算法。
 *
 * 核心思想：
 *   1. 用 Dijkstra 找到第 1 条最短路径
 *   2. 对于每条已找到的路径 p_i，选择路径上的每个节点作为 spur node
 *   3. 移除该节点前的路径（root path）并阻塞 spur node 的某些边
 *   4. 用 Dijkstra 计算 spur path
 *   5. 合并 root + spur 得到候选路径
 *   6. 从候选集中选择最短的作为下一条最短路径
 *
 * 时间复杂度: O(K * (V * (E + V log V)))   (K: 目标路径数)
 * 空间复杂度: O(K * V)
 */

import { NodeId } from '../types'
import { dijkstra, WeightedNeighbor } from './dijkstra'

export interface YenKSPOptions {
  /** 最多返回的路径数，默认 5 */
  K?: number
  /** 最大路径长度（边数），防止超长路径 */
  maxPathLength?: number
}

export interface YenPath {
  /** 路径上的节点序列 */
  nodes: NodeId[]
  /** 路径总权重 */
  totalWeight: number
}

/**
 * Yen's K-Shortest Paths
 *
 * @param getWeightedNeighbors - 返回某节点的加权邻居列表
 * @param startNode - 源节点
 * @param targetNode - 目标节点
 * @param options - Optional参数
 * @returns 前 K 条最短路径，按权重升序排列
 */
export function yenKSP(
  getWeightedNeighbors: (nodeId: NodeId) => WeightedNeighbor[],
  startNode: NodeId,
  targetNode: NodeId,
  options?: YenKSPOptions,
): YenPath[] {
  const K = options?.K ?? 5
  const maxPathLength = options?.maxPathLength ?? 100

  if (K <= 0) return []
  if (startNode === targetNode) {
    return [{ nodes: [startNode], totalWeight: 0 }]
  }

  // ── Step 1: 用 Dijkstra 找到第一条最短路径 ──
  const firstDist = dijkstra(getWeightedNeighbors, startNode)
  const firstPath = _reconstructPath(firstDist, startNode, targetNode)

  if (firstPath === null) {
    // 没有路径可达
    return []
  }

  // 应用于 edge 级别的阻塞
  const A: YenPath[] = [{ nodes: firstPath, totalWeight: firstDist.get(targetNode)!.distance }]
  const B: YenPath[] = []

  // ── Step 2: 迭代寻找第 2..K 条最短路径 ──
  for (let k = 1; k < K; k++) {
    const prevPath = A[k - 1]

    if (prevPath.nodes.length > maxPathLength) break

    // 对于当前路径上的每个 spur node 位置
    for (let i = 0; i < prevPath.nodes.length - 1; i++) {
      const spurNode = prevPath.nodes[i]

      // -- root path: 从 start 到 spur node 的路径 --
      const rootPath = prevPath.nodes.slice(0, i + 1)

      // 收集需移除的边和节点
      const removedEdges = new Set<string>()
      const removedNodes = new Set<NodeId>()

      // 对于 A 中所有以 rootPath 为前缀的路径，阻塞从 spurNode 出发的下一条边
      for (const path of A) {
        if (path.nodes.length > i && _arraysEqualPrefix(path.nodes, rootPath)) {
          const nextEdgeFrom = path.nodes[i]
          const nextEdgeTo = path.nodes[i + 1]
          if (nextEdgeTo !== undefined) {
            removedEdges.add(`${nextEdgeFrom}:${nextEdgeTo}`)
          }
        }
      }

      // 阻塞 root path 中除 spurNode 之外的所有节点（防止路径中出现环路）
      for (let j = 0; j < rootPath.length - 1; j++) {
        removedNodes.add(rootPath[j])
      }

      // -- 构造带阻塞的加权邻居函数 --
      const blockedNeighbors = (nodeId: NodeId): WeightedNeighbor[] => {
        const raw = getWeightedNeighbors(nodeId)
        return raw.filter((n) => {
          // 检查节点是否被阻塞
          if (removedNodes.has(n.nodeId)) return false
          // 检查边是否被阻塞
          if (removedEdges.has(`${nodeId}:${n.nodeId}`)) return false
          return true
        })
      }

      // 用 Dijkstra 计算从 spurNode 到 target 的 spur path
      const spurDist = dijkstra(blockedNeighbors, spurNode)
      const spurPath = _reconstructPath(spurDist, spurNode, targetNode)

      if (spurPath !== null) {
        // rootPath + spurPath = 完整候选路径
        const fullPath = [...rootPath.slice(0, -1), ...spurPath]
        const totalWeight =
          (i > 0 ? _pathWeight(getWeightedNeighbors, fullPath) : spurDist.get(targetNode)!.distance)

        // 完全去重：检查 fullPath 是否已经在 A 或 B 中
        const alreadyExists = [...A, ...B].some(
          (p) => p.nodes.length === fullPath.length && _arraysEqual(p.nodes, fullPath),
        )

        if (!alreadyExists && fullPath.length <= maxPathLength + 1) {
          B.push({ nodes: fullPath, totalWeight })
        }
      }
    }

    if (B.length === 0) break

    // 从 B 中选出 totalWeight 最小的路径
    B.sort((a, b) => a.totalWeight - b.totalWeight)
    A.push(B[0])
    B.splice(0, 1)
  }

  return A.slice(0, K)
}

// ── 内部辅助函数 ──

/**
 * 从 Dijkstra 结果重建路径
 */
function _reconstructPath(
  dist: Map<NodeId, { distance: number; parent: NodeId | null }>,
  start: NodeId,
  target: NodeId,
): NodeId[] | null {
  if (!dist.has(target)) return null // 不可达

  const path: NodeId[] = []
  let current: NodeId | null = target

  while (current !== null) {
    path.unshift(current)
    if (current === start) break
    const entry = dist.get(current)
    current = entry ? entry.parent : null
  }

  if (path[0] !== start) return null // 路径不完整
  return path
}

/**
 * 计算一条路径的总权重
 */
function _pathWeight(
  getWeightedNeighbors: (nodeId: NodeId) => WeightedNeighbor[],
  path: NodeId[],
): number {
  let total = 0
  for (let i = 0; i < path.length - 1; i++) {
    const neighbors = getWeightedNeighbors(path[i])
    const edge = neighbors.find((n) => n.nodeId === path[i + 1])
    if (edge) total += edge.weight
  }
  return total
}

/**
 * 比较两个数组是否相等
 */
function _arraysEqual(a: NodeId[], b: NodeId[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * 检查数组 a 的前缀是否等于 prefix
 */
function _arraysEqualPrefix(a: NodeId[], prefix: NodeId[]): boolean {
  if (a.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (a[i] !== prefix[i]) return false
  }
  return true
}
