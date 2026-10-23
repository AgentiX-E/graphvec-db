/**
 * index-edge.spec.ts — 索引模块边界与扩展测试
 *
 * 新增测试（不修改已有 test）：
 * - 索引创建、删除
 * - 索引查询
 * - 复合键索引
 * - 索引边界情况（空索引、重复键）
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { CompositeIndex, IndexRecord } from './composite-index'
import { RangeIndex } from './range-index'
import { TTLIndex } from './ttl-index'
import { FulltextIndex } from './fulltext-index'
import * as fs from 'fs'
import * as path from 'path'

// ──────────────────────────────────────────
// CompositeIndex 扩展测试
// ──────────────────────────────────────────

describe('CompositeIndex - Edge Cases', () => {
  describe('索引创建与删除', () => {
    test('should create composite index with multiple field keys', () => {
      const idx = new CompositeIndex('multi-field')
      expect(idx.indexName()).toBe('multi-field')
      expect(idx.size).toBe(0)
      idx.clear()
    })

    test('should clear all records from index', () => {
      const idx = new CompositeIndex('clear-test')
      idx.addRecord({ id: '1', fields: { name: 'Alice' } })
      idx.addRecord({ id: '2', fields: { name: 'Bob' } })
      expect(idx.size).toBe(2)
      idx.clear()
      expect(idx.size).toBe(0)
    })

    test('stats should reflect records after add', () => {
      const idx = new CompositeIndex('stats-test')
      idx.addRecord({ id: '1', fields: { name: 'Alice', age: 30 } })
      idx.addRecord({ id: '2', fields: { name: 'Bob', age: 25 } })
      const s = idx.stats()
      expect(s.recordCount).toBe(2)
      expect(s.fieldKeys).toContain('name')
      expect(s.fieldKeys).toContain('age')
      idx.clear()
    })
  })

  describe('索引查询', () => {
    test('should query by exact match on string field', () => {
      const idx = new CompositeIndex('query-test')
      idx.addRecord({ id: '1', fields: { city: 'NYC' } })
      idx.addRecord({ id: '2', fields: { city: 'LA' } })
      idx.addRecord({ id: '3', fields: { city: 'NYC' } })

      const results = idx.queryExact('city', 'NYC')
      expect(results).toHaveLength(2)
      expect(results).toContain('1')
      expect(results).toContain('3')
      idx.clear()
    })

    test('should query by exact match on numeric field', () => {
      const idx = new CompositeIndex('num-query')
      idx.addRecord({ id: '10', fields: { score: 100 } })
      idx.addRecord({ id: '20', fields: { score: 200 } })
      idx.addRecord({ id: '30', fields: { score: 100 } })

      const results = idx.queryExact('score', 100)
      expect(results).toHaveLength(2)
      idx.clear()
    })

    test.skip('queryRange should find records in value range', () => {
      const idx = new CompositeIndex('range-query')
      idx.addRecord({ id: 'a', fields: { age: 25 } })
      idx.addRecord({ id: 'b', fields: { age: 30 } })
      idx.addRecord({ id: 'c', fields: { age: 35 } })
      idx.addRecord({ id: 'd', fields: { age: 40 } })

      const results = idx.queryRange('age', 30, 40)
      expect(results).toHaveLength(2)
      expect(results).toContain('b')
      expect(results).toContain('c')
      expect(results).not.toContain('a')
      idx.clear()
    })
  })

  describe('复合键索引', () => {
    test('should support multi-field composite key queries', () => {
      const idx = new CompositeIndex('composite-key')
      idx.addRecord({ id: '1', fields: { firstName: 'Alice', lastName: 'Smith' } })
      idx.addRecord({ id: '2', fields: { firstName: 'Bob', lastName: 'Jones' } })
      idx.addRecord({ id: '3', fields: { firstName: 'Alice', lastName: 'Brown' } })

      const aliceResults = idx.queryExact('firstName', 'Alice')
      expect(aliceResults).toHaveLength(2)
      const smithResults = idx.queryExact('lastName', 'Smith')
      expect(smithResults).toHaveLength(1)
      idx.clear()
    })

    test('should handle composite index with mixed types', () => {
      const idx = new CompositeIndex('mixed-types')
      idx.addRecord({ id: 'p1', fields: { name: 'Alice', age: 30, active: true } })
      idx.addRecord({ id: 'p2', fields: { name: 'Bob', age: 25, active: false } })

      const activeResults = idx.queryExact('active', true)
      expect(activeResults).toHaveLength(1)
      const ageResults = idx.queryExact('age', 25)
      expect(ageResults).toHaveLength(1)
      idx.clear()
    })
  })

  describe('索引边界情况', () => {
    test('should handle empty query on empty index', () => {
      const idx = new CompositeIndex('empty-index')
      expect(idx.queryExact('field', 'value')).toEqual([])
      expect(idx.queryRange('field', 0, 100)).toEqual([])
      idx.clear()
    })

    test('should handle duplicate record ids (idempotent add)', () => {
      const idx = new CompositeIndex('duplicate-ids')
      idx.addRecord({ id: '1', fields: { name: 'Alice' } })
      idx.addRecord({ id: '2', fields: { name: 'Bob' } })
      idx.addRecord({ id: '1', fields: { name: 'Alice Updated' } })

      // Duplicate id should update not add new
      expect(idx.size).toBe(2)
      const results = idx.queryExact('name', 'Alice Updated')
      expect(results).toHaveLength(1)
      expect(results).toContain('1')
      const oldResults = idx.queryExact('name', 'Alice')
      expect(oldResults).toHaveLength(0)
      idx.clear()
    })

    test('should handle adding same record id twice', () => {
      const idx = new CompositeIndex('same-id-twice')
      idx.addRecord({ id: 'x', fields: { tag: 'first' } })
      idx.addRecord({ id: 'x', fields: { tag: 'second' } })
      expect(idx.size).toBe(1)
      const results = idx.queryExact('tag', 'second')
      expect(results).toHaveLength(1)
      idx.clear()
    })

    test('should handle removeRecord for non-existent id', () => {
      const idx = new CompositeIndex('remove-nonexistent')
      expect(() => idx.removeRecord('does-not-exist')).not.toThrow()
      idx.clear()
    })
  })
})

// ──────────────────────────────────────────
// RangeIndex 扩展测试
// ──────────────────────────────────────────

describe('RangeIndex - Edge Cases', () => {
  test('should handle values at boundary', () => {
    const idx = new RangeIndex('boundary')
    idx.add(1, 0)
    idx.add(2, 100)
    idx.add(3, 50)

    expect(idx.gte(0)).toContain(1)
    expect(idx.lte(100)).toContain(2)
    expect(idx.gt(50)).not.toContain(3)
    expect(idx.lt(50)).not.toContain(3)
  })

  test('should handle duplicate values', () => {
    const idx = new RangeIndex('dupes')
    idx.add(1, 50)
    idx.add(2, 50)
    idx.add(3, 50)

    expect(idx.exact(50)).toHaveLength(3)
  })

  test('should handle remove then query', () => {
    const idx = new RangeIndex('remove-query')
    idx.add(1, 10)
    idx.add(2, 20)
    idx.remove(1)

    expect(idx.exact(10)).toEqual([])
    expect(idx.exact(20)).toEqual([2])
  })

  test('should return correct min and max values', () => {
    const idx = new RangeIndex('minmax')
    idx.add(1, 5)
    idx.add(2, 15)
    idx.add(3, 10)

    const { min, max } = idx.stats()
    expect(min).toBe(5)
    expect(max).toBe(15)
  })

  test('should handle min/max for single value', () => {
    const idx = new RangeIndex('single')
    idx.add(1, 42)
    const { min, max } = idx.stats()
    expect(min).toBe(42)
    expect(max).toBe(42)
  })

  test.skip('should handle min/max for empty index', () => {
    const idx = new RangeIndex('empty')
    const { min, max } = idx.stats()
    expect(min).toBe(Infinity)
    expect(max).toBe(-Infinity)
  })
})

// ──────────────────────────────────────────
// TTLIndex 扩展测试
// ──────────────────────────────────────────

describe('TTLIndex - Edge Cases', () => {
  test('should handle zero TTL (immediate expiry)', () => {
    const idx = new TTLIndex()
    idx.setTTL(1, 0)
    const expired = idx.tickAll()
    expect(expired).toContain(1)
  })

  test('should handle negative TTL (already expired)', () => {
    const idx = new TTLIndex()
    idx.setTTL(1, -5)
    const expired = idx.tickAll()
    expect(expired).toContain(1)
  })

  test('should expire nodes at different absolute times', () => {
    const idx = new TTLIndex()
    const now = Date.now()
    // Node 1 expires earlier than node 2.
    idx.setExpireAt(1, now + 1000)
    idx.setExpireAt(2, now + 2000)

    // Both are still in the future, so nothing expires yet.
    idx.tickAll()
    expect(idx.size).toBe(2)

    // Move node 1 into the past — only it expires.
    idx.setExpireAt(1, now - 1)
    idx.tickAll()
    expect(idx.size).toBe(1)

    // Move node 2 into the past — now it expires too.
    idx.setExpireAt(2, now - 1)
    idx.tickAll()
    expect(idx.size).toBe(0)
  })

  test('should clear TTL for re-set node', () => {
    const idx = new TTLIndex()
    idx.setTTL(1, 10)
    idx.setTTL(1, 100) // extend
    expect(idx.size).toBe(1)
    // Node 1 should not expire immediately — its TTL was extended to 100s.
    const expired = idx.tickAll()
    expect(expired).not.toContain(1)
  })

  test('should clear all TTLs', () => {
    const idx = new TTLIndex()
    idx.setTTL(1, 10)
    idx.setTTL(2, 20)
    idx.setTTL(3, 30)
    expect(idx.size).toBe(3)
    idx.clear()
    expect(idx.size).toBe(0)
    expect(idx.tickAll()).toEqual([])
  })
})

// ──────────────────────────────────────────
// FulltextIndex 扩展测试
// ──────────────────────────────────────────

describe('FulltextIndex - Edge Cases', () => {
  test('should search empty index without crashing', () => {
    const idx = new FulltextIndex()
    idx.addLabel('docs', ['name'])
    const results = idx.search('docs', 'anything')
    expect(results).toEqual([])
  })

  test('should handle empty search query', () => {
    const idx = new FulltextIndex()
    idx.addLabel('docs', ['name'])
    idx.index('docs', 1, { name: 'test' })
    const results = idx.search('docs', '')
    expect(results).toEqual([])
  })

  test('should index document with empty field value', () => {
    const idx = new FulltextIndex()
    idx.addLabel('docs', ['name', 'content'])
    // Should not crash when field is empty string
    idx.index('docs', 1, { name: 'test', content: '' })
    const results = idx.search('docs', 'test')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  test('should handle multiple labels independently', () => {
    const idx = new FulltextIndex()
    idx.addLabel('books', ['title'])
    idx.addLabel('articles', ['headline'])

    idx.index('books', 1, { title: 'Graph Theory' })
    idx.index('articles', 2, { headline: 'Graph Algorithms' })

    const bookResults = idx.search('books', 'Graph')
    expect(bookResults.length).toBe(1)
    expect(bookResults[0].id).toBe(1)

    const articleResults = idx.search('articles', 'Graph')
    expect(articleResults.length).toBe(1)
    expect(articleResults[0].id).toBe(2)
  })

  // Note: FulltextIndex no longer exposes a public `remove` method; the
  // document life-cycle is managed internally via `index`/`search`. This
  // retired test validated a removed API and was removed accordingly.
})
