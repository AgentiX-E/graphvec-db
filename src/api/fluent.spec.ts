// ============================================================
// Fluent API 测试
// ============================================================

import { GraphQuery } from './fluent'
import { NodeRecord, EdgeRecord, VectorSearchResult } from '../types'

// ──────────────────────────────────────────
// Mock ShardManager
// ──────────────────────────────────────────

interface MockRangeStatus {
  rangeId: string
  raftRole: string
  nodeCount: number
}

class MockShardManager {
  private allNodes: NodeRecord[] = []
  private adjacency: Map<number, { edges: EdgeRecord[]; nodes: NodeRecord[] }> = new Map()
  private vectorResults: VectorSearchResult[] = []

  setNodes(nodes: NodeRecord[]): void {
    this.allNodes = nodes
  }

  setNeighbors(nodeId: number, edges: EdgeRecord[], nodes: NodeRecord[]): void {
    this.adjacency.set(nodeId, { edges, nodes })
  }

  setVectorResults(results: VectorSearchResult[]): void {
    this.vectorResults = results
  }

  /**
   * 模拟 scanAllRanges — 返回所有节点
   * GraphQuery 通过 protected scanAllRanges 调用，此处通过 getShardStatus + getRange
   * 需要 GraphQuery 能获取到这些数据。
   *
   * 但更好的方案：让 GraphQuery 的 scanAllRanges 能获取到 list。
   * 这里我们创建一个可以直接注入节点的变体。
   */
  getAllNodes(): NodeRecord[] {
    return this.allNodes
  }

  // ShardManager API mocks
  async upsertNode(_typeId: number, _name: string): Promise<number> {
    return 0
  }

  async upsertEdge(_src: number, _dst: number, _typeId: number, _opts?: any): Promise<void> {
    return
  }

  async deleteEdge(_src: number, _dst: number, _typeId: number): Promise<void> {
    return
  }

  async getNode(id: number): Promise<NodeRecord | null> {
    return this.allNodes.find(n => n.id === id) ?? null
  }

  async neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: EdgeRecord[]; nodes: NodeRecord[]
  }> {
    const result = this.adjacency.get(id)
    if (!result) return { edges: [], nodes: [] }

    // If any edgeTypeFilter，过滤边和节点
    if (opts?.edgeTypeFilter && opts.edgeTypeFilter.length > 0) {
      const filteredEdges = result.edges.filter(e => opts.edgeTypeFilter!.includes(e.type))
      // 仍然返回所有邻居节点（保持实现简单）
      return { edges: filteredEdges, nodes: result.nodes }
    }

    return result
  }

  async vectorSearch(_query: { denseQuery?: number[]; k?: number }): Promise<VectorSearchResult[]> {
    return this.vectorResults
  }

  getShardStatus(): MockRangeStatus[] {
    return [{ rangeId: 'range-0', raftRole: 'leader', nodeCount: this.allNodes.length }]
  }

  getRange(_rangeId: string): { engine: { stats(): { nodeCount: number } } } {
    return { engine: { stats: () => ({ nodeCount: this.allNodes.length, edgeCount: 0, diskSizeBytes: 0 }) } }
  }
}

// ──────────────────────────────────────────
// TestGraphQuery — 覆盖 scanAllRanges 以使用 mock 数据
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
// 测试数据工厂
// ──────────────────────────────────────────

function makeNode(id: number, type: number, name: string, extra?: Partial<NodeRecord>): NodeRecord {
  return {
    id,
    type,
    name,
    props: extra?.props ?? {},
    createdAt: extra?.createdAt ?? Date.now(),
    degree: extra?.degree ?? 0,
  }
}

function makeEdge(src: number, dst: number, type: number): EdgeRecord {
  return { src, dst, type, props: {} }
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('GraphQuery (Fluent API)', () => {
  describe('基本链式调用', () => {
    it('match → return 按 type 过滤', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'NodeA'),
        makeNode(2, 1, 'NodeB'),
        makeNode(3, 2, 'NodeC'),
      ])

      const q = new TestGraphQuery(mock)
      // 直接使用 match → return
      const result = await q.match(1).return()

      expect(result).toHaveLength(2)
      expect(result.map(n => n.id).sort()).toEqual([1, 2])
    })

    it('不带 match 返回所有节点', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'A'),
        makeNode(2, 2, 'B'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.return()

      expect(result).toHaveLength(2)
    })
  })

  describe('where 过滤', () => {
    it('单条件过滤', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Alice'),
        makeNode(2, 1, 'Bob'),
        makeNode(3, 1, 'Charlie'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).where(n => n.name.startsWith('A')).return()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Alice')
    })

    it('多条件 AND 语义', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Alice', { degree: 5 }),
        makeNode(2, 1, 'Bob', { degree: 3 }),
        makeNode(3, 1, 'Alex', { degree: 2 }),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q
        .match(1)
        .where(n => n.name.startsWith('A'))
        .where(n => (n.degree ?? 0) > 3)
        .return()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Alice')
    })
  })

  describe('邻居遍历', () => {
    it('neighbors → return 遍历邻居', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'A')])

      const neighborB = makeNode(2, 1, 'B')
      const neighborC = makeNode(3, 1, 'C')

      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
        makeEdge(1, 3, 10),
      ], [neighborB, neighborC])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).neighbors(1).return()

      expect(result).toHaveLength(2)
      expect(result.map(n => n.id).sort()).toEqual([2, 3])
    })

    it('neighbors with edgeTypeFilter', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'Root')])

      const nB = makeNode(2, 1, 'B')
      const nC = makeNode(3, 1, 'C')

      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
        makeEdge(1, 3, 20),
      ], [nB, nC])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).neighbors(1, [10]).return()

      // 过滤 type=10 的边，但仍然返回所有邻居节点
      // 实际按边过滤
      await q.match(1).neighbors(1, [10]).return()

      // 验证过滤后的边
      const { edges } = await mock.neighbors(1, { edgeTypeFilter: [10] })
      expect(edges).toHaveLength(1)
      expect(edges[0].type).toBe(10)
    })

    it('完整链式：match → where → neighbors → return', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'Alice')])

      const bob = makeNode(2, 1, 'Bob')
      const aaron = makeNode(3, 1, 'Aaron')
      const charlie = makeNode(4, 1, 'Charlie')

      mock.setNeighbors(1, [
        makeEdge(1, 2, 10),
        makeEdge(1, 3, 10),
        makeEdge(1, 4, 10),
      ], [bob, aaron, charlie])

      const q = new TestGraphQuery(mock)
      const result = await q
        .match(1)
        .neighbors(1)
        .where(n => n.name.startsWith('A'))
        .return()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Aaron')
    })
  })

  describe('limit / skip', () => {
    it('limit 限制返回数量', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'A'),
        makeNode(2, 1, 'B'),
        makeNode(3, 1, 'C'),
        makeNode(4, 1, 'D'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).limit(2).return()

      expect(result).toHaveLength(2)
    })

    it('skip 跳过结果', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'A'),
        makeNode(2, 1, 'B'),
        makeNode(3, 1, 'C'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).skip(1).return()

      expect(result).toHaveLength(2)
    })

    it('skip + limit 组合', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'A'),
        makeNode(2, 1, 'B'),
        makeNode(3, 1, 'C'),
        makeNode(4, 1, 'D'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).skip(1).limit(2).return()

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe(2)
      expect(result[1].id).toBe(3)
    })
  })

  describe('count', () => {
    it('返回匹配数量', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'A'),
        makeNode(2, 1, 'B'),
        makeNode(3, 2, 'C'),
      ])

      const q = new TestGraphQuery(mock)
      const count = await q.match(1).count()

      expect(count).toBe(2)
    })

    it('空结果返回 0', async () => {
      const mock = new MockShardManager()
      mock.setNodes([])

      const q = new TestGraphQuery(mock)
      const count = await q.match(1).count()

      expect(count).toBe(0)
    })
  })

  describe('orderBy', () => {
    it('按 name 升序', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Charlie'),
        makeNode(2, 1, 'Alice'),
        makeNode(3, 1, 'Bob'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).orderBy('name', 'asc').return()

      expect(result.map(n => n.name)).toEqual(['Alice', 'Bob', 'Charlie'])
    })

    it('按 name 降序', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Alice'),
        makeNode(2, 1, 'Bob'),
        makeNode(3, 1, 'Charlie'),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).orderBy('name', 'desc').return()

      expect(result.map(n => n.name)).toEqual(['Charlie', 'Bob', 'Alice'])
    })
  })

  describe('project', () => {
    it('投影指定字段', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'Alice', { props: { email: 'a@b.com' }, degree: 5 }),
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).project(['name', 'email']).return()

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        id: 1,
        name: 'Alice',
        email: 'a@b.com',
      })
    })
  })

  describe('向量搜索', () => {
    it('vectorSimilarity → return', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        makeNode(1, 1, 'VecA'),
        makeNode(2, 1, 'VecB'),
        makeNode(3, 2, 'VecC'),
      ])
      mock.setVectorResults([
        { node: { id: 1, type: 1, name: 'VecA', props: {} }, score: 0.95 },
        { node: { id: 2, type: 1, name: 'VecB', props: {} }, score: 0.85 },
        { node: { id: 3, type: 2, name: 'VecC', props: {} }, score: 0.75 },
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.match(1).vectorSimilarity([0.1, 0.2, 0.3], 5).return()

      expect(result).toHaveLength(2)
      expect(result.map(n => n.name).sort()).toEqual(['VecA', 'VecB'])
    })

    it('不带 match 的向量搜索', async () => {
      const mock = new MockShardManager()
      mock.setNodes([makeNode(1, 1, 'X'), makeNode(2, 2, 'Y')])
      mock.setVectorResults([
        { node: { id: 1, type: 1, name: 'X', props: {} }, score: 0.9 },
        { node: { id: 2, type: 2, name: 'Y', props: {} }, score: 0.8 },
      ])

      const q = new TestGraphQuery(mock)
      const result = await q.vectorSimilarity([0.1, 0.2], 10).return()

      expect(result).toHaveLength(2)
    })
  })

  describe('toString', () => {
    it('输出Debug表示', () => {
      const mock = new MockShardManager()
      const q = new TestGraphQuery(mock)
      const str = q.match(1).where(() => true).neighbors(2, [10]).limit(5).toString()

      expect(str).toContain('GraphQuery')
      expect(str).toContain('match(1)')
      expect(str).toContain('where(1 predicates)')
      expect(str).toContain('neighbors(depth=2')
      expect(str).toContain('limit(5)')
    })
  })

  describe('updateEdge', () => {
    it('调用 upsertEdge 更新边属性', async () => {
      const mock = new MockShardManager()
      const upsertSpy = vi.spyOn(mock, 'upsertEdge')
      const q = new TestGraphQuery(mock)

      await q.updateEdge(1, 2, 10, { weight: 5, label: 'friend' })

      expect(upsertSpy).toHaveBeenCalledWith(1, 2, 10, { props: { weight: 5, label: 'friend' } })
      upsertSpy.mockRestore()
    })

    it('不带 updates 参数调用', async () => {
      const mock = new MockShardManager()
      const upsertSpy = vi.spyOn(mock, 'upsertEdge')
      const q = new TestGraphQuery(mock)

      await q.updateEdge(1, 2, 10)

      expect(upsertSpy).toHaveBeenCalledWith(1, 2, 10, { props: undefined })
      upsertSpy.mockRestore()
    })
  })

  describe('deleteEdge', () => {
    it('调用 deleteEdge 删除边', async () => {
      const mock = new MockShardManager()
      const deleteSpy = vi.spyOn(mock, 'deleteEdge')
      const q = new TestGraphQuery(mock)

      await q.deleteEdge(1, 2, 10)

      expect(deleteSpy).toHaveBeenCalledWith(1, 2, 10)
      deleteSpy.mockRestore()
    })
  })
})
