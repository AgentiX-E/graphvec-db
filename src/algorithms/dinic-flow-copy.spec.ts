/**
 * Dinic 最大流算法单元测试（副本）
 *
 * 测试与 dinic-flow 相同导出函数 maxFlow 的不同场景
 */

import { describe, test, expect } from 'vitest'
import { maxFlow } from './dinic-flow'

describe('maxFlow (copy)', () => {
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

  // ── 链式图瓶颈测试 ──
  test('chain — bottleneck capacity limits flow', () => {
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 100 },
        { src: 2, dst: 3, capacity: 1 },
        { src: 3, dst: 4, capacity: 100 },
      ],
      1, 4,
    )
    expect(r.maxFlow).toBe(1)
  })

  // ── 单边直连 ──
  test('single edge — flow equals edge capacity', () => {
    const r = maxFlow(
      [1, 2],
      [{ src: 1, dst: 2, capacity: 7 }],
      1, 2,
    )
    expect(r.maxFlow).toBe(7)
  })

  // ── 反向边重路由 ──
  test('graph with competing flows — reverse edges required', () => {
    // Classic example where reverse edges are needed for max flow
    // Source 1 -> 2 (cap 10), 1 -> 3 (cap 10)
    // 2 -> 3 (cap 1), 2 -> 4 (cap 10), 3 -> 4 (cap 10)
    // Without reverse edges, greedy would send 10 via 1->2->4 and 0 via 1->3
    // With reverse: 1->2->4 (10) + 1->3->4 (10) - but 2->3 is needed to rearrange: send 1->2->3->4
    // Actually: 1->2->4=10, 1->3->4=10, total=20 (2->3=1 is irrelevant for max)
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 10 },
        { src: 1, dst: 3, capacity: 10 },
        { src: 2, dst: 3, capacity: 1 },
        { src: 2, dst: 4, capacity: 10 },
        { src: 3, dst: 4, capacity: 10 },
      ],
      1, 4,
    )
    expect(r.maxFlow).toBe(20)
  })

  // ── 多层级图 ──
  test('three-layer graph — flow distributes through middle layer', () => {
    // Src 1, mid 2,3, sink 4
    // 1→2 (10), 1→3 (10)
    // 2→4 (8), 3→4 (12)
    const r = maxFlow(
      [1, 2, 3, 4],
      [
        { src: 1, dst: 2, capacity: 10 },
        { src: 1, dst: 3, capacity: 10 },
        { src: 2, dst: 4, capacity: 8 },
        { src: 3, dst: 4, capacity: 12 },
      ],
      1, 4,
    )
    // 1→2→4: 8 (bottleneck 8), 1→3→4: 10 (bottleneck 10)
    // Total = 18
    expect(r.maxFlow).toBe(18)
  })

  // ── 结果验证 ──
  test('result includes flow on each edge', () => {
    const r = maxFlow(
      [1, 2, 3],
      [{ src: 1, dst: 2, capacity: 5 }, { src: 2, dst: 3, capacity: 3 }],
      1, 3,
    )
    expect(r.edges.length).toBe(2)
    const e1 = r.edges.find(e => e.src === 1 && e.dst === 2)!
    const e2 = r.edges.find(e => e.src === 2 && e.dst === 3)!
    expect(e1.flow).toBe(3)
    expect(e2.flow).toBe(3)
  })

  // ── 空图 ──
  test('empty graph — no flow', () => {
    const r = maxFlow([1], [], 1, 1)
    expect(r.maxFlow).toBe(0)
  })
})
