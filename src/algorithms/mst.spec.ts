/**
 * 最小生成树 (MST) 算法单元测试 — Kruskal 算法
 *
 * 测试 minimumSpanningTree: 基本图、加权图、边界条件、错误路径
 */

import { describe, test, expect } from 'vitest'
import { minimumSpanningTree } from './mst'

describe('MST', () => {
  test('empty graph — returns empty result', () => {
    const r = minimumSpanningTree([], [])
    expect(r.edges).toEqual([])
    expect(r.totalWeight).toBe(0)
  })

  test('single node — no edges needed', () => {
    const r = minimumSpanningTree([1], [])
    expect(r.edges).toEqual([])
    expect(r.totalWeight).toBe(0)
  })

  test('simple triangle — finds MST with minimal weight', () => {
    // Triangle: 1-2(1), 2-3(2), 1-3(3)
    // MST should pick edges with weight 1 and 2, total = 3
    const r = minimumSpanningTree([1, 2, 3], [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 2 },
      { src: 1, dst: 3, weight: 3 },
    ])
    expect(r.edges.length).toBe(2)
    expect(r.totalWeight).toBe(3)
  })

  test('chain graph — MST is the chain itself', () => {
    const r = minimumSpanningTree([1, 2, 3, 4], [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 2 },
      { src: 3, dst: 4, weight: 3 },
      { src: 1, dst: 3, weight: 4 },
    ])
    // MST should be 1-2(1), 2-3(2), 3-4(3) = 6
    expect(r.edges.length).toBe(3)
    expect(r.totalWeight).toBe(6)
  })

  test('disconnected graph — returns component MSTs only', () => {
    const r = minimumSpanningTree([1, 2, 3, 4], [
      { src: 1, dst: 2, weight: 1 },
      { src: 3, dst: 4, weight: 2 },
    ])
    // Two disconnected components: {1,2} and {3,4}
    // MST of each component is the single edge
    expect(r.edges.length).toBe(2)
    expect(r.totalWeight).toBe(3)
  })

  test('complete graph — Kruskal picks lowest weight edges without cycles', () => {
    // K4 with distinct weights
    const es = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 2 },
      { src: 3, dst: 4, weight: 3 },
      { src: 1, dst: 4, weight: 4 },
      { src: 1, dst: 3, weight: 5 },
      { src: 2, dst: 4, weight: 6 },
    ]
    const r = minimumSpanningTree([1, 2, 3, 4], es)
    expect(r.edges.length).toBe(3)
    expect(r.totalWeight).toBe(1 + 2 + 3)
  })

  test('equal weight edges — any MST with sum N-1 edges', () => {
    const edges = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 1, dst: 3, weight: 1 },
    ]
    const r = minimumSpanningTree([1, 2, 3], edges)
    expect(r.edges.length).toBe(2)
    expect(r.totalWeight).toBe(2)
  })

  test('edges with vertices not in vertex list are ignored', () => {
    // Edge 1-5 is given but 5 is not in vertices list
    const r = minimumSpanningTree([1, 2], [
      { src: 1, dst: 2, weight: 5 },
      { src: 1, dst: 5, weight: 1 },
    ])
    expect(r.edges.length).toBe(1)
    expect(r.totalWeight).toBe(5)
  })

  test('single edge with two nodes', () => {
    const r = minimumSpanningTree([1, 2], [{ src: 1, dst: 2, weight: 10 }])
    expect(r.edges.length).toBe(1)
    expect(r.totalWeight).toBe(10)
    expect(r.edges[0]).toEqual({ src: 1, dst: 2, weight: 10 })
  })

  test('no edges but 2 nodes — no MST', () => {
    const r = minimumSpanningTree([1, 2], [])
    expect(r.edges.length).toBe(0)
    expect(r.totalWeight).toBe(0)
  })

  test('negative weights — minimal total includes negative edges', () => {
    const r = minimumSpanningTree([1, 2, 3], [
      { src: 1, dst: 2, weight: -5 },
      { src: 2, dst: 3, weight: 1 },
      { src: 1, dst: 3, weight: 2 },
    ])
    expect(r.edges.length).toBe(2)
    expect(r.totalWeight).toBe(-4) // -5 + 1
  })
})
