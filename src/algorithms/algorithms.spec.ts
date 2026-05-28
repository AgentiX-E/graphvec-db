/**
 * 图算法纯函数单元测试
 *
 * 测试 bfs / dfs / pagerank / dijkstra 四个纯函数算法。
 * 不依赖 GraphEngine，仅测试算法逻辑正确性。
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { bfs } from './bfs'
import { dfs } from './dfs'
import { pagerank } from './pagerank'
import { dijkstra } from './dijkstra'

// ──────────────────────────────────────────
// 测试图：有向图
//   0 → 1 → 2 → 3
//   ↓
//   4
// ──────────────────────────────────────────

function createTestGraph() {
  const neighbors: Record<number, number[]> = {
    0: [1, 4],
    1: [2],
    2: [3],
    3: [],
    4: [],
  }
  return {
    allNodes: [0, 1, 2, 3, 4] as NodeId[],
    getNeighbors: (nid: NodeId) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试图：带权有向图（Dijkstra）
//   0 ──1──→ 1 ──2──→ 2
//   │                ↑
//   └─────5──────────┘
// ──────────────────────────────────────────

function createWeightedGraph() {
  const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
    0: [{ nodeId: 1, weight: 1 }, { nodeId: 2, weight: 5 }],
    1: [{ nodeId: 2, weight: 2 }],
    2: [],
  }
  return {
    getWeightedNeighbors: (nid: NodeId) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// BFS
// ──────────────────────────────────────────

describe('bfs', () => {
  test('should traverse all reachable nodes from root', () => {
    const { getNeighbors } = createTestGraph()
    const result = bfs(getNeighbors, 0 as NodeId)

    // 所有节点可达
    expect(result.has(0 as NodeId)).toBe(true)
    expect(result.has(1 as NodeId)).toBe(true)
    expect(result.has(2 as NodeId)).toBe(true)
    expect(result.has(3 as NodeId)).toBe(true)
    expect(result.has(4 as NodeId)).toBe(true)

    // distance
    expect(result.get(0 as NodeId)!.distance).toBe(0)
    expect(result.get(1 as NodeId)!.distance).toBe(1)
    expect(result.get(4 as NodeId)!.distance).toBe(1)
    expect(result.get(2 as NodeId)!.distance).toBe(2)
    expect(result.get(3 as NodeId)!.distance).toBe(3)
  })

  test('start node should have distance 0 and parent null', () => {
    const { getNeighbors } = createTestGraph()
    const result = bfs(getNeighbors, 2 as NodeId)
    expect(result.get(2 as NodeId)!.distance).toBe(0)
    expect(result.get(2 as NodeId)!.parent).toBeNull()
  })

  test('should return empty result for single node graph', () => {
    const getNeighbors = () => [] as NodeId[]
    const result = bfs(getNeighbors, 42 as NodeId)
    expect(result.size).toBe(1)
    expect(result.get(42 as NodeId)!.distance).toBe(0)
  })
})

// ──────────────────────────────────────────
// DFS
// ──────────────────────────────────────────

describe('dfs', () => {
  test('should produce pre and post order', () => {
    const { getNeighbors } = createTestGraph()
    const result = dfs(getNeighbors, 0 as NodeId)

    // 所有可达节点应被访问
    expect(result.pre.length).toBe(5)
    expect(result.post.length).toBe(5)

    // pre-order: node 0 should be first
    expect(result.pre[0]).toBe(0)
    // post-order: node 0 should be last (since it's root)
    expect(result.post[result.post.length - 1]).toBe(0)
  })

  test('start node should have parent null', () => {
    const { getNeighbors } = createTestGraph()
    const result = dfs(getNeighbors, 0 as NodeId)
    expect(result.parent.get(0 as NodeId)).toBeNull()
  })

  test('single node graph', () => {
    const getNeighbors = () => [] as NodeId[]
    const result = dfs(getNeighbors, 42 as NodeId)
    expect(result.pre).toEqual([42])
    expect(result.post).toEqual([42])
    expect(result.parent.get(42 as NodeId)).toBeNull()
  })
})

// ──────────────────────────────────────────
// PageRank
// ──────────────────────────────────────────

describe('pagerank', () => {
  test('should produce valid probability distribution', () => {
    const { getNeighbors, allNodes } = createTestGraph()
    const result = pagerank(getNeighbors, allNodes)
    let sum = 0
    for (const [, rank] of result) {
      sum += rank
    }
    // PageRank 近似概率分布，总和 ≈ 1
    expect(sum).toBeCloseTo(1, 1)
  })

  test('all nodes should have a score', () => {
    const { getNeighbors, allNodes } = createTestGraph()
    const result = pagerank(getNeighbors, allNodes)
    for (const node of allNodes) {
      expect(result.has(node)).toBe(true)
      expect(result.get(node)!).toBeGreaterThan(0)
    }
  })

  test('single node returns 1.0', () => {
    const result = pagerank(() => [], [42 as NodeId])
    expect(result.get(42 as NodeId)).toBeCloseTo(1, 5)
  })

  test('empty graph returns empty map', () => {
    const result = pagerank(() => [], [])
    expect(result.size).toBe(0)
  })
})

// ──────────────────────────────────────────
// Dijkstra
// ──────────────────────────────────────────

describe('dijkstra', () => {
  test('should find shortest distances from start', () => {
    const { getWeightedNeighbors } = createWeightedGraph()
    const result = dijkstra(getWeightedNeighbors, 0 as NodeId)

    expect(result.get(0 as NodeId)!.distance).toBe(0)
    expect(result.get(1 as NodeId)!.distance).toBe(1)
    // 路径 0→1→2 权重和为 3（比 0→2 直接 5 更短）
    expect(result.get(2 as NodeId)!.distance).toBe(3)
  })

  test('should set parent correctly', () => {
    const { getWeightedNeighbors } = createWeightedGraph()
    const result = dijkstra(getWeightedNeighbors, 0 as NodeId)

    expect(result.get(0 as NodeId)!.parent).toBeNull()
    // 最优路径: 0 → 1 (weight 1) → 2 (weight 2)
    expect(result.get(1 as NodeId)!.parent).toBe(0)
    expect(result.get(2 as NodeId)!.parent).toBe(1)
  })

  test('single node returns distance 0', () => {
    const result = dijkstra(() => [], 42 as NodeId)
    expect(result.get(42 as NodeId)!.distance).toBe(0)
    expect(result.get(42 as NodeId)!.parent).toBeNull()
  })
})
