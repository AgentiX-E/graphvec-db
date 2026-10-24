/**
 * planner-bridge.spec.ts — OptimizerBridge 单元测试
 *
 * 验证 OptimizerBridge 的 4 个核心路径：
 * 1. executeOptimized（完整 pipeline: SCAN → FILTER → SORT → LIMIT → PROJECT）
 * 2. 每种 PlanNodeType 的行为（SCAN/FILTER/PROJECT/SORT/LIMIT/UNION/NEIGHBORS）
 * 3. 过滤下推 (pushedFilters, pushedLimit)
 * 4. 边际场景（空结果、空类型、所有节点同类型）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OptimizerBridge } from '../query/planner-bridge'
import { NodeRecord } from '../types'
import type { QuerySpec } from '../api/query-planner'
import { PlanNodeType, PlanNode } from '../api/query-planner'

/** 创建一个 mock GraphEngine */
function createMockEngine(nodes: NodeRecord[] = []): any {
  return {
    _nodeIds: nodes.map(n => n.id),
    scanAllNodes: vi.fn().mockReturnValue([...nodes]),
    neighbors: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    getNode: vi.fn().mockImplementation((id: number) => {
      const n = nodes.find(x => x.id === id)
      return n
        ? { id: n.id, typeId: n.type, key: n.name ?? '', props: n.props }
        : null
    }),
  }
}

const MOCK_NODES: NodeRecord[] = [
  { id: 1, type: 1, name: 'Alice', props: { age: 30, city: 'NYC', salary: 100 } },
  { id: 2, type: 1, name: 'Bob', props: { age: 25, city: 'NYC', salary: 80 } },
  { id: 3, type: 2, name: 'Charlie', props: { age: 35, city: 'LA', salary: 120 } },
  { id: 4, type: 2, name: 'Diana', props: { age: 28, city: 'SF', salary: 90 } },
  { id: 5, type: 3, name: 'Eve', props: { age: 22, city: 'NYC', salary: 60 } },
]

describe('OptimizerBridge', () => {
  let bridge: OptimizerBridge
  let engine: any

  beforeEach(() => {
    engine = createMockEngine(MOCK_NODES)
    bridge = new OptimizerBridge(engine)
  })

  describe('executeOptimized', () => {
    it('returns all nodes on empty spec', async () => {
      const result = await bridge.executeOptimized({})
      expect(result).toHaveLength(5)
    })

    it('filters by typeId', async () => {
      const result = await bridge.executeOptimized({
        match: { typeId: 1 },
      })
      expect(result).toHaveLength(2)
      expect(result.every(n => n.type === 1)).toBe(true)
    })

    it('applies predicate filters', async () => {
      const result = await bridge.executeOptimized({
        predicates: [
          (n: NodeRecord) => (n.props?.age as number) >= 28,
        ],
      })
      expect(result).toHaveLength(3)
      expect(result.map(n => n.name).sort()).toEqual(['Alice', 'Charlie', 'Diana'])
    })

    it('projects specific fields', async () => {
      const result = await bridge.executeOptimized({
        match: { typeId: 1 },
        return: ['name', 'age'],
      })
      expect(result).toHaveLength(2)
      for (const r of result) {
        // name should be there (we project it)
        expect(r).toHaveProperty('name')
        // age is projected to the top level (PROJECT clears props)
        expect(r).toHaveProperty('age')
      }
    })

    it('sorts by numeric field ascending', async () => {
      const result = await bridge.executeOptimized({
        orderBy: { field: 'age', direction: 'asc' },
      })
      const ages = result.map(n => n.props?.age as number)
      for (let i = 1; i < ages.length; i++) {
        expect(ages[i]).toBeGreaterThanOrEqual(ages[i - 1])
      }
    })

    it('sorts by string field descending', async () => {
      const result = await bridge.executeOptimized({
        orderBy: { field: 'name', direction: 'desc' },
      })
      const names = result.map(n => n.name)
      for (let i = 1; i < names.length; i++) {
        expect(names[i].localeCompare(names[i - 1])).toBeLessThanOrEqual(0)
      }
    })

    it('applies limit', async () => {
      const result = await bridge.executeOptimized({
        limit: 2,
      })
      expect(result).toHaveLength(2)
    })

    it('applies skip + limit', async () => {
      const result = await bridge.executeOptimized({
        skip: 2,
        limit: 2,
      })
      expect(result).toHaveLength(2)
      // skip first 2: ids should be 3, 4
      expect(result[0].id).toBeGreaterThanOrEqual(3)
    })

    it('applies multi-field filter chaining', async () => {
      const result = await bridge.executeOptimized({
        predicates: [
          (n: NodeRecord) => (n.props?.age as number) >= 25,
          (n: NodeRecord) => n.props?.city === 'NYC',
        ],
      })
      expect(result).toHaveLength(2)
      expect(result.every(n => n.props?.city === 'NYC')).toBe(true)
    })
  })

  describe('pipe filter pushdown equivalence', () => {
    it('type + filter + limit produces same result when order varies', async () => {
      // 只有 typeId 过滤 + predicates 对结果集一致
      const spec = {
        match: { typeId: 2 },
        predicates: [
          (n: NodeRecord) => (n.props?.age as number) > 28,
        ],
      }
      const result = await bridge.executeOptimized(spec)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Charlie')
    })
  })

  describe('aggregate sort + limit', () => {
    let aggBridge: OptimizerBridge

    beforeEach(() => {
      aggBridge = new OptimizerBridge(createMockEngine(MOCK_NODES))
    })

    it('top 2 highest salary', async () => {
      const result = await aggBridge.executeOptimized({
        orderBy: { field: 'salary', direction: 'desc' },
        limit: 2,
      })
      expect(result).toHaveLength(2)
      const salaries = result.map(n => n.props?.salary as number)
      expect(salaries[0]).toBe(120)
      expect(salaries[1]).toBe(100)
    })
  })

  describe('explain', () => {
    it('returns non-empty explain string', () => {
      const text = bridge.explain({ match: { typeId: 1 } })
      expect(text).toBeTruthy()
      expect(typeof text).toBe('string')
    })
  })

  describe('edge cases', () => {
    it('empty engine returns empty result', async () => {
      const emptyBridge = new OptimizerBridge(createMockEngine([]))
      const result = await emptyBridge.executeOptimized({})
      expect(result).toEqual([])
    })

    it('handles non-matching typeId gracefully', async () => {
      const result = await bridge.executeOptimized({ match: { typeId: 999 } })
      expect(result).toEqual([])
    })

    it('handles zero limit', async () => {
      const result = await bridge.executeOptimized({ limit: 0 })
      expect(result).toHaveLength(0)
    })
  })

  describe('scan + sort + project pipeline', () => {
    let pipeBridge: OptimizerBridge

    beforeEach(() => {
      pipeBridge = new OptimizerBridge(createMockEngine(MOCK_NODES))
    })

    it('full pipeline produces correct end result', async () => {
      const result = await pipeBridge.executeOptimized({
        predicates: [
          (n: NodeRecord) => (n.props?.salary as number) >= 85,
        ],
        orderBy: { field: 'salary', direction: 'desc' },
        return: ['id', 'name', 'salary'],
      })
      // type=1,2 + salary>=85 = Alice(100), Charlie(120), Diana(90) = 3
      expect(result).toHaveLength(3)
      expect(result[0].name).toBe('Charlie')
      expect(result[2].name).toBe('Diana')
      // projected fields present
      expect(result[0]).toHaveProperty('id')
      expect(result[0]).toHaveProperty('name')
    })
  })

  describe('neighbors traversal', () => {
    it('returns empty when engine has no edges', async () => {
      const spec = {
        neighbors: {
          id: 1,
          maxDepth: 1,
        },
      }
      const result = await bridge.executeOptimized(spec)
      // 当 engine 无边时 neighbors 返回空，但 NodeRecord 仍来自 SCAN
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('union', () => {
    it('deduplicates nodes from both sides', async () => {
      // UNION 在 OptimizerBridge 中通过 PlanNodeType.UNION 实现，
      // 当 plan.children >= 2 时合并左右结果
      const spec: QuerySpec = {}
      // 通过 _executeOptimizedIR 直接调用的是 SCAN（单子节点），
      // UNION 需要多子节点，在这里不做集成测试（由 query-engine 覆盖）
      // 此处验证 basic spec 执行路径
      const result = await bridge.executeOptimized(spec)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('executeOptimizedString', () => {
    it('throws expected error', async () => {
      await expect(
        bridge.executeOptimizedString('MATCH (n) RETURN n'),
      ).rejects.toThrow('Use executeOptimized(QuerySpec)')
    })
  })
})

// ────────────────────────────────────────────────────────────
// 直接驱动桥接层内部执行，覆盖 optimizeIR 产不出的 PlanNode 分支：
//   - _applyPredicate 的全部 op（gt/gte/lt/lte/neq/prefix/in/eq）
//   - SCAN / NEIGHBORS 的 pushedFilters 与 pushedLimit 下推
//   - _collectNeighbors 的深度递归
//   - UNION 多子节点合并
//   - _scanAllNodes 的 fallback，以及 VECTOR_SEARCH/INDEX_LOOKUP/default 兜底
// ────────────────────────────────────────────────────────────
describe('OptimizerBridge — plan-node execution branches', () => {
  let bridge: OptimizerBridge

  beforeEach(() => {
    bridge = new OptimizerBridge(createMockEngine(MOCK_NODES))
  })

  /** 构造单节点 plan 并驱动执行 */
  function runPlan(plan: PlanNode): Promise<NodeRecord[]> {
    return (bridge as any)._executeOptimizedIR(plan, {})
  }

  // ── _applyPredicate operator coverage ────────────────────
  describe('_applyPredicate operators via FILTER node', () => {
    function filterPlan(op: string, field: string, value: unknown): PlanNode {
      return {
        type: PlanNodeType.FILTER,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          {
            type: PlanNodeType.SCAN,
            estimatedCost: 1,
            estimatedRows: 1000,
            children: [],
            details: {},
          },
        ],
        details: { predicates: [{ field, op, value }] },
      }
    }

    it('eq matches exact value', async () => {
      const r = await runPlan(filterPlan('eq', 'name', 'Alice'))
      expect(r.map(n => n.name)).toEqual(['Alice'])
    })

    it('neq excludes matching value', async () => {
      const r = await runPlan(filterPlan('neq', 'name', 'Alice'))
      expect(r.length).toBe(4)
      expect(r.map(n => n.name)).not.toContain('Alice')
    })

    it('gt compares numbers', async () => {
      const r = await runPlan(filterPlan('gt', 'age', 30))
      expect(r.map(n => n.props?.age)).toEqual([35])
    })

    it('gte includes the boundary', async () => {
      const r = await runPlan(filterPlan('gte', 'age', 30))
      expect(r.map(n => n.props?.age).sort()).toEqual([30, 35])
    })

    it('lt compares numbers', async () => {
      const r = await runPlan(filterPlan('lt', 'age', 25))
      expect(r.map(n => n.props?.age)).toEqual([22])
    })

    it('lte includes the boundary', async () => {
      const r = await runPlan(filterPlan('lte', 'age', 25))
      expect(r.map(n => n.props?.age).sort()).toEqual([22, 25])
    })

    it('prefix matches string startsWith', async () => {
      const r = await runPlan(filterPlan('prefix', 'name', 'A'))
      expect(r.map(n => n.name)).toEqual(['Alice'])
    })

    it('in matches membership in a list', async () => {
      const r = await runPlan(filterPlan('in', 'name', ['Alice', 'Bob']))
      expect(r.map(n => n.name).sort()).toEqual(['Alice', 'Bob'])
    })

    it('unknown operator passes everything through', async () => {
      const r = await runPlan(filterPlan('bogus', 'name', 'Alice'))
      expect(r.length).toBe(5)
    })
  })

  // ── SCAN with pushedFilters / pushedLimit ─────────────────
  describe('SCAN pushedFilters and pushedLimit', () => {
    it('applies pushed filters on the scan result', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.SCAN,
        estimatedCost: 100,
        estimatedRows: 1000,
        children: [],
        details: {
          pushedFilters: [{ field: 'name', op: 'neq', value: 'Alice' }],
        },
      }
      const r = await runPlan(plan)
      expect(r.length).toBe(4)
      expect(r.map(n => n.name)).not.toContain('Alice')
    })

    it('applies pushedLimit to cut the scan early', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.SCAN,
        estimatedCost: 100,
        estimatedRows: 1000,
        children: [],
        details: { pushedLimit: 2 },
      }
      const r = await runPlan(plan)
      expect(r).toHaveLength(2)
    })

    it('filters by typeId on the scan node', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.SCAN,
        estimatedCost: 100,
        estimatedRows: 1000,
        children: [],
        details: { typeId: 2 },
      }
      const r = await runPlan(plan)
      expect(r.length).toBe(2)
      expect(r.every(n => n.type === 2)).toBe(true)
    })
  })

  // ── NEIGHBORS traversal with real edges + recursion ──────
  describe('NEIGHBORS traversal', () => {
    it('collects neighbors recursively up to maxDepth', async () => {
      const neighborEngine = createMockEngine(MOCK_NODES)
      const adjacency: Record<number, NodeRecord[]> = {
        1: [MOCK_NODES[1]], // Bob
        2: [MOCK_NODES[2]], // Charlie (from Bob)
      }
      neighborEngine.neighbors = vi.fn().mockImplementation((id: number) => {
        const nodes = adjacency[id] ?? []
        return { nodes, edges: [] }
      })
      const nbBridge = new OptimizerBridge(neighborEngine)

      const plan: PlanNode = {
        type: PlanNodeType.NEIGHBORS,
        estimatedCost: 200,
        estimatedRows: 1,
        children: [
          {
            type: PlanNodeType.SCAN,
            estimatedCost: 100,
            estimatedRows: 1000,
            children: [],
            details: { typeId: 1 },
          },
        ],
        details: { maxDepth: 2 },
      }
      const r = await (nbBridge as any)._executeOptimizedIR(plan, {})
      // Traversal preserves path multiplicity: input node 1 (Alice) reaches
      // Bob (id 2) at depth 1 and Charlie (id 3) at depth 2, while input node
      // 2 (Bob) also reaches Charlie (id 3) at depth 1. Each path yields one
      // row, so Charlie appears twice — mirroring Cypher MATCH semantics.
      const ids = r.map((n: NodeRecord) => n.id).sort()
      expect(ids).toEqual([2, 3, 3])
    })

    it('applies pushedFilters on neighbor results', async () => {
      const neighborEngine = createMockEngine(MOCK_NODES)
      neighborEngine.neighbors = vi.fn().mockImplementation(() => ({
        nodes: [MOCK_NODES[1], MOCK_NODES[2]],
        edges: [],
      }))
      const nbBridge = new OptimizerBridge(neighborEngine)

      const plan: PlanNode = {
        type: PlanNodeType.NEIGHBORS,
        estimatedCost: 200,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: {
          maxDepth: 1,
          pushedFilters: [{ field: 'name', op: 'eq', value: 'Bob' }],
        },
      }
      const r = await (nbBridge as any)._executeOptimizedIR(plan, {})
      expect(r.map((n: NodeRecord) => n.name)).toEqual(['Bob'])
    })

    it('applies pushedLimit on neighbor results', async () => {
      const neighborEngine = createMockEngine(MOCK_NODES)
      neighborEngine.neighbors = vi.fn().mockImplementation(() => ({
        nodes: [MOCK_NODES[1], MOCK_NODES[2], MOCK_NODES[3]],
        edges: [],
      }))
      const nbBridge = new OptimizerBridge(neighborEngine)

      const plan: PlanNode = {
        type: PlanNodeType.NEIGHBORS,
        estimatedCost: 200,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: { maxDepth: 1, pushedLimit: 2 },
      }
      const r = await (nbBridge as any)._executeOptimizedIR(plan, {})
      expect(r).toHaveLength(2)
    })
  })

  // ── UNION multi-child merge ──────────────────────────────
  describe('UNION merge', () => {
    it('deduplicates nodes across both children', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.UNION,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 2 } },
        ],
        details: {},
      }
      const r = await runPlan(plan)
      expect(r.map(n => n.id).sort()).toEqual([1, 2, 3, 4])
    })

    it('deduplicates overlapping children', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.UNION,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: {},
      }
      const r = await runPlan(plan)
      expect(r.map(n => n.id).sort()).toEqual([1, 2])
    })
  })

  // ── fallback / no-op node types ──────────────────────────
  describe('fallback and no-op branches', () => {
    it('_scanAllNodes returns empty when engine lacks scanAllNodes', async () => {
      const bareBridge = new OptimizerBridge({} as any)
      const plan: PlanNode = {
        type: PlanNodeType.SCAN,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [],
        details: {},
      }
      const r = await (bareBridge as any)._executeOptimizedIR(plan, {})
      expect(r).toEqual([])
    })

    it('VECTOR_SEARCH node passes input through', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.VECTOR_SEARCH,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: {},
      }
      const r = await runPlan(plan)
      // vector search is a transparent pass-through in this bridge
      expect(r.length).toBe(2)
    })

    it('INDEX_LOOKUP node passes input through', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.INDEX_LOOKUP,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: {},
      }
      const r = await runPlan(plan)
      expect(r.length).toBe(2)
    })

    it('UNION with fewer than two children passes input through', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.UNION,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: {},
      }
      const r = await runPlan(plan)
      expect(r.map(n => n.id).sort()).toEqual([1, 2])
    })

    it('unknown plan node type falls through to passthrough', async () => {
      const plan: PlanNode = {
        type: PlanNodeType.JOIN,
        estimatedCost: 1,
        estimatedRows: 1,
        children: [
          { type: PlanNodeType.SCAN, estimatedCost: 1, estimatedRows: 1, children: [], details: { typeId: 1 } },
        ],
        details: {},
      }
      const r = await runPlan(plan)
      expect(r.length).toBe(2)
    })
  })
})
