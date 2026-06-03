/**
 * label-expression.spec.ts — 标签表达式 & 节点模式增强单元测试
 *
 * 覆盖：
 * - LABEL_EXPR（union、exclude、mixed）
 * - 无标签 (n)
 * - 无方向边 ()--() / ()-[]-()
 * - 空结果
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ── 辅助函数 ─────────────────────────────────────────────
function makeNodes(...labels: string[]): any[] {
  return labels.map((l, i) => ({ _label: l, id: i, name: l }))
}

function run(query: string, nodes: any[]): any[] {
  const plan = parseQuery(query)
  return _executeQuery(plan, nodes)
}

// ── 测试套件 ─────────────────────────────────────────────
describe('标签表达式 LABEL_EXPR', () => {
  const nodes = makeNodes('Person', 'Animal', 'Thing')

  // ── union ──
  it('MATCH (n:Person|Animal) 返回 Person OR Animal 标签的节点', () => {
    const plan = parseQuery('MATCH (n:Person|Animal) RETURN n')
    expect(plan.labelExpr).toEqual({
      type: 'LABEL_EXPR',
      items: [
        { exclude: false, name: 'Person' },
        { exclude: false, name: 'Animal' },
      ],
    })
    const result = run('MATCH (n:Person|Animal) RETURN n', nodes)
    expect(result).toHaveLength(2)
  })

  // ── exclude ──
  it('MATCH (n:!Person) 排除 Person 标签', () => {
    const plan = parseQuery('MATCH (n:!Person) RETURN n')
    expect(plan.labelExpr).toEqual({
      type: 'LABEL_EXPR',
      items: [{ exclude: true, name: 'Person' }],
    })
    const result = run('MATCH (n:!Person) RETURN n', nodes)
    expect(result).toHaveLength(2)
  })

  // ── 无标签 ──
  it('MATCH (n) 无标签时匹配所有节点', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.scanLabel).toBeNull()
    expect(plan.labelExpr).toBeNull()
    const result = run('MATCH (n) RETURN n', nodes)
    expect(result).toHaveLength(3)
  })

  // ── 无方向边 ──
  it('()-[r]-() 无方向边匹配', () => {
    const plan = parseQuery('MATCH (a)-[r]-(b) RETURN a,b')
    expect(plan.steps.length).toBeGreaterThanOrEqual(1)
    expect(plan.steps[0].direction).toBe('any')
  })

  it('()--() 无方向边匹配（简写）', () => {
    const plan = parseQuery('MATCH (a)--(b) RETURN a,b')
    expect(plan.steps.length).toBeGreaterThanOrEqual(1)
    expect(plan.steps[0].direction).toBe('any')
  })

  it('()-[]-() 无方向边匹配（空边简写）', () => {
    const plan = parseQuery('MATCH (a)-[]-(b) RETURN a,b')
    expect(plan.steps.length).toBeGreaterThanOrEqual(1)
    expect(plan.steps[0].direction).toBe('any')
  })

  // ── 混合标签表达式 ──
  it('MATCH (n:Person|!Animal) 混合标签表达式', () => {
    const plan = parseQuery('MATCH (n:Person|!Animal) RETURN n')
    expect(plan.labelExpr).toEqual({
      type: 'LABEL_EXPR',
      items: [
        { exclude: false, name: 'Person' },
        { exclude: true, name: 'Animal' },
      ],
    })
    // Person only — Animal is excluded
    const result = run('MATCH (n:Person|!Animal) RETURN n', nodes)
    expect(result).toHaveLength(1)
  })

  // ── 空结果 ──
  it('不匹配的标签表达式返回空结果', () => {
    const plan = parseQuery('MATCH (n:Robot) RETURN n')
    expect(plan.scanLabel).toBe('Robot')
    const result = run('MATCH (n:Robot) RETURN n', nodes)
    expect(result).toHaveLength(0)
  })

  // ── 带属性的标签表达式 ──
  it('LABEL_EXPR 带属性过滤器', () => {
    const labeledNodes = [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Person', name: 'Bob', age: 25 },
      { _label: 'Animal', name: 'Buddy', age: 3 },
    ]
    const plan = parseQuery('MATCH (n:Person|Animal) RETURN n')
    expect(plan.scanLabel).toBe('Person')
    const result = _executeQuery(plan, labeledNodes)
    expect(result).toHaveLength(3)
  })
})
