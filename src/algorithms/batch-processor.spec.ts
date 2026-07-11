/**
 * batch-processor.spec.ts — BatchProcessor 单元测试
 *
 * 验证：
 * 1. splitIntoBatches：正确分块、边界值、Error处理
 * 2. processInBatches：批量异步处理、结果拼接、边际场景
 */
import { describe, it, expect } from 'vitest'
import { BatchProcessor } from './batch-processor'

describe('BatchProcessor', () => {
  const bp = new BatchProcessor()

  describe('splitIntoBatches', () => {
    it('splits array into batches of specified size', () => {
      const items = [1, 2, 3, 4, 5, 6, 7]
      const batches = bp.splitIntoBatches(items, 3)
      expect(batches).toHaveLength(3)
      expect(batches[0]).toEqual([1, 2, 3])
      expect(batches[1]).toEqual([4, 5, 6])
      expect(batches[2]).toEqual([7])
    })

    it('handles empty array', () => {
      expect(bp.splitIntoBatches([], 10)).toEqual([])
    })

    it('handles batch size equal to array length', () => {
      expect(bp.splitIntoBatches([1, 2, 3], 3)).toEqual([[1, 2, 3]])
    })

    it('handles batch size larger than array', () => {
      expect(bp.splitIntoBatches([1, 2], 10)).toEqual([[1, 2]])
    })

    it('handles batch size of 1', () => {
      expect(bp.splitIntoBatches(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']])
    })

    it('throws on zero or negative batch size', () => {
      expect(() => bp.splitIntoBatches([1], 0)).toThrow('must be > 0')
      expect(() => bp.splitIntoBatches([1], -1)).toThrow('must be > 0')
    })
  })

  describe('processInBatches', () => {
    it('processes all items in correct order', async () => {
      const items = [1, 2, 3, 4, 5]
      const result = await bp.processInBatches(
        items,
        async (batch) => batch.map(x => x * 2),
        2,
      )
      expect(result).toEqual([2, 4, 6, 8, 10])
    })

    it('preserves batch ordering', async () => {
      const items = ['a', 'b', 'c', 'd']
      const result = await bp.processInBatches(
        items,
        async (batch) => batch.map(x => x.toUpperCase()),
        1,
      )
      expect(result).toEqual(['A', 'B', 'C', 'D'])
    })

    it('handles empty items', async () => {
      const result = await bp.processInBatches(
        [],
        async (batch) => batch,
        5,
      )
      expect(result).toEqual([])
    })

    it('handles single batch', async () => {
      const result = await bp.processInBatches(
        [10, 20, 30],
        async (batch) => [batch.reduce((a, b) => a + b, 0)],
        5,
      )
      expect(result).toEqual([60])
    })

    it('awaits async batchFn', async () => {
      const items = [1, 2, 3]
      const result = await bp.processInBatches(
        items,
        async (batch) => {
          // 模拟异步操作
          await new Promise(r => setTimeout(r, 1))
          return batch.map(x => x + 1)
        },
        2,
      )
      expect(result).toEqual([2, 3, 4])
    })

    it('batchFn called exactly for each batch', async () => {
      const items = [1, 2, 3, 4, 5, 6]
      let callCount = 0
      await bp.processInBatches(
        items,
        async (batch) => {
          callCount++
          return batch
        },
        2,
      )
      expect(callCount).toBe(3)
    })
  })
})
