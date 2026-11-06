/**
 * fluent-direction.spec.ts — Tests for Fluent API direction/config methods
 *
 * Covers: out(), in(), both(), outE(), inE(), bothE(), has(),
 * enableOptimizer(), withinTxn(), setQueryCache(), orderBy() asc/desc,
 * project(), vectorSimilarity().
 */
import { GraphQuery } from './fluent'
import { NodeRecord, EdgeRecord, VectorSearchResult } from '../types'

interface MockRangeStatus { rangeId: string; raftRole: string; nodeCount: number }

class MockShardManager {
  private allNodes: NodeRecord[] = []
  private adjacency: Map<number, { edges: EdgeRecord[]; nodes: NodeRecord[] }> = new Map()
  private vectorResults: VectorSearchResult[] = []
  setNodes(nodes: NodeRecord[]): void { this.allNodes = nodes }
  setNeighbors(nodeId: number, edges: EdgeRecord[], nodes: NodeRecord[]): void { this.adjacency.set(nodeId, { edges, nodes }) }
  getAllNodes(): NodeRecord[] { return this.allNodes }
  async upsertNode(_t: number, _n: string): Promise<number> { return 0 }
  async upsertEdge(_s: number, _d: number, _t: number, _o?: any): Promise<void> {}
  async deleteEdge(_s: number, _d: number, _t: number): Promise<void> {}
  async getNode(id: number): Promise<NodeRecord | null> { return this.allNodes.find(n => n.id === id) ?? null }
  async neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{ edges: EdgeRecord[]; nodes: NodeRecord[] }> {
    const r = this.adjacency.get(id); if (!r) return { edges: [], nodes: [] }
    if (opts?.edgeTypeFilter?.length) return { edges: r.edges.filter(e => opts.edgeTypeFilter!.includes(e.type)), nodes: r.nodes }
    return r
  }
  async vectorSearch(_q: { denseQuery?: number[]; k?: number }): Promise<VectorSearchResult[]> { return [] }
  getShardStatus(): MockRangeStatus[] { return [{ rangeId: 'r0', raftRole: 'leader', nodeCount: this.allNodes.length }] }
  getRange(_id: string): { engine: { stats(): { nodeCount: number } } } { return { engine: { stats: () => ({ nodeCount: this.allNodes.length, edgeCount: 0, diskSizeBytes: 0 }) } } }
}

class TestGraphQuery extends GraphQuery {
  private mock: MockShardManager
  constructor(mock: MockShardManager) { super(mock as any); this.mock = mock }
  protected async scanAllRanges(): Promise<NodeRecord[]> { return this.mock.getAllNodes() }
}

describe('Fluent direction methods', () => {
  it('out() sets out direction and returns this', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).out([10], 2)).toBe(q)
  })
  it('in() sets in direction and returns this', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).in([10], 3)).toBe(q)
  })
  it('both() sets both direction and returns this', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).both(undefined, 1)).toBe(q)
  })
  it('outE() sets outgoing edge traversal', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).outE([10], 1)).toBe(q)
  })
  it('inE() sets incoming edge traversal', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).inE([10], 1)).toBe(q)
  })
  it('bothE() sets bidirectional edge traversal', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).bothE([10], 1)).toBe(q)
  })
  it('has() adds property predicate', () => {
    const q = new TestGraphQuery(new MockShardManager())
    const r = q.match(10).has('age', 30)
    expect(r.toString()).toContain('where(1 predicates)')
  })
})

describe('Fluent config methods', () => {
  it('enableOptimizer toggles and returns this', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.enableOptimizer(false)).toBe(q)
    expect(q.enableOptimizer(true)).toBe(q)
  })
  it('withinTxn sets txn id and returns this', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.withinTxn('tx-42')).toBe(q)
  })
  it('setQueryCache sets cache and returns this', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.setQueryCache(null as any)).toBe(q)
  })
})

describe('Fluent order/project/vector', () => {
  it('orderBy asc (default)', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).orderBy('name')).toBe(q)
  })
  it('orderBy desc', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).orderBy('name', 'desc')).toBe(q)
  })
  it('project restricts fields', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).project(['name', 'age'])).toBe(q)
  })
  it('vectorSimilarity configures vector search', () => {
    const q = new TestGraphQuery(new MockShardManager())
    expect(q.match(1).vectorSimilarity([0.1, 0.2], 5)).toBe(q)
  })
})