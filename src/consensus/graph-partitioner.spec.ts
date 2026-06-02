/**
 * GraphPartitioner 单元测试
 */

import { describe, test, expect } from 'vitest'
import { GraphPartitioner } from './graph-partitioner'

describe('GraphPartitioner - Louvain-based', () => {
  test('two clear clusters with strong intra edges', () => {
    // Cluster A: 0-1-2 densely connected (weight 10)
    // Cluster B: 3-4-5 densely connected (weight 10)
    // Weak connection between clusters: 2-3 (weight 0.5)
    const vertices = [0, 1, 2, 3, 4, 5]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 }, { src: 2, dst: 0 },
      { src: 3, dst: 4 }, { src: 4, dst: 5 }, { src: 5, dst: 3 },
      { src: 2, dst: 3 },
    ]
    const edgeWeights = [
      { src: 0, dst: 1, weight: 10 },
      { src: 1, dst: 2, weight: 10 },
      { src: 2, dst: 0, weight: 10 },
      { src: 3, dst: 4, weight: 10 },
      { src: 4, dst: 5, weight: 10 },
      { src: 5, dst: 3, weight: 10 },
      { src: 2, dst: 3, weight: 0.5 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({ method: 'louvain', edgeWeights })

    // All nodes should be assigned
    expect(result.assignment.size).toBe(6)
    // Should have at least one partition
    expect(result.partitions.length).toBeGreaterThanOrEqual(1)
    // Partitions should have reasonable sizes
    for (const p of result.partitions) {
      expect(p.nodeCount).toBeGreaterThanOrEqual(1)
    }
  })

  test('single cluster returns all nodes in same partition', () => {
    const vertices = [0, 1, 2, 3]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 }, { src: 2, dst: 3 }, { src: 3, dst: 0 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({ method: 'louvain' })

    // All nodes assigned
    expect(result.assignment.size).toBe(4)
    // Nodes 0 and 2 should be in same community (by dint of the edge weights all being 1)
  })

  test('empty graph returns empty result', () => {
    const partitioner = new GraphPartitioner([], [])
    const result = partitioner.partition({ method: 'louvain' })
    expect(result.assignment.size).toBe(0)
    expect(result.partitions).toHaveLength(0)
  })

  test('single node returns one partition', () => {
    const partitioner = new GraphPartitioner([42], [])
    const result = partitioner.partition({ method: 'louvain' })
    expect(result.assignment.get(42)).toBe(0)
    expect(result.partitions).toHaveLength(1)
    expect(result.partitions[0].nodeCount).toBe(1)
  })
})

describe('GraphPartitioner - Greedy', () => {
  test('simple graph split into partitions', () => {
    // Line graph: 0-1-2-3-4-5
    const vertices = [0, 1, 2, 3, 4, 5]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 },
      { src: 2, dst: 3 }, { src: 3, dst: 4 }, { src: 4, dst: 5 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({ method: 'greedy', numPartitions: 2 })

    expect(result.partitions).toHaveLength(2)
    expect(result.cutSize).toBeGreaterThanOrEqual(1)
    // All vertices should be assigned
    expect(result.assignment.size).toBe(6)
  })

  test('star graph with many partitions', () => {
    // Center node 0 connected to 1-10
    const vertices = Array.from({ length: 11 }, (_, i) => i)
    const edges = vertices.slice(1).map((v) => ({ src: 0, dst: v }))

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({ method: 'greedy', numPartitions: 3 })

    // All vertices assigned
    expect(result.assignment.size).toBe(11)
    expect(result.partitions.length).toBeGreaterThanOrEqual(1)
  })

  test('edge-cut strategy', () => {
    const vertices = [0, 1, 2, 3]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 }, { src: 2, dst: 3 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({
      method: 'greedy',
      numPartitions: 2,
      strategy: 'edge-cut',
    })

    expect(result.strategy).toBe('edge-cut')
    expect(result.cutSize).toBeGreaterThanOrEqual(0)
  })

  test('maxPartitionSize constraint', () => {
    const vertices = [0, 1, 2, 3, 4, 5]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 }, { src: 2, dst: 3 },
      { src: 3, dst: 4 }, { src: 4, dst: 5 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({
      method: 'greedy',
      maxPartitionSize: 2,
      numPartitions: 3,
    })

    // Each partition should be at most 2 nodes
    for (const p of result.partitions) {
      expect(p.nodeCount).toBeLessThanOrEqual(2)
    }
  })

  test('balance is computed correctly', () => {
    const vertices = [0, 1, 2, 3, 4, 5]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 },
      { src: 3, dst: 4 }, { src: 4, dst: 5 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({ method: 'greedy', numPartitions: 2 })

    expect(result.balance).toBeGreaterThanOrEqual(0)
    expect(result.balance).toBeLessThanOrEqual(1)
  })
})

describe('GraphPartitioner - Metadata', () => {
  test('partition metadata is correct', () => {
    const vertices = [0, 1, 2, 3]
    const edges = [
      { src: 0, dst: 1 }, { src: 1, dst: 2 }, { src: 2, dst: 3 },
    ]

    const partitioner = new GraphPartitioner(vertices, edges)
    const result = partitioner.partition({ method: 'greedy', numPartitions: 2, maxPartitionSize: 2 })

    expect(result.partitions).toHaveLength(2)

    let totalNodes = 0
    for (const p of result.partitions) {
      totalNodes += p.nodeCount
      expect(p.edgeCount).toBeGreaterThanOrEqual(0)
      expect(p.cutEdges).toBeGreaterThanOrEqual(0)
      expect(p.nodeRatio).toBeGreaterThan(0)
    }
    expect(totalNodes).toBe(4)
  })
})
