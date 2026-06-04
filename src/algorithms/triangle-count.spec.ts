/**
 * Triangle Count algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { triangleCount } from './triangle-count'

describe('triangleCount', () => {
  test('should find all triangles in a simple graph', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3],
      1: [0, 2],
      2: [0, 1],
      3: [0],
    }
    const result = triangleCount([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.triangles).toHaveLength(1)
    const tri = result.triangles[0].sort()
    expect(tri).toEqual([0, 1, 2])
  })

  test('complete graph K4 has 4 triangles', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3],
      1: [0, 2, 3],
      2: [0, 1, 3],
      3: [0, 1, 2],
    }
    const result = triangleCount([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(4)
    expect(result.triangles).toHaveLength(4)
  })

  test('empty graph has no triangles', () => {
    const result = triangleCount([], () => [])
    expect(result.count).toBe(0)
    expect(result.triangles).toEqual([])
  })

  test('single node has no triangles', () => {
    const result = triangleCount([42] as NodeId[], () => [])
    expect(result.count).toBe(0)
  })

  test('path graph has no triangles', () => {
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2],
    }
    const result = triangleCount([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(0)
  })

  test('two disconnected triangles', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
      3: [4, 5],
      4: [3, 5],
      5: [3, 4],
    }
    const result = triangleCount([0, 1, 2, 3, 4, 5] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
    expect(result.triangles).toHaveLength(2)
  })

  // ── 新增测试 ──

  test('star graph has no triangles', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3, 4],
      1: [0],
      2: [0],
      3: [0],
      4: [0],
    }
    const result = triangleCount([0, 1, 2, 3, 4] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(0)
  })

  test('complete graph K5 has 10 triangles', () => {
    const nodes = [0, 1, 2, 3, 4] as NodeId[]
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3, 4],
      1: [0, 2, 3, 4],
      2: [0, 1, 3, 4],
      3: [0, 1, 2, 4],
      4: [0, 1, 2, 3],
    }
    const result = triangleCount(nodes, (nid) => neighbors[nid] ?? [])
    // K5 has C(5,3) = 10 triangles
    expect(result.count).toBe(10)
    expect(result.triangles).toHaveLength(10)
  })

  test('triangle sharing an edge — counts correctly', () => {
    //   2
    //  / \
    // 0---1
    //  \ /
    //   3
    // Two triangles: {0,1,2} and {0,1,3} sharing edge 0-1
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3],
      1: [0, 2, 3],
      2: [0, 1],
      3: [0, 1],
    }
    const result = triangleCount([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
  })

  test('self-loops do not create triangles', () => {
    // Nodes 0 and 1 have self-loops, edge 0-1 exists, but that's not a triangle
    const neighbors: Record<number, number[]> = {
      0: [1, 0],
      1: [0, 1],
    }
    const result = triangleCount([0, 1] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(0)
  })

  test('non-consecutive node IDs', () => {
    const neighbors: Record<number, number[]> = {
      10: [20, 30],
      20: [10, 30],
      30: [10, 20],
    }
    const result = triangleCount([10, 20, 30] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.triangles[0].sort()).toEqual([10, 20, 30])
  })
})
