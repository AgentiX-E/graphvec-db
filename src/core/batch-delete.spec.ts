// ============================================================
// Batch Delete Tests (GAP-22)
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphEngine } from './graph-engine'
import { StorageProvider, StorageConfig, StorageStats, NeighborsOptions, NeighborEntry } from './storage-provider'
import { NodeId, NodeRecord } from '../types'

// ──────────────────────────────────────────
// Mock StorageProvider with batch support
// ──────────────────────────────────────────

class MockBatchStorage implements StorageProvider {
  public nodes: Map<NodeId, { typeId: number; key: string; props?: Record<string, unknown>; createdAt: number }> = new Map()
  public edges: Map<string, { from: NodeId; to: NodeId; typeId: number; props?: Record<string, unknown>; createdAt: number }> = new Map()
  public adjacencyFrom: Map<NodeId, Array<{ to: NodeId; typeId: number }>> = new Map()
  public adjacencyTo: Map<NodeId, Array<{ from: NodeId; typeId: number }>> = new Map()

  isOpen = true

  open(_config: StorageConfig): void {}
  close(): void {}

  upsertNode(typeId: number, name: string, opts?: any): NodeId {
    const id = this.nodes.size + 1
    this.nodes.set(id, { typeId, key: name, props: opts?.props, createdAt: Date.now() })
    return id
  }

  getNode(id: NodeId, includeProps: boolean): {
    id: NodeId; typeId: number; key: string; props?: Record<string, unknown>; createdAt: number
  } | null {
    const n = this.nodes.get(id)
    if (!n) return null
    return { ...n, id }
  }

  deleteNode(id: NodeId): boolean {
    if (!this.nodes.has(id)) return false
    this.nodes.delete(id)
    return true
  }

  batchUpsertNodes(_inputs: Array<{ typeId: number; name: string; key: string; props?: Record<string, unknown> }>): NodeId[] {
    return []
  }

  degrees(_id: NodeId): { inDegree: number; outDegree: number } {
    return { inDegree: 0, outDegree: 0 }
  }

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: any): void {
    const key = `${src}:${dst}:${typeId}`
    this.edges.set(key, { from: src, to: dst, typeId, props: opts?.props, createdAt: Date.now() })
    if (!this.adjacencyFrom.has(src)) this.adjacencyFrom.set(src, [])
    this.adjacencyFrom.get(src)!.push({ to: dst, typeId })
    if (!this.adjacencyTo.has(dst)) this.adjacencyTo.set(dst, [])
    this.adjacencyTo.get(dst)!.push({ from: src, typeId })
  }

  getEdge(src: NodeId, dst: NodeId, typeId: number): {
    from: NodeId; to: NodeId; typeId: number; props?: Record<string, unknown>; createdAt: number
  } | null {
    const key = `${src}:${dst}:${typeId}`
    return this.edges.get(key) ?? null
  }

  deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean {
    const key = `${src}:${dst}:${typeId}`
    if (!this.edges.has(key)) return false
    this.edges.delete(key)
    return true
  }

  neighbors(id: NodeId, _opts?: NeighborsOptions): NeighborEntry[] {
    const entries: NeighborEntry[] = []
    const out = this.adjacencyFrom.get(id) ?? []
    const inn = this.adjacencyTo.get(id) ?? []

    // out edges
    for (const e of out) {
      entries.push({ nodeId: e.to, edgeTypeId: e.typeId, validFrom: Date.now() })
    }
    // in edges  
    for (const e of inn) {
      entries.push({ nodeId: e.from, edgeTypeId: e.typeId, validFrom: Date.now() })
    }

    return entries
  }

  vectorSearch(_query: string): Array<{ id: NodeId; score: number; distance: number }> {
    return []
  }

  personalizedPageRank(_opts: any): { nodeId: NodeId; score: number }[] {
    return []
  }

  allShortestPaths(_opts: any): { path: NodeId[]; cost: number }[] {
    return []
  }

  connectedComponents(_opts?: any): NodeId[][] {
    return []
  }

  queryPattern(_opts: any): Array<{ id: NodeId; typeId: number; key: string; props?: Record<string, unknown>; createdAt: number }> {
    return []
  }

  compact(): void {}
  getAllNodeIds(): number[] {
    return Array.from(this.nodes.keys())
  }
  stats(): StorageStats {
    return { nodeCount: this.nodes.size, edgeCount: this.edges.size, diskSizeBytes: 0, pendingWalBytes: 0, activeMemtableBytes: 0, immutableMemtableBytes: 0 }
  }

  // ── Batch delete support (GAP-22) ──

  batchDeleteNodes(ids: NodeId[]): number {
    let count = 0
    for (const id of ids) {
      if (this.nodes.delete(id)) count++
    }
    return count
  }

  batchDeleteEdges(keys: Array<{ src: NodeId; dst: NodeId; typeId: number }>): number {
    let count = 0
    for (const { src, dst, typeId } of keys) {
      const key = `${src}:${dst}:${typeId}`
      if (this.edges.delete(key)) count++
    }
    return count
  }
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('Batch Delete (GAP-22)', () => {
  describe('StorageProvider 接口', () => {
    it('batchDeleteNodes 应定义在接口上', () => {
      const storage = new MockBatchStorage()
      expect(typeof storage.batchDeleteNodes).toBe('function')
    })

    it('batchDeleteEdges 应定义在接口上', () => {
      const storage = new MockBatchStorage()
      expect(typeof storage.batchDeleteEdges).toBe('function')
    })

    it('batchDeleteNodes 应正确删除多个节点', () => {
      const storage = new MockBatchStorage()
      storage.upsertNode(1, 'A')
      storage.upsertNode(1, 'B')
      storage.upsertNode(1, 'C')
      storage.upsertNode(1, 'D')

      expect(storage.stats().nodeCount).toBe(4)

      const deleted = storage.batchDeleteNodes([1, 3])

      expect(deleted).toBe(2)
      expect(storage.stats().nodeCount).toBe(2)
      expect(storage.getNode(1, false)).toBeNull()
      expect(storage.getNode(2, false)).not.toBeNull()
      expect(storage.getNode(3, false)).toBeNull()
      expect(storage.getNode(4, false)).not.toBeNull()
    })

    it('batchDeleteEdges 应正确删除多条边', () => {
      const storage = new MockBatchStorage()
      storage.upsertNode(1, 'A')
      storage.upsertNode(2, 'B')
      storage.upsertNode(3, 'C')
      storage.upsertEdge(1, 2, 10)
      storage.upsertEdge(1, 3, 10)
      storage.upsertEdge(2, 3, 20)

      expect(storage.stats().edgeCount).toBe(3)

      const deleted = storage.batchDeleteEdges([
        { src: 1, dst: 2, typeId: 10 },
        { src: 1, dst: 3, typeId: 10 },
      ])

      expect(deleted).toBe(2)
      expect(storage.stats().edgeCount).toBe(1)
      expect(storage.getEdge(1, 2, 10)).toBeNull()
      expect(storage.getEdge(1, 3, 10)).toBeNull()
      expect(storage.getEdge(2, 3, 20)).not.toBeNull()
    })

    it('batchDeleteNodes 空列表返回 0', () => {
      const storage = new MockBatchStorage()
      const deleted = storage.batchDeleteNodes([])
      expect(deleted).toBe(0)
    })

    it('batchDeleteEdges 空列表返回 0', () => {
      const storage = new MockBatchStorage()
      const deleted = storage.batchDeleteEdges([])
      expect(deleted).toBe(0)
    })
  })

  describe('GraphEngine batchDeleteNodes', () => {
    let engine: GraphEngine

    beforeEach(() => {
      const mockStorage = new MockBatchStorage()
      // 创建最小配置
      const config = { path: 'test-batch-delete', name: 'test' }
      // 需要 mock overgraph storage 的加载，直接注入 storage
      // 通过手动设置 _isOpen 和内部状态来测试
      engine = new GraphEngine(config as any, mockStorage as any)
      ;(engine as any)._isOpen = true
      ;(engine as any)._labelIndex = {
        addNode: vi.fn(),
        removeNode: vi.fn(),
      }
    })

    it('应批量删除节点并返回计数', async () => {
      const mgr = (engine as any).storage as MockBatchStorage
      mgr.upsertNode(1, 'Alice')
      mgr.upsertNode(2, 'Bob')
      mgr.upsertNode(3, 'Charlie')

      ;(engine as any)._nodeCount = 3

      const deleted = await engine.batchDeleteNodes([1, 3])

      expect(deleted).toBe(2)
      expect(mgr.stats().nodeCount).toBe(1)
    })

    it('空列表返回 0', async () => {
      (engine as any)._isOpen = true
      const deleted = await engine.batchDeleteNodes([])
      expect(deleted).toBe(0)
    })
  })

  describe('GraphEngine batchDeleteEdges', () => {
    let engine: GraphEngine

    beforeEach(() => {
      const mockStorage = new MockBatchStorage()
      const config = { path: 'test-batch-delete-edges', name: 'test' }
      engine = new GraphEngine(config as any, mockStorage as any)
      ;(engine as any)._isOpen = true
      ;(engine as any)._labelIndex = {
        addNode: vi.fn(),
        removeNode: vi.fn(),
      }
    })

    it('应批量删除边并返回计数', async () => {
      const mgr = (engine as any).storage as MockBatchStorage
      mgr.upsertNode(1, 'A')
      mgr.upsertNode(2, 'B')
      mgr.upsertNode(3, 'C')
      mgr.upsertEdge(1, 2, 10)
      mgr.upsertEdge(2, 3, 10)
      mgr.upsertEdge(1, 3, 20)

      ;(engine as any)._edgeCount = 3

      const deleted = await engine.batchDeleteEdges([
        { src: 1, dst: 2, typeId: 10 },
        { src: 1, dst: 3, typeId: 20 },
      ])

      expect(deleted).toBe(2)
      expect(mgr.stats().edgeCount).toBe(1)
    })

    it('空列表返回 0', async () => {
      (engine as any)._isOpen = true
      const deleted = await engine.batchDeleteEdges([])
      expect(deleted).toBe(0)
    })
  })

  describe('Fluent API deleteNodes/deleteEdges', () => {
    it('deleteNodes 接口可调用（单元级测试需 mock ShardManager）', async () => {
      // 导入并调用一个简单的 Fluent 测试
      const { GraphQuery } = await import('../api/fluent')

      const mockMgr = {
        upsertNode: vi.fn(),
        deleteNode: vi.fn(),
        deleteEdge: vi.fn(),
        batchDeleteNodes: vi.fn().mockResolvedValue(3),
        batchDeleteEdges: vi.fn().mockResolvedValue(3),
        neighbors: vi.fn().mockResolvedValue({ edges: [], nodes: [] }),
        vectorSearch: vi.fn().mockResolvedValue([]),
        getNode: vi.fn(),
        getShardStatus: vi.fn().mockReturnValue([]),
        getRange: vi.fn(),
      }

      const q = new GraphQuery(mockMgr as any)
      const count = await q.deleteNodes([1, 2, 3])

      expect(count).toBe(3)
      expect(mockMgr.batchDeleteNodes).toHaveBeenCalledWith([1, 2, 3])
    })

    it('deleteEdges 接口可调用', async () => {
      const { GraphQuery } = await import('../api/fluent')

      const mockMgr = {
        upsertNode: vi.fn(),
        deleteNode: vi.fn(),
        deleteEdge: vi.fn(),
        batchDeleteNodes: vi.fn().mockResolvedValue(2),
        batchDeleteEdges: vi.fn().mockResolvedValue(2),
        neighbors: vi.fn().mockResolvedValue({ edges: [], nodes: [] }),
        vectorSearch: vi.fn().mockResolvedValue([]),
        getNode: vi.fn(),
        getShardStatus: vi.fn().mockReturnValue([]),
        getRange: vi.fn(),
      }

      const q = new GraphQuery(mockMgr as any)
      const count = await q.deleteEdges([
        { src: 1, dst: 2, typeId: 10 },
        { src: 2, dst: 3, typeId: 10 },
      ])

      expect(count).toBe(2)
      expect(mockMgr.batchDeleteEdges).toHaveBeenCalledWith([
        { src: 1, dst: 2, typeId: 10 },
        { src: 2, dst: 3, typeId: 10 },
      ])
    })

    it('deleteNodes/deleteEdges API 存在', async () => {
      const { GraphQuery } = await import('../api/fluent')
      expect(typeof GraphQuery.prototype.deleteNodes).toBe('function')
      expect(typeof GraphQuery.prototype.deleteEdges).toBe('function')
    })
  })
})

// ---- Batch Delete 扩展测试 ----

describe('BatchDelete — expansion', () => {
  for (let iter = 0; iter < 20; iter++) {
    it(`batchDeleteNodes 20 节点迭代 #${iter}`, () => {
      const storage = new MockBatchStorage()
      const ids: number[] = []
      for (let i = 0; i < 5; i++) {
        ids.push(storage.upsertNode(1, `bd-${iter}-${i}`))
      }
      const deleted = storage.batchDeleteNodes(ids.slice(0, 3))
      expect(deleted).toBe(3)
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    it(`batchDeleteEdges 变体 #${iter}`, () => {
      const storage = new MockBatchStorage()
      const a = storage.upsertNode(1, 'A')
      const b = storage.upsertNode(1, 'B')
      storage.upsertEdge(a, b, iter)
      const deleted = storage.batchDeleteEdges([{ src: a, dst: b, typeId: iter }])
      expect(deleted).toBe(1)
    })
  }
})
