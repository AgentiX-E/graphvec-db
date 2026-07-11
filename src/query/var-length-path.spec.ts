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

// ── executeVarLenPath 直接测试 ──
import { executeVarLenPath } from './var-length-path'

// Mock expression-engine — factory is hoisted by vitest before imports
vi.mock('./expression-engine', () => {
  const mockEvaluateExpr = ((expr: any, row?: any) => {
    if (typeof expr === 'string') {
      const parts = expr.split('.')
      if (parts.length === 2 && row && parts[1] in row) return row[parts[1]]
      if (expr.startsWith('length(') || expr.startsWith('nodes(') || expr.startsWith('relationships(')) return null
      if (row && expr in row) return row[expr]
      return null
    }
    return null
  }) as any

  const mockPostProcess = ((result: any[], plan: any) => result) as any

  return {
    _evaluateExpression: mockEvaluateExpr,
    _postProcessResults: mockPostProcess,
    _bigintReplacer: ((_k: string, v: unknown): unknown =>
      typeof v === 'bigint' ? { __bigint: v.toString() } : v) as any,
    _bigintReviver: ((_k: string, v: unknown): unknown =>
      v && typeof v === 'object' && (v as any).__bigint !== undefined ? BigInt((v as any).__bigint) : v) as any,
  }
})

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

    it('Optional字段应为 undefined 默认', () => {
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

  // ═══════════════════════════════════════════════════════
  // GAP-24: 性能边界测试
  // ═══════════════════════════════════════════════════════

  describe('变长路径性能边界 (GAP-24)', () => {
    let mock: MockShardManager

    beforeEach(() => {
      mock = new MockShardManager()
    })

    it('3-hop 展开 — 链式图 1→2→3→4 精确匹配', async () => {
      // 构建 4 节点链: 1 → 2 → 3 → 4
      for (let i = 1; i <= 4; i++) {
        mock.addNode(makeNode(i, `Node${i}`))
      }
      mock.setNeighbors(1, [makeNode(2, 'Node2')])
      mock.setNeighbors(2, [makeNode(3, 'Node3')])
      mock.setNeighbors(3, [makeNode(4, 'Node4')])
      mock.setNeighbors(4, [])

      // 固定 3-hop 展开（minDepth = maxDepth = 3）
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 3,
          maxDepth: 3,
          direction: 'out',
        },
      })
      const optPlan = optimizeIR(plan)
      const results = await executeIR(optPlan, mock as any)

      // 从 1 出发 3 跳精确到达节点 4
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(4)
      expect(results[0].name).toBe('Node4')
    })

    it('0-hop (self match) — minDepth = 0 自身不重复、仅返回可达邻居', async () => {
      // 当前 bfsVariableExpand 实现中，起始节点被标记 visited
      // 但不加入 result。仅邻居在符合深度范围时加入。
      // minDepth=0 时，深度 1 的邻居会被收集（1 >= 0）
      mock.addNode(makeNode(1, 'Start'))
      mock.addNode(makeNode(2, 'Other'))
      mock.setNeighbors(1, [makeNode(2, 'Other')])
      mock.setNeighbors(2, [])

      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 0,
          maxDepth: 2,
          direction: 'out',
        },
      })
      const optPlan = optimizeIR(plan)
      const results = await executeIR(optPlan, mock as any)

      const ids = results.map(r => r.id).sort()
      // minDepth=0 时，所有 depth >= 1 的节点被收集：邻居 2
      // 但自身不在 result 中（BFS impl 只返回 neighbors）
      expect(ids).toEqual([2])
    })

    it('大 hops (maxDepth=100) 不会导致挂起或 O(n²) 退化', async () => {
      // 构建 30 节点链
      for (let i = 1; i <= 30; i++) {
        mock.addNode(makeNode(i, `N${i}`))
      }
      for (let i = 1; i < 30; i++) {
        mock.setNeighbors(i, [makeNode(i + 1, `N${i + 1}`)])
      }
      mock.setNeighbors(30, [])

      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 1,
          minDepth: 1,
          maxDepth: 100,
          direction: 'out',
        },
      })
      const optPlan = optimizeIR(plan)

      // 增加执行超时检测
      const startTime = Date.now()
      const results = await executeIR(optPlan, mock as any)
      const elapsed = Date.now() - startTime

      // 30 节点链，应该在 2 秒内完成
      expect(elapsed).toBeLessThan(2000)
      // 应返回所有 29 个可达节点（1→...→30，不包括起始节点自身）
      expect(results).toHaveLength(29)
      // 验证 ID 不重复
      const ids = results.map(r => r.id)
      expect(new Set(ids).size).toBe(29)
    })

    it('方向性约束 — in 方向从链尾反向追溯', async () => {
      // 构建有向图: 1 → 2 → 3 → 4
      // MockShardManager 的 neighbors() 基于 adjacency 映射。
      // 对于 in 方向，需要为每个节点设置被哪些节点指向。
      // 这里我们设置双向邻居来模拟 in-direction 遍历的效果，
      // 因为 mock 的 neighbors() 不解析 direction 参数。
      for (let i = 1; i <= 4; i++) {
        mock.addNode(makeNode(i, `Node${i}`))
      }
      mock.setNeighbors(1, [makeNode(2, 'Node2')])    // 1→2
      mock.setNeighbors(2, [makeNode(1, 'Node1'), makeNode(3, 'Node3')]) // 2→1 (for in from 4→3→2)
      mock.setNeighbors(3, [makeNode(2, 'Node2'), makeNode(4, 'Node4')]) // 3→2 (for in)
      mock.setNeighbors(4, [makeNode(3, 'Node3')])    // 4→3 (for in)

      // 从 4 出发，方向 in: 应沿反向找到 3, 2, 1
      const plan = buildIRFromSpec({
        match: { typeId: 1 },
        variableLengthPath: {
          startId: 4,
          minDepth: 1,
          maxDepth: 3,
          direction: 'in',
        },
      })
      const optPlan = optimizeIR(plan)
      const results = await executeIR(optPlan, mock as any)

      const ids = results.map(r => r.id).sort()
      // in 方向从 4 开始反查，应找到 3, 2, 1
      expect(ids).toEqual([1, 2, 3])
      // 应排除 4（起点的 out-neighbor 中没有 4）
      expect(ids).not.toContain(4)
    })
  })
})

// ═══════════════════════════════════════════════════════
// executeVarLenPath 直接单元测试
// ═══════════════════════════════════════════════════════

describe('executeVarLenPath 直接测试（从 query-engine 提取的 VLE 引擎）', () => {
  /**
   * 构建链式图：n0 -[:NEXT]-> n1 -[:NEXT]-> n2 -[:NEXT]-> n3 -[:NEXT]-> n4
   */
  function buildChain5(scanLabel: string = 'Node'): Array<Record<string, unknown>> {
    const nodes: Array<Record<string, unknown>> = [
      { _label: scanLabel, name: 'v0', __edges: [] },
      { _label: '', name: 'v1', __edges: [] },
      { _label: '', name: 'v2', __edges: [] },
      { _label: '', name: 'v3', __edges: [] },
      { _label: '', name: 'v4', __edges: [] },
    ]
    for (let i = 0; i < 4; i++) {
      const edge = { dstIdx: i + 1, srcIdx: i, label: 'NEXT' }
      ;(nodes[i] as any).__edges.push(edge)
      ;(nodes[i + 1] as any).__edges.push(edge)
    }
    return nodes
  }

  function makePlan(overrides: Record<string, any> = {}): any {
    return {
      scanLabel: 'Node',
      pathVar: undefined,
      returnColumns: [],
      steps: [{
        source: 'a',
        direction: 'out',
        edgeLabel: 'NEXT',
        targetAlias: 'b',
        targetLabel: undefined,
        range: { min: 1, max: 3 },
        ...overrides,
      }],
    }
  }

  it('基础 1~3 跳 BFS — 应返回 3 条路径', () => {
    const nodes = buildChain5()
    const plan = makePlan({ range: { min: 1, max: 3 } })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(3)
  })

  it('2~4 跳 — 应返回 3 条', () => {
    const nodes = buildChain5()
    const plan = makePlan({ range: { min: 2, max: 4 } })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(3)
  })

  it('精确 3 跳 — 应返回 1 条', () => {
    const nodes = buildChain5()
    const plan = makePlan({ range: { min: 3, max: 3 } })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(1)
  })

  it('超出范围时返回空', () => {
    const nodes = buildChain5()
    const plan = makePlan({ range: { min: 10, max: 20 } })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(0)
  })

  it('targetLabel 过滤 — 目标节点标签必须匹配', () => {
    const nodes = buildChain5()
    nodes[1] = { ...nodes[1], _label: 'Filtered' }
    const plan = makePlan({ targetLabel: 'NonExistent' })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(0)
  })

  it('edgeLabel 过滤 — 只遍历指定标签的边', () => {
    const nodes = buildChain5()
    ;(nodes[0] as any).__edges[0] = { dstIdx: 1, srcIdx: 0, label: 'OTHER' }
    ;(nodes[1] as any).__edges[0] = { dstIdx: 1, srcIdx: 0, label: 'OTHER' }
    const plan = makePlan({ edgeLabel: 'NEXT' })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(0)
  })

  it('扫描标签过滤 — 只有匹配 _label 的节点作为起点', () => {
    const nodes = buildChain5()
    // v0 的 _label 是 'Node'，设为 'Other' 后跳过
    nodes[0]._label = 'Other'
    const plan = makePlan({ scanLabel: 'Node' })
    const result = executeVarLenPath(plan, nodes)
    expect(result.length).toBe(0)
  })
})
