/**
 * 图算法纯函数单元测试
 *
 * 测试 bfs / dfs / pagerank / dijkstra 四个纯函数算法，
 * 以及 BatchProcessor、pagerankStream、bfsStream 流式变体。
 * 不依赖 GraphEngine，仅测试算法逻辑正确性。
 */

import { describe, test, expect } from 'vitest'
import { NodeId, NodeRecord } from '../types'
import { bfs } from './bfs'
import { dfs } from './dfs'
import { pagerank } from './pagerank'
import { dijkstra } from './dijkstra'
import { BatchProcessor } from './batch-processor'
import { pagerankStream } from './pagerank-stream'
import { bfsStream } from './bfs-stream'
import { closeness } from './closeness'

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
// 辅助：构建 AsyncIterable<NodeRecord[]> 用于流式测试
// ──────────────────────────────────────────

async function* iterableBatches<T>(batches: T[][]): AsyncIterable<T[]> {
  for (const batch of batches) {
    yield batch
  }
}

function toNodeRecords(ids: NodeId[]): NodeRecord[] {
  return ids.map(id => ({ id, type: 1, name: String(id), props: {} }))
}

// ──────────────────────────────────────────
// 辅助：创建大规模图用于流式测试
// ──────────────────────────────────────────

function createLargeGraph(nodeCount: number) {
  const neighbors: Record<number, number[]> = {}
  for (let i = 0; i < nodeCount; i++) {
    // 链式结构方便验证
    const nb: number[] = []
    if (i + 1 < nodeCount) nb.push(i + 1)
    neighbors[i] = nb
  }
  return {
    allNodes: Array.from({ length: nodeCount }, (_, i) => i) as NodeId[],
    getNeighbors: (nid: NodeId) => neighbors[nid] ?? [],
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

// ──────────────────────────────────────────
// BatchProcessor
// ──────────────────────────────────────────

describe('BatchProcessor', () => {
  const bp = new BatchProcessor()

  test('splitIntoBatches should divide array correctly', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(bp.splitIntoBatches(items, 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10],
    ])
  })

  test('splitIntoBatches with batchSize equal to length', () => {
    const items = [1, 2, 3]
    expect(bp.splitIntoBatches(items, 3)).toEqual([[1, 2, 3]])
  })

  test('splitIntoBatches with empty array', () => {
    expect(bp.splitIntoBatches([], 10)).toEqual([])
  })

  test('splitIntoBatches throws on zero or negative batchSize', () => {
    expect(() => bp.splitIntoBatches([1], 0)).toThrow('batchSize must be > 0')
    expect(() => bp.splitIntoBatches([1], -1)).toThrow('batchSize must be > 0')
  })

  test('processInBatches processes all items', async () => {
    const items = [1, 2, 3, 4, 5]
    const result = await bp.processInBatches(
      items,
      async (batch) => batch.map(x => x * 2),
      2,
    )
    expect(result).toEqual([2, 4, 6, 8, 10])
  })

  test('processInBatches with empty items returns empty', async () => {
    const result = await bp.processInBatches(
      [],
      async (batch) => batch,
      10,
    )
    expect(result).toEqual([])
  })

  test('processInBatches preserves order across batches', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    const result = await bp.processInBatches(
      items,
      async (batch) => batch,
      10,
    )
    expect(result).toEqual(items)
  })
})

// ──────────────────────────────────────────
// pagerankStream
// ──────────────────────────────────────────

describe('pagerankStream', () => {
  test('should match full-memory PageRank on small graph within 1%', async () => {
    const { getNeighbors, allNodes } = createTestGraph()

    // 全内存 PageRank
    const expected = pagerank(getNeighbors, allNodes)

    // 流式 PageRank：分 2 批
    const batches = iterableBatches([
      toNodeRecords([0, 1, 2]),
      toNodeRecords([3, 4]),
    ])
    const result = await pagerankStream(getNeighbors, batches, {
      maxIterations: 100,
      convergenceThreshold: 1e-6,
      localIterations: 5,
    })

    // 每个节点的 rank 偏差 < 1%
    for (const node of allNodes) {
      const expectedRank = expected.get(node)!
      const actualRank = result.get(node)!
      // 处理极小值的边界情况
      if (expectedRank > 1e-10) {
        const diff = Math.abs(actualRank - expectedRank) / expectedRank
        expect(diff).toBeLessThan(0.01)
      }
    }
  })

  test('should match full-memory PageRank on 1K chain graph within 5%', async () => {
    const nodeCount = 1000
    const { getNeighbors, allNodes } = createLargeGraph(nodeCount)

    // 全内存 PageRank（降低迭代次数和阈值以控制时间）
    const expected = pagerank(getNeighbors, allNodes, {
      maxIterations: 20,
      convergenceThreshold: 1e-4,
    })

    // 流式 PageRank：按 250 一批分 4 批
    const batches = iterableBatches([
      toNodeRecords(allNodes.slice(0, 250)),
      toNodeRecords(allNodes.slice(250, 500)),
      toNodeRecords(allNodes.slice(500, 750)),
      toNodeRecords(allNodes.slice(750)),
    ])
    const result = await pagerankStream(getNeighbors, batches, {
      maxIterations: 20,
      convergenceThreshold: 1e-4,
      localIterations: 5,
    })

    // 抽样检查前 20 个节点，偏差 < 1%
    const sampleSize = Math.min(20, allNodes.length)
    for (let i = 0; i < sampleSize; i++) {
      const node = allNodes[i]
      const expectedRank = expected.get(node)!
      const actualRank = result.get(node)!
      if (expectedRank > 1e-10) {
        const diff = Math.abs(actualRank - expectedRank) / expectedRank
        expect(diff).toBeLessThan(0.05)
      }
    }
  })

  test('should handle single batch same as full memory', async () => {
    const { getNeighbors, allNodes } = createTestGraph()
    const expected = pagerank(getNeighbors, allNodes)

    const batches = iterableBatches([toNodeRecords(allNodes)])
    const result = await pagerankStream(getNeighbors, batches)

    expect(result.size).toBe(expected.size)
    for (const node of allNodes) {
      const diff = Math.abs(result.get(node)! - expected.get(node)!)
      expect(diff).toBeLessThan(0.01)
    }
  })

  test('empty graph returns empty map', async () => {
    const result = await pagerankStream(
      () => [],
      iterableBatches([]),
    )
    expect(result.size).toBe(0)
  })
})

// ──────────────────────────────────────────
// bfsStream
// ──────────────────────────────────────────

describe('bfsStream', () => {
  test('should find same reachable set as full BFS on small graph', async () => {
    const { getNeighbors } = createTestGraph()

    // 全内存 BFS
    const expected = bfs(getNeighbors, 0 as NodeId)

    // 流式 BFS
    const batches = iterableBatches([
      toNodeRecords([0, 1]),
      toNodeRecords([2, 3, 4]),
    ])
    const result = await bfsStream(getNeighbors, 0 as NodeId, batches)

    // 可达集相同
    for (const node of expected.keys()) {
      expect(result.has(node)).toBe(true)
    }
    expect(result.size).toBe(expected.size)

    // distance 也应一致
    for (const [node, { distance }] of expected) {
      expect(result.get(node)!.distance).toBe(distance)
    }
  })

  test('should find same reachable set on 1K chain graph', async () => {
    const nodeCount = 1000
    const { getNeighbors, allNodes } = createLargeGraph(nodeCount)

    // 全内存 BFS
    const expected = bfs(getNeighbors, 0 as NodeId)

    // 流式 BFS：按 100 一批分 10 批
    const batchSize = 100
    const batches: NodeRecord[][] = []
    for (let i = 0; i < nodeCount; i += batchSize) {
      batches.push(toNodeRecords(allNodes.slice(i, i + batchSize)))
    }
    const result = await bfsStream(
      getNeighbors,
      0 as NodeId,
      iterableBatches(batches),
    )

    // 可达集相同
    expect(result.size).toBe(expected.size)
    for (const node of expected.keys()) {
      expect(result.has(node)).toBe(true)
    }
  })

  test('should respect maxBatchSize option', async () => {
    const nodeCount = 1000
    const { getNeighbors, allNodes } = createLargeGraph(nodeCount)

    const expected = bfs(getNeighbors, 0 as NodeId)

    const batches = iterableBatches([toNodeRecords(allNodes)])
    const result = await bfsStream(
      getNeighbors,
      0 as NodeId,
      batches,
      { maxBatchSize: 100 },
    )

    expect(result.size).toBe(expected.size)
    for (const node of expected.keys()) {
      expect(result.has(node)).toBe(true)
    }
  })

  test('single node stream returns {startNode: distance 0}', async () => {
    const result = await bfsStream(
      () => [],
      42 as NodeId,
      iterableBatches([toNodeRecords([42])]),
    )
    expect(result.size).toBe(1)
    expect(result.get(42 as NodeId)!.distance).toBe(0)
    expect(result.get(42 as NodeId)!.parent).toBeNull()
  })

  test('disconnected node is not in result', async () => {
    const neighbors: Record<number, number[]> = {}
    const getNeighbors = (nid: NodeId) => {
      // 5 是孤立节点
      const r: Record<number, number[]> = { 0: [1], 1: [0], 5: [] }
      return r[nid] ?? []
    }
    const batches = iterableBatches([
      toNodeRecords([0, 1, 5]),
    ])
    const result = await bfsStream(getNeighbors as any, 0 as NodeId, batches)
    expect(result.has(0 as NodeId)).toBe(true)
    expect(result.has(1 as NodeId)).toBe(true)
    // 5 不可达
    expect(result.has(5 as NodeId)).toBe(false)
  })
})

// ──────────────────────────────────────────
// Closeness Centrality
// ──────────────────────────────────────────

describe('Closeness Centrality', () => {
  test('middle node has highest closeness in a 3-node chain', () => {
    // Chain: 0 — 1 — 2
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
    }
    const getNeighbors = (nid: NodeId) => neighbors[nid] ?? []
    const allNodes: NodeId[] = [0, 1, 2]
    const result = closeness(getNeighbors, allNodes)

    // Node 1 (middle) should have the highest closeness
    expect(result.get(0 as NodeId)!).toBeLessThan(result.get(1 as NodeId)!)
    expect(result.get(2 as NodeId)!).toBeLessThan(result.get(1 as NodeId)!)

    // Verify values:
    // Node 0: distances to 1=1, 2=2 => sum=3, reachable=2 => score=2/3 ≈ 0.667
    // Node 1: distances to 0=1, 2=1 => sum=2, reachable=2 => score=2/2 = 1.0
    // Node 2: distances to 0=2, 1=1 => sum=3, reachable=2 => score=2/3 ≈ 0.667
    expect(result.get(0 as NodeId)!).toBeCloseTo(2 / 3, 5)
    expect(result.get(1 as NodeId)!).toBeCloseTo(1.0, 5)
    expect(result.get(2 as NodeId)!).toBeCloseTo(2 / 3, 5)
  })

  test('single node returns score 0', () => {
    const result = closeness(() => [], [42 as NodeId])
    expect(result.get(42 as NodeId)).toBe(0)
  })

  test('disconnected node returns score 0', () => {
    // Node 0 is connected to others, node 3 is disconnected
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0],
      2: [0],
      3: [],
    }
    const getNeighbors = (nid: NodeId) => neighbors[nid] ?? []
    const allNodes: NodeId[] = [0, 1, 2, 3]
    const result = closeness(getNeighbors, allNodes)

    // Disconnected node should score 0
    expect(result.get(3 as NodeId)).toBe(0)

    // Connected nodes should score > 0
    expect(result.get(0 as NodeId)!).toBeGreaterThan(0)
    expect(result.get(1 as NodeId)!).toBeGreaterThan(0)
    expect(result.get(2 as NodeId)!).toBeGreaterThan(0)
  })

  test('all nodes return scores > 0 for fully connected graph', () => {
    // Complete graph K4
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3],
      1: [0, 2, 3],
      2: [0, 1, 3],
      3: [0, 1, 2],
    }
    const getNeighbors = (nid: NodeId) => neighbors[nid] ?? []
    const allNodes: NodeId[] = [0, 1, 2, 3]
    const result = closeness(getNeighbors, allNodes)

    // In a complete graph, all nodes have closeness = (N-1)/(N-1) = 1.0
    for (const node of allNodes) {
      expect(result.get(node)!).toBeGreaterThan(0)
      expect(result.get(node)!).toBeCloseTo(1.0, 5)
    }
  })

  test('normalize=false returns raw 1/sumDistance values', () => {
    // Chain: 0 — 1 — 2
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
    }
    const getNeighbors = (nid: NodeId) => neighbors[nid] ?? []
    const allNodes: NodeId[] = [0, 1, 2]
    const result = closeness(getNeighbors, allNodes, { normalize: false })

    // Raw values: 1/sumDistance
    // Node 0: sumDist=3 => 1/3 ≈ 0.333
    // Node 1: sumDist=2 => 1/2 = 0.5
    // Node 2: sumDist=3 => 1/3 ≈ 0.333
    expect(result.get(0 as NodeId)!).toBeCloseTo(1 / 3, 5)
    expect(result.get(1 as NodeId)!).toBeCloseTo(1 / 2, 5)
    expect(result.get(2 as NodeId)!).toBeCloseTo(1 / 3, 5)
  })
})
