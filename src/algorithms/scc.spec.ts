/**
 * SCC algorithm unit tests
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
    // {0,1,2} is one SCC, {3} is another
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
    // In a DAG, each node is its own SCC
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
})
