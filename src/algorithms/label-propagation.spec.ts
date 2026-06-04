/**
 * Label Propagation algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { labelPropagation } from './label-propagation'

describe('labelPropagation', () => {
  test('should find communities in disconnected graph clusters', () => {
    // Two completely disconnected cliques
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
      3: [4, 5],
      4: [3, 5],
      5: [3, 4],
    }
    const result = labelPropagation(
      [0, 1, 2, 3, 4, 5] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    expect(result.converged).toBe(true)
    expect(result.communityCount).toBe(2)
    const labelA = result.labels.get(0 as NodeId)
    const labelB = result.labels.get(3 as NodeId)
    expect(labelA).not.toBe(labelB)
    expect(result.labels.get(1 as NodeId)).toBe(labelA)
    expect(result.labels.get(2 as NodeId)).toBe(labelA)
    expect(result.labels.get(4 as NodeId)).toBe(labelB)
    expect(result.labels.get(5 as NodeId)).toBe(labelB)
  })

  test('disconnected nodes each form their own community', () => {
    const result = labelPropagation(
      [0, 1, 2] as NodeId[],
      () => [],
    )
    expect(result.communityCount).toBe(3)
  })

  test('all nodes connected is one community', () => {
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
    }
    const result = labelPropagation(
      [0, 1, 2] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    expect(result.converged).toBe(true)
    expect(result.communityCount).toBe(1)
  })

  test('empty graph', () => {
    const result = labelPropagation([], () => [])
    expect(result.communityCount).toBe(0)
    expect(result.converged).toBe(true)
  })

  test('single node', () => {
    const result = labelPropagation([42] as NodeId[], () => [])
    expect(result.communityCount).toBe(1)
    expect(result.converged).toBe(true)
  })

  // ── 新增测试 ──

  test('line graph — propagates labels through chain', () => {
    // 0-1-2-3-4
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3],
    }
    const result = labelPropagation(
      [0, 1, 2, 3, 4] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    expect(result.converged).toBe(true)
    expect(result.communityCount).toBe(1)
  })

  test('star graph — all nodes in one community', () => {
    // Center 0 connected to 1,2,3,4
    const neighbors: Record<number, number[]> = {
      0: [1, 2, 3, 4],
      1: [0],
      2: [0],
      3: [0],
      4: [0],
    }
    const result = labelPropagation(
      [0, 1, 2, 3, 4] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    expect(result.converged).toBe(true)
    expect(result.communityCount).toBe(1)
  })

  test('two separate line graphs — forms 2 communities', () => {
    // Line 0-1-2, disconnected from line 3-4-5
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3, 5],
      5: [4],
    }
    const result = labelPropagation(
      [0, 1, 2, 3, 4, 5] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    expect(result.communityCount).toBe(2)
    expect(result.labels.get(0 as NodeId)).toBe(result.labels.get(2 as NodeId))
    expect(result.labels.get(3 as NodeId)).toBe(result.labels.get(5 as NodeId))
    expect(result.labels.get(0 as NodeId)).not.toBe(result.labels.get(3 as NodeId))
  })

  test('returns iteration count', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0],
      2: [0],
    }
    const result = labelPropagation(
      [0, 1, 2] as NodeId[],
      (nid) => neighbors[nid] ?? [],
    )
    expect(result.iterations).toBeGreaterThanOrEqual(1)
    expect(result.iterations).toBeLessThanOrEqual(100)
  })

  test('maxIterations option limits iterations', () => {
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [0],
    }
    const result = labelPropagation(
      [0, 1] as NodeId[],
      (nid) => neighbors[nid] ?? [],
      { maxIterations: 1 },
    )
    // With 2 nodes connected, should converge in 1 iterations
    expect(result.iterations).toBeLessThanOrEqual(2)
  })
})
