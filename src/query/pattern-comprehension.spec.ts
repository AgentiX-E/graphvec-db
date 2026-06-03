/**
 * Pattern Comprehension 模式推导测试
 *
 * 语法：[(n)-[:R]->(m) | m.prop] 或 [(n)-[:R]->(m) WHERE cond | m.prop]
 *
 * 测试清单：
 * 1. 基本 pattern comprehension
 * 2. 带 WHERE 过滤
 * 3. 嵌套 comprehension（在列表达式中使用）
 * 4. 空结果 → []
 */
import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

describe('Pattern Comprehension 解析', () => {
  it('基本 pattern comprehension — 解析正确', () => {
    const plan = parseQuery('MATCH (n) RETURN [(n)-[:KNOWS]->(m) | m.name]')
    const compCol = plan.comprehensionColumns
    expect(compCol).toBeDefined()
    expect(compCol!.length).toBe(1)
    const expr = compCol![0].expression
    expect(expr.type).toBe('PATTERN_COMPREHENSION')
    expect(expr.fromNode.name).toBe('n')
    expect(expr.edge.label).toBe('KNOWS')
    expect(expr.edge.direction).toBe('out')
    expect(expr.targetNode.name).toBe('m')
    expect(expr.project.type).toBe('PROP_REF')
    expect(expr.project.property).toBe('name')
    expect(expr.where).toBeNull()
  })

  it('带 WHERE 过滤的模式推导', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN [(n)-[:KNOWS]->(m) WHERE m.age > 18 | m.name]',
    )
    const compCol = plan.comprehensionColumns
    expect(compCol).toBeDefined()
    expect(compCol!.length).toBe(1)
    const expr = compCol![0].expression
    expect(expr.type).toBe('PATTERN_COMPREHENSION')
    expect(expr.where).toBeDefined()
    expect(expr.where.type).toBe('COMPARISON')
    expect(expr.where.operator).toBe('GT')
    expect(expr.where.left.type).toBe('PROP_REF')
    expect(expr.where.left.property).toBe('age')
    expect(expr.project.type).toBe('PROP_REF')
    expect(expr.project.property).toBe('name')
  })

  it('模式推导在列表达式中正确注册 alias', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN [(n)-[:KNOWS]->(m) | m.name] AS friends',
    )
    const compCol = plan.comprehensionColumns
    expect(compCol).toBeDefined()
    expect(compCol![0].alias).toBe('friends')
    expect(plan.returnColumns).toContain('friends')
  })

  it('模式推导列入 returnColumns', () => {
    const plan = parseQuery(
      'MATCH (n) RETURN n.name, [(n)-[:KNOWS]->(m) | m.name]',
    )
    expect(plan.returnColumns.length).toBe(2)
    expect(plan.returnColumns).toContain('_pc_1')
    expect(plan.comprehensionColumns).toBeDefined()
    expect(plan.comprehensionColumns!.length).toBe(1)
  })
})
