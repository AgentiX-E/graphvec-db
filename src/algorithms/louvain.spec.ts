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
})
