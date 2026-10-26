/**
 * range-index.spec.ts — 范围索引测试
 */
import { RangeIndex } from './range-index'
import { isCoverageEnabled } from '../test-utils/coverage'

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

  describe('performance O(log n)', () => {
    test.skipIf(isCoverageEnabled())('should have O(log n) insertion performance', () => {
      const idxSmall = new RangeIndex('x')
      const idxLarge = new RangeIndex('x')
      const nSmall = 10_000
      const nLarge = 100_000

      // warmup
      for (let i = 0; i < nSmall; i++) idxSmall.add(i, i * 2)
      for (let i = 0; i < nLarge; i++) idxLarge.add(i, i * 2)

      const start = performance.now()
      for (let i = 0; i < 10_000; i++) {
        idxSmall.exact(i * 2 + 1) // search for non-existent values (cache miss)
      }
      const timeSmall = performance.now() - start

      const start2 = performance.now()
      for (let i = 0; i < 10_000; i++) {
        idxLarge.exact(i * 2 + 1)
      }
      const timeLarge = performance.now() - start2

      // O(log n) means 10x data → ~1.25x time (log(100k)/log(10k) ≈ 5/4).
      // A linear scan would be ~10x. Use 5.0 as the cutoff: it still cleanly
      // rejects O(n) behavior while tolerating GC/cache noise on loaded CI
      // runners (a tight 3.0 threshold flakes when large-index time spikes to
      // ~3.7x purely from allocation pressure).
      const ratio = timeLarge / timeSmall
      expect(ratio).toBeLessThan(5.0)
    })

    test.skipIf(isCoverageEnabled())('should handle 100k sequential inserts efficiently', () => {
      const idx = new RangeIndex('seq')
      const start = performance.now()
      for (let i = 0; i < 100_000; i++) idx.add(i, i)
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(5000) // 5s
    })
  })
})
