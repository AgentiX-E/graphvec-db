import { describe, test, expect } from 'vitest'
import { approxBetweenness } from './approx-betweenness'

describe('approxBetweenness', () => {
  test('line graph: center nodes higher than ends', () => {
    // 0━1━2━3━4
    const vertices = [0, 1, 2, 3, 4]
    const adjList = new Map([
      [0, [1]],
      [1, [0, 2]],
      [2, [1, 3]],
      [3, [2, 4]],
      [4, [3]],
    ])
    const scores = approxBetweenness(vertices, adjList, { sampleSize: 5 })
    // With full sampling, inner nodes have higher betweenness
    expect(scores.get(0)!).toBeGreaterThanOrEqual(0)
    expect(scores.get(2)!).toBeGreaterThan(scores.get(0)!)
    expect(scores.get(2)!).toBeGreaterThan(scores.get(4)!)
  })

  test('single vertex has 0 betweenness', () => {
    const scores = approxBetweenness([42], new Map([[42, []]]))
    expect(scores.get(42)).toBe(0)
  })

  test('two vertices have 0 betweenness', () => {
    const scores = approxBetweenness(
      [0, 1],
      new Map([[0, [1]], [1, [0]]]),
    )
    expect(scores.get(0)).toBe(0)
    expect(scores.get(1)).toBe(0)
  })

  test('clique: all nodes have 0 betweenness', () => {
    const vertices = [0, 1, 2, 3]
    const adjList = new Map([
      [0, [1, 2, 3]],
      [1, [0, 2, 3]],
      [2, [0, 1, 3]],
      [3, [0, 1, 2]],
    ])
    const scores = approxBetweenness(vertices, adjList, { sampleSize: 4 })
    for (const v of vertices) {
      expect(scores.get(v)).toBe(0)
    }
  })

  test('star graph: center has highest betweenness', () => {
    const vertices = [0, 1, 2, 3, 4]
    const adjList = new Map([
      [0, [1, 2, 3, 4]],
      [1, [0]],
      [2, [0]],
      [3, [0]],
      [4, [0]],
    ])
    const scores = approxBetweenness(vertices, adjList, { sampleSize: 5 })
    expect(scores.get(0)!).toBeGreaterThan(scores.get(1)!)
    expect(scores.get(0)!).toBeGreaterThan(scores.get(2)!)
  })

  test('with sampling (reduced sources)', () => {
    const vertices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    // Line graph 0-1-2-...-9
    const adjList = new Map<number, number[]>()
    for (let i = 0; i < 10; i++) {
      adjList.set(i, [])
    }
    for (let i = 0; i < 9; i++) {
      adjList.get(i)!.push(i + 1)
      adjList.get(i + 1)!.push(i)
    }

    const scores = approxBetweenness(vertices, adjList, { sampleSize: 3 })
    // Should still produce reasonable results (approximation)
    expect(scores.get(0)).toBeGreaterThanOrEqual(0)
    expect(scores.get(9)).toBeGreaterThanOrEqual(0)
  })

  test('empty graph returns empty map', () => {
    const scores = approxBetweenness([], new Map())
    expect(scores.size).toBe(0)
  })

  test('score sum is finite', () => {
    const vertices = [0, 1, 2, 3, 4, 5]
    const adjList = new Map([
      [0, [1, 2]],
      [1, [0, 3]],
      [2, [0, 3]],
      [3, [1, 2, 4]],
      [4, [3, 5]],
      [5, [4]],
    ])
    const scores = approxBetweenness(vertices, adjList, { sampleSize: 6 })
    let sum = 0
    for (const v of vertices) {
      sum += scores.get(v)!
      expect(isFinite(scores.get(v)!)).toBe(true)
    }
    expect(sum).toBeGreaterThanOrEqual(0)
  })

  test('deterministic with same seed', () => {
    const vertices = [0, 1, 2, 3, 4, 5, 6, 7]
    const adjList = new Map<number, number[]>()
    for (let i = 0; i < 8; i++) {
      adjList.set(i, [(i + 1) % 8, (i + 7) % 8])
    }

    const r1 = approxBetweenness(vertices, adjList, { sampleSize: 3, seed: 123 })
    const r2 = approxBetweenness(vertices, adjList, { sampleSize: 3, seed: 123 })
    for (const v of vertices) {
      expect(r1.get(v)).toBe(r2.get(v))
    }
  })
})
