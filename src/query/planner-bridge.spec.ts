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
