import { describe, test, expect } from 'vitest'
import { yenKSP, YenPath } from './yenksp'
import { NodeId } from '../types'

describe('yenKSP - Yen\'s K-Shortest Paths', () => {
  // ── Simple weighted DAG ──
  //   0 ──1──→ 1 ──2──→ 2 ──3──→ 3
  //   │                ↑
  //   └──────5─────────┘
  function simpleWeighted() {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }, { nodeId: 2, weight: 5 }],
      1: [{ nodeId: 2, weight: 2 }],
      2: [{ nodeId: 3, weight: 3 }],
      3: [],
    }
    return (nid: NodeId) => neighbors[nid] ?? []
  }

  test('finds the single shortest path (K=1)', () => {
    const result = yenKSP(simpleWeighted(), 0, 3, { K: 1 })
    expect(result).toHaveLength(1)
    expect(result[0].nodes).toEqual([0, 1, 2, 3])
    expect(result[0].totalWeight).toBe(6)
  })

  test('finds top 2 shortest paths', () => {
    const result = yenKSP(simpleWeighted(), 0, 3, { K: 2 })
    expect(result).toHaveLength(2)
    // Path 1: 0→1→2→3 (weight 6)
    expect(result[0].nodes).toEqual([0, 1, 2, 3])
    expect(result[0].totalWeight).toBe(6)
    // Path 2: 0→2→3 (weight 8)
    expect(result[1].nodes).toEqual([0, 2, 3])
    expect(result[1].totalWeight).toBe(8)
  })

  test('finds top 3 paths in a graph with multiple routes', () => {
    // 0 ──1──→ 1 ──1──→ 3
    // │        ↑
    // 2───2────┘
    // │
    // └───4──→ 2  (backtrack, but fine for Yen since no cycles)
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }, { nodeId: 2, weight: 2 }],
      1: [{ nodeId: 3, weight: 1 }],
      2: [{ nodeId: 1, weight: 2 }, { nodeId: 3, weight: 4 }],
      3: [],
    }
    const get = (nid: NodeId) => neighbors[nid] ?? []

    const result = yenKSP(get, 0, 3, { K: 3 })
    expect(result[0].nodes).toEqual([0, 1, 3])
    expect(result[0].totalWeight).toBe(2)

    // All results should be valid paths
    for (const r of result) {
      expect(r.nodes[0]).toBe(0)
      expect(r.nodes[r.nodes.length - 1]).toBe(3)
      let sum = 0
      for (let i = 0; i < r.nodes.length - 1; i++) {
        const edge = get(r.nodes[i]).find((n) => n.nodeId === r.nodes[i + 1])
        if (edge) sum += edge.weight
      }
      expect(sum).toBe(r.totalWeight)
    }
  })

  test('returns empty when no path exists', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [],
      1: [],
    }
    const result = yenKSP((nid: NodeId) => neighbors[nid] ?? [], 0, 1, { K: 3 })
    expect(result).toHaveLength(0)
  })

  test('source equals target returns single path', () => {
    const result = yenKSP(simpleWeighted(), 2, 2, { K: 3 })
    expect(result).toHaveLength(1)
    expect(result[0].nodes).toEqual([2])
    expect(result[0].totalWeight).toBe(0)
  })

  test('K=0 returns empty', () => {
    const result = yenKSP(simpleWeighted(), 0, 3, { K: 0 })
    expect(result).toHaveLength(0)
  })

  test('disconnected graph returns safe empty', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [],
      1: [],
      2: [],
    }
    const result = yenKSP((nid: NodeId) => neighbors[nid] ?? [], 0, 2, { K: 2 })
    expect(result).toHaveLength(0)
  })

  test('paths are in ascending weight order', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 10 }, { nodeId: 2, weight: 5 }],
      1: [{ nodeId: 3, weight: 1 }],
      2: [{ nodeId: 3, weight: 1 }],
      3: [],
    }
    const result = yenKSP((nid: NodeId) => neighbors[nid] ?? [], 0, 3, { K: 3 })
    for (let i = 1; i < result.length; i++) {
      expect(result[i].totalWeight).toBeGreaterThanOrEqual(result[i - 1].totalWeight)
    }
  })
})
