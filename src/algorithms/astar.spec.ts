/**
 * A* algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { astar, HeuristicFn } from './astar'

describe('astar', () => {
  test('should find shortest path in weighted graph', () => {
    // 0 --1-- 1 --2-- 2
    //  \           /
    //   \---5----/
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }, { nodeId: 2, weight: 5 }],
      1: [{ nodeId: 2, weight: 2 }],
      2: [],
    }
    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      2 as NodeId,
    )
    expect(result).not.toBeNull()
    expect(result!.path).toEqual([0, 1, 2])
    expect(result!.cost).toBe(3)
  })

  test('start equals end returns zero-cost path', () => {
    const result = astar(
      () => [],
      42 as NodeId,
      42 as NodeId,
    )
    expect(result).not.toBeNull()
    expect(result!.path).toEqual([42])
    expect(result!.cost).toBe(0)
  })

  test('returns null when no path exists', () => {
    // Two disconnected nodes
    const result = astar(
      () => [],
      0 as NodeId,
      1 as NodeId,
    )
    expect(result).toBeNull()
  })

  test('uses heuristic to find goal faster', () => {
    // Grid-like: nodes arranged in 1D
    // 0 -- 1 -- 2 -- 3 -- 4
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }],
      1: [{ nodeId: 0, weight: 1 }, { nodeId: 2, weight: 1 }],
      2: [{ nodeId: 1, weight: 1 }, { nodeId: 3, weight: 1 }],
      3: [{ nodeId: 2, weight: 1 }, { nodeId: 4, weight: 1 }],
      4: [{ nodeId: 3, weight: 1 }],
    }
    // Manhattan-like heuristic: |goal - node|
    const heuristic: HeuristicFn = (node, goal) => Math.abs(node - goal)

    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      4 as NodeId,
      heuristic,
    )
    expect(result).not.toBeNull()
    expect(result!.path).toEqual([0, 1, 2, 3, 4])
    expect(result!.cost).toBe(4)
  })

  test('prefers cheaper path with heuristic', () => {
    // Two paths from 0 to 3: 0-1-2-3 (cost 3) or 0-3(direct, cost 10)
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }, { nodeId: 3, weight: 10 }],
      1: [{ nodeId: 2, weight: 1 }],
      2: [{ nodeId: 3, weight: 1 }],
      3: [],
    }
    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      3 as NodeId,
      (n, _g) => Math.abs(n - 3),
    )
    expect(result).not.toBeNull()
    expect(result!.cost).toBe(3)
    expect(result!.path).toEqual([0, 1, 2, 3])
  })

  test('single node graph', () => {
    const result = astar(
      () => [],
      42 as NodeId,
      42 as NodeId,
    )
    expect(result).not.toBeNull()
    expect(result!.path).toEqual([42])
    expect(result!.cost).toBe(0)
  })
})
