/**
 * show-describe.spec.ts — SHOW / DESCRIBE / DROP CONSTRAINT parsing and execution
 *
 * Migrated from the legacy `cypher-lite-parser` + `BUILTIN_FUNCTIONS` API to the
 * current `parseQuery` + `_executeQuery` facade.
 *
 * Current semantics:
 * - SHOW <X>      → `plan.show = { what: '<X>' }` (an object, not a bare string)
 * - DESCRIBE ...  → `plan.explain = true` (DESCRIBE is equivalent to EXPLAIN)
 * - DROP CONSTRAINT → `plan.type = 'DROP_CONSTRAINT'`
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ═══════════════════════════════════════════════════════════════
// SHOW 测试
// ═══════════════════════════════════════════════════════════════

describe('SHOW — 元数据查询', () => {
  describe('解析 (parseQuery)', () => {
    it('SHOW CONSTRAINTS 解析为 show.what=CONSTRAINTS', () => {
      const plan = parseQuery('SHOW CONSTRAINTS') as any
      expect(plan.show).toEqual({ what: 'CONSTRAINTS' })
    })

    it('SHOW INDEXES 解析为 show.what=INDEXES', () => {
      const plan = parseQuery('SHOW INDEXES') as any
      expect(plan.show).toEqual({ what: 'INDEXES' })
    })

    it('SHOW PROCEDURES 解析为 show.what=PROCEDURES', () => {
      const plan = parseQuery('SHOW PROCEDURES') as any
      expect(plan.show).toEqual({ what: 'PROCEDURES' })
    })

    it('SHOW FUNCTIONS 解析为 show.what=FUNCTIONS', () => {
      const plan = parseQuery('SHOW FUNCTIONS') as any
      expect(plan.show).toEqual({ what: 'FUNCTIONS' })
    })

    it('SHOW LABELS 解析为 show.what=LABELS', () => {
      const plan = parseQuery('SHOW LABELS') as any
      expect(plan.show).toEqual({ what: 'LABELS' })
    })

    it('SHOW RELATIONSHIPTYPES 解析为 show.what=RELATIONSHIPTYPES', () => {
      const plan = parseQuery('SHOW RELATIONSHIPTYPES') as any
      expect(plan.show).toEqual({ what: 'RELATIONSHIPTYPES' })
    })
  })

  describe('执行', () => {
    it('SHOW FUNCTIONS 返回函数名列表', async () => {
      const plan = parseQuery('SHOW FUNCTIONS')
      const rows = await _executeQuery(plan, [], 'SHOW FUNCTIONS') as any[]
      expect(Array.isArray(rows)).toBe(true)
      expect(rows.length).toBeGreaterThan(0)
      const names = rows.map((r) => r.name)
      expect(names).toContain('toString')
      expect(names).toContain('toInteger')
      expect(names).toContain('labels')
    })

    it('SHOW LABELS 收集节点标签', async () => {
      const nodes = [
        { _label: 'Person', name: 'Alice' },
        { _label: 'Person', name: 'Bob' },
        { _label: 'Animal', name: 'Rex' },
      ]
      const plan = parseQuery('SHOW LABELS')
      const rows = await _executeQuery(plan, nodes, 'SHOW LABELS') as any[]
      const labels = rows.map((r) => r.label)
      expect(labels).toEqual(['Person', 'Animal'])
    })

    it('SHOW RELATIONSHIPTYPES 收集边类型', async () => {
      const nodes = [
        {
          _label: 'Person',
          name: 'Alice',
          __edges: [{ srcIdx: 0, dstIdx: 1, label: 'KNOWS' }],
        },
      ]
      const plan = parseQuery('SHOW RELATIONSHIPTYPES')
      const rows = await _executeQuery(plan, nodes, 'SHOW RELATIONSHIPTYPES') as any[]
      const types = rows.map((r) => r.relationshipType)
      expect(types).toContain('KNOWS')
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 测试
// ═══════════════════════════════════════════════════════════════

describe('DESCRIBE — 等价于 EXPLAIN', () => {
  it('DESCRIBE MATCH (n:Person) RETURN n → plan.explain = true', () => {
    const plan = parseQuery('DESCRIBE MATCH (n:Person) RETURN n') as any
    expect(plan.explain).toBe(true)
  })

  it('DESCRIBE 保留查询语义 (scanLabel)', () => {
    const plan = parseQuery('DESCRIBE MATCH (n:Person) WHERE n.age > 18 RETURN n.name') as any
    expect(plan.explain).toBe(true)
    expect(plan.scanLabel).toBe('Person')
  })
})

// ═══════════════════════════════════════════════════════════════
// DROP CONSTRAINT 测试
// ═══════════════════════════════════════════════════════════════

describe('DROP CONSTRAINT — 解析', () => {
  it('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE → type=DROP_CONSTRAINT', () => {
    const plan = parseQuery('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE') as any
    expect(plan.type).toBe('DROP_CONSTRAINT')
  })

  it('DROP CONSTRAINT 不同 label 和属性也解析为 DROP_CONSTRAINT', () => {
    const plan = parseQuery('DROP CONSTRAINT ON (x:Label) ASSERT x.id IS UNIQUE') as any
    expect(plan.type).toBe('DROP_CONSTRAINT')
  })

  it('DROP CONSTRAINT 通过 parseQuery 不抛出异常', () => {
    expect(() => parseQuery('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE')).not.toThrow()
    const plan = parseQuery('DROP CONSTRAINT ON (node:Person) ASSERT node.age IS UNIQUE') as any
    expect(plan).toBeDefined()
  })
})
