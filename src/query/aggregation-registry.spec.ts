// ============================================================
// AggregationRegistry 测试
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { AggregationRegistry, Accumulator } from './aggregation-registry'

describe('AggregationRegistry', () => {
  let registry: AggregationRegistry

  beforeEach(() => {
    registry = new AggregationRegistry()
  })

  // ── 内置聚合 ──────────────────────────────

  describe('内置聚合', () => {
    it('count: 应返回元素个数', () => {
      const result = registry.aggregate('count', [1, 2, 3, 4, 5])
      expect(result).toBe(5)
    })

    it('count: 空数组返回 0', () => {
      const result = registry.aggregate('count', [])
      expect(result).toBe(0)
    })

    it('sum: 应返回数值之和', () => {
      const result = registry.aggregate('sum', [1, 2, 3, 4, 5])
      expect(result).toBe(15)
    })

    it('sum: 空数组返回 0', () => {
      const result = registry.aggregate('sum', [])
      expect(result).toBe(0)
    })

    it('sum: 非数值应跳过', () => {
      const result = registry.aggregate('sum', [1, 'hello', 3, null, 5])
      expect(result).toBe(9) // 1 + 3 + 5
    })

    it('avg: 应返回算术平均值', () => {
      const result = registry.aggregate('avg', [10, 20, 30, 40, 50])
      expect(result).toBe(30)
    })

    it('avg: 空数组返回 null', () => {
      const result = registry.aggregate('avg', [])
      expect(result).toBeNull()
    })

    it('min: 应返回最小值', () => {
      const result = registry.aggregate('min', [3, 1, 7, 2, 5])
      expect(result).toBe(1)
    })

    it('min: 空数组返回 null', () => {
      const result = registry.aggregate('min', [])
      expect(result).toBeNull()
    })

    it('max: 应返回最大值', () => {
      const result = registry.aggregate('max', [3, 1, 7, 2, 5])
      expect(result).toBe(7)
    })

    it('max: 空数组返回 null', () => {
      const result = registry.aggregate('max', [])
      expect(result).toBeNull()
    })

    it('count_distinct: 应返回去重后的元素个数', () => {
      const result = registry.aggregate('count_distinct', [1, 2, 2, 3, 3, 3, 4, 5, 5])
      expect(result).toBe(5)
    })

    it('count_distinct: 全相同元素应返回 1', () => {
      const result = registry.aggregate('count_distinct', [1, 1, 1, 1])
      expect(result).toBe(1)
    })
  })

  // ── 注册与自定义 UDA ──────────────────────

  describe('自定义 UDA', () => {
    it('应支持注册自定义聚合函数', () => {
      registry.register('collect', () => {
        const items: unknown[] = []
        return {
          state: items,
          accumulate(value: unknown) { items.push(value) },
          merge(other: Accumulator) { items.push(...(other as any).state) },
          finalize() { return [...items] },
          reset() { items.length = 0 },
        }
      }, 'Collect all values into array')

      expect(registry.has('collect')).toBe(true)

      const result = registry.aggregate('collect', [1, 2, 3])
      expect(Array.isArray(result)).toBe(true)
      expect(result).toEqual([1, 2, 3])
    })

    it('重复注册应抛出错误', () => {
      registry.register('my_uda', () => ({ state: 0 } as Accumulator))
      expect(() => registry.register('my_uda')).toThrow(/already registered/)
    })

    it('未注册的聚合函数应抛出错误', () => {
      expect(() => registry.aggregate('nonexistent', [1, 2, 3])).toThrow(/Unknown aggregation/)
    })

    it('自定义 UDA median（中位数）', () => {
      registry.register('median', () => {
        const nums: number[] = []
        return {
          state: nums as unknown,
          accumulate(value: unknown) {
            const n = typeof value === 'number' ? value : Number(value)
            if (!isNaN(n)) nums.push(n)
          },
          merge(other: Accumulator) {
            nums.push(...((other as any).state as number[]))
          },
          finalize() {
            if (nums.length === 0) return null
            const sorted = [...nums].sort((a, b) => a - b)
            const mid = Math.floor(sorted.length / 2)
            return sorted.length % 2 === 0
              ? (sorted[mid - 1] + sorted[mid]) / 2
              : sorted[mid]
          },
          reset() { nums.length = 0 },
        }
      }, 'Median of numeric values')

      const result = registry.aggregate('median', [1, 3, 5, 7, 9])
      expect(result).toBe(5) // 奇数个 → 中间值

      const resultEven = registry.aggregate('median', [1, 2, 3, 4])
      expect(resultEven).toBe(2.5) // 偶数个 → 中间两数平均

      const resultEmpty = registry.aggregate('median', [])
      expect(resultEmpty).toBeNull()
    })

    it('自定义 UDA stddev（标准差，使用 merge 模式）', () => {
      registry.register('stddev', () => {
        let sum = 0
        let sumSq = 0
        let count = 0
        return {
          state: { sum, sumSq, count } as unknown,
          accumulate(value: unknown) {
            const n = typeof value === 'number' ? value : Number(value)
            if (!isNaN(n)) { sum += n; sumSq += n * n; count++ }
          },
          merge(other: Accumulator) {
            const o = other as any
            sum += o.state.sum
            sumSq += o.state.sumSq
            count += o.state.count
          },
          finalize() {
            if (count === 0) return null
            const mean = sum / count
            return Math.sqrt(sumSq / count - mean * mean)
          },
          reset() { sum = 0; sumSq = 0; count = 0 },
        }
      }, 'Population standard deviation')

      const result = registry.aggregate('stddev', [2, 4, 4, 4, 5, 5, 7, 9])
      expect(result).toBeCloseTo(2.0, 1) // σ ≈ 2.0
    })
  })

  // ── 分组聚合 ──────────────────────────────

  describe('groupAggregate', () => {
    it('按 groupKey 分组聚合', () => {
      const result = registry.groupAggregate('count', [
        { groupKey: 'A', value: 1 },
        { groupKey: 'A', value: 2 },
        { groupKey: 'B', value: 3 },
        { groupKey: 'B', value: 4 },
        { groupKey: 'B', value: 5 },
      ])

      expect(result.get('A')).toBe(2)
      expect(result.get('B')).toBe(3)
      expect(result.size).toBe(2)
    })

    it('分组 sum', () => {
      const result = registry.groupAggregate('sum', [
        { groupKey: 'eng', value: 10 },
        { groupKey: 'eng', value: 20 },
        { groupKey: 'sales', value: 30 },
      ])

      expect(result.get('eng')).toBe(30)
      expect(result.get('sales')).toBe(30)
    })

    it('空数组应返回空 Map', () => {
      const result = registry.groupAggregate('count', [])
      expect(result.size).toBe(0)
    })
  })

  // ── list / unregister / clear ─────────────

  describe('list / unregister / clear', () => {
    it('list 应返回所有注册项', () => {
      const items = registry.list()
      expect(items.length).toBeGreaterThanOrEqual(6) // count, sum, avg, min, max, count_distinct
      expect(items.find(i => i.name === 'count')).toBeDefined()
      expect(items.find(i => i.name === 'sum')).toBeDefined()
      expect(items.find(i => i.name === 'avg')).toBeDefined()
    })

    it('unregister 应移除注册', () => {
      expect(registry.has('count')).toBe(true)
      registry.unregister('count')
      expect(registry.has('count')).toBe(false)
      expect(() => registry.aggregate('count', [1, 2, 3])).toThrow()
    })

    it('clear 应清除所有注册', () => {
      expect(registry.list().length).toBeGreaterThan(0)
      registry.clear()
      expect(registry.list().length).toBe(0)
    })
  })

  // ── Accumulator 生命周期 ───────────────────

  describe('Accumulator 生命周期', () => {
    it('createAccumulator 应返回新实例', () => {
      const acc1 = registry.createAccumulator('count')
      const acc2 = registry.createAccumulator('count')

      acc1.accumulate(1)
      acc1.accumulate(2)
      acc2.accumulate(3)

      expect(acc1.finalize()).toBe(2)
      expect(acc2.finalize()).toBe(1)
    })

    it('reset 应重置累加器', () => {
      const acc = registry.createAccumulator('sum')
      acc.accumulate(10)
      acc.accumulate(20)
      expect(acc.finalize()).toBe(30)

      acc.reset()
      expect(acc.finalize()).toBe(0) // 重置后 sum 为 0
    })

    it('merge 应合并两个累加器', () => {
      const acc1 = registry.createAccumulator('sum')
      acc1.accumulate(10)
      acc1.accumulate(20)

      const acc2 = registry.createAccumulator('sum')
      acc2.accumulate(30)
      acc2.accumulate(40)

      acc1.merge(acc2)
      expect(acc1.finalize()).toBe(100)
    })
  })
})
