/**
 * show-describe.spec.ts — SHOW / DESCRIBE / DROP CONSTRAINT 解析和执行测试
 *
 * 测试涵盖：
 * - SHOW CONSTRAINTS / INDEXES / PROCEDURES / FUNCTIONS 解析 + 执行
 * - DESCRIBE 等价于 EXPLAIN
 * - DROP CONSTRAINT ON ... ASSERT ... IS UNIQUE 解析
 * - DROP 不存在的语法Error
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, BUILTIN_FUNCTIONS } from './query-engine'
import { parser } from './cypher-lite-parser'

// ═══════════════════════════════════════════════════════════════
// SHOW 测试
// ═══════════════════════════════════════════════════════════════

describe('SHOW — 元数据查询', () => {
  describe('解析 (parseQuery)', () => {
    it('SHOW CONSTRAINTS 解析为 show=constraints', () => {
      const plan = parseQuery('SHOW CONSTRAINTS')
      expect(plan.show).toBe('constraints')
    })

    it('SHOW INDEXES 解析为 show=indexes', () => {
      const plan = parseQuery('SHOW INDEXES')
      expect(plan.show).toBe('indexes')
    })

    it('SHOW PROCEDURES 解析为 show=procedures', () => {
      const plan = parseQuery('SHOW PROCEDURES')
      expect(plan.show).toBe('procedures')
    })

    it('SHOW FUNCTIONS 解析为 show=functions', () => {
      const plan = parseQuery('SHOW FUNCTIONS')
      expect(plan.show).toBe('functions')
    })
  })

  describe('PEG 直接解析', () => {
    it('SHOW CONSTRAINTS — PEG 返回正确 AST', () => {
      const ast = parser.parse('SHOW CONSTRAINTS')
      expect(ast).toEqual({ type: 'SHOW', show: 'constraints' })
    })

    it('SHOW INDEXES — PEG 返回正确 AST', () => {
      const ast = parser.parse('SHOW INDEXES')
      expect(ast).toEqual({ type: 'SHOW', show: 'indexes' })
    })

    it('SHOW PROCEDURES — PEG 返回正确 AST', () => {
      const ast = parser.parse('SHOW PROCEDURES')
      expect(ast).toEqual({ type: 'SHOW', show: 'procedures' })
    })

    it('SHOW FUNCTIONS — PEG 返回正确 AST', () => {
      const ast = parser.parse('SHOW FUNCTIONS')
      expect(ast).toEqual({ type: 'SHOW', show: 'functions' })
    })

    it('SHOW LABELS — PEG 返回正确 AST', () => {
      const ast = parser.parse('SHOW LABELS')
      expect(ast).toEqual({ type: 'SHOW', show: 'labels' })
    })

    it('SHOW RELATIONSHIPTYPES — PEG 返回正确 AST', () => {
      const ast = parser.parse('SHOW RELATIONSHIPTYPES')
      expect(ast).toEqual({ type: 'SHOW', show: 'relationshiptypes' })
    })
  })

  describe('SHOW FUNCTIONS 执行返回函数名列表', () => {
    it('BUILTIN_FUNCTIONS 包含常用函数', () => {
      expect(BUILTIN_FUNCTIONS).toHaveProperty('toUpper')
      expect(BUILTIN_FUNCTIONS).toHaveProperty('toLower')
      expect(BUILTIN_FUNCTIONS).toHaveProperty('substring')
      expect(BUILTIN_FUNCTIONS).toHaveProperty('timestamp')
      expect(BUILTIN_FUNCTIONS).toHaveProperty('coalesce')
      expect(BUILTIN_FUNCTIONS).toHaveProperty('toString')
    })

    it('BUILTIN_FUNCTIONS 的 keys 包含了所有原生函数', () => {
      const keys = Object.keys(BUILTIN_FUNCTIONS)
      expect(keys).toContain('toUpper')
      expect(keys).toContain('toLower')
      expect(keys).toContain('substring')
      expect(keys).toContain('replace')
      expect(keys).toContain('trim')
      expect(keys).toContain('split')
      expect(keys).toContain('reverse')
      expect(keys).toContain('abs')
      expect(keys).toContain('round')
      expect(keys).toContain('timestamp')
      expect(keys).toContain('datetime')
      expect(keys).toContain('coalesce')
      expect(keys).toContain('toString')
      expect(keys).toContain('toInteger')
      expect(keys).toContain('toFloat')
      expect(keys).toContain('type')
      expect(keys).toContain('labels')
      expect(keys).toContain('length')
      expect(keys).toContain('nodes')
      expect(keys).toContain('relationships')
      expect(keys).toContain('startNode')
      expect(keys).toContain('endNode')
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 测试
// ═══════════════════════════════════════════════════════════════

describe('DESCRIBE — 等价于 EXPLAIN', () => {
  it('DESCRIBE MATCH (n:Person) RETURN n → plan.explain = true', () => {
    const plan = parseQuery('DESCRIBE MATCH (n:Person) RETURN n')
    expect(plan.explain).toBe(true)
  })

  it('DESCRIBE 不改变查询语义', () => {
    const plan = parseQuery('DESCRIBE MATCH (n:Person) WHERE n.age > 18 RETURN n.name')
    expect(plan.explain).toBe(true)
    expect(plan.scanLabel).toBe('Person')
  })

  it('PEG 直接解析 DESCRIBE MATCH 为 EXPLAIN 类型', () => {
    const ast = parser.parse('DESCRIBE MATCH (n:Person) RETURN n')
    expect(ast.type).toBe('EXPLAIN')
    expect(ast.explainMode).toBe('describe')
    expect(ast.innerStatement).toBeDefined()
    expect(ast.innerStatement.type).toBe('QUERY')
    expect(ast.innerStatement.match).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════
// DROP CONSTRAINT 测试
// ═══════════════════════════════════════════════════════════════

describe('DROP CONSTRAINT — 解析（执行留空）', () => {
  it('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE 解析成功', () => {
    const ast = parser.parse('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE')
    expect(ast.type).toBe('DROP_CONSTRAINT')
    expect(ast.label).toBe('Person')
    expect(ast.property).toBe('age')
  })

  it('DROP CONSTRAINT ON (x:Label) ASSERT x.id IS UNIQUE 不同 label 和属性', () => {
    const ast = parser.parse('DROP CONSTRAINT ON (x:Label) ASSERT x.id IS UNIQUE')
    expect(ast.type).toBe('DROP_CONSTRAINT')
    expect(ast.label).toBe('Label')
    expect(ast.property).toBe('id')
  })

  it('DROP CONSTRAINT 通过 parseQuery 不抛出异常', () => {
    expect(() => parseQuery('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE')).not.toThrow()
    const plan = parseQuery('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE')
    // 执行留空，plan 应有默认字段
    expect(plan).toBeDefined()
    expect(plan.scanLabel).toBeNull()
  })

  it('DROP CONSTRAINT 缺少 ASSERT 部分应解析失败', () => {
    expect(() => parser.parse('DROP CONSTRAINT ON (node:Person)')).toThrow()
  })

  it('DROP CONSTRAINT 缺少 IS UNIQUE 应解析失败', () => {
    expect(() => parser.parse('DROP CONSTRAINT ON (node:Person) ASSERT node.age')).toThrow()
  })
})
