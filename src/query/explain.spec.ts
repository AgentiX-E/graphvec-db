/**
 * explain.spec.ts — EXPLAIN 查询分析器测试
 *
 * 测试点：
 * - isExplainQuery 判断
 * - parseExplainQuery 解析
 * - text 格式输出
 * - JSON 格式输出
 * - ANALYZE 格式（含耗时）
 * - parseExplainNode
 * - formatExplainNode
 */
import { describe, test, expect, vi } from 'vitest'
import { ExplainFormatter, ExplainNode, parseExplainNode, formatExplainNode, AnalyzeTiming } from './explain'
import {
  parseQuery,
  QueryPlan,
  _generatePlanTree,
  _formatPlanTree,
  _profileQuery,
  explainQuery,
} from './query-engine'

describe('ExplainFormatter', () => {
  describe('GAP-30: isExplainQuery', () => {
    test('should detect EXPLAIN query', () => {
      expect(ExplainFormatter.isExplainQuery('EXPLAIN MATCH (n) RETURN n')).toBe(true)
      expect(ExplainFormatter.isExplainQuery('explain match (n) return n')).toBe(true)
      expect(ExplainFormatter.isExplainQuery('Explain MATCH (n) RETURN n')).toBe(true)
    })

    test('should return false for non-EXPLAIN query', () => {
      expect(ExplainFormatter.isExplainQuery('MATCH (n) RETURN n')).toBe(false)
      expect(ExplainFormatter.isExplainQuery('CREATE (n:Test {id: 1})')).toBe(false)
      expect(ExplainFormatter.isExplainQuery('')).toBe(false)
    })
  })

  describe('GAP-30: parseExplainQuery', () => {
    test('should parse EXPLAIN with text mode (default)', () => {
      const result = ExplainFormatter.parseExplainQuery('EXPLAIN MATCH (n:Person) RETURN n.name')
      expect(result).not.toBeNull()
      expect(result!.mode).toBe('text')
      expect(result!.innerQuery).toBe('MATCH (n:Person) RETURN n.name')
    })

    test('should parse EXPLAIN JSON', () => {
      const result = ExplainFormatter.parseExplainQuery('EXPLAIN JSON MATCH (n:Person) RETURN n.name')
      expect(result).not.toBeNull()
      expect(result!.mode).toBe('json')
      expect(result!.innerQuery).toBe('MATCH (n:Person) RETURN n.name')
    })

    test('should parse EXPLAIN ANALYZE', () => {
      const result = ExplainFormatter.parseExplainQuery('EXPLAIN ANALYZE MATCH (n:Person) RETURN n.name')
      expect(result).not.toBeNull()
      expect(result!.mode).toBe('analyze')
      expect(result!.innerQuery).toBe('MATCH (n:Person) RETURN n.name')
    })

    test('should ignore leading whitespace', () => {
      const result = ExplainFormatter.parseExplainQuery('  EXPLAIN MATCH (n) RETURN n')
      expect(result).not.toBeNull()
      expect(result!.mode).toBe('text')
    })

    test('should return null for non-EXPLAIN query', () => {
      expect(ExplainFormatter.parseExplainQuery('MATCH (n) RETURN n')).toBeNull()
    })
  })

  describe('GAP-30: 文本格式', () => {
    test('should format simple query plan as text', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
        limit: 10,
      }

      const result = ExplainFormatter.format(plan, { mode: 'text' })
      expect(result.planText).toContain(':Person')
      expect(result.planText).toContain('返回列')
      expect(result.planText).toContain('LIMIT: 10')
    })

    test('should format query with traversal steps', () => {
      const plan: QueryPlan = {
        scanLabel: null,
        steps: [
          { direction: 'out', edgeLabel: 'KNOWS', targetLabel: 'Person' },
        ],
        filters: [{ left: 'n.age', operator: '>', right: '30' }],
        returnColumns: ['n.name'],
      }

      const result = ExplainFormatter.format(plan, { mode: 'text' })
      expect(result.planText).toContain('ALL')
      expect(result.planText).toContain('KNOWS')
      expect(result.planText).toContain('过滤')
      expect(result.planText).toContain('n.age > 30')
    })

    test('should format variable-length path', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [
          { direction: 'out', edgeLabel: 'KNOWS', targetLabel: 'Person', minDepth: 1, maxDepth: 5 },
        ],
        filters: [],
        returnColumns: ['b.name'],
      }

      const result = ExplainFormatter.format(plan, { mode: 'text' })
      expect(result.planText).toContain('变长路径')
      expect(result.planText).toContain('1')
      expect(result.planText).toContain('5')
    })

    test('should format CREATE query', () => {
      const plan: QueryPlan = {
        type: 'CREATE',
        scanLabel: null,
        steps: [],
        filters: [],
        returnColumns: [],
        createNodes: [{ alias: 'n', label: 'Person', props: { name: 'Alice' } }],
        createEdges: [],
      }

      const result = ExplainFormatter.format(plan, { mode: 'text' })
      expect(result.planText).toContain('CREATE')
      expect(result.planText).toContain('Person')
    })

    test('should format query with ORDER BY', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
        orderBy: [{ property: 'n.name', direction: 'ASC' }],
      }

      const result = ExplainFormatter.format(plan, { mode: 'text' })
      expect(result.planText).toContain('排序')
      expect(result.planText).toContain('ASC')
    })

    test('should format query with aggregate', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['count(n)'],
        aggregate: { function: 'count', column: 'n' },
      }

      const result = ExplainFormatter.format(plan, { mode: 'text' })
      expect(result.planText).toContain('count')
    })
  })

  describe('GAP-30: JSON 格式', () => {
    test('should format query plan as JSON', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
        limit: 10,
      }

      const result = ExplainFormatter.format(plan, { mode: 'json' })
      expect(() => JSON.parse(result.planText)).not.toThrow()

      const parsed = JSON.parse(result.planText)
      expect(parsed.scanLabel).toBe('Person')
      expect(parsed.returnColumns).toEqual(['n.name'])
      expect(parsed.limit).toBe(10)
    })

    test('should include steps in JSON output', () => {
      const plan: QueryPlan = {
        scanLabel: null,
        steps: [{ direction: 'out', edgeLabel: 'KNOWS' }],
        filters: [],
        returnColumns: [],
      }

      const result = ExplainFormatter.format(plan, { mode: 'json' })
      const parsed = JSON.parse(result.planText)
      expect(parsed.steps).toHaveLength(1)
      expect(parsed.steps[0].edgeLabel).toBe('KNOWS')
    })

    test('should include filters in JSON output', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [{ left: 'n.age', operator: '>', right: '30' }],
        returnColumns: [],
      }

      const result = ExplainFormatter.format(plan, { mode: 'json' })
      const parsed = JSON.parse(result.planText)
      expect(parsed.filters).toHaveLength(1)
      expect(parsed.filters[0].operator).toBe('>')
    })

    test('should create proper JSON output for complete plan', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [{ direction: 'out', edgeLabel: 'KNOWS', targetLabel: 'Friend' }],
        filters: [{ left: 'n.name', operator: '=', right: '"Alice"' }],
        returnColumns: ['n.name', 'b.name'],
        orderBy: [{ property: 'n.name', direction: 'ASC' }],
        limit: 5,
        skip: 10,
      }

      const result = ExplainFormatter.format(plan, { mode: 'json' })
      const parsed = JSON.parse(result.planText)
      expect(parsed.scanLabel).toBe('Person')
      expect(parsed.limit).toBe(5)
      expect(parsed.skip).toBe(10)
    })
  })

  describe('GAP-30: ANALYZE 模式', () => {
    test('analyze should return timings', async () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }

      const mockExecute = vi.fn().mockResolvedValue(10)
      const result = await ExplainFormatter.analyze(plan, mockExecute)

      expect(result.timings).toBeDefined()
      expect(result.timings!.length).toBeGreaterThanOrEqual(2)
      expect(result.timings![0].phase).toContain('解析')
      expect(result.timings![1].phase).toContain('执行')
      expect(result.timings![1].rows).toBe(10)
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0)
    })

    test('analyze should handle execution failure', async () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }

      const mockExecute = vi.fn().mockRejectedValue(new Error('exec failed'))
      const result = await ExplainFormatter.analyze(plan, mockExecute)

      expect(result.timings![1].rows).toBe(0)
      expect(result.timings![1].durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('GAP-30: parseExplainNode / formatExplainNode', () => {
    test('parseExplainNode should extract ExplainNode', () => {
      const node = parseExplainNode('EXPLAIN MATCH (n:Person) RETURN n.name')
      expect(node).not.toBeNull()
      expect(node!.type).toBe('EXPLAIN')
      expect(node!.mode).toBe('text')
      expect(node!.innerQuery).toBe('MATCH (n:Person) RETURN n.name')
    })

    test('parseExplainNode should handle JSON mode', () => {
      const node = parseExplainNode('EXPLAIN JSON MATCH (n) RETURN n')
      expect(node).not.toBeNull()
      expect(node!.mode).toBe('json')
    })

    test('parseExplainNode should return null for non-EXPLAIN', () => {
      expect(parseExplainNode('MATCH (n) RETURN n')).toBeNull()
    })

    test('formatExplainNode should produce readable output', () => {
      const node: ExplainNode = { type: 'EXPLAIN', mode: 'text', innerQuery: 'MATCH (n:Person) RETURN n.name' }
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }

      const output = formatExplainNode(node, plan)
      expect(output).toContain(':Person')
      expect(output).toContain('执行计划')
    })

    test('formatExplainNode should include ANALYZE timings', () => {
      const node: ExplainNode = { type: 'EXPLAIN', mode: 'analyze', innerQuery: 'MATCH (n:Person) RETURN n.name' }
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }

      const timings: AnalyzeTiming[] = [
        { phase: '解析 (Parse)', durationMs: 0.5, rows: 0 },
        { phase: '执行 (Execute)', durationMs: 12.3, rows: 42 },
      ]

      const output = formatExplainNode(node, plan, timings)
      expect(output).toContain('执行计划')
      expect(output).toContain('执行耗时')
      expect(output).toContain('12.30ms')
      expect(output).toContain('42')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// EXPLAIN / PROFILE — query-engine.ts 层集成测试
// ═══════════════════════════════════════════════════════════════════
describe('EXPLAIN / PROFILE 集成 (query-engine.ts)', () => {
  describe('parseQuery 解析 EXPLAIN / PROFILE 前缀', () => {
    test('EXPLAIN MATCH (n) RETURN n → plan.explain = true', () => {
      const plan = parseQuery('EXPLAIN MATCH (n) RETURN n')
      expect(plan.explain).toBe(true)
      expect(plan.profile).toBeFalsy()
    })

    test('PROFILE MATCH (n) RETURN n → plan.profile = true', () => {
      const plan = parseQuery('PROFILE MATCH (n) RETURN n')
      expect(plan.profile).toBe(true)
      expect(plan.explain).toBeFalsy()
    })

    test('普通查询 (无 EXPLAIN/PROFILE) 不应设置标志', () => {
      const plan = parseQuery('MATCH (n) RETURN n')
      expect(plan.explain).toBeUndefined()
      expect(plan.profile).toBeUndefined()
    })

    test('EXPLAIN 大小写不敏感', () => {
      const plan = parseQuery('explain match (n:Person) where n.age > 18 return n.name')
      expect(plan.explain).toBe(true)
    })
  })

  describe('_generatePlanTree — 生成执行计划树', () => {
    test('简单的 MATCH + WHERE + RETURN 生成完整树', () => {
      const plan = parseQuery('EXPLAIN MATCH (n:Person) WHERE n.age > 18 RETURN n.name')
      const tree = _generatePlanTree(plan)

      expect(tree).toBeDefined()
      expect(tree.operator).toBe('SCAN_ALL')
      expect(tree.children).toBeDefined()
      const ops = collectOperators(tree)
      expect(ops).toContain('SCAN_ALL')
      expect(ops).toContain('LABEL_FILTER')
      expect(ops).toContain('FILTER')
      expect(ops).toContain('PROJECT')
    })

    test('MATCH + RETURN 的基本树结构', () => {
      const plan: QueryPlan = {
        scanLabel: null,
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }
      const tree = _generatePlanTree(plan)
      expect(tree.operator).toBe('SCAN_ALL')
      expect(tree.children).toHaveLength(1)
      expect(tree.children![0].operator).toBe('PROJECT')
    })

    test('ORDER BY + LIMIT 生成排序和限制节点', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [],
        returnColumns: ['n.name', 'n.age'],
        orderBy: [{ property: 'n.age', direction: 'DESC' }],
        limit: 5,
      }
      const tree = _generatePlanTree(plan)
      const ops = collectOperators(tree)
      expect(ops).toContain('ORDER_BY')
      expect(ops).toContain('LIMIT')
    })
  })

  describe('_formatPlanTree — 格式化计划树为可读字符串', () => {
    test('生成带树状缩进的字符串', () => {
      const plan: QueryPlan = {
        scanLabel: null,
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }
      const tree = _generatePlanTree(plan)
      const output = _formatPlanTree(tree)
      expect(output).toContain('SCAN_ALL')
      expect(output).toContain('PROJECT')
      expect(output).toContain('└──')
    })

    test('多阶段计划输出包含所有阶段', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [{ source: 'n', property: 'age', operator: 'GT', value: 18 }],
        returnColumns: ['n.name'],
        orderBy: [{ property: 'n.name', direction: 'ASC' }],
      }
      const tree = _generatePlanTree(plan)
      const output = _formatPlanTree(tree)
      expect(output).toContain('SCAN_ALL')
      expect(output).toContain('LABEL_FILTER')
      expect(output).toContain('FILTER')
      expect(output).toContain('PROJECT')
      expect(output).toContain('ORDER_BY')
    })
  })

  describe('_profileQuery — 收集每步执行统计', () => {
    test('PROFILE 收集阶段统计Info', () => {
      const plan: QueryPlan = {
        scanLabel: 'Person',
        steps: [],
        filters: [{ source: 'n', property: 'age', operator: 'GT', value: 18 }],
        returnColumns: ['n.name'],
      }
      const nodes: Array<Record<string, unknown>> = [
        { _label: 'Person', name: 'Alice', age: 25 },
        { _label: 'Person', name: 'Bob', age: 30 },
      ]
      const result = _profileQuery(plan, nodes)

      expect(result.plan).toBeDefined()
      expect(result.stages).toBeInstanceOf(Array)
      expect(result.stages.length).toBeGreaterThanOrEqual(2)
      for (const stage of result.stages) {
        expect(stage).toHaveProperty('operator')
        expect(stage).toHaveProperty('rows')
        expect(stage).toHaveProperty('timeMs')
      }
    })
  })

  describe('explainQuery — 完整输出', () => {
    test('EXPLAIN 生成完整执行计划字符串', () => {
      const plan: QueryPlan = {
        explain: true,
        scanLabel: null,
        steps: [],
        filters: [],
        returnColumns: ['n.name'],
      }
      const output = explainQuery(plan)
      expect(output).toContain('Execution Plan')
      expect(output).toContain('SCAN_ALL')
    })

    test('PROFILE 添加执行统计', () => {
      const plan: QueryPlan = {
        profile: true,
        scanLabel: 'Person',
        steps: [],
        filters: [{ source: 'n', property: 'age', operator: 'GT', value: 18 }],
        returnColumns: ['n.name'],
      }
      const nodes: Array<Record<string, unknown>> = [
        { _label: 'Person', name: 'Alice', age: 25 },
      ]
      const output = explainQuery(plan, nodes)
      expect(output).toContain('Execution Plan')
      expect(output).toContain('Profile')
      expect(output).toContain('rows')
      expect(output).toContain('cost')
    })
  })

  // 辅助测试函数
})

/** 收集 PlanNode 树中的所有操作符名 */
function collectOperators(node: any): string[] {
  const ops: string[] = []
  function walk(n: any) {
    if (n && n.operator) {
      ops.push(n.operator)
      if (n.children) {
        for (const c of n.children) {
          walk(c)
        }
      }
    }
  }
  walk(node)
  return ops
}
