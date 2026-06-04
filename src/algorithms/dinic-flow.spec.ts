/**
 * Dinic 最大流算法单元测试
 *
 * 测试 maxFlow 函数：基础图、复杂拓扑、边界条件、错误路径
 */

import { describe, test, expect } from 'vitest'
import { maxFlow, FlowEdge } from './dinic-flow'

describe('maxFlow', () => {
  // ── 基础图 ──
  test('diamond graph — max flow is sum of two paths', () => {
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 10 },
        { src: 1, dst: 3, capacity: 10 },
        { src: 2, dst: 4, capacity: 10 },
        { src: 3, dst: 4, capacity: 10 },
      ],
      1, 4,
    )
    expect(r.maxFlow).toBe(20)
  })

  test('no path from source to sink — flow is 0', () => {
    const r = maxFlow(
      [1, 2, 3],
      [{ src: 1, dst: 2, capacity: 5 }],
      1, 3,
    )
    expect(r.maxFlow).toBe(0)
  })

  test('source equals sink — flow is 0', () => {
    const r = maxFlow([1], [], 1, 1)
    expect(r.maxFlow).toBe(0)
  })

  // ── 链式图 ──
  test('chain graph — flow equals bottleneck edge', () => {
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 10 },
        { src: 2, dst: 3, capacity: 5 },
        { src: 3, dst: 4, capacity: 8 },
      ],
      1, 4,
    )
    // Bottleneck = 5 (edge 2→3)
    expect(r.maxFlow).toBe(5)
  })

  // ── 倒流图（需要反向边处理） ──
  test('graph requiring reverse edges — back-and-forth routing', () => {
    //    5
    //  /   \
    // 1     3
    //  \   / ^
    //   2 -  4
    // 1→2 (cap 3), 1→3 (cap 2), 2→3 (cap 1), 2→4 (cap 3), 3→4 (cap 2)
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 3 },
        { src: 1, dst: 3, capacity: 2 },
        { src: 2, dst: 3, capacity: 1 },
        { src: 2, dst: 4, capacity: 3 },
        { src: 3, dst: 4, capacity: 2 },
      ],
      1, 4,
    )
    // Can send: 1→2→4 (3) + 1→3→4 (2) + 1→2→3→4 (1) = but max is 5
    // After 1→3→4 (2) and 1→2→4 (3), total = 5
    expect(r.maxFlow).toBe(5)
  })

  // ── 完全二分图 ──
  test('complete bipartite — max flow equals sum of source edges', () => {
    // S → A,B → C → T
    // But simpler: S→X, S→Y, X→T, Y→T
    const r = maxFlow(
      ['S', 'X', 'Y', 'T'],
      [
        { src: 'S', dst: 'X', capacity: 7 },
        { src: 'S', dst: 'Y', capacity: 5 },
        { src: 'X', dst: 'T', capacity: 6 },
        { src: 'Y', dst: 'T', capacity: 5 },
      ] as any,
      'S', 'T',
    )
    // S→X→T: min(7,6)=6, S→Y→T: min(5,5)=5. Total=11
    expect(r.maxFlow).toBe(11)
  })

  // ── 所有容量都很大 ──
  test('all edges have large capacity — flow equals sum of source edges', () => {
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 1000 },
        { src: 1, dst: 3, capacity: 1000 },
        { src: 2, dst: 4, capacity: 1000 },
        { src: 3, dst: 4, capacity: 1000 },
      ],
      1, 4,
    )
    expect(r.maxFlow).toBe(2000)
  })

  // ── 零容量边 ──
  test('zero-capacity edges — no flow passes through', () => {
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 0 },
        { src: 2, dst: 4, capacity: 10 },
        { src: 1, dst: 3, capacity: 10 },
        { src: 3, dst: 4, capacity: 0 },
      ],
      1, 4,
    )
    expect(r.maxFlow).toBe(0)
  })

  // ── 结果包含 edges 数组 ──
  test('result contains edges property', () => {
    const r = maxFlow(
      [1, 2],
      [{ src: 1, dst: 2, capacity: 5 }],
      1, 2,
    )
    expect(r.edges).toBeDefined()
    expect(Array.isArray(r.edges)).toBe(true)
    expect(r.edges.length).toBe(1)
    expect(r.edges[0].flow).toBe(5)
  })

  // ── 大容量边（接近 Number.MAX_SAFE_INTEGER 的边被截断但不要溢出） ──
  test('edge capacities near Number.MAX_SAFE_INTEGER — no overflow', () => {
    const r = maxFlow(
      [1, 2],
      [{ src: 1, dst: 2, capacity: Number.MAX_SAFE_INTEGER }],
      1, 2,
    )
    expect(r.maxFlow).toBe(Number.MAX_SAFE_INTEGER)
    expect(r.edges[0].flow).toBe(Number.MAX_SAFE_INTEGER)
  })

  // ── 多入口多出口 ──
  test('multiple intermediate nodes — complex flow', () => {
    const r = maxFlow(
      [1, 2, 3, 4, 5, 6],
      [
        { src: 1, dst: 2, capacity: 10 },
        { src: 1, dst: 3, capacity: 10 },
        { src: 2, dst: 4, capacity: 5 },
        { src: 2, dst: 5, capacity: 5 },
        { src: 3, dst: 5, capacity: 5 },
        { src: 3, dst: 6, capacity: 5 },
        { src: 4, dst: 6, capacity: 5 },
        { src: 5, dst: 6, capacity: 10 },
      ],
      1, 6,
    )
    // Source 1 can push 20 total
    // 1→2→4→6: min(10,5,5)=5
    // 1→2→5→6: min(10,5,10)=5
    // 1→3→5→6: min(10,5,10)=5
    // 1→3→6: min(10,5)=5
    // Total = 20
    expect(r.maxFlow).toBe(20)
  })

  // ── 空顶点集 ──
  test('empty vertex list — returns 0 flow with empty edges', () => {
    const r = maxFlow([], [], 1, 2)
    expect(r.maxFlow).toBe(0)
    expect(r.edges).toEqual([])
  })
})
