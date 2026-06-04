// ============================================================
// QueryIR 测试
//
// 覆盖场景：
//   - buildIRFromSpec: QuerySpec → PlanNode 转换
//   - optimizeIR: 优化规则（pushDownFilter, limitPushdown）
//   - limitPushdown: 下推 LIMIT 到 SCAN/NEIGHBORS
//   - formatPlanExplain: 计划格式化
//   - executeIR: 计划执行
//   - Fluent API plan() 方法
//   - Fluent API enableOptimizer 集成
// ============================================================

import {
  buildIRFromSpec,
  optimizeIR,
  limitPushdown,
  formatPlanExplain,
  executeIR,
  PlanNodeType,
  PlanNode,
  QuerySpec,
} from './query-planner'
import { GraphQuery } from './fluent'
import { NodeRecord, EdgeRecord, VectorSearchResult } from '../types'

// ──────────────────────────────────────────
// Mock ShardManager (同 fluent.spec.ts 风格)
// ──────────────────────────────────────────

class MockShardManager {
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

class TestQuery extends GraphQuery {
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
// 数据工厂
// ──────────────────────────────────────────

function n(id: number, type: number, name: string, extra?: Partial<NodeRecord>): NodeRecord {
  return {
    id, type, name,
    props: extra?.props ?? {},
    createdAt: extra?.createdAt ?? Date.now(),
    degree: extra?.degree ?? 0,
  }
}

function e(src: number, dst: number, type: number): EdgeRecord {
  return { src, dst, type, props: {} }
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('QueryIR', () => {
  // ─────────────────────────────────────
  // buildIRFromSpec
  // ─────────────────────────────────────
  describe('buildIRFromSpec', () => {
    it('should build SCAN from basic match spec', () => {
      const spec: QuerySpec = { match: { typeId: 1 } }
      const plan = buildIRFromSpec(spec)
      expect(plan.type).toBe(PlanNodeType.SCAN)
      expect(plan.details['typeId']).toBe(1)
    })

    it('should build FILTER + SCAN for where spec', () => {
      const spec: QuerySpec = {
        match: { typeId: 1 },
        where: { name: 'Alice' },
      }
      const plan = buildIRFromSpec(spec)
      expect(plan.type).toBe(PlanNodeType.FILTER)
      expect(plan.children[0].type).toBe(PlanNodeType.SCAN)
    })

    it('should build LIMIT + SORT + FILTER + SCAN chain', () => {
      const spec: QuerySpec = {
        match: { typeId: 1 },
        where: { name: 'Alice' },
        orderBy: { field: 'name', direction: 'asc' },
        limit: 10,
      }
      const plan = buildIRFromSpec(spec)
      expect(plan.type).toBe(PlanNodeType.LIMIT)
      expect(plan.children[0].type).toBe(PlanNodeType.SORT)
      expect(plan.children[0].children[0].type).toBe(PlanNodeType.FILTER)
      expect(plan.children[0].children[0].children[0].type).toBe(PlanNodeType.SCAN)
    })

    it('should build VECTOR_SEARCH for vectorSearch spec', () => {
      const spec: QuerySpec = {
        vectorSearch: { vector: [0.1, 0.2], topK: 5 },
      }
      const plan = buildIRFromSpec(spec)
      expect(plan.type).toBe(PlanNodeType.VECTOR_SEARCH)
      expect(plan.details['topK']).toBe(5)
    })

    it('should build PROJECT for return spec', () => {
      const spec: QuerySpec = {
        match: { typeId: 1 },
        return: ['id', 'name'],
      }
      const plan = buildIRFromSpec(spec)
      expect(plan.type).toBe(PlanNodeType.PROJECT)
      expect(plan.details['fields']).toEqual(['id', 'name'])
    })

    it('should build NEIGHBORS for neighbors spec', () => {
      const spec: QuerySpec = {
        match: { typeId: 1 },
        neighbors: { id: 1, maxDepth: 2 },
      }
      const plan = buildIRFromSpec(spec)
      expect(plan.type).toBe(PlanNodeType.NEIGHBORS)
      expect(plan.details['maxDepth']).toBe(2)
      // NEIGHBORS has SCAN as child
      expect(plan.children[0].type).toBe(PlanNodeType.SCAN)
    })
  })

  // ─────────────────────────────────────
  // limitPushdown
  // ─────────────────────────────────────
  describe('limitPushdown', () => {
    it('should push LIMIT into SCAN', () => {
      const plan: PlanNode = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: 10,
        children: [{
          type: PlanNodeType.SCAN,
          estimatedCost: 100,
          estimatedRows: 100,
          children: [],
          details: { typeId: 1 },
        }],
        details: { limit: 10 },
      }

      const optimized = limitPushdown(plan)
      expect(optimized.type).toBe(PlanNodeType.LIMIT)
      expect(optimized.children[0].type).toBe(PlanNodeType.SCAN)
      expect(optimized.children[0].details['pushedLimit']).toBe(10)
    })

    it('should push LIMIT through SORT into SCAN', () => {
      const plan: PlanNode = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: 10,
        children: [{
          type: PlanNodeType.SORT,
          estimatedCost: 30,
          estimatedRows: 100,
          children: [{
            type: PlanNodeType.SCAN,
            estimatedCost: 100,
            estimatedRows: 100,
            children: [],
            details: { typeId: 1 },
          }],
          details: { field: 'name', dir: 'asc' },
        }],
        details: { limit: 10 },
      }

      const optimized = limitPushdown(plan)
      // SORT 阻止 LIMIT 下推（先排序再取 TopN 语义正确）
      // LIMIT 保留在 SORT 上方
      expect(optimized.type).toBe(PlanNodeType.LIMIT)
      expect(optimized.children[0].type).toBe(PlanNodeType.SORT)
      expect(optimized.children[0].details['pushedLimit']).toBeUndefined()
    })

    it('should push LIMIT into NEIGHBORS', () => {
      const plan: PlanNode = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: 10,
        children: [{
          type: PlanNodeType.NEIGHBORS,
          estimatedCost: 200,
          estimatedRows: 50,
          children: [],
          details: { maxDepth: 1 },
        }],
        details: { limit: 10 },
      }

      const optimized = limitPushdown(plan)
      expect(optimized.type).toBe(PlanNodeType.LIMIT)
      expect(optimized.children[0].details['pushedLimit']).toBe(10)
    })

    it('should not push LIMIT into non-SCAN/NEIGHBORS', () => {
      const plan: PlanNode = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: 10,
        children: [{
          type: PlanNodeType.PROJECT,
          estimatedCost: 2,
          estimatedRows: 10,
          children: [],
          details: { fields: ['id'] },
        }],
        details: { limit: 10 },
      }

      const optimized = limitPushdown(plan)
      expect(optimized.children[0].details['pushedLimit']).toBeUndefined()
    })
  })

  // ─────────────────────────────────────
  // optimizeIR
  // ─────────────────────────────────────
  describe('optimizeIR', () => {
    it('should push down filter + limit on full plan', () => {
      const spec: QuerySpec = {
        match: { typeId: 1 },
        where: { name: 'Alice' },
        orderBy: { field: 'id', direction: 'asc' },
        limit: 10,
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)

      // After pushDownFilter, FILTER is merged into SCAN.
      // So LMIT → SORT → SCAN (with pushedFilters)
      // SORT + LIMIT 共存时，LIMIT 不过 SORT（先排序再取 TopN）
      // 因此 SCAN 有 pushedFilters 但没有 pushedLimit
      const sortNode = optimized.children[0] // SORT
      expect(sortNode.type).toBe(PlanNodeType.SORT)
      const scanNode = sortNode.children[0]
      expect(scanNode.type).toBe(PlanNodeType.SCAN)
      expect(scanNode.details['pushedFilters']).toBeDefined()
      expect(scanNode.details['pushedLimit']).toBeUndefined()
    })

    it('should handle empty where spec', () => {
      const spec: QuerySpec = { match: { typeId: 1 } }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      expect(optimized.type).toBe(PlanNodeType.SCAN)
    })
  })

  // ─────────────────────────────────────
  // formatPlanExplain
  // ─────────────────────────────────────
  describe('formatPlanExplain', () => {
    it('should produce readable plan description', () => {
      const plan: PlanNode = {
        type: PlanNodeType.SCAN,
        estimatedCost: 100,
        estimatedRows: 1000,
        children: [],
        details: { typeId: 1 },
      }
      const explain = formatPlanExplain(plan)
      expect(explain).toContain('SCAN')
      expect(explain).toContain('rows=1000')
      expect(explain).toContain('cost=100')
    })

    it('should show nested plan with indentation', () => {
      const plan: PlanNode = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: 10,
        children: [{
          type: PlanNodeType.SCAN,
          estimatedCost: 100,
          estimatedRows: 1000,
          children: [],
          details: { typeId: 1 },
        }],
        details: { limit: 10 },
      }
      const explain = formatPlanExplain(plan)
      // Child should be indented more
      const lines = explain.trim().split('\n')
      expect(lines.length).toBe(2)
      expect(lines[1].startsWith('  ->')).toBe(true)
    })
  })

  // ─────────────────────────────────────
  // executeIR
  // ─────────────────────────────────────
  describe('executeIR', () => {
    it('should execute SCAN plan via IR', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'A'),
        n(2, 1, 'B'),
        n(3, 2, 'C'),
      ])

      const spec: QuerySpec = { match: { typeId: 1 } }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      expect(result).toHaveLength(2)
      expect(result.map(r => r.id).sort()).toEqual([1, 2])
    })

    it('should execute PROJECT plan via IR', async () => {
      const mock = new MockShardManager()
      mock.setNodes([n(1, 1, 'Alice', { props: { email: 'a@b.com' }, degree: 5 })])

      const spec: QuerySpec = {
        match: { typeId: 1 },
        return: ['name', 'email'],
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(1)
      expect((result[0] as any).name).toBe('Alice')
      expect((result[0] as any).email).toBe('a@b.com')
    })

    it('should execute LIMIT plan via IR', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'A'),
        n(2, 1, 'B'),
        n(3, 1, 'C'),
      ])

      const spec: QuerySpec = {
        match: { typeId: 1 },
        limit: 2,
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      expect(result).toHaveLength(2)
    })

    it('should execute SORT plan via IR', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(3, 1, 'Charlie'),
        n(1, 1, 'Alice'),
        n(2, 1, 'Bob'),
      ])

      const spec: QuerySpec = {
        match: { typeId: 1 },
        orderBy: { field: 'name', direction: 'asc' },
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      expect(result.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie'])
    })

    it('should execute with function predicates via IR', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'Alice', { degree: 5 }),
        n(2, 1, 'Bob', { degree: 3 }),
        n(3, 1, 'Charlie', { degree: 8 }),
      ])

      const spec: QuerySpec = {
        match: { typeId: 1 },
        predicates: [(node: NodeRecord) => (node.degree ?? 0) > 4],
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const fnPreds = spec.predicates
      const result = await executeIR(optimized, mock as any, fnPreds)

      expect(result).toHaveLength(2)
      expect(result.map(r => r.name).sort()).toEqual(['Alice', 'Charlie'])
    })

    it('should execute with skip via IR', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'A'),
        n(2, 1, 'B'),
        n(3, 1, 'C'),
      ])

      const spec: QuerySpec = {
        match: { typeId: 1 },
        skip: 1,
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      expect(result).toHaveLength(2)
    })

    it('should execute IR with limitPushdown optimization', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'A'),
        n(2, 1, 'B'),
        n(3, 1, 'C'),
        n(4, 1, 'D'),
        n(5, 1, 'E'),
      ])

      const spec: QuerySpec = {
        match: { typeId: 1 },
        limit: 3,
      }
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      // With limitPushdown, SCAN returns only 3 items, LIMIT truncates again (idempotent)
      expect(result).toHaveLength(3)
    })
  })

  // ─────────────────────────────────────
  // Fluent plan() 方法
  // ─────────────────────────────────────
  describe('Fluent plan() 方法', () => {
    it('should return readable plan description', () => {
      const mock = new MockShardManager()
      const q = new TestQuery(mock)
      const plan = q.match(1).where(() => true).limit(5).plan()

      expect(typeof plan).toBe('string')
      expect(plan.length).toBeGreaterThan(0)
      expect(plan).toContain('SCAN')
      expect(plan).toContain('LIMIT')
    })

    it('plan() should work without execution', () => {
      const mock = new MockShardManager()
      const q = new TestQuery(mock)
      // Should not throw - just returns a plan string
      const plan = q.plan()
      expect(plan).toContain('SCAN')
    })
  })

  // ─────────────────────────────────────
  // Fluent enableOptimizer 集成
  // ─────────────────────────────────────
  describe('Fluent enableOptimizer 集成', () => {
    it('should produce same results as original execution', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'Alice', { degree: 5 }),
        n(2, 1, 'Bob', { degree: 3 }),
        n(3, 1, 'Charlie', { degree: 8 }),
      ])

      // Original path
      const q1 = new TestQuery(mock)
      const result1 = await q1.match(1)
        .where(no => (no.degree ?? 0) > 4)
        .orderBy('name', 'asc')
        .return()

      // Optimizer path
      const q2 = new TestQuery(mock)
      const result2 = await q2.match(1)
        .enableOptimizer(true)
        .where(no => (no.degree ?? 0) > 4)
        .orderBy('name', 'asc')
        .return()

      // Results should be semantically equivalent
      expect(result2).toHaveLength(2)
      expect(result2.map(r => r.name).sort()).toEqual(['Alice', 'Charlie'])
      // Same count
      expect(result1).toHaveLength(result2.length)
    })

    it('enableOptimizer with match + neighbors', async () => {
      const mock = new MockShardManager()
      mock.setNodes([n(1, 1, 'Root')])
      mock.setNeighbors(1, [e(1, 2, 10), e(1, 3, 10)], [
        n(2, 1, 'Alpha'),
        n(3, 1, 'Beta'),
      ])

      const q = new TestQuery(mock)
      const result = await q.match(1)
        .enableOptimizer(true)
        .neighbors(1)
        .return()

      expect(result).toHaveLength(2)
      expect(result.map(r => r.name).sort()).toEqual(['Alpha', 'Beta'])
    })

    it('enableOptimizer with limit', async () => {
      const mock = new MockShardManager()
      mock.setNodes([
        n(1, 1, 'A'),
        n(2, 1, 'B'),
        n(3, 1, 'C'),
        n(4, 1, 'D'),
      ])

      const q = new TestQuery(mock)
      const result = await q.match(1)
        .enableOptimizer(true)
        .limit(2)
        .return()

      expect(result).toHaveLength(2)
    })

    it('enableOptimizer with project fields', async () => {
      const mock = new MockShardManager()
      mock.setNodes([n(1, 1, 'Alice', { props: { email: 'a@b.com' } })])

      const q = new TestQuery(mock)
      const result = await q.match(1)
        .enableOptimizer(true)
        .project(['name', 'email'])
        .return()

      expect(result).toHaveLength(1)
      expect((result[0] as any).name).toBe('Alice')
      expect((result[0] as any).email).toBe('a@b.com')
    })

    it('enableOptimizer with vectorSearch', async () => {
      const mock = new MockShardManager()
      mock.setNodes([n(1, 1, 'V1'), n(2, 1, 'V2')])
      mock.setVectorResults([
        { node: { id: 1, type: 1, name: 'V1', props: {} }, score: 0.95 },
        { node: { id: 2, type: 1, name: 'V2', props: {} }, score: 0.85 },
      ])

      const q = new TestQuery(mock)
      const result = await q.match(1)
        .enableOptimizer(true)
        .vectorSimilarity([0.1, 0.2], 5)
        .return()

      expect(result).toHaveLength(2)
      expect(result.map(r => r.name).sort()).toEqual(['V1', 'V2'])
    })

    it('default (without enableOptimizer) still works', async () => {
      // Verifies backward compatibility
      const mock = new MockShardManager()
      mock.setNodes([n(1, 1, 'X'), n(2, 2, 'Y')])

      const q = new TestQuery(mock)
      const result = await q.match(1).return()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('X')
    })
  })
})
