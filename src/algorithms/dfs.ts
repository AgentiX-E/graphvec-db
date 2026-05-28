/**
 * 深度优先搜索 (DFS)
 *
 * 从 startNode 出发进行深度优先遍历，返回前序(pre)和后序(post)访问顺序以及 parent 映射。
 * 纯函数，不依赖 GraphEngine 实例。
 *
 * 时间复杂度: O(V + E)
 * 空间复杂度: O(V)
 */

import { NodeId } from '../types'

export interface DFSResult {
  pre: NodeId[]
  post: NodeId[]
  parent: Map<NodeId, NodeId | null>
}

export function dfs(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  startNode: NodeId,
  order?: 'pre' | 'post',
): DFSResult {
  const pre: NodeId[] = []
  const post: NodeId[] = []
  const parent = new Map<NodeId, NodeId | null>()
  const visited = new Set<NodeId>()

  function visit(node: NodeId): void {
    visited.add(node)
    pre.push(node)

    for (const neighbor of getNeighbors(node)) {
      if (!visited.has(neighbor)) {
        parent.set(neighbor, node)
        visit(neighbor)
      }
    }

    post.push(node)
  }

  // 只对指定 order 返回 pre 或 post；但为了一致性我们总是收集两者
  parent.set(startNode, null)
  visit(startNode)

  // 如果用户指定了 order，只按指定顺序返回
  return { pre, post, parent }
}
