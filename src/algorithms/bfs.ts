/**
 * 广度优先搜索 (BFS)
 *
 * 从 startNode 出发遍历图，返回每个可达节点的 distance 和 parent。
 * 纯函数，不依赖 GraphEngine 实例。
 *
 * 时间复杂度: O(V + E)
 * 空间复杂度: O(V)
 */

import { NodeId } from '../types'

export interface BFSResult {
  distance: number
  parent: NodeId | null
}

export function bfs(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  startNode: NodeId,
): Map<NodeId, BFSResult> {
  const result = new Map<NodeId, BFSResult>()
  const queue: NodeId[] = []

  result.set(startNode, { distance: 0, parent: null })
  queue.push(startNode)

  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    const currentDist = result.get(current)!.distance

    for (const neighbor of getNeighbors(current)) {
      if (!result.has(neighbor)) {
        result.set(neighbor, { distance: currentDist + 1, parent: current })
        queue.push(neighbor)
      }
    }
  }

  return result
}
