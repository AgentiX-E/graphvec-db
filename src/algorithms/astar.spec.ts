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
    const result = astar(
      () => [],
      0 as NodeId,
      1 as NodeId,
    )
    expect(result).toBeNull()
  })

  test('uses heuristic to find goal faster', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }],
      1: [{ nodeId: 0, weight: 1 }, { nodeId: 2, weight: 1 }],
      2: [{ nodeId: 1, weight: 1 }, { nodeId: 3, weight: 1 }],
      3: [{ nodeId: 2, weight: 1 }, { nodeId: 4, weight: 1 }],
      4: [{ nodeId: 3, weight: 1 }],
    }
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

  // ── 新增测试 ──

  test('graph with self-loop edge — should not cause infinite loop', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 0, weight: 0 }, { nodeId: 1, weight: 1 }],
      1: [{ nodeId: 0, weight: 1 }],
    }
    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      1 as NodeId,
    )
    expect(result).not.toBeNull()
    expect(result!.cost).toBe(1)
    expect(result!.path).toEqual([0, 1])
  })

  test('multiple parallel edges — picks lowest weight', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 100 }, { nodeId: 1, weight: 1 }],
      1: [],
    }
    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      1 as NodeId,
    )
    // Should pick cheapest weight 1
    expect(result).not.toBeNull()
    expect(result!.cost).toBe(1)
  })

  test('heuristic is admissible — finds optimal path when tie-breaking works', () => {
    // Graph where heuristic guides correctly
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 2 }, { nodeId: 2, weight: 1 }],
      1: [{ nodeId: 3, weight: 1 }],
      2: [{ nodeId: 3, weight: 5 }],
      3: [],
    }
    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      3 as NodeId,
      (n, _g) => Math.abs(n - 3),
    )
    // Optimal: 0→1→3 = 3   vs   0→2→3 = 6
    expect(result).not.toBeNull()
    expect(result!.cost).toBe(3)
    expect(result!.path).toEqual([0, 1, 3])
  })

  test('complex graph with no path — returns null', () => {
    const neighbors: Record<number, Array<{ nodeId: number; weight: number }>> = {
      0: [{ nodeId: 1, weight: 1 }, { nodeId: 2, weight: 1 }],
      1: [{ nodeId: 2, weight: 1 }],
      2: [{ nodeId: 0, weight: 1 }],
      3: [],
    }
    // Component {0,1,2} is cyclic, but 3 is disconnected from it
    const result = astar(
      (nid) => neighbors[nid] ?? [],
      0 as NodeId,
      3 as NodeId,
    )
    expect(result).toBeNull()
  })
})
