/**
 * leiden.spec.ts — Leiden 社区发现算法测试
 */
import { leidenCommunity, type LeidenEdge } from './leiden'

describe('leidenCommunity', () => {
  test('should return empty result for empty graph', () => {
    const result = leidenCommunity([], [])
    expect(result.communities.size).toBe(0)
    expect(result.modularity).toBe(0)
    expect(result.levels).toBe(0)
  })

  test('should put all nodes in isolated communities for disconnected graph', () => {
    const vertices = [1, 2, 3]
    const edges: LeidenEdge[] = []
    const result = leidenCommunity(vertices, edges)
    expect(result.communities.size).toBe(3)
    expect(result.levels).toBeGreaterThanOrEqual(1)
  })

  test('should put connected nodes in same community (triangle)', () => {
    const vertices = [1, 2, 3]
    const edges = [
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 1, dst: 3, weight: 1 },
    ]
    const result = leidenCommunity(vertices, edges)
    expect(result.communities.size).toBe(3)
    // All nodes should be in the same community
    const communities = new Set(result.communities.values())
    expect(communities.size).toBe(1)
  })

  test('should separate two disconnected cliques', () => {
    const vertices = [1, 2, 3, 4, 5, 6]
    const edges = [
      // Clique 1
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 3, weight: 1 },
      { src: 1, dst: 3, weight: 1 },
      // Clique 2
      { src: 4, dst: 5, weight: 1 },
      { src: 5, dst: 6, weight: 1 },
      { src: 4, dst: 6, weight: 1 },
    ]
    const result = leidenCommunity(vertices, edges)
    expect(result.communities.size).toBe(6)
    expect(result.levels).toBeGreaterThanOrEqual(1)

    // Clique 1 nodes should be together
    const c1 = result.communities.get(1)
    expect(result.communities.get(2)).toBe(c1)
    expect(result.communities.get(3)).toBe(c1)

    // Clique 2 nodes should be together (different from clique 1)
    const c4 = result.communities.get(4)
    expect(result.communities.get(5)).toBe(c4)
    expect(result.communities.get(6)).toBe(c4)

    // The two communities should be different
    expect(c1).not.toBe(c4)
  })

  test('should produce positive modularity for structured graph', () => {
    const vertices = [1, 2, 3, 4, 5, 6, 7, 8]
    const edges = [
      // Community A
      { src: 1, dst: 2, weight: 2 },
      { src: 2, dst: 3, weight: 2 },
      { src: 1, dst: 3, weight: 2 },
      // Community B
      { src: 4, dst: 5, weight: 2 },
      { src: 5, dst: 6, weight: 2 },
      { src: 4, dst: 6, weight: 2 },
      // Weak bridge between communities
      { src: 3, dst: 4, weight: 0.1 },
      // Extra nodes in community A
      { src: 1, dst: 7, weight: 1 },
      { src: 7, dst: 8, weight: 1 },
    ]
    const result = leidenCommunity(vertices, edges)
    expect(result.modularity).toBeGreaterThan(0)
  })

  test('should handle single node', () => {
    const vertices = [42]
    const edges: Array<{ src: number; dst: number; weight: number }> = []
    const result = leidenCommunity(vertices, edges)
    expect(result.communities.size).toBe(1)
    expect(result.communities.get(42)).toBe(42)
  })

  test('should handle two-node edge', () => {
    const vertices = [1, 2]
    const edges = [{ src: 1, dst: 2, weight: 1 }]
    const result = leidenCommunity(vertices, edges)
    expect(result.communities.size).toBe(2)
    const communities = new Set(result.communities.values())
    expect(communities.size).toBe(1) // Same community
  })

  test('should handle weighted edges correctly', () => {
    // Strong weight between 1-2, much weaker to 3
    const vertices = [1, 2, 3]
    const edges = [
      { src: 1, dst: 2, weight: 10 },
      { src: 2, dst: 3, weight: 0.1 },
      { src: 1, dst: 3, weight: 0.1 },
    ]
    const result = leidenCommunity(vertices, edges)
    // 1 and 2 should be together (strong connection)
    // Check community membership
    const c1 = result.communities.get(1)
    const c2 = result.communities.get(2)
    const c3 = result.communities.get(3)
    expect(c1).toBeDefined()
    expect(c2).toBeDefined()
    expect(c3).toBeDefined()
    expect(c1).toBe(c2)
  })
})
