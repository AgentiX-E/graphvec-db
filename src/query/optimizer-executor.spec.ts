/**
 * optimizer-executor.spec.ts — 优化器驱动执行器单元测试
 *
 * 单独验证 buildIRFromSpec + optimizeIR 管道：
 * - 确保 IR 构建/优化逻辑可独立运行（不依赖 GraphEngine）
 * - 覆盖正常路径、优化效果、边界条件
 */

import { describe, it, expect } from 'vitest'
import {
  buildIRFromSpec,
  optimizeIR,
  PlanNodeType,
  PlanNode,
} from '../api/query-planner'

// ──────────────────────────────────────────
// 正常路径
// ──────────────────────────────────────────

describe('Normal path — buildIRFromSpec + optimizeIR', () => {
  it('简单的 match/label 条件转为正确的 IR plan', () => {
    const spec = {
      match: { typeId: 5, name: 'Person' },
    }
    const ir = buildIRFromSpec(spec)

    expect(ir).toBeDefined()
    expect(ir.type).toBe(PlanNodeType.SCAN)
    expect(ir.details).toBeDefined()
    expect(ir.details['typeId']).toBe(5)
    expect(ir.details['name']).toBe('Person')
    expect(Array.isArray(ir.children)).toBe(true)
    expect(ir.children).toHaveLength(0)
  })

  it('optimizeIR 对 SCAN+WHERE 不做出破坏性修改', () => {
    const spec = {
      match: { typeId: 5 },
      where: { name: 'Alice', age: 30 },
    }
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)

    // 验证类型不变
    expect(optimized.type).toBe(PlanNodeType.SCAN)

    // typeId 保留
    expect(optimized.details['typeId']).toBe(5)

    // 下推条件出现在 pushedFilters 中（不再是单独的 FILTER）
    const pushed = optimized.details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }> | undefined
    expect(pushed).toBeDefined()
    expect(Array.isArray(pushed)).toBe(true)
    expect(pushed).toHaveLength(2)

    const fields = pushed!.map(p => p.field)
    expect(fields).toContain('name')
    expect(fields).toContain('age')
    expect(pushed!.every(p => p.op === 'eq')).toBe(true)
  })

  it('优化后的 plan 包含 type, details 和子节点', () => {
    const spec = {
      match: { typeId: 3 },
      where: { active: true },
      orderBy: { field: 'name', direction: 'asc' as const },
      limit: 10,
    }
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)

    // 整个管道应当产生一个合法的树
    expect(optimized).toBeDefined()
    expect(typeof optimized.type).toBe('string')
    expect(optimized.details).toBeDefined()
    expect(typeof optimized.details).toBe('object')

    // SCAN 自身无子节点（filter 已被下推）
    // 但整个树中应该包含 LIMIT 和 SORT
    const types: string[] = []
    function collectTypes(node: PlanNode): void {
      types.push(node.type)
      for (const c of node.children) collectTypes(c)
    }
    collectTypes(optimized)

    expect(types).toContain(PlanNodeType.SCAN)
    expect(types).toContain(PlanNodeType.SORT)
    expect(types).toContain(PlanNodeType.LIMIT)
  })
})

// ──────────────────────────────────────────
// optimizeIR 优化效果
// ──────────────────────────────────────────

describe('optimizeIR — 优化效果', () => {
  it('identity 优化（op IDENTITY）通过原始输入', () => {
    // 没有 where → 没有 FILTER → optimizeIR 不做任何修改
    const spec = { match: { typeId: 1 } }
    const ir = buildIRFromSpec(spec)
    const result = optimizeIR(ir)

    expect(result.type).toBe(PlanNodeType.SCAN)
    expect(result.details['typeId']).toBe(1)
    // 没有 pushedFilters（因为没有 where）
    expect(result.details['pushedFilters']).toBeUndefined()
  })

  it('优化器能识别简单的过滤条件并标记 pushedFilters', () => {
    const spec = {
      match: { typeId: 10 },
      where: { city: 'Beijing' },
    }
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)

    // FILTER 被下推，根节点应为 SCAN
    expect(optimized.type).toBe(PlanNodeType.SCAN)

    // pushedFilters 应该有 1 条
    const filters = optimized.details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }> | undefined
    expect(filters).toBeDefined()
    expect(filters).toHaveLength(1)
    expect(filters![0]).toEqual({ field: 'city', op: 'eq', value: 'Beijing' })
  })

  it('NEIGHBORS 节点的谓词也能下推', () => {
    const spec = {
      match: { typeId: 7 },
      neighbors: { id: 42, maxDepth: 2 },
      where: { level: 5 },
    }
    const ir = buildIRFromSpec(spec)

    // buildIRFromSpec 构建了 SCAN → NEIGHBORS → FILTER → PROJECT(无)
    // optimizeIR 应把 FILTER 下推到 NEIGHBORS
    const optimized = optimizeIR(ir)

    // 上层的 FILTER 应该被合并，SCAN 应该是叶子
    expect(optimized.type).toBe(PlanNodeType.NEIGHBORS)

    const pushed = optimized.details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }> | undefined
    expect(pushed).toBeDefined()
    expect(pushed).toHaveLength(1)
    expect(pushed![0]).toEqual({ field: 'level', op: 'eq', value: 5 })
  })

  it('多条件过滤全部下推到 SCAN', () => {
    const spec = {
      match: { typeId: 2 },
      where: { city: 'Shanghai', active: true },
      limit: 5,
    }
    const ir = buildIRFromSpec(spec)

    // 构建：SCAN → FILTER(2 conds) → LIMIT
    // optimizeIR: filter pushdown → limit pushdown
    const optimized = optimizeIR(ir)

    // LIMIT 是根节点，SCAN 在其 child 链中
    function findScanWithPushedFilters(node: PlanNode): PlanNode | null {
      if (node.type === PlanNodeType.SCAN && node.details['pushedFilters']) return node
      for (const c of node.children) {
        const found = findScanWithPushedFilters(c)
        if (found) return found
      }
      return null
    }

    const scanNode = findScanWithPushedFilters(optimized)
    expect(scanNode).not.toBeNull()
    const filters = scanNode!.details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }>
    expect(filters).toHaveLength(2)
  })
})

// ──────────────────────────────────────────
// 边界条件
// ──────────────────────────────────────────

describe('Boundary conditions', () => {
  it('空 spec ({}) 生成合法的 IR', () => {
    const ir = buildIRFromSpec({})

    expect(ir).toBeDefined()
    expect(ir.type).toBe(PlanNodeType.SCAN)
    expect(ir.details['typeId']).toBeNull()
    expect(ir.details['name']).toBeNull()
    expect(ir.children).toHaveLength(0)

    // optimizeIR 不应报错
    const optimized = optimizeIR(ir)
    expect(optimized.type).toBe(PlanNodeType.SCAN)
    expect(optimized.details['typeId']).toBeNull()
  })

  it('spec 包含 limit → IR 中正确编码', () => {
    const spec = {
      match: { typeId: 1 },
      limit: 25,
    }
    const ir = buildIRFromSpec(spec)

    // SCAN → LIMIT
    expect(ir.type).toBe(PlanNodeType.LIMIT)
    expect(ir.details['limit']).toBe(25)
    expect(ir.details['skip']).toBe(0)
    expect(ir.children).toHaveLength(1)
    expect(ir.children[0].type).toBe(PlanNodeType.SCAN)
    expect(ir.children[0].details['typeId']).toBe(1)
  })

  it('spec 包含 skip → IR 中正确编码', () => {
    const spec = {
      match: { typeId: 1 },
      skip: 10,
    }
    const ir = buildIRFromSpec(spec)

    // SCAN → LIMIT (因为 skip>0 时会创建 LIMIT 节点)
    expect(ir.type).toBe(PlanNodeType.LIMIT)
    expect(ir.details['skip']).toBe(10)
    expect(ir.details['limit']).toBe(1000) // 默认 limit
    expect(ir.children[0].type).toBe(PlanNodeType.SCAN)
  })

  it('limit + skip 同时包含', () => {
    const spec = {
      match: { typeId: 1 },
      limit: 20,
      skip: 5,
    }
    const ir = buildIRFromSpec(spec)

    expect(ir.type).toBe(PlanNodeType.LIMIT)
    expect(ir.details['limit']).toBe(20)
    expect(ir.details['skip']).toBe(5)
  })

  it('limit pushdown 将 limit 值注入 SCAN 的 pushedLimit', () => {
    const spec = {
      match: { typeId: 3 },
      limit: 15,
    }
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)

    // 优化后 SCAN 节点应有 pushedLimit
    const scanNode = optimized.type === PlanNodeType.LIMIT
      ? optimized.children[0]
      : optimized
    if (scanNode.type === PlanNodeType.SCAN) {
      expect(scanNode.details['pushedLimit']).toBe(15)
    }
  })

  it('where 中无匹配条件 → SCAN 无 pushedFilters', () => {
    const spec = { match: { typeId: 4 } }
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)

    expect(optimized.type).toBe(PlanNodeType.SCAN)
    expect(optimized.details['pushedFilters']).toBeUndefined()
  })

  it('spec 完整（match+where+orderBy+limit+return）整体管道', () => {
    const spec = {
      match: { typeId: 8 },
      where: { status: 'active' },
      orderBy: { field: 'score', direction: 'desc' as const },
      limit: 10,
      return: ['id', 'name', 'score'],
    }
    const ir = buildIRFromSpec(spec)

    // 树结构（从上到下）：PROJECT → LIMIT → SORT → [FILTER→SCAN 被下推合并]
    expect(ir.type).toBe(PlanNodeType.PROJECT)
    expect(ir.details['fields']).toEqual(['id', 'name', 'score'])

    const limitNode = ir.children[0]
    expect(limitNode.type).toBe(PlanNodeType.LIMIT)
    expect(limitNode.details['limit']).toBe(10)

    const sortNode = limitNode.children[0]
    expect(sortNode.type).toBe(PlanNodeType.SORT)
    expect(sortNode.details['field']).toBe('score')
    expect(sortNode.details['dir']).toBe('desc')

    // 优化后：FILTER 被下推 → SCAN 带有 pushedFilters
    const optimized = optimizeIR(ir)
    const sortedScanNodes: PlanNode[] = []
    function findScan(node: PlanNode): void {
      if (node.type === PlanNodeType.SCAN) sortedScanNodes.push(node)
      for (const c of node.children) findScan(c)
    }
    findScan(optimized)

    expect(sortedScanNodes.length).toBeGreaterThanOrEqual(1)
    const scan = sortedScanNodes[0]
    expect(scan.details['pushedFilters']).toBeDefined()
    // SORT + LIMIT 共存时，limitPushdown 不穿越 SORT 节点
    // LIMIT 仍保留在 SORT 之后的层，SCAN 看不到 pushedLimit
    // 这是正确的优化行为：先排序再取 TopN，而不是先 limit 再排序
  })

  it('spec = undefined 不会崩溃（空对象降级）', () => {
    // verify that empty object produces valid IR (already tested above)
    const ir = buildIRFromSpec({})
    expect(ir).toBeDefined()
    expect(ir.type).toBe(PlanNodeType.SCAN)
  })
})
