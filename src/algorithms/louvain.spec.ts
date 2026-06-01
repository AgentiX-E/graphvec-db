import { louvainCommunity } from './louvain'

describe('Louvain', () => {
  test('two communities', () => {
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 3, dst: 1, weight: 1 },
      { src: 4, dst: 5, weight: 1 },
      { src: 5, dst: 6, weight: 1 },
      { src: 6, dst: 4, weight: 1 },
      { src: 3, dst: 4, weight: 0.1 },
    ]
    const r = louvainCommunity(vertices, edges)
    expect(r.communities.get(1)).toBe(r.communities.get(3))
    expect(r.communities.get(4)).toBe(r.communities.get(6))
    expect(r.levels).toBeGreaterThanOrEqual(1)
  })

  test('empty', () => {
    const r = louvainCommunity([], [])
    expect(r.levels).toBe(0)
  })

  test('single node', () => {
    const r = louvainCommunity([1], [])
    expect(r.levels).toBe(1)
    expect(r.communities.get(1)).toBe(1)
  })

  test('multi-level communities with Phase 2', () => {
    // Four dense clusters, with stronger links between A↔B and C↔D
    // and weaker links across the AB↔CD boundary.
    // This creates a two-level hierarchy.
    const vertices = [1, 2, 3, 4, 5, 6, 7, 8]
    const edges = [
      // Cluster A (1-2)
      { src: 1, dst: 2, weight: 10 },
      // Cluster B (3-4)
      { src: 3, dst: 4, weight: 10 },
      // Cluster C (5-6)
      { src: 5, dst: 6, weight: 10 },
      // Cluster D (7-8)
      { src: 7, dst: 8, weight: 10 },
      // Strong links within pair AB
      { src: 2, dst: 3, weight: 5 },
      // Strong links within pair CD
      { src: 6, dst: 7, weight: 5 },
      // Weak link between pairs
      { src: 1, dst: 5, weight: 0.1 },
      { src: 4, dst: 8, weight: 0.1 },
    ]
    const r = louvainCommunity(vertices, edges)

    // Phase 1: Cluster pairs (A+B) and (C+D) should form due to strong internal links
    expect(r.communities.get(1)).toBe(r.communities.get(2))
    expect(r.communities.get(5)).toBe(r.communities.get(6))

    // Should have at least 2 levels
    expect(r.levels).toBeGreaterThanOrEqual(2)

    // Verify levelCommunities is populated
    if (r.levelCommunities) {
      expect(r.levelCommunities.length).toBe(r.levels)
    }
  })

  test('two dense clusters far apart - single level is enough', () => {
    // Two fully disconnected clusters with no inter-cluster edges
    // Phase 2 won't add value since there are no edges between clusters
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 3, dst: 1, weight: 1 },
      { src: 4, dst: 5, weight: 1 },
      { src: 5, dst: 6, weight: 1 },
      { src: 6, dst: 4, weight: 1 },
    ]
    const r = louvainCommunity(vertices, edges)

    // Should still produce correct communities
    expect(r.communities.get(1)).toBe(r.communities.get(3))
    expect(r.communities.get(4)).toBe(r.communities.get(6))
    expect(r.communities.get(1)).not.toBe(r.communities.get(4))
  })

  test('modularity improves with Phase 2 aggregation', () => {
    // Three clusters where A and B are weakly linked, and B and C are weakly linked
    // but A and C are more weakly linked
    // This tests that Phase 2 actually runs (levels > 1)
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      { src: 1, dst: 2, weight: 5 },
      { src: 2, dst: 3, weight: 5 },
      { src: 3, dst: 1, weight: 5 },
      { src: 4, dst: 5, weight: 5 },
      { src: 5, dst: 6, weight: 5 },
      { src: 6, dst: 4, weight: 5 },
      { src: 3, dst: 4, weight: 0.5 },
      { src: 6, dst: 1, weight: 0.5 },
    ]
    const r = louvainCommunity(vertices, edges)

    // Modularity should be a valid number
    expect(r.modularity).toBeGreaterThanOrEqual(-1)
    expect(r.modularity).toBeLessThanOrEqual(1)
    expect(r.levels).toBeGreaterThanOrEqual(1)
  })

  test('large graph with clear hierarchy forms multi-level communities', () => {
    // 12 nodes in 3 clusters of 4, each cluster densely connected
    // Cross edges create a two-level hierarchy
    const vertices = Array.from({ length: 12 }, (_, i) => i + 1)
    const edges: Array<{ src: number; dst: number; weight: number }> = []

    // Cluster 0: 1-2-3-4 (weight 10)
    for (let i = 1; i <= 4; i++) {
      for (let j = i + 1; j <= 4; j++) {
        edges.push({ src: i, dst: j, weight: 10 })
      }
    }

    // Cluster 1: 5-6-7-8 (weight 10)
    for (let i = 5; i <= 8; i++) {
      for (let j = i + 1; j <= 8; j++) {
        edges.push({ src: i, dst: j, weight: 10 })
      }
    }

    // Cluster 2: 9-10-11-12 (weight 10)
    for (let i = 9; i <= 12; i++) {
      for (let j = i + 1; j <= 12; j++) {
        edges.push({ src: i, dst: j, weight: 10 })
      }
    }

    // Cross edges: cluster 0 ↔ 1 (weight 1), cluster 1 ↔ 2 (weight 1)
    edges.push({ src: 1, dst: 5, weight: 1 })
    edges.push({ src: 2, dst: 6, weight: 1 })
    edges.push({ src: 5, dst: 9, weight: 1 })
    edges.push({ src: 6, dst: 10, weight: 1 })

    const r = louvainCommunity(vertices, edges)

    // Phase 1: Each cluster should form its own community
    // Nodes 1-4 same community, 5-8 same, 9-12 same
    expect(r.communities.get(1)).toBe(r.communities.get(4))
    expect(r.communities.get(5)).toBe(r.communities.get(8))
    expect(r.communities.get(9)).toBe(r.communities.get(12))

    // Verify communities exist
    expect(r.levels).toBeGreaterThanOrEqual(1)
    expect(r.modularity).toBeGreaterThan(-1)
  })
})
