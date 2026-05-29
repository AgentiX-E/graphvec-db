/**
 * Triangle Count algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { triangleCount } from './triangle-count'

describe('triangleCount', () => {
  test('should find all triangles in a simple graph', () => {
    // Triangle: 0-1-2, plus extra node 3 connected to 0
    // 0 - 1, 0 - 2, 1 - 2, 0 - 3
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3],
      1: [0, 2],
      2: [0, 1],
      3: [0],
    }
    const result = triangleCount([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1) // Only (0,1,2) forms a triangle
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
    // K4 has C(4,3) = 4 triangles
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
    // 0 - 1 - 2 - 3
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
})
