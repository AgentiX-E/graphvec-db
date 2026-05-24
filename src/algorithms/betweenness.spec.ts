import { betweennessCentrality } from './betweenness'

describe('Betweenness', () => {
  test('line graph', () => {
    const adj = new Map<number, number[]>([
      [1, [2]],
      [2, [1, 3]],
      [3, [2]],
    ])
    const r = betweennessCentrality([1, 2, 3], adj)
    expect(r[2]).toBeGreaterThan(r[1])
    expect(r[2]).toBeGreaterThan(r[3])
  })

  test('single vertex', () => {
    const r = betweennessCentrality([1], new Map([[1, []]]))
    expect(r[1]).toBe(0)
  })

  test('clique', () => {
    const adj = new Map([
      [1, [2, 3, 4]],
      [2, [1, 3, 4]],
      [3, [1, 2, 4]],
      [4, [1, 2, 3]],
    ])
    const r = betweennessCentrality([1, 2, 3, 4], adj, false)
    expect(r[1]).toBe(0)
    expect(r[2]).toBe(0)
    expect(r[3]).toBe(0)
    expect(r[4]).toBe(0)
  })
})
