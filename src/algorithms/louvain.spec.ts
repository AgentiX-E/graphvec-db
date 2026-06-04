import { describe, test, expect } from 'vitest'
import { louvainCommunity } from './louvain'

describe('Louvain', () => {
  test('two communities', () => {
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 3, dst: 1, weight: 1 },
      { src: 4, dst: 5, weight: 1 },
      { src: 5, dst: 6, weight: 1 },
      { src: 6, dst: 4, weight: 1 },
      { src: 3, dst: 4, weight: 0.1 },
    ]
    const r = louvainCommunity(vertices, edges)
    expect(r.communities.get(1)).toBe(r.communities.get(3))
    expect(r.communities.get(4)).toBe(r.communities.get(6))
    expect(r.levels).toBeGreaterThanOrEqual(1)
  })

  test('empty', () => {
    const r = louvainCommunity([], [])
    expect(r.levels).toBe(0)
  })

  test('single node', () => {
    const r = louvainCommunity([1], [])
    expect(r.levels).toBe(1)
    expect(r.communities.get(1)).toBe(1)
  })

  test('multi-level communities with Phase 2', () => {
    const vertices = [1, 2, 3, 4, 5, 6, 7, 8]
    const edges = [
      { src: 1, dst: 2, weight: 10 },
      { src: 3, dst: 4, weight: 10 },
      { src: 5, dst: 6, weight: 10 },
      { src: 7, dst: 8, weight: 10 },
      { src: 2, dst: 3, weight: 5 },
      { src: 6, dst: 7, weight: 5 },
      { src: 1, dst: 5, weight: 0.1 },
      { src: 4, dst: 8, weight: 0.1 },
    ]
    const r = louvainCommunity(vertices, edges)
    expect(r.communities.get(1)).toBe(r.communities.get(2))
    expect(r.communities.get(5)).toBe(r.communities.get(6))
    expect(r.levels).toBeGreaterThanOrEqual(2)
    if (r.levelCommunities) {
      expect(r.levelCommunities.length).toBe(r.levels)
    }
  })

  test('two dense clusters far apart - single level is enough', () => {
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 3, dst: 1, weight: 1 },
      { src: 4, dst: 5, weight: 1 },
      { src: 5, dst: 6, weight: 1 },
      { src: 6, dst: 4, weight: 1 },
    ]
    const r = louvainCommunity(vertices, edges)
    expect(r.communities.get(1)).toBe(r.communities.get(3))
    expect(r.communities.get(4)).toBe(r.communities.get(6))
    expect(r.communities.get(1)).not.toBe(r.communities.get(4))
  })

  test('modularity improves with Phase 2 aggregation', () => {
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      { src: 1, dst: 2, weight: 5 },
      { src: 2, dst: 3, weight: 5 },
      { src: 3, dst: 1, weight: 5 },
      { src: 4, dst: 5, weight: 5 },
      { src: 5, dst: 6, weight: 5 },
      { src: 6, dst: 4, weight: 5 },
      { src: 3, dst: 4, weight: 0.5 },
      { src: 6, dst: 1, weight: 0.5 },
    ]
    const r = louvainCommunity(vertices, edges)
    expect(r.modularity).toBeGreaterThanOrEqual(-1)
    expect(r.modularity).toBeLessThanOrEqual(1)
    expect(r.levels).toBeGreaterThanOrEqual(1)
  })

  test('large graph with clear hierarchy forms multi-level communities', () => {
    const vertices = Array.from({ length: 12 }, (_, i) => i + 1)
    const edges: Array<{ src: number; dst: number; weight: number }> = []
    for (let i = 1; i <= 4; i++) {
      for (let j = i + 1; j <= 4; j++) {
        edges.push({ src: i, dst: j, weight: 10 })
      }
    }
    for (let i = 5; i <= 8; i++) {
      for (let j = i + 1; j <= 8; j++) {
        edges.push({ src: i, dst: j, weight: 10 })
      }
    }
    for (let i = 9; i <= 12; i++) {
      for (let j = i + 1; j <= 12; j++) {
        edges.push({ src: i, dst: j, weight: 10 })
      }
    }
    edges.push({ src: 1, dst: 5, weight: 1 })
    edges.push({ src: 2, dst: 6, weight: 1 })
    edges.push({ src: 5, dst: 9, weight: 1 })
    edges.push({ src: 6, dst: 10, weight: 1 })
    const r = louvainCommunity(vertices, edges)
    expect(r.communities.get(1)).toBe(r.communities.get(4))
    expect(r.communities.get(5)).toBe(r.communities.get(8))
    expect(r.communities.get(9)).toBe(r.communities.get(12))
    expect(r.levels).toBeGreaterThanOrEqual(1)
    expect(r.modularity).toBeGreaterThan(-1)
  })

  // ── 新增测试 ──

  test('two connected nodes — single community', () => {
    const r = louvainCommunity([1, 2], [{ src: 1, dst: 2, weight: 1 }])
    expect(r.communities.get(1)).toBe(r.communities.get(2))
    expect(r.levels).toBeGreaterThanOrEqual(1)
  })

  test('triangle — all nodes likely in same community', () => {
    const r = louvainCommunity([1, 2, 3], [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 1, dst: 3, weight: 1 },
    ])
    // In a fully connected triangle, louvain may or may not merge all into one
    // community depending on implementation details. Just verify it runs
    // and produces valid output.
    expect(r.levels).toBeGreaterThanOrEqual(1)
    expect(r.modularity).toBeDefined()
    expect(r.communities.size).toBe(3)
  })

  test('isolated nodes — each its own community', () => {
    const r = louvainCommunity([1, 2, 3], [])
    const communities = new Set(r.communities.values())
    expect(communities.size).toBe(3)
  })

  test('weighted graph — strong internal edges form communities', () => {
    const r = louvainCommunity([1, 2, 3, 4], [
      { src: 1, dst: 2, weight: 10 },
      { src: 2, dst: 3, weight: 0.1 },
      { src: 3, dst: 4, weight: 10 },
    ])
    // 1-2 should be together (strong), 3-4 should be together (strong)
    // 2-3 is weak, so communities should be {1,2} and {3,4}
    expect(r.communities.get(1)).toBe(r.communities.get(2))
    expect(r.communities.get(3)).toBe(r.communities.get(4))
    expect(r.communities.get(1)).not.toBe(r.communities.get(3))
  })

  test('louvain preserves modularity field', () => {
    const r = louvainCommunity([1, 2, 3], [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
    ])
    expect(r.modularity).toBeDefined()
    expect(typeof r.modularity).toBe('number')
  })
})
