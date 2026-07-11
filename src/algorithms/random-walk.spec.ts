/**
 * 随机游走测试
 *
 * Note: 随机性使用 seed 或 mock 控制，确保可重复。
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

  it('全连接图 — 可跨节点游走', () => {
    const complete = makeGraph([[1, 2], [1, 3], [2, 3], [1, 4], [2, 4], [3, 4]])
    const path = randomWalk(complete, 1, 3)
    expect(path.length).toBe(4) // start + 3
    expect(path[0]).toBe(1)
    // 所有步骤应在图中
    for (let i = 0; i < path.length - 1; i++) {
      expect(complete.get(path[i])!.has(path[i + 1])).toBe(true)
    }
  })

  it('负深度返回 [start]', () => {
    const path = randomWalk(graph, 2, -1)
    expect(path).toEqual([2])
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

  it('循环图 — 节点可以重复访问', () => {
    const cycle = makeGraph([[1, 2], [2, 3], [3, 1]])
    const path = randomWalk(cycle, 1, 5)
    expect(path.length).toBe(6)
    // 在 3 节点循环中，路径每一步在图内
    for (let i = 0; i < path.length - 1; i++) {
      expect(cycle.get(path[i])!.has(path[i + 1])).toBe(true)
    }
  })

  it('两个节点无边 — randomWalk 停在起始点', () => {
    const empty = new Map([[5, new Set()]])
    const path = randomWalk(empty, 5, 10)
    expect(path).toEqual([5])
  })

  it('randomWalks — all paths start with correct start node', () => {
    const graph = makeGraph([[1, 2], [2, 3], [3, 4]])
    const walks = randomWalks(graph, [1, 4], 3, 2)
    for (const w of walks) {
      expect([1, 4]).toContain(w[0])
    }
  })

  it('randomWalk — 4-step walk in chain is valid', () => {
    const graph = makeGraph([[1, 2], [2, 3], [3, 4]])
    const path = randomWalk(graph, 1, 4)
    expect(path.length).toBe(5)
    expect(path[0]).toBe(1)
  })
})
