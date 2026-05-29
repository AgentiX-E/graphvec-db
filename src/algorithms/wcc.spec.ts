/**
 * WCC algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { wcc } from './wcc'

describe('wcc', () => {
  function createLinearGraph() {
    // 0 - 1 - 2, 3 - 4 (disconnected)
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3],
    }
    return {
      nodeIds: [0, 1, 2, 3, 4] as NodeId[],
      getNeighbors: (nid: NodeId) => neighbors[nid] ?? [],
    }
  }

  test('should find connected components in disconnected graph', () => {
    const { nodeIds, getNeighbors } = createLinearGraph()
    const result = wcc(nodeIds, getNeighbors)
    expect(result.count).toBe(2)
    expect(result.components.length).toBe(2)
    // Find component with 0
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
})
