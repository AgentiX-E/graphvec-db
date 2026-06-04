/**
 * SCC algorithm unit tests — Tarjan's algorithm
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { scc } from './scc'

describe('scc', () => {
  test('should find SCCs in a directed graph with cycles', () => {
    // 0 -> 1 -> 2 -> 0 (cycle), 3 -> 3 (self-loop)
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [2],
      2: [0],
      3: [3],
    }
    const result = scc([0, 1, 2, 3] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
    const cycleComp = result.components.find(c => c.length === 3)!
    expect(cycleComp.sort()).toEqual([0, 1, 2])
    const singleComp = result.components.find(c => c.length === 1)!
    expect(singleComp[0]).toBe(3)
  })

  test('DAG has each node as its own SCC', () => {
    // 0 -> 1 -> 2 (no cycles)
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [2],
      2: [],
    }
    const result = scc([0, 1, 2] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(3)
    for (const comp of result.components) {
      expect(comp.length).toBe(1)
    }
  })

  test('empty graph returns no components', () => {
    const result = scc([], () => [])
    expect(result.count).toBe(0)
    expect(result.components).toEqual([])
  })

  test('single node returns one component', () => {
    const result = scc([42] as NodeId[], () => [])
    expect(result.count).toBe(1)
    expect(result.components[0]).toEqual([42])
  })

  test('bidirectional complete graph is one SCC', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
    }
    const result = scc([0, 1, 2] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].sort()).toEqual([0, 1, 2])
  })

  // ── 新增测试 ──

  test('simple two-node cycle is one SCC', () => {
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0],
    }
    const result = scc([0, 1] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].sort()).toEqual([0, 1])
  })

  test('complex graph with multiple SCCs', () => {
    // 0 -> 1 -> 2 -> 0 (SCC A: 0,1,2)
    // 0 -> 3 (SCC B: 3)
    // 3 -> 4 -> 5 -> 3 (SCC C: 3,4,5? Wait, 3->4,4->5,5->3 creates SCC)
    // Actually: 0->3, 3->4->5->3, so {3,4,5} is one SCC
    const neighbors: Record<number, number[]> = {
      0: [1, 3],
      1: [2],
      2: [0],
      3: [4],
      4: [5],
      5: [3],
    }
    const result = scc([0, 1, 2, 3, 4, 5] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
    const sizes = result.components.map(c => c.length).sort((a, b) => a - b)
    expect(sizes).toEqual([3, 3])
  })

  test('single directed cycle is one SCC', () => {
    // 0 -> 1 -> 2 -> 0
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [2],
      2: [0],
    }
    const result = scc([0, 1, 2] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(1)
    expect(result.components[0].sort()).toEqual([0, 1, 2])
  })

  test('isolated nodes each form their own SCC', () => {
    const result = scc([0, 1, 2] as NodeId[], () => [])
    expect(result.count).toBe(3)
    for (const comp of result.components) {
      expect(comp.length).toBe(1)
    }
  })

  test('complex graph with mixed SCC sizes', () => {
    // 0 -> 1, 1 -> 0 (SCC: {0,1})
    // 0 -> 2 (2 is sink, SCC: {2})
    // 2 -> 3, 3 -> 2 (SCC: {2,3}? No, 2->3 and 3->2, yes {2,3})
    // Actually simpler: 0<->1, 2 isolated, 3->4->5  (all separate)
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0],
      2: [],
      3: [4],
      4: [5],
      5: [],
    }
    const result = scc([0, 1, 2, 3, 4, 5] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(5) // {0,1}, {2}, {3}, {4}, {5}
  })

  test('non-consecutive node IDs', () => {
    const neighbors: Record<number, number[]> = {
      10: [20],
      20: [10],
      30: [],
    }
    const result = scc([10, 20, 30] as NodeId[], (nid) => neighbors[nid] ?? [])
    expect(result.count).toBe(2)
    const compA = result.components.find(c => c.includes(10 as NodeId))!
    expect(compA.sort()).toEqual([10, 20])
    const compB = result.components.find(c => c.includes(30 as NodeId))!
    expect(compB).toEqual([30])
  })

  test('all components cover all nodes', () => {
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [2],
      2: [0],
      3: [4],
      4: [3],
    }
    const result = scc([0, 1, 2, 3, 4] as NodeId[], (nid) => neighbors[nid] ?? [])
    const allNodes = new Set(result.components.flat())
    expect(allNodes.size).toBe(5)
  })
})
