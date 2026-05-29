/**
 * Label Propagation algorithm unit tests
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { labelPropagation } from './label-propagation'

describe('labelPropagation', () => {
  test('should find communities in disconnected graph clusters', () => {
    // Two completely disconnected cliques
    // Community A: {0,1,2}, Community B: {3,4,5} (no edges between them)
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
    // Nodes 0,1,2 should share one label; 3,4,5 share another
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
})
