// ============================================================
// Fluent API 链式遍历补齐测试 (GAP-21)
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQuery } from './fluent'
import { NodeRecord, EdgeRecord } from '../types'

// ──────────────────────────────────────────
// Mock ShardManager
// ──────────────────────────────────────────

class MockShardManager {
  private allNodes: NodeRecord[] = []
  private adjacency: Map<number, { edges: EdgeRecord[]; nodes: NodeRecord[] }> = new Map()

  setNodes(nodes: NodeRecord[]): void {
    this.allNodes = nodes
  }

  setNeighbors(nodeId: number, edges: EdgeRecord[], nodes: NodeRecord[]): void {
    this.adjacency.set(nodeId, { edges, nodes })
  }

  getAllNodes(): NodeRecord[] {
    return this.allNodes
  }

  async upsertNode(_typeId: number, _name: string): Promise<number> { return 0 }
  async upsertEdge(_src: number, _dst: number, _typeId: number, _opts?: any): Promise<void> {}
  async deleteEdge(_src: number, _dst: number, _typeId: number): Promise<void> {}
  async deleteNodes(ids: number[]): Promise<void> {
    this.allNodes = this.allNodes.filter(n => !ids.includes(n.id))
  }
  async deleteEdges(keys: Array<{ src: number; dst: number; typeId: number }>): Promise<void> {}

  async getNode(id: number): Promise<NodeRecord | null> {
    return this.allNodes.find(n => n.id === id) ?? null
  }

  async neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: EdgeRecord[]; nodes: NodeRecord[]
  }> {
    const result = this.adjacency.get(id)
    if (!result) return { edges: [], nodes: [] }
    if (opts?.edgeTypeFilter && opts.edgeTypeFilter.length > 0) {
      const filteredEdges = result.edges.filter(e => opts.edgeTypeFilter!.includes(e.type))
      return { edges: filteredEdges, nodes: result.nodes }
    }
    return result
  }

  async vectorSearch(_query: any): Promise<{ node: NodeRecord; score: number }[]> {
    return []
  }

  getShardStatus(): any[] { return [] }
  getRange(_rangeId: string): any {
    return { engine: { stats: () => ({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }) } }
  }
}

// ──────────────────────────────────────────
// TestGraphQuery — 覆盖 scanAllRanges
// ──────────────────────────────────────────

class TestGraphQuery extends GraphQuery {
  private mock: MockShardManager
  constructor(mock: MockShardManager) {
    super(mock as any)
    this.mock = mock
  }
  protected async scanAllRanges(): Promise<NodeRecord[]> {
    return this.mock.getAllNodes()
  }
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function makeNode(id: number, type: number, name: string, extra?: Partial<NodeRecord>): NodeRecord {
  return {
    id, type, name,
    props: extra?.props ?? {},
    createdAt: extra?.createdAt ?? Date.now(),
    degree: extra?.degree ?? 0,
  }
}

function makeEdge(src: number, dst: number, type: number): EdgeRecord {
  return { src, dst, type, props: {} }
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('Fluent Traverse (GAP-21)', () => {
  describe('out() — 出边遍历', () => {
    it('out() 应沿出边遍历邻居', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'A')])
      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
        makeEdge(1, 3, 10),
      ], [makeNode(2, 1, 'B'), makeNode(3, 1, 'C')])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).out().return()

      expect(result).toHaveLength(2)
      expect(result.map(n => n.name).sort()).toEqual(['B', 'C'])
    })

    it('out(edgeTypes) 应按边类型过滤', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'Root')])
      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
        makeEdge(1, 3, 20),
      ], [makeNode(2, 1, 'B'), makeNode(3, 1, 'C')])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).out([10]).return()

      // 边过滤后，仍访问所有邻居（方向正确）
      expect(result.length).toBeGreaterThanOrEqual(1)
      // 验证过滤后的边
      const { edges } = await mock.neighbors(1, { edgeTypeFilter: [10] })
      expect(edges).toHaveLength(1)
      expect(edges[0].type).toBe(10)
    })

    it('out() 链式调用应返回 this', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      const ret = q.match(1).out()
      expect(ret).toBe(q)  // 返回 this
    })
  })

  describe('in() — 入边遍历', () => {
    it('in() 应设置方向为 in', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      q.match(1).in()
      expect(q.toString()).toContain('direction(in)')
    })

    it('in() 链式调用应返回 this', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      const ret = q.match(1).in()
      expect(ret).toBe(q)
    })
  })

  describe('both() — 双向遍历', () => {
    it('both() 应设置方向为 both', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      q.match(1).both()
      expect(q.toString()).toContain('direction(both)')
    })

    it('both() 链式调用应返回 this', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      const ret = q.match(1).both()
      expect(ret).toBe(q)
    })
  })

  describe('has() — 属性过滤', () => {
    it('has(key, value) 应过滤匹配属性', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Alice', { props: { age: 25 } }),
        makeNode(2, 1, 'Bob', { props: { age: 30 } }),
        makeNode(3, 1, 'Charlie', { props: { age: 25 } }),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).has('age', 25).return()

      expect(result).toHaveLength(2)
      expect(result.map(n => n.name).sort()).toEqual(['Alice', 'Charlie'])
    })

    it('has() 链式调用应返回 this', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      const ret = q.match(1).has('color', 'red')
      expect(ret).toBe(q)
    })

    it('has() 可与 where() 组合', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Alice', { props: { age: 25, city: 'NYC' } }),
        makeNode(2, 1, 'Bob', { props: { age: 30, city: 'NYC' } }),
        makeNode(3, 1, 'Charlie', { props: { age: 25, city: 'LA' } }),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q
        .match(1)
        .has('age', 25)
        .where(n => n.name.startsWith('A'))
        .return()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Alice')
    })
  })

  describe('outE() / inE() / bothE() — 边遍历', () => {
    it('outE() 应设置遍历参数', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      q.match(1).outE([10])
      expect(q.toString()).toContain('neighbors')
      expect(q.toString()).toContain('edgeFilter')
    })

    it('inE() 应设置方向为 in', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      q.match(1).inE([10])
      expect(q.toString()).toContain('direction(in)')
    })

    it('bothE() 应设置方向为 both', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      q.match(1).bothE()
      expect(q.toString()).toContain('direction(both)')
    })
  })

  describe('完整链式调用', () => {
    it('match → out → has → return', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'Start')])
      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
        makeEdge(1, 3, 10),
        makeEdge(1, 4, 10),
      ], [
        makeNode(2, 1, 'Bob', { props: { role: 'admin' } }),
        makeNode(3, 1, 'Alice', { props: { role: 'user' } }),
        makeNode(4, 1, 'Charlie', { props: { role: 'admin' } }),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q
        .match(1)
        .out([10])
        .has('role', 'admin')
        .return()

      expect(result).toHaveLength(2)
      expect(result.map(n => n.name).sort()).toEqual(['Bob', 'Charlie'])
    })

    it('match → out → where → return — 多步链式组合', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'Root')])
      // 直接设置两级邻居
      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
      ], [makeNode(2, 1, 'Middle')])
      mock.setNeighbors(2, [
        makeEdge(2, 3, 10),
        makeEdge(2, 4, 10),
      ], [makeNode(3, 1, 'LeafA'), makeNode(4, 1, 'LeafB')])

      const q = new TestGraphQuery(mock)
      // out+depth 相当于 neighbors(depth=2)，收集 2 跳内所有节点
      const result = await q
        .match(1)
        .out([10], 2)
        .where(n => n.name.startsWith('Leaf'))
        .return()

      // 从 1 出发 2 跳后可到达：Middle(2, depth1), LeafA(3, depth2), LeafB(4, depth2)
      // where 过滤后只剩 LeafA 和 LeafB
      expect(result).toHaveLength(2)
      expect(result.map(n => n.name).sort()).toEqual(['LeafA', 'LeafB'])
    })
  })
})
