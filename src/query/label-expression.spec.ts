/**
 * label-expression.spec.ts — label expression & node pattern unit tests
 *
 * Covers:
 * - Multi-label AND matching (n:Person:Employee → labelExpr):
 *   the only label-expression form currently implemented.  OR (`|`) and
 *   exclude (`!`) label expressions are NOT supported by the ANTLR grammar
 *   (they are rejected at the lexer level), so no tests assume them.
 * - No label (n)
 * - Undirected edges ()--() / ()-[r]-() / ()-[]-()
 * - Empty result
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ── 辅助函数 ─────────────────────────────────────────────
function makeNodes(...labels: string[]): any[] {
  return labels.map((l, i) => ({ _label: l, id: i, name: l }))
}

// ── 测试套件 ─────────────────────────────────────────────
describe('标签表达式 LABEL_EXPR', () => {
  const nodes = makeNodes('Person', 'Animal', 'Thing')

  // ── 多标签 AND ──
  it('MATCH (n:Person:Employee) 多标签 AND → labelExpr', () => {
    const plan = parseQuery('MATCH (n:Person:Employee) RETURN n')
    expect(plan.scanLabel).toBe('Person')
    expect(plan.labelExpr).toEqual({
      type: 'LABEL_EXPR',
      items: [
        { exclude: false, name: 'Person' },
        { exclude: false, name: 'Employee' },
      ],
    })
  })

  // ── 无标签 ──
  it('MATCH (n) 无标签时匹配所有节点', async () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.scanLabel).toBeNull()
    expect(plan.labelExpr).toBeNull()
    const result = await _executeQuery(plan, nodes, 'MATCH (n) RETURN n')
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

  // ── 空结果 ──
  it('不匹配的标签返回空结果', async () => {
    const plan = parseQuery('MATCH (n:Robot) RETURN n')
    expect(plan.scanLabel).toBe('Robot')
    const result = await _executeQuery(plan, nodes, 'MATCH (n:Robot) RETURN n')
    expect(result).toHaveLength(0)
  })

  // ── 单标签 ──
  it('MATCH (n:Person) 单标签匹配', async () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n')
    expect(plan.scanLabel).toBe('Person')
    expect(plan.labelExpr).toBeNull()
    const result = await _executeQuery(plan, nodes, 'MATCH (n:Person) RETURN n')
    expect(result).toHaveLength(1)
  })
})
