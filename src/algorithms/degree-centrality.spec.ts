/**
 * Degree Centrality algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { degreeCentrality } from './degree-centrality'

describe('degreeCentrality', () => {
  test('should compute normalized centrality', () => {
    // Star graph: node 0 connected to all others
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3, 4],
      1: [0],
      2: [0],
      3: [0],
      4: [0],
    }
    const result = degreeCentrality(
      [0, 1, 2, 3, 4] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    // N=5, divisor = 4
    // Node 0 degree=4, centrality = 4/4 = 1.0
    // Others degree=1, centrality = 1/4 = 0.25
    expect(result.scores.get(0 as NodeId)).toBeCloseTo(1.0, 5)
    expect(result.scores.get(1 as NodeId)).toBeCloseTo(0.25, 5)
    expect(result.scores.get(2 as NodeId)).toBeCloseTo(0.25, 5)
  })

  test('unnormalized centrality equals raw degree', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0],
      2: [0],
    }
    const result = degreeCentrality(
      [0, 1, 2] as NodeId[],
      (nid) => neighbors[nid] ?? [],
      undefined,
      { normalized: false },
    )
    expect(result.scores.get(0 as NodeId)).toBe(2)
    expect(result.scores.get(1 as NodeId)).toBe(1)
    expect(result.scores.get(2 as NodeId)).toBe(1)
  })

  test('single node has 0 centrality (normalized: 0/(1-1))', () => {
    const result = degreeCentrality([42] as NodeId[], () => [], undefined, { normalized: true })
    expect(result.scores.get(42 as NodeId)).toBe(0)
  })

  test('two connected nodes have equal centrality', () => {
    const neighbors: Record<number, number[]> = { 0: [1], 1: [0] }
    const result = degreeCentrality(
      [0, 1] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    // N=2, divisor=1, each has degree=1 => centrality=1
    expect(result.scores.get(0 as NodeId)).toBe(1)
    expect(result.scores.get(1 as NodeId)).toBe(1)
  })

  test('complete graph has all equal centrality', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
    }
    const result = degreeCentrality(
      [0, 1, 2] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    // N=3, divisor=2, each degree=2 => centrality=1
    expect(result.scores.get(0 as NodeId)).toBe(1)
    expect(result.scores.get(1 as NodeId)).toBe(1)
    expect(result.scores.get(2 as NodeId)).toBe(1)
  })

  // ── 新增测试 ──

  test('empty graph returns empty scores map', () => {
    const result = degreeCentrality([], () => [])
    expect(result.scores.size).toBe(0)
  })

  test('directed in-degree centrality', () => {
    // Directed graph: 0→1, 0→2, 1→2
    const outNeighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [2],
      2: [],
    }
    const inNeighbors: Record<number, number[]> = {
      0: [],
      1: [0],
      2: [0, 1],
    }
    const result = degreeCentrality(
      [0, 1, 2] as NodeId[],
      (nid) => outNeighbors[nid] ?? [],
      (nid) => inNeighbors[nid] ?? [],
      { direction: 'in' },
    )
    // Node 2 has in-degree 2, normalized: 2/2 = 1
    // Node 0 has in-degree 0, normalized: 0/2 = 0
    expect(result.scores.get(2 as NodeId)).toBe(1)
    expect(result.scores.get(0 as NodeId)).toBe(0)
    expect(result.scores.get(1 as NodeId)).toBeCloseTo(0.5, 5)
  })

  test('directed out-degree centrality', () => {
    const outNeighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [2],
      2: [],
    }
    const result = degreeCentrality(
      [0, 1, 2] as NodeId[],
      (nid) => outNeighbors[nid] ?? [],
      undefined,
      { direction: 'out', normalized: false },
    )
    expect(result.scores.get(0 as NodeId)).toBe(2)
    expect(result.scores.get(1 as NodeId)).toBe(1)
    expect(result.scores.get(2 as NodeId)).toBe(0)
  })

  test('isolated nodes have 0 centrality', () => {
    const result = degreeCentrality(
      [0, 1, 2] as NodeId[],
      () => [],
      undefined,
      { normalized: false },
    )
    expect(result.scores.get(0 as NodeId)).toBe(0)
    expect(result.scores.get(1 as NodeId)).toBe(0)
    expect(result.scores.get(2 as NodeId)).toBe(0)
  })

  test('non-consecutive node IDs', () => {
    const neighbors: Record<number, number[]> = {
      10: [20],
      20: [10, 30],
      30: [20],
    }
    const result = degreeCentrality(
      [10, 20, 30] as NodeId[],
      (nid) => neighbors[nid] ?? [],
      undefined,
      { normalized: false },
    )
    expect(result.scores.get(10 as NodeId)).toBe(1)
    expect(result.scores.get(20 as NodeId)).toBe(2)
    expect(result.scores.get(30 as NodeId)).toBe(1)
  })
})
