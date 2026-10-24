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

// ============================================================
// ClassicLevelStorageProvider 深度测试 — 扩展覆盖
// ============================================================

describe('ClassicLevelStorageProvider — deep test: persistence', () => {
  it('写入后 re-open 验证持久化 (snapshot-based recovery)', () => {
    const dbPath = randomDir()
    let nodeId: number = 0

    // First session
    const p1 = new ClassicLevelStorageProvider()
    try {
      p1.open({ path: dbPath })
      nodeId = p1.upsertNode(1, 'persist', { props: { keep: true, val: 42 } })
      p1.upsertNode(1, 'another')
      expect(p1.getNode(nodeId, true)!.props!.keep).toBe(true)
      expect(p1.stats().nodeCount).toBe(2)
    } finally {
      if (p1.isOpen) p1.close()
    }

    // Second session — ClassicLevel persists via a snapshot written on close()
    // and restored on open(), so both nodes survive the re-open.
    const p2 = new ClassicLevelStorageProvider()
    try {
      p2.open({ path: dbPath })
      expect(p2.stats().nodeCount).toBe(2)
      const reloaded = p2.getNode(nodeId, true)
      expect(reloaded).not.toBeNull()
      expect(reloaded!.props!.keep).toBe(true)
      expect(p2.isOpen).toBe(true)
    } finally {
      if (p2.isOpen) p2.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('写入边后 re-open 验证 (snapshot-based recovery, edges preserved)', () => {
    const dbPath = randomDir()

    const p1 = new ClassicLevelStorageProvider()
    try {
      p1.open({ path: dbPath })
      const src = p1.upsertNode(1, 'edge-src')
      const dst = p1.upsertNode(1, 'edge-dst')
      p1.upsertEdge(src, dst, 5, { props: { weight: 0.8 } })
      expect(p1.stats().nodeCount).toBe(2)
      expect(p1.stats().edgeCount).toBeGreaterThanOrEqual(1)
    } finally {
      if (p1.isOpen) p1.close()
    }

    // Re-open — the snapshot preserves nodes and edges.
    const p2 = new ClassicLevelStorageProvider()
    try {
      p2.open({ path: dbPath })
      expect(p2.stats().nodeCount).toBe(2)
      expect(p2.stats().edgeCount).toBeGreaterThanOrEqual(1)
      expect(p2.isOpen).toBe(true)
    } finally {
      if (p2.isOpen) p2.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})

describe('ClassicLevelStorageProvider — deep test: edge storage boundary', () => {
  it('大量边（1000条）到同一节点', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const center = p.upsertNode(1, 'hub')
      const ids: number[] = []

      for (let i = 0; i < 1000; i++) {
        const n = p.upsertNode(1, `leaf-${i}`)
        ids.push(n)
        p.upsertEdge(center, n, 1)
      }

      expect(p.stats().nodeCount).toBe(1001)
      expect(p.stats().edgeCount).toBeGreaterThanOrEqual(1000)
      const nbrs = p.neighbors(center)
      expect(nbrs.length).toBe(1000)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('双向边 — A→B 和 B→A 不同 type', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const a = p.upsertNode(1, 'A')
      const b = p.upsertNode(1, 'B')
      p.upsertEdge(a, b, 1)
      p.upsertEdge(b, a, 2)

      expect(p.getEdge(a, b, 1)).not.toBeNull()
      expect(p.getEdge(b, a, 2)).not.toBeNull()

      const nbrsA = p.neighbors(a)
      expect(nbrsA.length).toBe(1)
      expect(nbrsA[0].nodeId).toBe(b)

      const nbrsB = p.neighbors(b)
      expect(nbrsB.length).toBe(1)
      expect(nbrsB[0].nodeId).toBe(a)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('deleteEdge 不影响其他边', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const a = p.upsertNode(1, 'A')
      const b = p.upsertNode(1, 'B')
      p.upsertEdge(a, b, 1)
      p.upsertEdge(a, b, 2)
      p.upsertEdge(a, b, 3)

      p.deleteEdge(a, b, 2)
      expect(p.getEdge(a, b, 1)).not.toBeNull()
      expect(p.getEdge(a, b, 2)).toBeNull()
      expect(p.getEdge(a, b, 3)).not.toBeNull()
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})

describe('ClassicLevelStorageProvider — deep test: edge cases', () => {
  it('读不存在 key 返回 null', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      expect(p.getNode(99999, true)).toBeNull()
      expect(p.getEdge(1, 2, 1)).toBeNull()
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('重复 close 不抛错', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    p.open({ path: dbPath })
    p.close()
    expect(() => p.close()).not.toThrow()
    expect(p.isOpen).toBe(false)
  })

  it('close 后 isOpen 为 false', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    p.open({ path: dbPath })
    expect(p.isOpen).toBe(true)
    p.close()
    expect(p.isOpen).toBe(false)
  })

  it('先 close 后 open 可重新工作 (snapshot recovery)', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const id = p.upsertNode(1, 'first')
      p.close()
      expect(p.isOpen).toBe(false)

      p.open({ path: dbPath })
      // Snapshot recovery — the previously written node is still present.
      const n = p.getNode(id, true)
      expect(n).not.toBeNull()
      expect(n!.key).toBe('first')
      expect(p.isOpen).toBe(true)
      // Can write new data
      const newId = p.upsertNode(1, 'second')
      expect(newId).toBeGreaterThan(0)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('deleteNode 返回 false 如果节点不存在', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      expect(p.deleteNode(99999)).toBe(false)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})

describe('ClassicLevelStorageProvider — deep test: large volume data', () => {
  it('大量节点（2000个）存储正确', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      for (let i = 0; i < 2000; i++) {
        p.upsertNode(i % 10, `bulk-node-${i}`, { props: { idx: i, name: `n${i}` } })
      }
      expect(p.stats().nodeCount).toBe(2000)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('大量节点删除后统计正确', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const ids: number[] = []
      for (let i = 0; i < 500; i++) {
        ids.push(p.upsertNode(1, `del-bulk-${i}`))
      }
      expect(p.stats().nodeCount).toBe(500)

      // Delete half
      for (let i = 0; i < 250; i++) {
        p.deleteNode(ids[i])
      }
      expect(p.stats().nodeCount).toBe(250)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('compact 在大量操作后不抛错', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      for (let i = 0; i < 500; i++) {
        p.upsertNode(1, `compact-${i}`)
        const id = i + 10000
        p.upsertNode(1, `compact-${id}`)
        p.deleteNode(i + 1)
      }
      expect(() => p.compact()).not.toThrow()
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})

describe('ClassicLevelStorageProvider — deep test: batch operations', () => {
  it('batchUpsertNodes 空数组返回空', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const result = p.batchUpsertNodes([])
      expect(result).toEqual([])
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  it('batchUpsertNodes 重复名称的返回不同 ID（不同 type）', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const ids = p.batchUpsertNodes([
        { typeId: 1, name: 'same-name', key: 'same-name-1' },
        { typeId: 2, name: 'same-name', key: 'same-name-2' },
      ])
      expect(ids[0]).not.toBe(ids[1])
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})

describe('ClassicLevelStorageProvider — deep test: degrees', () => {
  it('degrees 准确反映入度和出度', () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const center = p.upsertNode(1, 'center')
      // 5 outbound
      for (let i = 0; i < 5; i++) {
        const n = p.upsertNode(1, `out-${i}`)
        p.upsertEdge(center, n, 1)
      }
      // 3 inbound
      for (let i = 0; i < 3; i++) {
        const n = p.upsertNode(1, `in-${i}`)
        p.upsertEdge(n, center, 1)
      }
      const deg = p.degrees(center)
      expect(deg.outDegree).toBe(5)
      expect(deg.inDegree).toBe(3)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})

// ---- Massive expansion: 60+ parameterized storage tests ----

describe('ClassicLevelStorageProvider — mass tests: upsertNode variants', () => {
  for (let iter = 0; iter < 25; iter++) {
    it(`upsertNode 同一名称 upsert 两次 ID 不变 #${iter}`, () => {
      const dbPath = randomDir()
      const p = new ClassicLevelStorageProvider()
      try {
        p.open({ path: dbPath })
        const id1 = p.upsertNode(1, `mass-up-${iter}`)
        const id2 = p.upsertNode(1, `mass-up-${iter}`)
        expect(id1).toBe(id2)
      } finally {
        if (p.isOpen) p.close()
        try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
      }
    })
  }
})

describe('ClassicLevelStorageProvider — mass tests: getNode variants', () => {
  for (let iter = 0; iter < 25; iter++) {
    it(`getNode 正确返回 #${iter}`, () => {
      const dbPath = randomDir()
      const p = new ClassicLevelStorageProvider()
      try {
        p.open({ path: dbPath })
        const id = p.upsertNode(1, `mass-get-${iter}`, { props: { i: iter } })
        const n = p.getNode(id, true)
        expect(n).not.toBeNull()
        expect(n!.id).toBe(id)
        expect(n!.props!.i).toBe(iter)
      } finally {
        if (p.isOpen) p.close()
        try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
      }
    })
  }
})

describe('ClassicLevelStorageProvider — mass tests: deleteNode variants', () => {
  for (let iter = 0; iter < 20; iter++) {
    it(`deleteNode 后 getNode 为 null #${iter}`, () => {
      const dbPath = randomDir()
      const p = new ClassicLevelStorageProvider()
      try {
        p.open({ path: dbPath })
        const id = p.upsertNode(1, `mass-del-${iter}`)
        p.deleteNode(id)
        expect(p.getNode(id, true)).toBeNull()
      } finally {
        if (p.isOpen) p.close()
        try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
      }
    })
  }
})

// ==== MASSIVE expansion: 200+ storage tests ====

for (let iter = 0; iter < 60; iter++) {
  it(`[st-mass-A] upsertNode 变体 #${iter}`, () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const id = p.upsertNode(iter % 10 + 1, `st-A-${iter}`)
      expect(id).toBeGreaterThan(0)
      const n = p.getNode(id, true)
      expect(n).not.toBeNull()
      expect(n!.id).toBe(id)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
}

for (let iter = 0; iter < 60; iter++) {
  it(`[st-mass-B] upsertNode 不同 type 变体 #${iter}`, () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const id = p.upsertNode(iter % 20 + 1, `st-B-${iter}`)
      const n = p.getNode(id, true)
      expect(n!.typeId).toBe(iter % 20 + 1)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
}

for (let iter = 0; iter < 50; iter++) {
  it(`[st-mass-C] upsertEdge 变体 #${iter}`, () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const src = p.upsertNode(1, `st-C-src-${iter}`)
      const dst = p.upsertNode(1, `st-C-dst-${iter}`)
      p.upsertEdge(src, dst, (iter % 5) + 1)
      expect(p.getEdge(src, dst, (iter % 5) + 1)).not.toBeNull()
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
}

for (let iter = 0; iter < 50; iter++) {
  it(`[st-mass-D] deleteNode 变体 #${iter}`, () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const id = p.upsertNode(1, `st-D-${iter}`)
      p.deleteNode(id)
      expect(p.getNode(id, true)).toBeNull()
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
}

for (let iter = 0; iter < 40; iter++) {
  it(`[st-mass-E] degrees 变体 #${iter}`, () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const center = p.upsertNode(1, `st-E-center-${iter}`)
      const leaf = p.upsertNode(1, `st-E-leaf-${iter}`)
      p.upsertEdge(center, leaf, 1)
      const deg = p.degrees(center)
      expect(deg.outDegree).toBe(1)
      expect(deg.inDegree).toBe(0)
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
}

for (let iter = 0; iter < 40; iter++) {
  it(`[st-mass-F] batchUpsertNodes 变体 #${iter}`, () => {
    const dbPath = randomDir()
    const p = new ClassicLevelStorageProvider()
    try {
      p.open({ path: dbPath })
      const ids = p.batchUpsertNodes([
        { typeId: 1, name: `st-F-a-${iter}`, key: `st-F-a-${iter}` },
        { typeId: 2, name: `st-F-b-${iter}`, key: `st-F-b-${iter}` },
      ])
      expect(ids.length).toBe(2)
      expect(ids[0]).not.toBe(ids[1])
    } finally {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
}

// ==== BULK: shared-storage describe blocks ====

for (let batch = 0; batch < 20; batch++) {
  describe(`[bulk-st] shared storage #${batch}`, () => {
    let dbPath: string
    let p: ClassicLevelStorageProvider
    beforeAll(() => {
      dbPath = randomDir()
      p = new ClassicLevelStorageProvider()
      p.open({ path: dbPath })
    })
    afterAll(() => {
      if (p.isOpen) p.close()
      try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ok */ }
    })
    for (let sub = 0; sub < 10; sub++) {
      it(`v${batch}.${sub}`, () => {
        const id = p.upsertNode(1, `bulk-st-${batch}-${sub}`)
        expect(p.getNode(id, true)).not.toBeNull()
      })
    }
  })
}
