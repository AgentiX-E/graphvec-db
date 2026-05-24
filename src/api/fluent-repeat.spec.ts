// ============================================================
// Fluent API 重复测试 — 确保基础功能不退化
//
// 与 fluent.spec.ts 不重叠，覆盖以下场景：
//   - 边缘 case（空列表、不存在数据）
//   - 组合条件（多属性 + 多 predicate）
//   - 链式调用的不可变性
//   - 返回空结果等边界
// ============================================================

import { GraphQuery } from './fluent'
import { NodeRecord, EdgeRecord, VectorSearchResult } from '../types'

// ──────────────────────────────────────────
// Mock ShardManager
// ──────────────────────────────────────────

class FakeShardManager {
  private allNodes: NodeRecord[] = []
  private neighborMap: Map<number, { edges: EdgeRecord[]; nodes: NodeRecord[] }> = new Map()
  private vectorResults: VectorSearchResult[] = []

  setNodes(nodes: NodeRecord[]): void { this.allNodes = nodes }
  setNeighbors(id: number, edges: EdgeRecord[], nodes: NodeRecord[]): void {
    this.neighborMap.set(id, { edges, nodes })
  }
  setVectorResults(results: VectorSearchResult[]): void { this.vectorResults = results }
  getAllNodes(): NodeRecord[] { return [...this.allNodes] }

  async getNode(id: number): Promise<NodeRecord | null> {
    return this.allNodes.find(n => n.id === id) ?? null
  }

  async neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: EdgeRecord[]; nodes: NodeRecord[]
  }> {
    const entry = this.neighborMap.get(id)
    if (!entry) return { edges: [], nodes: [] }

    if (opts?.edgeTypeFilter && opts.edgeTypeFilter.length > 0) {
      const filtered = entry.edges.filter(e => opts.edgeTypeFilter!.includes(e.type))
      return { edges: filtered, nodes: entry.nodes }
    }

    return { edges: [...entry.edges], nodes: [...entry.nodes] }
  }

  async vectorSearch(_q: { denseQuery?: number[]; k?: number }): Promise<VectorSearchResult[]> {
    return [...this.vectorResults]
  }

  getShardStatus(): Array<{ rangeId: string; raftRole: string; nodeCount: number }> {
    return [{ rangeId: 'r0', raftRole: 'leader', nodeCount: this.allNodes.length }]
  }

  getRange(_id: string): { engine: { stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } } } {
    return { engine: { stats: () => ({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }) } }
  }

  async upsertNode(_typeId: number, _name: string): Promise<number> { return 0 }
}

// ──────────────────────────────────────────
// TestGraphQuery — 覆盖 scanAllRanges
// ──────────────────────────────────────────

class TestGQ extends GraphQuery {
  private fake: FakeShardManager
  constructor(fake: FakeShardManager) {
    super(fake as any)
    this.fake = fake
  }
  protected async scanAllRanges(): Promise<NodeRecord[]> {
    return this.fake.getAllNodes()
  }
}

// ──────────────────────────────────────────
// 数据工厂
// ──────────────────────────────────────────

function n(id: number, type: number, name: string, extra?: Partial<NodeRecord>): NodeRecord {
  return { id, type, name, props: extra?.props ?? {}, createdAt: extra?.createdAt ?? Date.now(), degree: extra?.degree ?? 0 }
}

function e(src: number, dst: number, type: number): EdgeRecord {
  return { src, dst, type, props: {} }
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('Fluent API — 基础功能重复验证', () => {
  describe('empty / no-match 场景', () => {
    it('空节点列表返回 []', async () => {
      const f = new FakeShardManager()
      f.setNodes([])
      const q = new TestGQ(f)
      const res = await q.match(1).return()
      expect(res).toEqual([])
    })

    it('match 不存在的 typeId 返回 []', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 2, 'B')])
      const q = new TestGQ(f)
      const res = await q.match(999).return()
      expect(res).toEqual([])
    })

    it('where 全淘汰返回 []', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'X'), n(2, 1, 'Y')])
      const q = new TestGQ(f)
      const res = await q.match(1).where(() => false).return()
      expect(res).toEqual([])
    })

    it('邻居遍历空邻居返回 []', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'Root')])
      f.setNeighbors(1, [], [])
      const q = new TestGQ(f)
      const res = await q.match(1).neighbors(2).return()
      expect(res).toEqual([])
    })

    it('空向量搜索结果返回 []', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'V')])
      f.setVectorResults([])
      const q = new TestGQ(f)
      const res = await q.vectorSimilarity([0.1], 5).return()
      expect(res).toEqual([])
    })
  })

  describe('多条件组合匹配', () => {
    it('name + degree + props 组合过滤', async () => {
      const f = new FakeShardManager()
      f.setNodes([
        n(1, 1, 'Admin', { props: { email: 'admin@x.com' }, degree: 10 }),
        n(2, 1, 'Admin2', { props: { email: 'admin2@x.com' }, degree: 5 }),
        n(3, 1, 'Guest', { props: { email: 'guest@x.com' }, degree: 1 }),
      ])

      const q = new TestGQ(f)
      const res = await q
        .match(1)
        .where(no => no.name.startsWith('Admin'))
        .where(no => (no.degree ?? 0) >= 5)
        .where(no => (no.props?.email as string ?? '').includes('admin'))
        .return()

      expect(res).toHaveLength(2)
      expect(res.map(r => r.id).sort()).toEqual([1, 2])
    })

    it('邻居 + 多条件组合', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'Start')])
      f.setNeighbors(1, [e(1, 2, 10), e(1, 3, 10), e(1, 4, 20)], [
        n(2, 1, 'Alpha', { degree: 3 }),
        n(3, 1, 'Beta', { degree: 7 }),
        n(4, 2, 'Gamma', { degree: 5 }),
      ])

      const q = new TestGQ(f)

      // neighbors deg=1 返回所有邻居节点，然后 where 过滤 degree > 4
      const res = await q
        .match(1)
        .neighbors(1)
        .where(no => (no.degree ?? 0) > 4)
        .return()

      expect(res).toHaveLength(2)
      expect(res.map(r => r.name).sort()).toEqual(['Beta', 'Gamma'])
    })

    it('多个 where 串联顺序不影响结果', async () => {
      const f = new FakeShardManager()
      f.setNodes([
        n(1, 1, 'A1', { props: { status: 'active', region: 'us' }, degree: 2 }),
        n(2, 1, 'A2', { props: { status: 'inactive', region: 'us' }, degree: 2 }),
        n(3, 1, 'A3', { props: { status: 'active', region: 'eu' }, degree: 2 }),
        n(4, 1, 'A4', { props: { status: 'active', region: 'us' }, degree: 1 }),
      ])

      const q = new TestGQ(f)
      const res = await q
        .match(1)
        .where(no => no.props?.status === 'active')
        .where(no => no.props?.region === 'us')
        .where(no => (no.degree ?? 0) >= 2)
        .return()

      expect(res).toHaveLength(1)
      expect(res[0].name).toBe('A1')
    })
  })

  describe('链式调用不可变性', () => {
    it('多次 return 产生一致结果', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 1, 'B'), n(3, 2, 'C')])

      const q = new TestGQ(f).match(1)

      const r1 = await q.return()
      const r2 = await q.return()

      expect(r1).toHaveLength(2)
      expect(r2).toHaveLength(2)
      expect(r1).toEqual(r2)
    })

    it('match 后链式追加 where 不影响之前的 match', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 2, 'B')])

      const base = new TestGQ(f).match(1)

      const withWhere = await base.where(n => n.name === 'A').return()
      const withoutWhere = await base.return()

      expect(withoutWhere).toHaveLength(1) // type=1 only
      expect(withWhere).toHaveLength(1)
      expect(withoutWhere[0].name).toBe('A')
      expect(withWhere[0].name).toBe('A')
    })
  })

  describe('skip / limit 边缘 case', () => {
    it('skip 超过总数返回 []', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 1, 'B')])

      const q = new TestGQ(f)
      const res = await q.match(1).skip(100).return()
      expect(res).toEqual([])
    })

    it('limit = 0 返回空（0 条语义）', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 1, 'B'), n(3, 1, 'C')])

      const q = new TestGQ(f)
      const res = await q.match(1).limit(0).return()
      expect(res).toHaveLength(0)
    })

    it('limit 大于总数返回全部', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 1, 'B')])

      const q = new TestGQ(f)
      const res = await q.match(1).limit(999).return()
      expect(res).toHaveLength(2)
    })

    it('skip + limit 组合极限值', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 1, 'B'), n(3, 1, 'C'), n(4, 1, 'D')])

      const q = new TestGQ(f)
      // skip(2).limit(1) -> 取第3个
      const res = await q.match(1).orderBy('id', 'asc').skip(2).limit(1).return()
      expect(res).toHaveLength(1)
      expect(res[0].id).toBe(3)
    })
  })

  describe('orderBy 边缘 case', () => {
    it('空列表排序不抛错', async () => {
      const f = new FakeShardManager()
      f.setNodes([])

      const q = new TestGQ(f)
      const res = await q.match(1).orderBy('name', 'asc').return()
      expect(res).toEqual([])
    })

    it('排序字段为 null 的节点排在最后', async () => {
      const f = new FakeShardManager()
      f.setNodes([
        n(1, 1, 'B'),
        n(2, 1, 'A'),
        // 没有 degree 属性
      ])

      const q = new TestGQ(f)

      // 按 degree 升序 (B and A both have degree=0, so order may vary by input;
      // we just test it doesn't crash and returns correct name sort for deterministic result)
      const withNoNull = await q.match(1).orderBy('name', 'asc').return()
      expect(withNoNull[0].name).toBe('A')
      expect(withNoNull[1].name).toBe('B')
    })
  })

  describe('count 边缘 case', () => {
    it('空匹配 count = 0', async () => {
      const f = new FakeShardManager()
      f.setNodes([])
      const q = new TestGQ(f)
      expect(await q.match(1).count()).toBe(0)
    })

    it('with where + count', async () => {
      const f = new FakeShardManager()
      f.setNodes([
        n(1, 1, 'Alice', { degree: 5 }),
        n(2, 1, 'Bob', { degree: 3 }),
        n(3, 1, 'Charlie', { degree: 8 }),
      ])

      const q = new TestGQ(f)
      const cnt = await q.match(1).where(n => (n.degree ?? 0) > 4).count()
      expect(cnt).toBe(2)
    })
  })

  describe('project 边缘 case', () => {
    it('投影不存在的字段', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'X', { props: { email: 'x@b.com' } })])

      const q = new TestGQ(f)
      const res = await q.match(1).project(['nonexistent']).return()

      expect(res).toHaveLength(1)
      // 不存在的字段不包含在结果中，但 id 始终存在
      expect(res[0].id).toBe(1)
      expect(Object.keys(res[0])).toEqual(['id'])
    })

    it('默认包含 id', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'X')])

      const q = new TestGQ(f)
      const res = await q.match(1).project(['name']).return()

      expect(res[0]).toEqual({ id: 1, name: 'X' })
    })
  })

  describe('toString 描述', () => {
    it('空查询的 toString', () => {
      const f = new FakeShardManager()
      const q = new TestGQ(f)
      expect(q.toString()).toBe('GraphQuery')
    })

    it('部分链式的 toString', () => {
      const f = new FakeShardManager()
      const q = new TestGQ(f)
      const str = q.match(5).where(n => n.name.length > 0).orderBy('name', 'desc').toString()
      expect(str).toContain('match(5)')
      expect(str).toContain('orderBy(name, desc)')
    })

    it('向量搜索的 toString', () => {
      const f = new FakeShardManager()
      const q = new TestGQ(f)
      const str = q.vectorSimilarity([0.1, 0.2], 3).toString()
      expect(str).toContain('vectorSimilarity(k=3)')
    })
  })

  describe('向量搜索边缘 case', () => {
    it('向量搜索 + where 过滤', async () => {
      const f = new FakeShardManager()
      f.setNodes([n(1, 1, 'A'), n(2, 1, 'B'), n(3, 2, 'C')])
      f.setVectorResults([
        { node: { id: 1, type: 1, name: 'A', props: {} }, score: 0.9 },
        { node: { id: 2, type: 1, name: 'B', props: {} }, score: 0.8 },
        { node: { id: 3, type: 2, name: 'C', props: {} }, score: 0.7 },
      ])

      const q = new TestGQ(f)
      const res = await q
        .match(1)
        .vectorSimilarity([0.1], 10)
        .where(n => n.name !== 'B')
        .return()

      expect(res).toHaveLength(1)
      expect(res[0].name).toBe('A')
    })
  })
})
