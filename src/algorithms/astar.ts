/**
 * A* Shortest Path Algorithm
 *
 * Uses a min-heap (same pattern as Dijkstra) with a heuristic function.
 * Guarantees optimality if heuristic is admissible (never overestimates).
 * Self-implemented, reuse Dijkstra's min-heap pattern.
 */

import { NodeId } from '../types'

export interface WeightedNeighbor {
  nodeId: NodeId
  weight: number
}

export interface AStarResult {
  /** The shortest path from start to end (inclusive) */
  path: NodeId[]
  /** Total cost of the path */
  cost: number
}

/**
 * Heuristic function type. Returns estimated cost from node to goal.
 */
export type HeuristicFn = (node: NodeId, goal: NodeId) => number

/**
 * Default heuristic: returns 0 (equivalent to Dijkstra).
 */
export function zeroHeuristic(_node: NodeId, _goal: NodeId): number {
  return 0
}

/**
 * Min-heap for A* priority queue.
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
  fScore: number
}

/**
 * A* shortest path algorithm.
 *
 * @param getWeightedNeighbors - Function returning neighbors with edge weights
 * @param start - Start node ID
 * @param end - Goal node ID
 * @param heuristic - Heuristic function (default: zero heuristic = Dijkstra)
 * @returns AStarResult with path and cost, or null if no path exists
 */
export function astar(
  getWeightedNeighbors: (nodeId: NodeId) => WeightedNeighbor[],
  start: NodeId,
  end: NodeId,
  heuristic: HeuristicFn = zeroHeuristic,
): AStarResult | null {
  if (start === end) {
    return { path: [start], cost: 0 }
  }

  // gScore: known cost from start to node
  const gScore = new Map<NodeId, number>()
  const parent = new Map<NodeId, NodeId | null>()
  const heap = new MinHeap<QueueItem>((a, b) => a.fScore - b.fScore)

  gScore.set(start, 0)
  parent.set(start, null)
  heap.push({ nodeId: start, fScore: heuristic(start, end) })

  const closed = new Set<NodeId>()

  while (heap.size > 0) {
    const current = heap.pop()!
    const { nodeId } = current

    if (nodeId === end) {
      // Reconstruct path
      const path: NodeId[] = []
      let cur: NodeId | null = end
      while (cur !== null) {
        path.unshift(cur)
        cur = parent.get(cur) ?? null
      }
      return { path, cost: gScore.get(end)! }
    }

    if (closed.has(nodeId)) continue
    closed.add(nodeId)

    const currentG = gScore.get(nodeId)!
    for (const neighbor of getWeightedNeighbors(nodeId)) {
      if (closed.has(neighbor.nodeId)) continue

      const tentativeG = currentG + neighbor.weight
      const existingG = gScore.get(neighbor.nodeId)
      if (existingG !== undefined && tentativeG >= existingG) continue

      gScore.set(neighbor.nodeId, tentativeG)
      parent.set(neighbor.nodeId, nodeId)
      heap.push({
        nodeId: neighbor.nodeId,
        fScore: tentativeG + heuristic(neighbor.nodeId, end),
      })
    }
  }

  return null
}
