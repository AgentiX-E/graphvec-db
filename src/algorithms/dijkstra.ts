/**
 * Dijkstra 最短路径算法
 *
 * 使用最小堆（优先队列）实现，假设所有边权重 >= 0。
 * 纯函数，不依赖 GraphEngine 实例。
 *
 * 时间复杂度: O((V + E) log V) 使用二叉堆
 * 空间复杂度: O(V)
 */

import { NodeId } from '../types'

export interface WeightedNeighbor {
  nodeId: NodeId
  weight: number
}

export interface DijkstraResult {
  distance: number
  parent: NodeId | null
}

/**
 * 最小二叉堆（优先队列），用于 Dijkstra
 */
class MinHeap<T> {
  private data: T[] = []
  private compare: (a: T, b: T) => number

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare
  }

  push(item: T): void {
    this.data.push(item)
    this._siftUp(this.data.length - 1)
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined
    const top = this.data[0]
    const last = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = last
      this._siftDown(0)
    }
    return top
  }

  get size(): number {
    return this.data.length
  }

  private _siftUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1
      if (this.compare(this.data[idx], this.data[parentIdx]) < 0) {
        [this.data[idx], this.data[parentIdx]] = [this.data[parentIdx], this.data[idx]]
        idx = parentIdx
      } else {
        break
      }
    }
  }

  private _siftDown(idx: number): void {
    const n = this.data.length
    while (true) {
      let smallest = idx
      const left = (idx << 1) + 1
      const right = left + 1

      if (left < n && this.compare(this.data[left], this.data[smallest]) < 0) {
        smallest = left
      }
      if (right < n && this.compare(this.data[right], this.data[smallest]) < 0) {
        smallest = right
      }
      if (smallest !== idx) {
        [this.data[idx], this.data[smallest]] = [this.data[smallest], this.data[idx]]
        idx = smallest
      } else {
        break
      }
    }
  }
}

interface QueueItem {
  nodeId: NodeId
  dist: number
}

export function dijkstra(
  getWeightedNeighbors: (nodeId: NodeId) => WeightedNeighbor[],
  startNode: NodeId,
): Map<NodeId, DijkstraResult> {
  const result = new Map<NodeId, DijkstraResult>()
  const heap = new MinHeap<QueueItem>((a, b) => a.dist - b.dist)

  result.set(startNode, { distance: 0, parent: null })
  heap.push({ nodeId: startNode, dist: 0 })

  while (heap.size > 0) {
    const current = heap.pop()!
    const { nodeId, dist } = current

    // 如果堆中已有更优路径，跳过
    const known = result.get(nodeId)!
    if (dist > known.distance) continue

    for (const neighbor of getWeightedNeighbors(nodeId)) {
      const newDist = dist + neighbor.weight
      const existing = result.get(neighbor.nodeId)

      if (!existing || newDist < existing.distance) {
        result.set(neighbor.nodeId, {
          distance: newDist,
          parent: nodeId,
        })
        heap.push({ nodeId: neighbor.nodeId, dist: newDist })
      }
    }
  }

  return result
}
