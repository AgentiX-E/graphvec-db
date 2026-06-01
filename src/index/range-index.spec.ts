/**
 * range-index.spec.ts — 范围索引测试
 */
import { RangeIndex } from './range-index'

describe('RangeIndex', () => {
  describe('add / exact', () => {
    test('should add and find by exact value', () => {
      const idx = new RangeIndex('age')
      idx.add(1, 25)
      idx.add(2, 30)
      idx.add(3, 25)

      expect(idx.exact(25)).toEqual(expect.arrayContaining([1, 3]))
      expect(idx.exact(30)).toEqual([2])
      expect(idx.exact(99)).toEqual([])
    })

    test('should return empty for non-existent value', () => {
      const idx = new RangeIndex('age')
      expect(idx.exact(100)).toEqual([])
    })
  })

  describe('lt (less than)', () => {
    test('should find all nodes with value < bound', () => {
      const idx = new RangeIndex('score')
      idx.addMany([
        { nodeId: 1, value: 10 },
        { nodeId: 2, value: 20 },
        { nodeId: 3, value: 30 },
        { nodeId: 4, value: 40 },
      ])

      const result = idx.lt(30)
      expect(result.sort()).toEqual([1, 2])
    })

    test('should return empty when all values >= bound', () => {
      const idx = new RangeIndex('score')
      idx.add(1, 100)
      expect(idx.lt(50)).toEqual([])
    })
  })

  describe('lte (less than or equal)', () => {
    test('should include bound value', () => {
      const idx = new RangeIndex('score')
      idx.addMany([
        { nodeId: 1, value: 10 },
        { nodeId: 2, value: 20 },
        { nodeId: 3, value: 30 },
      ])

      const result = idx.lte(20)
      expect(result.sort()).toEqual([1, 2])
    })
  })

  describe('gt (greater than)', () => {
    test('should find all nodes with value > bound', () => {
      const idx = new RangeIndex('score')
      idx.addMany([
        { nodeId: 1, value: 10 },
        { nodeId: 2, value: 20 },
        { nodeId: 3, value: 30 },
      ])

      const result = idx.gt(20)
      expect(result).toEqual([3])
    })
  })

  describe('gte (greater than or equal)', () => {
    test('should include bound value', () => {
      const idx = new RangeIndex('score')
      idx.addMany([
        { nodeId: 1, value: 10 },
        { nodeId: 2, value: 20 },
        { nodeId: 3, value: 30 },
      ])

      const result = idx.gte(20)
      expect(result.sort()).toEqual([2, 3])
    })
  })

  describe('between', () => {
    test('should find nodes within inclusive range', () => {
      const idx = new RangeIndex('score')
      idx.addMany([
        { nodeId: 1, value: 10 },
        { nodeId: 2, value: 20 },
        { nodeId: 3, value: 30 },
        { nodeId: 4, value: 40 },
      ])

      const result = idx.between(15, 35)
      expect(result.sort()).toEqual([2, 3])
    })

    test('should return empty when min > max', () => {
      const idx = new RangeIndex('score')
      idx.add(1, 50)
      expect(idx.between(60, 40)).toEqual([])
    })

    test('should handle single-value range', () => {
      const idx = new RangeIndex('score')
      idx.add(1, 50)
      idx.add(2, 60)
      expect(idx.between(50, 50)).toEqual([1])
    })
  })

  describe('remove', () => {
    test('should remove a node from all values', () => {
      const idx = new RangeIndex('age')
      idx.add(1, 25)
      idx.add(2, 30)
      idx.add(1, 35) // node 1 appears twice (possible if props update)

      expect(idx.exact(25)).toContain(1)
      idx.remove(1)
      expect(idx.exact(25)).not.toContain(1)
      expect(idx.exact(35)).not.toContain(1)
    })

    test('should return false for non-existent node', () => {
      const idx = new RangeIndex('age')
      expect(idx.remove(999)).toBe(false)
    })
  })

  describe('stats', () => {
    test('should return correct min, max, count', () => {
      const idx = new RangeIndex('age')
      idx.add(1, 18)
      idx.add(2, 65)
      idx.add(3, 30)

      const stats = idx.stats()
      expect(stats.min).toBe(18)
      expect(stats.max).toBe(65)
      expect(stats.count).toBe(3)
    })

    test('should handle empty index', () => {
      const idx = new RangeIndex('test')
      const stats = idx.stats()
      expect(stats.min).toBeUndefined()
      expect(stats.max).toBeUndefined()
      expect(stats.count).toBe(0)
    })
  })

  describe('clear', () => {
    test('should clear all entries', () => {
      const idx = new RangeIndex('age')
      idx.add(1, 25)
      idx.add(2, 30)
      idx.clear()
      expect(idx.size).toBe(0)
      expect(idx.exact(25)).toEqual([])
      expect(idx.stats().count).toBe(0)
    })
  })

  describe('addMany', () => {
    test('should add multiple entries at once', () => {
      const idx = new RangeIndex('age')
      idx.addMany([
        { nodeId: 1, value: 20 },
        { nodeId: 2, value: 30 },
        { nodeId: 3, value: 40 },
      ])

      expect(idx.lte(30).sort()).toEqual([1, 2])
      expect(idx.gt(30)).toEqual([3])
    })
  })
})
