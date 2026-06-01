/**
 * PageRank 算法
 *
 * 标准 PageRank 实现，基于邻接函数和节点列表。
 * 纯函数，不依赖 GraphEngine 实例。
 *
 * 时间复杂度: O(I * (V + E))，I 为迭代次数
 * 空间复杂度: O(V + E)
 *
 * 优化说明：
 * 构建反向邻接表（入边索引）避免 O(V²) 的全节点扫描，
 * 将每次迭代从 O(V²) 优化为 O(V + E)。
 */

import { NodeId } from '../types'

export interface PageRankOptions {
  dampingFactor?: number
  maxIterations?: number
  convergenceThreshold?: number
}

/**
 * 构建反向邻接表（入边索引）。
 * 返回 Map<targetNode, sourceNodes[]>，
 * 即每个节点的所有入边来源。
 */
function buildIncomingMap(
  allNodes: NodeId[],
  neighbors: Map<NodeId, NodeId[]>,
  outDegree: Map<NodeId, number>,
): Map<NodeId, NodeId[]> {
  const incoming = new Map<NodeId, NodeId[]>()
  for (const node of allNodes) {
    incoming.set(node, [])
  }
  for (const src of allNodes) {
    const deg = outDegree.get(src)!
    if (deg === 0) continue
    const nb = neighbors.get(src)!
    for (const dst of nb) {
      const list = incoming.get(dst)
      if (list) {
        list.push(src)
      }
    }
  }
  return incoming
}

export function pagerank(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  options?: PageRankOptions,
): Map<NodeId, number> {
  const dampingFactor = options?.dampingFactor ?? 0.85
  const maxIterations = options?.maxIterations ?? 100
  const convergenceThreshold = options?.convergenceThreshold ?? 1e-6

  const n = allNodes.length
  if (n === 0) return new Map()

  // 初始化所有节点 rank 为 1/n
  const rank = new Map<NodeId, number>()
  // 预计算每个节点的出度并存储邻居
  const outDegree = new Map<NodeId, number>()
  const neighbors = new Map<NodeId, NodeId[]>()

  for (const node of allNodes) {
    rank.set(node, 1 / n)
    const nb = getNeighbors(node)
    neighbors.set(node, nb)
    outDegree.set(node, nb.length)
  }

  // 构建反向邻接表（入边索引），避免 O(V²) 的全节点扫描
  const incoming = buildIncomingMap(allNodes, neighbors, outDegree)

  // 处理 dangling nodes（出度为 0 的节点）
  // 每次迭代中其 rank 均匀分配给所有节点

  for (let iter = 0; iter < maxIterations; iter++) {
    // 计算 dangling 节点的总 rank
    let danglingRank = 0
    for (const node of allNodes) {
      if (outDegree.get(node)! === 0) {
        danglingRank += rank.get(node)!
      }
    }

    const newRank = new Map<NodeId, number>()

    // 每个节点的新 rank = (1-d)/n + d * (sum(incoming_rank/outdeg) + dangling_rank/n)
    const teleport = (1 - dampingFactor) / n
    const danglingContribution = dampingFactor * danglingRank / n

    for (const node of allNodes) {
      let incomingSum = 0
      // 使用预构建的入边索引，O(degree) 而非 O(V)
      const srcList = incoming.get(node) ?? []
      for (const src of srcList) {
        incomingSum += rank.get(src)! / outDegree.get(src)!
      }

      newRank.set(node, teleport + dampingFactor * incomingSum + danglingContribution)
    }

    // 检查收敛
    let diff = 0
    for (const node of allNodes) {
      diff += Math.abs(newRank.get(node)! - rank.get(node)!)
    }

    // 更新 rank
    for (const [node, val] of newRank) {
      rank.set(node, val)
    }

    if (diff < convergenceThreshold) {
      break
    }
  }

  return rank
}
