/**
 * 图算法 — 相似度 + 链路预测
 *
 * 测试 similarity.ts 模块的 5 个公开函数。
 */

import { describe, it, expect } from 'vitest'
import {
  jaccardSimilarity,
  cosineSimilarity,
  adamicAdar,
  preferentialAttachment,
  resourceAllocation,
} from './similarity'

describe('Jaccard 相似度', () => {
  it('相同集合返回 1', () => {
    const s = new Set([1, 2, 3])
    expect(jaccardSimilarity(s, s)).toBe(1)
  })

  it('无交集合返回 0', () => {
    expect(jaccardSimilarity(new Set([1]), new Set([2]))).toBe(0)
  })

  it('部分重叠返回正确值', () => {
    const a = new Set([1, 2, 3])
    const b = new Set([2, 3, 4])
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 5)
  })

  it('空集合返回 0', () => {
    expect(jaccardSimilarity(new Set(), new Set([1]))).toBe(0)
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0)
  })

  it('对称性: J(A,B) === J(B,A)', () => {
    const a = new Set([1, 2, 5, 8])
    const b = new Set([2, 3, 4, 5])
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a))
  })
})

describe('Cosine 相似度', () => {
  it('相同向量返回 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5)
  })

  it('正交向量返回 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('不同维度返回 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })

  it('零向量返回 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('45 度角返回 ~0.707', () => {
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(1 / Math.sqrt(2), 4)
  })
})

describe('Adamic-Adar 链路预测', () => {
  it('无公共邻居返回 0', () => {
    expect(adamicAdar(new Set([1, 2]), new Set([3, 4]), (id) => id)).toBe(0)
  })

  it('有公共邻居返回正分', () => {
    const score = adamicAdar(new Set([1, 2]), new Set([2, 3]), (id) => id)
    expect(score).toBeGreaterThan(0)
  })

  it('高 degree 公共邻居贡献更低', () => {
    const high = adamicAdar(new Set([100]), new Set([100]), () => 100)
    const low = adamicAdar(new Set([100]), new Set([100]), () => 2)
    expect(high).toBeLessThan(low)
  })
})

describe('Preferential Attachment', () => {
  it('度乘积算法', () => {
    expect(preferentialAttachment(3, 4)).toBe(12)
    expect(preferentialAttachment(0, 5)).toBe(0)
    expect(preferentialAttachment(1, 1)).toBe(1)
  })
})

describe('Resource Allocation', () => {
  it('无公共邻居返回 0', () => {
    expect(resourceAllocation(new Set([1]), new Set([2]), () => 1)).toBe(0)
  })

  it('有公共邻居返回正分', () => {
    expect(resourceAllocation(new Set([1, 2]), new Set([2, 3]), () => 2))
      .toBeCloseTo(0.5, 5)
  })
})
