// ============================================================
// QueryPlanner 测试
// ============================================================

import { QueryPlanner, PlanNodeType, PlanNode, ColumnStat, optimizeIRWithStats } from './query-planner'
import { StatsCollector, StatsSnapshot, Predicate } from './stats-collector'
import { NodeRecord, EdgeRecord } from '../types'
import { GraphEngine } from '../core/graph-engine'

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

  // ──────────────────────────────────────────
  // CBO — Cost-Based Optimization (P1-1)
  // ──────────────────────────────────────────

  describe('CBO 查询优化器', () => {
    describe('predicatePushWithStats', () => {
      test('should order predicates by selectivity (most selective first)', () => {
        // Mock StatsCollector that returns known selectivities
        const mockEstimator = {
          estimateSelectivity: (_typeId: number, pred: Predicate, _stats?: StatsSnapshot) => {
            // eq type=1 → 0.1; eq name=A → 0.02; eq age=30 → 0.5
            if (pred.field === 'name') return 0.02
            if (pred.field === 'type') return 0.1
            if (pred.field === 'age') return 0.5
            return 0.5
          },
        } as unknown as StatsCollector

        const plannerWithStats = new QueryPlanner(mockShardManager as any, mockEstimator)

        // Create a StatsSnapshot
        const snapshot: StatsSnapshot = {
          typeStats: new Map([[1, { typeId: 1, totalNodes: 100, totalEdges: 200, propertyStats: new Map() }]]),
          totalNodes: 100,
          totalEdges: 200,
          collectedAt: Date.now(),
        }

        // Build a FILTER plan with predicates in any order
        const ir: PlanNode = {
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
          details: {
            predicates: [
              { field: 'type', op: 'eq', value: 2 },    // selectivity 0.1
              { field: 'age', op: 'eq', value: 30 },    // selectivity 0.5 (least selective)
              { field: 'name', op: 'eq', value: 'Alice' }, // selectivity 0.02 (most selective)
            ],
          },
        }

        const result = plannerWithStats.predicatePushWithStats(ir, snapshot, 1)
        const predicates = (result.details['predicates'] as Array<{ field: string; op: string; value: unknown }>)

        expect(predicates.length).toBe(3)
        // name (0.02) should be first, type (0.1) second, age (0.5) third
        expect(predicates[0].field).toBe('name')
        expect(predicates[1].field).toBe('type')
        expect(predicates[2].field).toBe('age')
        expect(result.details['selectivityOrdered']).toBe(true)
      })

      test('should not reorder single predicate', () => {
        const mockEstimator = {
          estimateSelectivity: () => 0.5,
        } as unknown as StatsCollector
        const plannerWithStats = new QueryPlanner(mockShardManager as any, mockEstimator)

        const snapshot: StatsSnapshot = {
          typeStats: new Map(),
          totalNodes: 100,
          totalEdges: 200,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
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
          details: {
            predicates: [
              { field: 'name', op: 'eq', value: 'Alice' },
            ],
          },
        }

        const result = plannerWithStats.predicatePushWithStats(ir, snapshot, 1)
        expect((result.details['predicates'] as Array<unknown>).length).toBe(1)
      })

      test('should fall back to existing heuristic when stats collector is not provided', () => {
        const plannerNoStats = new QueryPlanner(mockShardManager as any)

        const ir: PlanNode = {
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
          details: {
            predicates: [
              { field: 'age', op: 'eq', value: 30 },
              { field: 'name', op: 'eq', value: 'Alice' },
            ],
          },
        }

        // Without stats, predicatePushWithStats won't crash but won't reorder either
        // since it relies on this.statsCollector which is undefined
        // The method should still work but estimateSelectivity will return 0.5
        expect(() => {
          // This would need a snapshot, but without collector it doesn't matter
          const snapshot: StatsSnapshot = {
            typeStats: new Map(),
            totalNodes: 100,
            totalEdges: 200,
            collectedAt: Date.now(),
          }
          plannerNoStats.predicatePushWithStats(ir, snapshot, 1)
        }).not.toThrow()
      })
    })

    describe('reorderJoins', () => {
      test('should order join children by estimated cardinality (smallest first)', () => {
        const mockEstimator = {
          estimateSelectivity: () => 0.5,
        } as unknown as StatsCollector
        const plannerWithStats = new QueryPlanner(mockShardManager as any, mockEstimator)

        const snapshot: StatsSnapshot = {
          typeStats: new Map([
            [1, { typeId: 1, totalNodes: 1000, totalEdges: 200, propertyStats: new Map() }],
            [2, { typeId: 2, totalNodes: 100, totalEdges: 20, propertyStats: new Map() }],
          ]),
          totalNodes: 1100,
          totalEdges: 220,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
          type: PlanNodeType.JOIN,
          estimatedCost: 100,
          estimatedRows: 500,
          children: [
            {
              type: PlanNodeType.SCAN,
              estimatedCost: 100,
              estimatedRows: 1000,
              children: [],
              details: { typeId: 1 }, // 1000 nodes
            },
            {
              type: PlanNodeType.SCAN,
              estimatedCost: 100,
              estimatedRows: 100,
              children: [],
              details: { typeId: 2 },  // 100 nodes
            },
          ],
          details: { joinType: 'inner' },
        }

        const result = plannerWithStats.reorderJoins(ir, snapshot)

        // typeId=2 (100 nodes) should come first (build side)
        expect(result.children.length).toBe(2)
        expect(result.children[0].details['typeId']).toBe(2)
        expect(result.children[1].details['typeId']).toBe(1)
        expect(result.details['joinOrdered']).toBe(true)
      })

      test('should not reorder single child join', () => {
        const plannerNoStats = new QueryPlanner(mockShardManager as any)

        const snapshot: StatsSnapshot = {
          typeStats: new Map(),
          totalNodes: 100,
          totalEdges: 200,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
          type: PlanNodeType.JOIN,
          estimatedCost: 100,
          estimatedRows: 500,
          children: [
            {
              type: PlanNodeType.SCAN,
              estimatedCost: 100,
              estimatedRows: 100,
              children: [],
              details: { typeId: 1 },
            },
          ],
          details: { joinType: 'inner' },
        }

        const result = plannerNoStats.reorderJoins(ir, snapshot)
        expect(result.children.length).toBe(1)
        expect(result.details['joinOrdered']).toBeUndefined()
      })
    })

    describe('optimizeIRWithStats', () => {
      test('should reorder predicates by selectivity and push them down', () => {
        const snapshot: StatsSnapshot = {
          typeStats: new Map([
            [1, { typeId: 1, totalNodes: 100, totalEdges: 200, propertyStats: new Map() }],
          ]),
          totalNodes: 100,
          totalEdges: 200,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
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
          details: {
            predicates: [
              { field: 'neq', op: 'neq', value: 'XYZ' },   // heuristic key=5
              { field: 'name', op: 'eq', value: 'Alice' },  // heuristic key=1 (most selective)
              { field: 'age', op: 'gt', value: 18 },        // heuristic key=4
            ],
          },
        }

        const result = optimizeIRWithStats(ir, snapshot, 1)

        // After optimization, FILTER should be merged into SCAN (pushdown)
        // The predicates should be reordered: eq first (key=1), gt (key=4), neq (key=5)
        const pushedFilters = result.details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }>
        expect(pushedFilters).toBeDefined()
        expect(pushedFilters.length).toBe(3)
        expect(pushedFilters[0].field).toBe('name')
        expect(pushedFilters[1].field).toBe('age')
        expect(pushedFilters[2].field).toBe('neq')
      })

      test('should reorder join children by cardinality', () => {
        const snapshot: StatsSnapshot = {
          typeStats: new Map([
            [10, { typeId: 10, totalNodes: 500, totalEdges: 100, propertyStats: new Map() }],
            [20, { typeId: 20, totalNodes: 50, totalEdges: 10, propertyStats: new Map() }],
          ]),
          totalNodes: 550,
          totalEdges: 110,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
          type: PlanNodeType.JOIN,
          estimatedCost: 100,
          estimatedRows: 200,
          children: [
            {
              type: PlanNodeType.SCAN,
              estimatedCost: 100,
              estimatedRows: 500,
              children: [],
              details: { typeId: 10 },  // 500 nodes
            },
            {
              type: PlanNodeType.SCAN,
              estimatedCost: 100,
              estimatedRows: 50,
              children: [],
              details: { typeId: 20 },  // 50 nodes
            },
          ],
          details: { joinType: 'inner' },
        }

        const result = optimizeIRWithStats(ir, snapshot, undefined)

        expect(result.children.length).toBe(2)
        // Smaller type (20 → 50 nodes) should be first
        expect(result.children[0].details['typeId']).toBe(20)
        expect(result.children[1].details['typeId']).toBe(10)
        expect(result.details['joinOrdered']).toBe(true)
      })
    })

    describe('CBO fallback behavior', () => {
      test('no stats available → falls back to existing heuristic without crash', () => {
        // When Planner is constructed without StatsCollector, no crash
        // even when used with optimizeIRWithStats
        const snapshot: StatsSnapshot = {
          typeStats: new Map(),
          totalNodes: 0,
          totalEdges: 0,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
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
          details: {
            predicates: [
              { field: 'name', op: 'eq', value: 'Alice' },
            ],
          },
        }

        // Should not throw even with empty stats
        expect(() => optimizeIRWithStats(ir, snapshot)).not.toThrow()
      })

      test('optimizeIRWithStats on simple scan (no filter/join) should not crash', () => {
        const snapshot: StatsSnapshot = {
          typeStats: new Map(),
          totalNodes: 0,
          totalEdges: 0,
          collectedAt: Date.now(),
        }

        const ir: PlanNode = {
          type: PlanNodeType.SCAN,
          estimatedCost: 100,
          estimatedRows: 100,
          children: [],
          details: { typeId: 1 },
        }

        expect(() => optimizeIRWithStats(ir, snapshot)).not.toThrow()
      })
    })

    describe('CBO constructor integration', () => {
      test('QueryPlanner accepts StatsCollector in constructor', () => {
        const mockCollector = {
          getLastSnapshot: () => null,
          estimateSelectivity: () => 0.5,
        } as unknown as StatsCollector

        const p = new QueryPlanner(mockShardManager as any, mockCollector)
        expect(p).toBeDefined()
      })

      test('QueryPlanner works without StatsCollector', () => {
        const p = new QueryPlanner(mockShardManager as any)
        expect(p).toBeDefined()
      })
    })
  })
})
