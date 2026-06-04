/**
 * WCC algorithm unit tests — Weakly Connected Components
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { wcc } from './wcc'

describe('wcc', () => {
  test('should find connected components in disconnected graph', () => {
    // 0 - 1 - 2, 3 - 4 (disconnected)
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3],
    }
    const result = wcc([0, 1, 2, 3, 4] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
    expect(result.components.length).toBe(2)
    const comp0 = result.components.find(c => c.includes(0 as NodeId))!
    expect(comp0).toContain(0)
    expect(comp0).toContain(1)
    expect(comp0).toContain(2)
    const comp3 = result.components.find(c => c.includes(3 as NodeId))!
    expect(comp3).toContain(3)
    expect(comp3).toContain(4)
  })

  test('single component for connected graph', () => {
    const neighbors: Record<number, number[]> = { 0: [1], 1: [0, 2], 2: [1] }
    const result = wcc([0, 1, 2] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].sort()).toEqual([0, 1, 2])
  })

  test('empty graph returns no components', () => {
    const result = wcc([], () => [])
    expect(result.count).toBe(0)
    expect(result.components).toEqual([])
  })

  test('single node graph returns one component', () => {
    const result = wcc([42] as NodeId[], () => [])
    expect(result.count).toBe(1)
    expect(result.components[0]).toEqual([42])
  })

  test('complete graph is one component', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
    }
    const result = wcc([0, 1, 2] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].sort()).toEqual([0, 1, 2])
  })

  test('all isolated nodes', () => {
    const result = wcc([0, 1, 2] as NodeId[], () => [])
    expect(result.count).toBe(3)
    expect(result.components.length).toBe(3)
  })

  // ── 新增测试 ──

  test('star graph is one component', () => {
    // Center 0 connected to 1,2,3
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3],
      1: [0],
      2: [0],
      3: [0],
    }
    const result = wcc([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].length).toBe(4)
  })

  test('two separate stars', () => {
    // Star A: center 0 with leaves 1,2
    // Star B: center 3 with leaves 4,5
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0],
      2: [0],
      3: [4, 5],
      4: [3],
      5: [3],
    }
    const result = wcc([0, 1, 2, 3, 4, 5] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
    const compA = result.components.find(c => c.includes(0 as NodeId))!
    const compB = result.components.find(c => c.includes(3 as NodeId))!
    expect(compA.length).toBe(3)
    expect(compB.length).toBe(3)
  })

  test('cycle graph is one component', () => {
    // 0-1-2-3-0
    const neighbors: Record<number, number[]> = {
      0: [1, 3],
      1: [0, 2],
      2: [1, 3],
      3: [0, 2],
    }
    const result = wcc([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
  })

  test('chain graph is one component', () => {
    // 0-1-2-3-4
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3],
    }
    const result = wcc([0, 1, 2, 3, 4] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].length).toBe(5)
  })

  test('non-consecutive node IDs', () => {
    const neighbors: Record<number, number[]> = {
      10: [20],
      20: [10],
      30: [],
    }
    const result = wcc([10, 20, 30] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
  })

  test('directed edges treated as undirected for WCC', () => {
    // Directed edges: 0->1->2 (should be one component in undirected sense)
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [2],
      2: [],
    }
    const result = wcc([0, 1, 2] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].length).toBe(3)
  })
})
