// ============================================================
// node2vec.spec.ts — Node2Vec 图嵌入 + Jaccard 相似度测试
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  node2vec,
  cosineSimilarity,
  jaccardSimilarity,
  allPairsJaccard,
} from './node2vec'
import { NodeId } from '../types'

/**
 * 构建一个简单的测试图：
 *   0 ─ 1 ─ 2 ─ 3
 *   │         │
 *   4 ─────── 5
 *
 * 共 6 个节点，7 条边。
 */
function buildTestGraph(): {
  nodeIds: NodeId[]
  getNeighbors: (nodeId: NodeId) => NodeId[]
} {
  const adj: Record<NodeId, NodeId[]> = {
    0: [1, 4],
    1: [0, 2],
    2: [1, 3, 5],
    3: [2],
    4: [0, 5],
    5: [2, 4],
  }

  const nodeIds: NodeId[] = [0, 1, 2, 3, 4, 5]

  return {
    nodeIds,
    getNeighbors: (id: NodeId): NodeId[] => adj[id] ?? [],
  }
}

describe('node2vec', () => {
  it('should produce embeddings for each node', () => {
    const { nodeIds, getNeighbors } = buildTestGraph()
    const result = node2vec(nodeIds, getNeighbors, {
      dimensions: 16,
      walksPerNode: 5,
      walkLength: 20,
      epochs: 2,
      negativeSamples: 3,
      seed: 42,
    })

    expect(result.embeddings.size).toBe(6)
    for (const id of nodeIds) {
      const emb = result.embeddings.get(id)
      expect(emb).toBeDefined()
      expect(emb!.length).toBe(16)
      // Check finite values
      for (const v of emb!) {
        expect(isFinite(v)).toBe(true)
      }
    }
  })

  it('should return zero steps for empty node list', () => {
    const result = node2vec([], () => [])
    expect(result.embeddings.size).toBe(0)
    expect(result.steps).toBe(0)
  })

  it('should handle isolated nodes (no neighbors)', () => {
    const nodeIds: NodeId[] = [0, 1]
    const result = node2vec(nodeIds, () => [], {
      dimensions: 8,
      walksPerNode: 2,
      walkLength: 5,
      epochs: 1,
    })

    expect(result.embeddings.size).toBe(2)
  })

  it('should produce different embeddings for different seeds', () => {
    const { nodeIds, getNeighbors } = buildTestGraph()
    const result1 = node2vec(nodeIds, getNeighbors, {
      dimensions: 8,
      walksPerNode: 3,
      walkLength: 10,
      epochs: 1,
      seed: 42,
    })
    const result2 = node2vec(nodeIds, getNeighbors, {
      dimensions: 8,
      walksPerNode: 3,
      walkLength: 10,
      epochs: 1,
      seed: 99,
    })

    const emb1 = result1.embeddings.get(0)!
    const emb2 = result2.embeddings.get(0)!
    let diff = false
    for (let i = 0; i < emb1.length; i++) {
      if (Math.abs(emb1[i] - emb2[i]) > 0.01) {
        diff = true
        break
      }
    }
    expect(diff).toBe(true)
  })

  it('should produce same embeddings with same seed', () => {
    const { nodeIds, getNeighbors } = buildTestGraph()

    const run = (seed: number) => node2vec(nodeIds, getNeighbors, {
      dimensions: 8,
      walksPerNode: 3,
      walkLength: 10,
      epochs: 1,
      seed,
    })

    const r1 = run(42)
    const r2 = run(42)

    const e1 = r1.embeddings.get(0)!
    const e2 = r2.embeddings.get(0)!
    for (let i = 0; i < e1.length; i++) {
      expect(Math.abs(e1[i] - e2[i])).toBeLessThan(0.001)
    }
  })

  it('should produce reasonable embedding dimensions', () => {
    const { nodeIds, getNeighbors } = buildTestGraph()
    const result = node2vec(nodeIds, getNeighbors, { dimensions: 64 })
    expect(result.embeddings.get(0)!.length).toBe(64)
  })
})

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const a = [1, 2, 3]
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5)
  })

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })

  it('should return -1 for opposite vectors', () => {
    const a = [1, 2, 3]
    const b = [-1, -2, -3]
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5)
  })

  it('should handle zero vectors', () => {
    const a = [0, 0, 0]
    const b = [1, 0, 0]
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('should handle vectors of different lengths', () => {
    const a = [1, 2, 3]
    const b = [1, 2]
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('should compute correct cosine similarity', () => {
    // a · b = 1*2 + 2*3 + 3*4 = 20
    // |a| = sqrt(14), |b| = sqrt(29)
    // cos = 20 / (sqrt(14) * sqrt(29)) ≈ 0.9922
    const a = [1, 2, 3]
    const b = [2, 3, 4]
    const sim = cosineSimilarity(a, b)
    expect(sim).toBeGreaterThan(0.9)
    expect(sim).toBeLessThan(1.0)
  })
})

describe('jaccardSimilarity', () => {
  it('should return 0 for nodes with no neighbor overlap', () => {
    const adj: Record<NodeId, NodeId[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3],
    }

    const sim = jaccardSimilarity(0, 3, (id) => adj[id] ?? [])
    expect(sim).toBe(0)
  })

  it('should return 1 for same node (identical neighbors)', () => {
    const adj: Record<NodeId, NodeId[]> = {
      0: [1, 2],
    }

    // J(A,A) = |N(A) ∩ N(A)| / |N(A) ∪ N(A)| = |N(A)| / |N(A)| = 1.0
    const sim = jaccardSimilarity(0, 0, (id) => adj[id] ?? [])
    expect(sim).toBeCloseTo(1.0, 5)
  })

  it('should compute Jaccard similarity correctly', () => {
    // Graph: 0 connected to 1,2.  3 connected to 1,2.
    // N(0) = {1,2}, N(3) = {1,2}
    // Intersection = {1,2} => 2, Union = {1,2} => 2
    // J = 2/2 = 1.0
    const adj: Record<NodeId, NodeId[]> = {
      0: [1, 2],
      1: [0, 3],
      2: [0, 3],
      3: [1, 2],
    }

    const sim = jaccardSimilarity(0, 3, (id) => adj[id] ?? [])
    expect(sim).toBeCloseTo(1.0, 5)
  })

  it('should compute partial overlap', () => {
    // N(0) = {1,2,4}, N(3) = {1,2,5}
    // Intersection = {1,2} => 2, Union = {1,2,4,5} => 4
    // J = 2/4 = 0.5
    const adj: Record<NodeId, NodeId[]> = {
      0: [1, 2, 4],
      1: [0, 3],
      2: [0, 3],
      3: [1, 2, 5],
      4: [0],
      5: [3],
    }

    const sim = jaccardSimilarity(0, 3, (id) => adj[id] ?? [])
    expect(sim).toBeCloseTo(0.5, 5)
  })
})

describe('allPairsJaccard', () => {
  it('should compute all-pairs Jaccard similarity for graph edges', () => {
    const adj: Record<NodeId, NodeId[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1, 3],
      3: [2],
    }
    const nodeIds: NodeId[] = [0, 1, 2, 3]

    const result = allPairsJaccard(nodeIds, (id) => adj[id] ?? [])
    // Should have 3 pairs (edges, each once)
    expect(result.pairs.length).toBeGreaterThan(0)

    // Check edge (0,1): N(0)={1,2}, N(1)={0,2} -> intersection={2}=1, union={0,1,2}=3 -> J=1/3
    // Actually N(0) removes {0} -> {1,2}, N(1) removes {1} -> {0,2} -> intersect={2}=1, union={0,1,2}=3 -> J≈0.333
    const pair01 = result.pairs.find(p =>
      (p.nodeA === 0 && p.nodeB === 1) || (p.nodeA === 1 && p.nodeB === 0)
    )
    expect(pair01).toBeDefined()
    expect(pair01!.similarity).toBeCloseTo(1 / 3, 2)
  })

  it('should filter results by threshold', () => {
    const adj: Record<NodeId, NodeId[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3],
    }
    const nodeIds: NodeId[] = [0, 1, 2, 3, 4]

    // With threshold 1.0, only (3,4) should have similarity 0 (N(3)={4}, N(4)={3} -> disjoint after self-removal)
    // Actually: N(3) = {4}, N(4) = {3} -> intersection = {}, union = {3,4} -> J = 0/2 = 0
    // So with threshold 0, all should appear
    const result = allPairsJaccard(nodeIds, (id) => adj[id] ?? [], 0)
    expect(result.pairs.length).toBe(3) // 3 edges: (0,1), (1,2), (3,4)

    const resultFiltered = allPairsJaccard(nodeIds, (id) => adj[id] ?? [], 0.5)
    // (0,1): N(0)={1}, N(1)={0,2} -> intersect=0 -> J=0
    // (1,2): N(1)={0,2}, N(2)={1} -> intersect=0 -> J=0
    // (3,4): N(3)={4}, N(4)={3} -> intersect=0 -> J=0
    expect(resultFiltered.pairs.length).toBe(0)
  })
})

describe('Node2Vec with Jaccard (integration)', () => {
  it('should produce consistent embeddings for structurally similar nodes', () => {
    // Test graph: 2 disconnected components of the same structure
    // Component A: 0-1-2, Component B: 3-4-5
    const adj: Record<NodeId, NodeId[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3, 5],
      5: [4],
    }
    const nodeIds: NodeId[] = [0, 1, 2, 3, 4, 5]
    const getNeighbors = (id: NodeId) => adj[id] ?? []

    const result = node2vec(nodeIds, getNeighbors, {
      dimensions: 16,
      walksPerNode: 10,
      walkLength: 40,
      epochs: 5,
      seed: 42,
    })

    // Nodes 0 and 3 (both endpoints of a chain) and 1 and 4 (both middle nodes)
    // should have positive embedding similarity
    const emb0 = result.embeddings.get(0)!
    const emb3 = result.embeddings.get(3)!
    const sim03 = cosineSimilarity(emb0, emb3)
    expect(sim03).toBeGreaterThan(0)

    const emb1 = result.embeddings.get(1)!
    const emb4 = result.embeddings.get(4)!
    const sim14 = cosineSimilarity(emb1, emb4)
    expect(sim14).toBeGreaterThan(0)
  })
})
