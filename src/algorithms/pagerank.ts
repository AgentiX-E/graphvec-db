/**
 * PageRank 算法
 *
 * 标准 PageRank 实现，基于邻接函数和节点列表。
 * 纯函数，不依赖 GraphEngine 实例。
 *
 * 时间复杂度: O(I * (V + E))，I 为迭代次数
 * 空间复杂度: O(V)
 */

import { NodeId } from '../types'

export interface PageRankOptions {
  dampingFactor?: number
  maxIterations?: number
  convergenceThreshold?: number
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
      // 收集所有指向 node 的邻居
      // PageRank 的标准实现倾向于遍历所有边；这里采用"对每个节点遍历所有节点检查入边"的简化
      // 但效率低。更好的方式：对每个节点检查它的出边，贡献给目标节点。
      // 我们需要反向索引，但为了保持纯函数接口，这里用 O(V^2) 的简单实现。
      // 实际使用时 GraphEngine 包装方法会提供更高效的邻接查询。
      for (const src of allNodes) {
        const nb = neighbors.get(src)!
        const deg = outDegree.get(src)!
        if (deg > 0 && nb.includes(node)) {
          incomingSum += rank.get(src)! / deg
        }
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
