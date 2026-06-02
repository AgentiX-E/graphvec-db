/**
 * 随机游走测试
 *
 * 注意：随机性使用 seed 或 mock 控制，确保可重复。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomWalk, randomWalks } from './random-walk'

function makeGraph(edges: Array<[number, number]>): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>()
  for (const [u, v] of edges) {
    if (!adj.has(u)) adj.set(u, new Set())
    if (!adj.has(v)) adj.set(v, new Set())
    adj.get(u)!.add(v)
    adj.get(v)!.add(u)
  }
  return adj
}

describe('randomWalk', () => {
  let graph: Map<number, Set<number>>

  beforeEach(() => {
    // 线性图: 1-2-3-4
    graph = makeGraph([[1, 2], [2, 3], [3, 4]])
  })

  it('深度为 0 只返回起始节点', () => {
    const path = randomWalk(graph, 1, 0)
    expect(path).toEqual([1])
  })

  it('深度为 2 返回长度为 3 的路径', () => {
    const path = randomWalk(graph, 2, 2)
    expect(path.length).toBe(3) // start + 2 steps
    expect(path[0]).toBe(2)
  })

  it('路径元素都是数字', () => {
    const path = randomWalk(graph, 1, 5)
    for (const node of path) {
      expect(typeof node).toBe('number')
    }
  })

  it('孤立节点返回 [node]', () => {
    const single = new Map([[42, new Set()]])
    const path = randomWalk(single, 42, 10)
    expect(path).toEqual([42])
  })
})

describe('randomWalks', () => {
  it('空起始节点返回空', () => {
    expect(randomWalks(new Map(), [], 5, 2)).toEqual([])
  })

  it('节点 1 走 2 轮深度 2，返回 2 条路径', () => {
    const graph = makeGraph([[1, 2], [2, 3]])
    const walks = randomWalks(graph, [1], 2, 2)
    expect(walks.length).toBe(2)
    for (const w of walks) {
      expect(w.length).toBe(3) // start + 2 steps
      expect(w[0]).toBe(1)
    }
  })

  it('两个节点各走 1 轮深度 1，返回 2 条路径', () => {
    const graph = makeGraph([[1, 2], [2, 3]])
    const walks = randomWalks(graph, [1, 3], 1, 1)
    expect(walks.length).toBe(2)
  })
})
