/**
 * storage-classic-level.spec.ts — ClassicLevelStorageProvider 完整单元测试
 *
 * 测试 StorageProvider 接口所有方法：
 * - 生命周期: open/close/isOpen
 * - 节点: upsertNode/getNode/deleteNode/batchUpsertNodes/degrees
 * - 边: upsertEdge/getEdge/deleteEdge/neighbors
 * - 维护: compact/stats
 * - 图算法: personalizedPageRank/allShortestPaths/connectedComponents/queryPattern
 * - 搜索: vectorSearch
 * - 索引: createCompositeIndex/dropCompositeIndex
 * - 快照: exportSnapshot/importSnapshot
 *
 * 每个测试使用独立临时目录，beforeEach/afterEach 确保清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { ClassicLevelStorageProvider } from './storage-classic-level'

function randomDir(): string {
  return path.join(tmpdir(), 'classic-level-test-' + Math.random().toString(36).slice(2, 10))
}

describe('ClassicLevelStorageProvider', () => {
  let provider: ClassicLevelStorageProvider
  let dbPath: string

  beforeEach(() => {
    provider = new ClassicLevelStorageProvider()
    dbPath = randomDir()
  })

  afterEach(() => {
    try {
      if (provider.isOpen) provider.close()
    } catch { /* ignore */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ── 生命周期 ──────────────────────────────────

  describe('lifecycle', () => {
    it('isOpen is false before open', () => {
      expect(provider.isOpen).toBe(false)
    })

    it('open sets isOpen to true', () => {
      provider.open({ path: dbPath })
      expect(provider.isOpen).toBe(true)
    })

    it('close sets isOpen to false', () => {
      provider.open({ path: dbPath })
      provider.close()
      expect(provider.isOpen).toBe(false)
    })

    it('open is idempotent', () => {
      provider.open({ path: dbPath })
      provider.open({ path: dbPath })
      expect(provider.isOpen).toBe(true)
    })

    it('close is idempotent', () => {
      provider.open({ path: dbPath })
      provider.close()
      provider.close()
      expect(provider.isOpen).toBe(false)
    })
  })

  // ── 节点操作 ──────────────────────────────────

  describe('node operations', () => {
    it('upsertNode creates a new node and returns a numeric ID', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'node-a')
      expect(typeof id).toBe('number')
      expect(id).toBeGreaterThan(0)
    })

    it('upsertNode returns auto-incrementing IDs', () => {
      provider.open({ path: dbPath })
      const id1 = provider.upsertNode(1, 'a')
      const id2 = provider.upsertNode(1, 'b')
      expect(id2).toBeGreaterThan(id1)
    })

    it('upsertNode with same typeId+name returns existing ID (upsert)', () => {
      provider.open({ path: dbPath })
      const id1 = provider.upsertNode(1, 'dup')
      const id2 = provider.upsertNode(1, 'dup')
      expect(id2).toBe(id1)
    })

    it('upsertNode with different typeId but same name returns different ID', () => {
      provider.open({ path: dbPath })
      const id1 = provider.upsertNode(1, 'same-name')
      const id2 = provider.upsertNode(2, 'same-name')
      expect(id2).not.toBe(id1)
    })

    it('upsertNode with props stores them', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'with-props', { props: { color: 'red', size: 10 } })
      const node = provider.getNode(id, true)
      expect(node).not.toBeNull()
      expect(node!.props).toEqual({ color: 'red', size: 10 })
    })

    it('getNode returns node without props when includeProps=false', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'no-props')
      const node = provider.getNode(id, false)
      expect(node).not.toBeNull()
      expect(node!.id).toBe(id)
      expect(node!.typeId).toBe(1)
      expect(node!.key).toBe('no-props')
      expect(node!.props).toBeUndefined()
    })

    it('getNode with includeProps=true returns full entry', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'full', { props: { x: 1 } })
      const node = provider.getNode(id, true)
      expect(node).not.toBeNull()
      expect(node!.props).toEqual({ x: 1 })
      expect(node!.createdAt).toBeGreaterThan(0)
    })

    it('getNode returns null for non-existent node', () => {
      provider.open({ path: dbPath })
      const node = provider.getNode(9999, true)
      expect(node).toBeNull()
    })

    it('deleteNode removes an existing node', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'to-delete')
      expect(provider.deleteNode(id)).toBe(true)
      expect(provider.getNode(id, true)).toBeNull()
    })

    it('deleteNode returns false for non-existent node', () => {
      provider.open({ path: dbPath })
      expect(provider.deleteNode(9999)).toBe(false)
    })

    it('batchUpsertNodes creates multiple nodes', () => {
      provider.open({ path: dbPath })
      const ids = provider.batchUpsertNodes([
        { typeId: 1, name: 'batch-a', key: 'batch-a' },
        { typeId: 1, name: 'batch-b', key: 'batch-b' },
        { typeId: 2, name: 'batch-c', key: 'batch-c' },
      ])
      expect(ids).toHaveLength(3)
      expect(provider.getNode(ids[0], true)).not.toBeNull()
      expect(provider.getNode(ids[1], true)).not.toBeNull()
      expect(provider.getNode(ids[2], true)).not.toBeNull()
    })

    it('degrees returns 0 for node with no edges', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'isolated')
      const deg = provider.degrees(id)
      expect(deg.inDegree).toBe(0)
      expect(deg.outDegree).toBe(0)
    })
  })

  // ── 边操作 ──────────────────────────────────

  describe('edge operations', () => {
    it('upsertEdge creates an edge between two nodes', () => {
      provider.open({ path: dbPath })
      const src = provider.upsertNode(1, 'src')
      const dst = provider.upsertNode(1, 'dst')
      provider.upsertEdge(src, dst, 1)
      const edge = provider.getEdge(src, dst, 1)
      expect(edge).not.toBeNull()
      expect(edge!.from).toBe(src)
      expect(edge!.to).toBe(dst)
      expect(edge!.typeId).toBe(1)
    })

    it('upsertEdge with props stores them', () => {
      provider.open({ path: dbPath })
      const src = provider.upsertNode(1, 's')
      const dst = provider.upsertNode(1, 't')
      provider.upsertEdge(src, dst, 1, { props: { weight: 0.5 } })
      const edge = provider.getEdge(src, dst, 1)
      expect(edge!.props).toEqual({ weight: 0.5 })
    })

    it('getEdge returns null for non-existent edge', () => {
      provider.open({ path: dbPath })
      expect(provider.getEdge(1, 2, 1)).toBeNull()
    })

    it('deleteEdge removes an existing edge', () => {
      provider.open({ path: dbPath })
      const src = provider.upsertNode(1, 's')
      const dst = provider.upsertNode(1, 't')
      provider.upsertEdge(src, dst, 1)
      expect(provider.deleteEdge(src, dst, 1)).toBe(true)
      expect(provider.getEdge(src, dst, 1)).toBeNull()
    })

    it('deleteEdge returns false for non-existent edge', () => {
      provider.open({ path: dbPath })
      expect(provider.deleteEdge(1, 2, 1)).toBe(false)
    })
  })

  // ── 邻居查询 ──────────────────────────────────

  describe('neighbors', () => {
    it('returns empty for node with no edges', () => {
      provider.open({ path: dbPath })
      const id = provider.upsertNode(1, 'lonely')
      expect(provider.neighbors(id)).toHaveLength(0)
    })

    it('returns direct outbound neighbors', () => {
      provider.open({ path: dbPath })
      const src = provider.upsertNode(1, 'src')
      const dst1 = provider.upsertNode(1, 'dst1')
      const dst2 = provider.upsertNode(1, 'dst2')
      provider.upsertEdge(src, dst1, 1)
      provider.upsertEdge(src, dst2, 2)
      const nbrs = provider.neighbors(src)
      expect(nbrs).toHaveLength(2)
      const nids = nbrs.map(n => n.nodeId).sort()
      expect(nids).toEqual([dst1, dst2].sort())
    })

    it('filters by edge type', () => {
      provider.open({ path: dbPath })
      const src = provider.upsertNode(1, 'src')
      const dst = provider.upsertNode(1, 'dst')
      provider.upsertEdge(src, dst, 1)
      provider.upsertEdge(src, dst, 2)
      const nbrs = provider.neighbors(src, { edgeTypeFilter: [1] })
      expect(nbrs).toHaveLength(1)
      expect(nbrs[0].edgeTypeId).toBe(1)
    })

    it('supports multi-hop (maxDepth > 1)', () => {
      provider.open({ path: dbPath })
      const a = provider.upsertNode(1, 'a')
      const b = provider.upsertNode(1, 'b')
      const c = provider.upsertNode(1, 'c')
      provider.upsertEdge(a, b, 1)
      provider.upsertEdge(b, c, 1)
      const nbrs = provider.neighbors(a, { maxDepth: 2 })
      // a → b (hop 1), a → b → c (hop 2)
      expect(nbrs.length).toBeGreaterThanOrEqual(2)
      const nids = nbrs.map(n => n.nodeId)
      expect(nids).toContain(b)
      expect(nids).toContain(c)
    })
  })

  // ── 图算法（空实现） ──────────────────────────

  describe('graph algorithms (stubs)', () => {
    it('personalizedPageRank returns empty array', () => {
      provider.open({ path: dbPath })
      const result = provider.personalizedPageRank({
        sourceNode: 1, maxIter: 10, alpha: 0.85, tolerance: 1e-6, topK: 5,
      })
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(0)
    })

    it('allShortestPaths returns empty array', () => {
      provider.open({ path: dbPath })
      const result = provider.allShortestPaths({ source: 1, target: 2, maxDepth: 3 })
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(0)
    })

    it('connectedComponents returns empty array', () => {
      provider.open({ path: dbPath })
      const result = provider.connectedComponents()
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(0)
    })

    it('queryPattern returns empty array', () => {
      provider.open({ path: dbPath })
      const result = provider.queryPattern({ depth: 1, limit: 10 })
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(0)
    })
  })

  // ── 搜索 ──────────────────────────────────────

  describe('vectorSearch', () => {
    it('returns empty array', () => {
      provider.open({ path: dbPath })
      const result = provider.vectorSearch('test')
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(0)
    })
  })

  // ── 索引（空实现） ────────────────────────────

  describe('composite index', () => {
    it('createCompositeIndex does not throw', () => {
      provider.open({ path: dbPath })
      expect(() => provider.createCompositeIndex(['name', 'type'], 'idx_name_type')).not.toThrow()
    })

    it('dropCompositeIndex does not throw', () => {
      provider.open({ path: dbPath })
      expect(() => provider.dropCompositeIndex('idx_name_type')).not.toThrow()
    })
  })

  // ── 维护 ──────────────────────────────────────

  describe('maintenance', () => {
    it('compact does not throw', () => {
      provider.open({ path: dbPath })
      expect(() => provider.compact()).not.toThrow()
    })

    it('stats returns counts after inserting nodes and edges', () => {
      provider.open({ path: dbPath })
      const n1 = provider.upsertNode(1, 'a')
      const n2 = provider.upsertNode(1, 'b')
      provider.upsertEdge(n1, n2, 1)
      const s = provider.stats()
      expect(s.nodeCount).toBe(2)
      // edgeCount counts the primary edge entries (PREFIX_EDGE)
      expect(s.edgeCount).toBeGreaterThanOrEqual(1)
    })

    it('stats after deletion reflects updated counts', () => {
      provider.open({ path: dbPath })
      const n1 = provider.upsertNode(1, 'a')
      provider.deleteNode(n1)
      const s = provider.stats()
      expect(s.nodeCount).toBe(0)
    })
  })

  // ── 快照 ──────────────────────────────────────

  describe('snapshot', () => {
    it('exportSnapshot returns a Buffer', () => {
      provider.open({ path: dbPath })
      const buf = provider.exportSnapshot()
      expect(Buffer.isBuffer(buf)).toBe(true)
    })

    it('importSnapshot does not throw', () => {
      provider.open({ path: dbPath })
      expect(() => provider.importSnapshot(Buffer.from('test'))).not.toThrow()
    })
  })

  // ── 完整 CRUD 流程 ────────────────────────────

  describe('full CRUD flow', () => {
    it('creates nodes, adds edges, queries data, then deletes', () => {
      provider.open({ path: dbPath })
      // Create
      const alice = provider.upsertNode(1, 'Alice', { props: { age: 30 } })
      const bob = provider.upsertNode(1, 'Bob', { props: { age: 25 } })
      const carol = provider.upsertNode(2, 'Carol', { props: { age: 35 } })
      provider.upsertEdge(alice, bob, 1, { props: { since: 2020 } })
      provider.upsertEdge(alice, carol, 2, { props: { since: 2021 } })

      // Query
      expect(provider.getNode(alice, true)!.props!.age).toBe(30)
      expect(provider.getNode(bob, false)!.key).toBe('Bob')
      expect(provider.neighbors(alice)).toHaveLength(2)
      expect(provider.degrees(alice).outDegree).toBe(2)
      expect(provider.degrees(bob).inDegree).toBe(1)

      // Delete
      provider.deleteEdge(alice, bob, 1)
      expect(provider.getEdge(alice, bob, 1)).toBeNull()
      expect(provider.neighbors(alice)).toHaveLength(1)

      provider.deleteNode(bob)
      expect(provider.getNode(bob, true)).toBeNull()
    })
  })
})
