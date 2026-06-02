// ============================================================
// VariableLengthPath — 变长路径匹配测试
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PlanNodeType,
  buildIRFromSpec,
  optimizeIR,
  executeIR,
  VariableLengthPathNode,
} from '../api/query-planner'
import { NodeRecord } from '../types'

// ──────────────────────────────────────────
// Mock ShardManager
// ──────────────────────────────────────────

class MockShardManager {
  private adjacency = new Map<number, NodeRecord[]>()
  private allNodes = new Map<number, NodeRecord>()

  setNeighbors(nodeId: number, neighbors: NodeRecord[]): void {
    this.adjacency.set(nodeId, neighbors)
  }

  addNode(node: NodeRecord): void {
    this.allNodes.set(node.id, node)
  }

  /** Required by scanAllNodes in query-planner */
  getAllNodes(): NodeRecord[] {
    return Array.from(this.allNodes.values())
  }

  async upsertNode(_typeId: number, _name: string): Promise<number> { return 0 }
  async upsertEdge(_src: number, _dst: number, _typeId: number, _opts?: any): Promise<void> {}
  async deleteEdge(_src: number, _dst: number, _typeId: number): Promise<void> {}

  async getNode(id: number): Promise<NodeRecord | null> {
    return this.allNodes.get(id) ?? null
  }

  async neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: { src: number; dst: number; type: number }[]
    nodes: NodeRecord[]
  }> {
    const neighbors = this.adjacency.get(id)
    if (!neighbors) return { edges: [], nodes: [] }

    const edges = neighbors.map(n => ({
      src: id,
      dst: n.id,
      type: opts?.edgeTypeFilter?.[0] ?? 10,
    }))
    return { edges, nodes: neighbors }
  }

  async vectorSearch(_query: any): Promise<{ node: NodeRecord; score: number }[]> {
    return []
  }

  getShardStatus(): any[] { return [] }
  getRange(_rangeId: string): any { return { engine: { stats: () => ({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }) } } }
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function makeNode(id: number, name: string, type: number = 1, extra?: Partial<NodeRecord>): NodeRecord {
  return {
    id,
    type,
    name,
    props: extra?.props ?? {},
    createdAt: extra?.createdAt ?? Date.now(),
    degree: extra?.degree ?? 0,
  }
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('VariableLengthPath (GAP-20)', () => {
  describe('VariableLengthPathNode 接口', () => {
    it('应包含所有必需字段', () => {
      const vln: VariableLengthPathNode = {
        startId: 1,
        minDepth: 1,
        maxDepth: 3,
        direction: 'out',
      }
      expect(vln.startId).toBe(1)
      expect(vln.minDepth).toBe(1)
      expect(vln.maxDepth).toBe(3)
      expect(vln.direction).toBe('out')
    })

    it('可选字段应为 undefined 默认', () => {
      const vln: VariableLengthPathNode = {
        startId: 1,
        minDepth: 1,
        maxDepth: 3,
        direction: 'out',
      }
      expect(vln.edgeType).toBeUndefined()
      expect(vln.edgeTypes).toBeUndefined()
    })

    it('应支持 edgeType 和 edgeTypes 设置', () => {
      const vln: VariableLengthPathNode = {
        startId: 1,
        edgeType: 10,
        minDepth: 1,
        maxDepth: 3,
        direction: 'out',
        edgeTypes: [10, 20],
      }
      expect(vln.edgeType).toBe(10)
      expect(vln.edgeTypes).toEqual([10, 20])
    })
  })

  describe('buildIRFromSpec 变长路径', () => {
    it('spec 含 variableLengthPath 时生成 VARIABLE_LENGTH_PATH 节点', () => {
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 3,
          direction: 'out',
        },
      })

      // 根节点应为 VARIABLE_LENGTH_PATH
      expect(plan.type).toBe(PlanNodeType.VARIABLE_LENGTH_PATH)
      expect(plan.details['minDepth']).toBe(1)
      expect(plan.details['maxDepth']).toBe(3)
      expect(plan.details['direction']).toBe('out')
    })

    it('VARIABLE_LENGTH_PATH 的子节点应为 SCAN', () => {
      const plan = buildIRFromSpec({
        match: { typeId: 2 },
        variableLengthPath: {
          startId: 5,
          minDepth: 2,
          maxDepth: 5,
          direction: 'both',
        },
      })

      expect(plan.type).toBe(PlanNodeType.VARIABLE_LENGTH_PATH)
      expect(plan.children).toHaveLength(1)
      expect(plan.children[0].type).toBe(PlanNodeType.SCAN)
      expect(plan.children[0].details['typeId']).toBe(2)
    })
  })

  describe('BFS 变长展开执行', () => {
    let mock: MockShardManager

    beforeEach(() => {
      mock = new MockShardManager()

      // 构建链式图: 1 -> 2 -> 3 -> 4 -> 5 -> 6
      for (let i = 1; i <= 6; i++) {
        mock.addNode(makeNode(i, `Node${i}`))
      }
      mock.setNeighbors(1, [makeNode(2, 'Node2')])
      mock.setNeighbors(2, [makeNode(3, 'Node3')])
      mock.setNeighbors(3, [makeNode(4, 'Node4')])
      mock.setNeighbors(4, [makeNode(5, 'Node5')])
      mock.setNeighbors(5, [makeNode(6, 'Node6')])
      mock.setNeighbors(6, [])
    })

    it('MATCH (a:1)-[*1..1]->(b) — 单跳变长（等价于 neighbors 1）', async () => {
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 1,
          direction: 'out',
        },
      })
      const optimized = optimizeIR(plan)
      const result = await executeIR(optimized, mock as any)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(2)
    })

    it('MATCH (a)-[*1..3]->(b) — 三跳内可到达节点', async () => {
      const plan = buildIRFromSpec({
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 3,
          direction: 'out',
        },
      })
      const mockInput = [makeNode(1, 'Start', 1)]
      // Execute directly by targeting VARIABLE_LENGTH_PATH case
      // We need to yield first because executeNode calls shardManager.neighbors
      // The simplest test: check the built plan structure and manually verify neighbors chain

      // For integration test, let's check that the plan has correct params
      expect(plan.details['minDepth']).toBe(1)
      expect(plan.details['maxDepth']).toBe(3)
      expect(plan.details['startId']).toBe(1)

      // Now actually execute with proper input data
      // Build the plan with scan first, then vary-length path
      const fullPlan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 3,
          direction: 'out',
        },
      })
      const optPlan = optimizeIR(fullPlan)
      const results = await executeIR(optPlan, mock as any)

      // From node 1, 3 hops: reach nodes 2, 3, 4
      expect(results.length).toBeGreaterThanOrEqual(3)
      const ids = results.map(r => r.id).sort()
      expect(ids).toContain(2)  // depth 1
      expect(ids).toContain(3)  // depth 2
      expect(ids).toContain(4)  // depth 3
      expect(ids).not.toContain(5) // depth 4 (beyond maxDepth)
    })

    it('MATCH (a)-[*2..4]->(b) — 跳数范围匹配', async () => {
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 2,
          maxDepth: 4,
          direction: 'out',
        },
      })
      const optPlan = optimizeIR(plan)
      const results = await executeIR(optPlan, mock as any)

      // From node 1, depths 2-4: reach nodes 3, 4, 5
      const ids = results.map(r => r.id).sort()
      expect(ids).toContain(3)  // depth 2
      expect(ids).toContain(4)  // depth 3
      expect(ids).toContain(5)  // depth 4
      expect(ids).not.toContain(2) // depth 1 (below minDepth)
      expect(ids).not.toContain(6) // depth 5 (beyond maxDepth)
    })

    it('无匹配边时返回空结果', async () => {
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 6,
          minDepth: 1,
          maxDepth: 3,
          direction: 'out',
        },
      })
      const optPlan = optimizeIR(plan)
      const results = await executeIR(optPlan, mock as any)

      expect(results).toHaveLength(0)
    })

    it('方向为 both 时双向遍历', async () => {
      // 创建双向图: 2 <-> 3
      // node 2 可到 3，node 3 可回到 2
      const mock2 = new MockShardManager()
      for (let i = 1; i <= 4; i++) {
        mock2.addNode(makeNode(i, `Node${i}`))
      }
      mock2.setNeighbors(1, [makeNode(2, 'Node2')])
      mock2.setNeighbors(2, [makeNode(1, 'Node1'), makeNode(3, 'Node3')])
      mock2.setNeighbors(3, [makeNode(2, 'Node2'), makeNode(4, 'Node4')])
      mock2.setNeighbors(4, [makeNode(3, 'Node3')])

      const plan = buildIRFromSpec({
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 3,
          direction: 'both',
        },
      })
      const optPlan = optimizeIR(plan)
      const results = await executeIR(optPlan, mock2 as any)

      // From 1, both directions: nodes 2, 3, 4 reachable within 3 hops
      const ids = results.map(r => r.id).sort()
      expect(ids).toContain(2)
      expect(ids).toContain(3)
      expect(ids).toContain(4)
    })
  })

  describe('optimizeIR 变长路径', () => {
    it('VARIABLE_LENGTH_PATH 节点不会被优化器消除', () => {
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 3,
          direction: 'out',
        },
      })
      const optimized = optimizeIR(plan)

      expect(optimized.type).toBe(PlanNodeType.VARIABLE_LENGTH_PATH)
    })

    it('优化后保持 depth 参数', () => {
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 3,
          minDepth: 1,
          maxDepth: 5,
          direction: 'out',
        },
      })
      const optimized = optimizeIR(plan)

      expect(optimized.details['minDepth']).toBe(1)
      expect(optimized.details['maxDepth']).toBe(5)
    })
  })

  describe('formatPlanExplain 变长路径', () => {
    it('VARIABLE_LENGTH_PATH 应出现在 EXPLAIN 输出中', async () => {
      // 动态导入 formatPlanExplain
      const { formatPlanExplain } = await import('../api/query-planner')

      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 3,
          direction: 'out',
        },
      })
      const explained = formatPlanExplain(plan)

      expect(explained).toContain('VARIABLE_LENGTH_PATH')
      expect(explained).toContain('minDepth')
      expect(explained).toContain('maxDepth')
    })
  })
})
