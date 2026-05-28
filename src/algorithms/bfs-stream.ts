/**
 * Streaming BFS — 流式批处理广度优先搜索
 *
 * 对给定的节点批次列表，逐层扩展邻居，每层内按 maxBatchSize 分批处理。
 * 结果应与全内存 BFS 的可达集一致。
 */

import { NodeId, NodeRecord } from '../types'
import { BFSResult } from './bfs'

export interface BFSStreamOptions {
  maxBatchSize?: number
}

/**
 * 流式 BFS：将未探索的层节点分批扩展。
 *
 * 输入：nodes — 批次的 NodeRecord 数组
 * 输出：等同于 bfs(getNeighbors, startNode) 的可达集
 */
export async function bfsStream(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  startNode: NodeId,
  nodesBatches: AsyncIterable<NodeRecord[]>,
  options?: BFSStreamOptions,
): Promise<Map<NodeId, BFSResult>> {
  const maxBatchSize = options?.maxBatchSize ?? 1000
  const result = new Map<NodeId, BFSResult>()

  // 初始化起始节点
  result.set(startNode, { distance: 0, parent: null })

  // 当前层：从 startNode 开始
  let currentLevel: NodeId[] = [startNode]
  let distance = 0
  const allNodeIds = new Set<NodeId>()
  allNodeIds.add(startNode)

  // 先收集所有节点 ID
  for await (const batch of nodesBatches) {
    for (const n of batch) {
      allNodeIds.add(n.id)
    }
  }

  // 逐层 BFS
  while (currentLevel.length > 0) {
    const nextLevelSet = new Set<NodeId>()

    // 将当前层按 maxBatchSize 分批
    for (let i = 0; i < currentLevel.length; i += maxBatchSize) {
      const subBatch = currentLevel.slice(i, i + maxBatchSize)

      // 并行展开子批中的每个节点
      const neighborResult = subBatch.map(node => {
        const nb = getNeighbors(node)
        return { node, neighbors: nb.filter(n => allNodeIds.has(n)) }
      })

      for (const { neighbors } of neighborResult) {
        for (const neighbor of neighbors) {
          if (!result.has(neighbor)) {
            result.set(neighbor, { distance: distance + 1, parent: null })
            nextLevelSet.add(neighbor)
          }
        }
      }
    }

    currentLevel = Array.from(nextLevelSet)
    distance++
  }

  return result
}
