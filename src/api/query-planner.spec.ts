// ============================================================
// QueryPlanner 测试
// ============================================================

import { QueryPlanner, PlanNodeType, PlanNode, ColumnStat } from './query-planner'
import { NodeRecord, EdgeRecord } from '../types'

// ──────────────────────────────────────────
// MockShardManager
// ──────────────────────────────────────────

class MockShardManager {
  private allNodes: NodeRecord[] = []
  private edgeStore: Map<string, EdgeRecord> = new Map()

  setNodes(nodes: NodeRecord[]): void {
    this.allNodes = nodes
  }

  async getNode(id: number): Promise<NodeRecord | null> {
    return this.allNodes.find(n => n.id === id) ?? null
  }

  getAllRanges(): string[] {
    return ['range-0']
  }

  getShardStatus(): Array<{ rangeId: string; raftRole: string; nodeCount: number }> {
    return [{ rangeId: 'range-0', raftRole: 'leader', nodeCount: this.allNodes.length }]
  }
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('QueryPlanner', () => {
  let mockShardManager: MockShardManager
  let planner: QueryPlanner

  beforeEach(() => {
    mockShardManager = new MockShardManager()
    mockShardManager.setNodes([
      { id: 1, type: 1, name: 'A', props: {}, createdAt: 1000, degree: 0 },
      { id: 2, type: 1, name: 'B', props: {}, createdAt: 2000, degree: 0 },
      { id: 3, type: 1, name: 'C', props: {}, createdAt: 3000, degree: 0 },
      { id: 4, type: 2, name: 'D', props: {}, createdAt: 4000, degree: 0 },
      { id: 5, type: 2, name: 'E', props: {}, createdAt: 5000, degree: 0 },
    ])
    planner = new QueryPlanner(mockShardManager as any)
  })

  // ──────────────────────────────────────────
  // Plan 节点构建（5 tests）
  // ──────────────────────────────────────────

  describe('plan 节点构建', () => {
    test('should create SCAN plan for basic query', () => {
      const plan = planner.plan({ typeId: 1 })
      expect(plan.type).toBe(PlanNodeType.SCAN)
      expect(plan.estimatedRows).toBeGreaterThan(0)
    })

    test('should create FILTER node for predicates', () => {
      const plan = planner.plan({
        typeId: 1,
        predicates: [{ field: 'name', op: 'eq', value: 'A' }],
      })
      expect(plan.type).toBe(PlanNodeType.FILTER)
      expect(plan.children[0].type).toBe(PlanNodeType.SCAN)
    })

    test('should create LIMIT node', () => {
      const plan = planner.plan({ typeId: 1, limit: 10 })
      expect(plan.type).toBe(PlanNodeType.LIMIT)
    })

    test('should create multiple plan layers', () => {
      const plan = planner.plan({
        typeId: 1,
        predicates: [{ field: 'name', op: 'eq', value: 'A' }],
        limit: 5,
        orderBy: { field: 'name', dir: 'asc' },
      })
      // Top-down: LIMIT → SORT → FILTER → SCAN
      expect(plan.type).toBe(PlanNodeType.LIMIT)
      expect(plan.children[0].type).toBe(PlanNodeType.SORT)
      expect(plan.children[0].children[0].type).toBe(PlanNodeType.FILTER)
      expect(plan.children[0].children[0].children[0].type).toBe(PlanNodeType.SCAN)
    })

    test('should create PROJECT plan', () => {
      const plan = planner.plan({
        typeId: 1,
        project: ['id', 'name'],
      })
      expect(plan.type).toBe(PlanNodeType.PROJECT)
    })
  })

  // ──────────────────────────────────────────
  // EXPLAIN 输出（3 tests）
  // ──────────────────────────────────────────

  describe('EXPLAIN 输出', () => {
    test('should produce readable explain output', () => {
      const explain = planner.explain({ typeId: 1 })
      expect(explain).toContain('SCAN')
      expect(explain).toContain('rows=')
      expect(explain).toContain('cost=')
    })

    test('EXPLAIN should include predicates', () => {
      const explain = planner.explain({
        typeId: 1,
        predicates: [{ field: 'name', op: 'eq', value: 'A' }],
      })
      expect(explain).toContain('FILTER')
      expect(explain).toContain('predicates')
    })

    test('EXPLAIN should include LIMIT node', () => {
      const explain = planner.explain({ typeId: 1, limit: 5 })
      expect(explain).toContain('LIMIT')
      expect(explain).toContain('limit=5')
    })
  })

  // ──────────────────────────────────────────
  // 统计收集（2 tests）
  // ──────────────────────────────────────────

  describe('统计收集', () => {
    test('collectStats should gather statistics from shard manager', async () => {
      await planner.collectStats()
      const stats = planner.getStats()
      expect(stats.has('nodes')).toBe(true)
      expect(stats.get('nodes')!.rowCount).toBe(5)
    })

    test('stats should include column statistics', async () => {
      await planner.collectStats()
      const colStats = planner.getStats().get('nodes')!.columnStats
      expect(colStats.has('id')).toBe(true)
      expect(colStats.has('type')).toBe(true)
      expect(colStats.has('name')).toBe(true)
    })
  })

  // ──────────────────────────────────────────
  // 选择性估算（7 tests）
  // ──────────────────────────────────────────

  describe('选择性估算', () => {
    test('等式选择性应为 1/distinctCount', () => {
      const colStat: ColumnStat = { columnName: 'id', distinctCount: 100, nullCount: 0 }
      const sel = planner.estimateSelectivity(colStat, 'eq', 42)
      expect(sel).toBe(0.01)
    })

    test('范围选择性应默认为 ~0.33', () => {
      const colStat: ColumnStat = { columnName: 'id', distinctCount: 100, nullCount: 0 }
      const sel = planner.estimateSelectivity(colStat, 'gt', 50)
      expect(sel).toBeCloseTo(0.33, 2)
    })

    test('前缀选择性应为 1/sqrt(ndv)', () => {
      const colStat: ColumnStat = { columnName: 'name', distinctCount: 100, nullCount: 0 }
      const sel = planner.estimateSelectivity(colStat, 'prefix', 'A')
      expect(sel).toBe(0.1)
    })

    test('复合条件（in）应累加选择性', () => {
      const colStat: ColumnStat = { columnName: 'id', distinctCount: 100, nullCount: 0 }
      const sel = planner.estimateSelectivity(colStat, 'in', [1, 2, 3])
      expect(sel).toBeCloseTo(0.03, 2)
    })

    test('neq 应为 1 - 等式选择性', () => {
      const colStat: ColumnStat = { columnName: 'id', distinctCount: 100, nullCount: 0 }
      const sel = planner.estimateSelectivity(colStat, 'neq', 42)
      expect(sel).toBeCloseTo(0.99, 2)
    })

    test('空列统计时返回默认 0.5', () => {
      const sel = planner.estimateSelectivity(undefined, 'eq', 42)
      expect(sel).toBe(0.5)
    })

    test('空列表 in 条件应返回 0.5', () => {
      const colStat: ColumnStat = { columnName: 'id', distinctCount: 100, nullCount: 0 }
      const sel = planner.estimateSelectivity(colStat, 'in', [])
      expect(sel).toBe(0.5)
    })
  })

  // ──────────────────────────────────────────
  // 优化规则（5 tests）
  // ──────────────────────────────────────────

  describe('pushDownFilter', () => {
    test('should push filter down to scan node', () => {
      const plan: PlanNode = {
        type: PlanNodeType.FILTER,
        estimatedCost: 50,
        estimatedRows: 10,
        children: [{
          type: PlanNodeType.SCAN,
          estimatedCost: 100,
          estimatedRows: 100,
          children: [],
          details: { typeId: 1 },
        }],
        details: { predicates: [{ field: 'name', op: 'eq', value: 'A' }] },
      }

      const optimized = planner.pushDownFilter(plan)
      expect(optimized.type).toBe(PlanNodeType.SCAN)
      expect(optimized.details['pushedFilters']).toBeDefined()
    })

    test('should not push filter to non-scan neighbor', () => {
      const plan: PlanNode = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: 1,
        children: [],
        details: { limit: 1 },
      }

      const optimized = planner.pushDownFilter(plan)
      expect(optimized.type).toBe(PlanNodeType.LIMIT)
    })
  })

  describe('chooseIndex', () => {
    test('should choose index matching predicate field', () => {
      const chosen = planner.chooseIndex(
        [{ field: 'name', op: 'eq', value: 'A' }],
        ['id', 'name', 'type'],
      )
      expect(chosen).toBe('name')
    })

    test('should return null for no predicates', () => {
      const chosen = planner.chooseIndex([], ['id', 'name'])
      expect(chosen).toBeNull()
    })

    test('should prefer eq over range for same field', () => {
      const chosen = planner.chooseIndex(
        [
          { field: 'name', op: 'prefix', value: 'A' },
          { field: 'name', op: 'eq', value: 'A' },
        ],
        ['id', 'name'],
      )
      expect(chosen).toBe('name')
    })
  })

  describe('完整计划树优化', () => {
    test('optimize should apply all rules', () => {
      const optimized = planner.optimize({
        typeId: 1,
        predicates: [{ field: 'name', op: 'eq', value: 'A' }],
      })

      // After pushDownFilter, filter is merged into scan
      expect(optimized.details['chosenIndex']).toBe('name')
    })

    test('optimize without predicates', () => {
      const optimized = planner.optimize({ typeId: 1 })
      expect(optimized.type).toBe(PlanNodeType.SCAN)
    })
  })

  // ──────────────────────────────────────────
  // GraphQuery.enableOptimizer 开关（3 tests）
  // ──────────────────────────────────────────

  describe('enableOptimizer 开关', () => {
    test('index lookup plan when useIndex set', () => {
      const plan = planner.plan({
        typeId: 1,
        useIndex: 'name',
      })
      expect(plan.type).toBe(PlanNodeType.INDEX_LOOKUP)
      expect(plan.details['indexName']).toBe('name')
    })

    test('optimize with neighbors', () => {
      const optimized = planner.optimize({
        typeId: 1,
        neighbors: { depth: 1 },
      })
      // Top level depends on structure, just ensure it doesn't crash
      expect(optimized).toBeDefined()
    })

    test('optimize with full query', () => {
      const optimized = planner.optimize({
        typeId: 1,
        predicates: [{ field: 'type', op: 'eq', value: 1 }],
        neighbors: { depth: 2, edgeFilter: [10] },
        limit: 20,
        orderBy: { field: 'name', dir: 'asc' },
        project: ['id', 'name'],
      })
      expect(optimized).toBeDefined()
      expect(optimized.details['chosenIndex']).toBe('type')
    })
  })
})
