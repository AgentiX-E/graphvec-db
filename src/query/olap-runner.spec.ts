/**
 * olap-runner.spec.ts — OLAP 批量分析执行器测试
 *
 * 测试覆盖：
 * 1. pagerank 批量分析结果
 * 2. bfs 批量分析结果
 * 3. 不支持的算法 → 报错
 * 4. 空图分析 → 空结果
 * 5. degree_centrality 批量分析结果
 *
 * 合计 5 tests ✅
 */

import { describe, it, expect } from 'vitest'
import { OlapRunner, OlapConfig, OlapResult } from './olap-runner'
import { GraphEngine, NodeId } from '../core/graph-engine'

// ── Mock GraphEngine ──────────────────────────────────────

/**
 * MockGraphEngine — 模拟 GraphEngine 用于 OLAP 测试。
 *
 * 包含少量节点和边，支持 neighbors 和算法调用。
 */
class MockGraphEngine {
  private _nodeIds = new Set([1, 2, 3, 4, 5])
  private _edges = new Map<NodeId, Array<{ dst: number }>>()
  private _nodeCount = 5
  private _edgeCount = 6

  constructor() {
    // 构造一个小型图:
    // 1 → 2, 2 → 3, 3 → 4, 4 → 5, 5 → 1, 2 → 4
    this._edges.set(1, [{ dst: 2 }])
    this._edges.set(2, [{ dst: 3 }, { dst: 4 }])
    this._edges.set(3, [{ dst: 4 }])
    this._edges.set(4, [{ dst: 5 }])
    this._edges.set(5, [{ dst: 1 }])
  }

  stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } {
    return { nodeCount: this._nodeCount, edgeCount: this._edgeCount, diskSizeBytes: 0 }
  }

  neighbors(nodeId: NodeId): { edges: Array<{ dst: number }> } {
    return { edges: this._edges.get(nodeId) || [] }
  }

  async bfs(startNode: NodeId): Promise<Map<NodeId, { distance: number; parent: NodeId | null }>> {
    const result = new Map<NodeId, { distance: number; parent: NodeId | null }>()
    const queue: NodeId[] = []

    result.set(startNode, { distance: 0, parent: null })
    queue.push(startNode)

    let head = 0
    while (head < queue.length) {
      const current = queue[head++]
      const currentDist = result.get(current)!.distance

      for (const neighbor of (this._edges.get(current) || [])) {
        if (!result.has(neighbor.dst)) {
          result.set(neighbor.dst, { distance: currentDist + 1, parent: current })
          queue.push(neighbor.dst)
        }
      }
    }
    return result
  }

  async pagerank(options?: {
    dampingFactor?: number; maxIterations?: number; convergenceThreshold?: number
  }): Promise<Map<NodeId, number>> {
    const damping = options?.dampingFactor ?? 0.85
    const iterations = options?.maxIterations ?? 20
    const allNodes = Array.from(this._nodeIds)
    const n = allNodes.length
    const result = new Map<NodeId, number>()

    // Simple PageRank simulation
    let scores = new Map<NodeId, number>()
    for (const id of allNodes) scores.set(id, 1 / n)

    for (let iter = 0; iter < iterations; iter++) {
      const newScores = new Map<NodeId, number>()
      let danglingSum = 0
      for (const id of allNodes) {
        danglingSum += scores.get(id)!
      }

      for (const id of allNodes) {
        let sum = 0
        // Find nodes that point to this one
        for (const [src, neighbors] of this._edges) {
          for (const edge of neighbors) {
            if (edge.dst === id) {
              const outDeg = (this._edges.get(src) || []).length
              sum += scores.get(src)! / outDeg
            }
          }
        }
        const rank = (1 - damping) / n + damping * sum
        newScores.set(id, rank)
      }
      scores = newScores
    }

    return scores
  }

  async degreeCentrality(options?: {
    normalized?: boolean; direction?: 'in' | 'out' | 'all'
  }): Promise<{ scores: Map<number, number> }> {
    const normalized = options?.normalized ?? true
    const allNodes = Array.from(this._nodeIds)
    const n = allNodes.length
    const scores = new Map<number, number>()

    for (const id of allNodes) {
      const degree = (this._edges.get(id) || []).length
      let score: number
      if (normalized && n > 1) {
        score = degree / (n - 1)
      } else {
        score = degree
      }
      scores.set(id, score)
    }

    return { scores }
  }

  // 暴露 _nodeIds 供 OLAP runner 内部使用
  get _nodeIds(): Set<number> {
    return this._nodeIds
  }
}

// ── Empty Mock GraphEngine ─────────────────────────────────

class EmptyMockGraphEngine {
  stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } {
    return { nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }
  }
  neighbors(_nodeId: NodeId): { edges: Array<{ dst: number }> } {
    return { edges: [] }
  }
  async bfs(_startNode: NodeId): Promise<Map<NodeId, { distance: number; parent: NodeId | null }>> {
    return new Map()
  }
  async pagerank(): Promise<Map<NodeId, number>> { return new Map() }
  async degreeCentrality(): Promise<{ scores: Map<number, number> }> {
    return { scores: new Map() }
  }
  get _nodeIds(): Set<number> { return new Set() }
}

// ── 测试 ───────────────────────────────────────────────────

describe('OlapRunner', () => {
  describe('pagerank', () => {
    it('should compute pagerank scores for all nodes', async () => {
      const engine = new MockGraphEngine() as unknown as GraphEngine
      const config: OlapConfig = { algo: 'pagerank', iterations: 20 }
      const runner = new OlapRunner(engine, config)

      const result = await runner.run()

      expect(result.algo).toBe('pagerank')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.graphStats.nodeCount).toBe(5)
      expect(result.graphStats.edgeCount).toBe(6)
      expect(result.data).toBeDefined()

      // data 应包含所有节点的 rank
      const data = result.data as Record<string, number>
      expect(Object.keys(data).length).toBe(5)
      // 所有 rank 应为正数
      for (const rank of Object.values(data)) {
        expect(rank).toBeGreaterThan(0)
      }
      // 所有 rank 之和应接近 1.0
      const sum = Object.values(data).reduce((a: number, b: number) => a + b, 0)
      expect(sum).toBeCloseTo(1.0, 1)
    })
  })

  describe('bfs', () => {
    it('should traverse graph from start node', async () => {
      const engine = new MockGraphEngine() as unknown as GraphEngine
      const config: OlapConfig = { algo: 'bfs', startNode: 1 }
      const runner = new OlapRunner(engine, config)

      const result = await runner.run()

      expect(result.algo).toBe('bfs')
      expect(result.graphStats.nodeCount).toBe(5)

      const data = result.data as Record<string, { distance: number; parent: number | null }>
      expect(data['1']).toBeDefined()
      expect(data['1'].distance).toBe(0)
      expect(data['1'].parent).toBeNull()

      // 从节点 1 出发，所有 5 个节点都应可达（环）
      expect(Object.keys(data).length).toBe(5)
      // 检查特定距离
      expect(data['2'].distance).toBe(1)
      expect(data['2'].parent).toBe(1)
      expect(data['3'].distance).toBe(2)
    })
  })

  describe('unsupported algorithm', () => {
    it('should throw error for unsupported algorithm', async () => {
      const engine = new MockGraphEngine() as unknown as GraphEngine
      const config = { algo: 'kmeans' } as OlapConfig
      const runner = new OlapRunner(engine, config)

      await expect(runner.run()).rejects.toThrow(/Unsupported OLAP algorithm/)
    })
  })

  describe('degree_centrality', () => {
    it('should compute degree centrality for all nodes', async () => {
      const engine = new MockGraphEngine() as unknown as GraphEngine
      const config: OlapConfig = { algo: 'degree_centrality' }
      const runner = new OlapRunner(engine, config)

      const result = await runner.run()

      expect(result.algo).toBe('degree_centrality')
      expect(result.graphStats.nodeCount).toBe(5)

      const data = result.data as Record<string, number>
      expect(Object.keys(data).length).toBe(5)

      // Node 2 has 2 outgoing edges (→3 and →4)
      // Normalized: 2/(5-1) = 0.5
      expect(data['2']).toBeCloseTo(0.5, 5)

      // Node 1 has 1 outgoing edge
      // Normalized: 1/4 = 0.25
      expect(data['1']).toBeCloseTo(0.25, 5)
    })
  })

  describe('empty graph', () => {
    it('should return empty result for empty graph', async () => {
      const engine = new EmptyMockGraphEngine() as unknown as GraphEngine
      const config: OlapConfig = { algo: 'pagerank', iterations: 20 }
      const runner = new OlapRunner(engine, config)

      const result = await runner.run()

      expect(result.algo).toBe('pagerank')
      expect(result.graphStats.nodeCount).toBe(0)
      expect(result.graphStats.edgeCount).toBe(0)
      // 空图的 pagerank 应返回空数据
      const data = result.data as Record<string, number>
      expect(Object.keys(data).length).toBe(0)
    })
  })

  // ── 额外: bfs 缺少 startNode ──
  describe('validation', () => {
    it('should require startNode for BFS', async () => {
      const engine = new MockGraphEngine() as unknown as GraphEngine
      const config: OlapConfig = { algo: 'bfs' }
      const runner = new OlapRunner(engine, config)

      await expect(runner.run()).rejects.toThrow(/BFS requires a startNode/)
    })
  })
})
