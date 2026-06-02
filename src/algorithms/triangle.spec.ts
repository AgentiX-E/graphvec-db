/**
 * 三角计数与聚类系数测试
 */

import { describe, it, expect } from 'vitest'
import {
  countTriangles,
  clusteringCoefficient,
  averageClusteringCoefficient,
} from './triangle'

function makeGraph(
  edges: Array<[number, number]>,
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>()
  for (const [u, v] of edges) {
    if (!adj.has(u)) adj.set(u, new Set())
    if (!adj.has(v)) adj.set(v, new Set())
    adj.get(u)!.add(v)
    adj.get(v)!.add(u)
  }
  return adj
}

describe('countTriangles', () => {
  it('空图返回 0', () => {
    expect(countTriangles(new Map())).toBe(0)
  })

  it('一条边返回 0', () => {
    const g = makeGraph([[1, 2]])
    expect(countTriangles(g)).toBe(0)
  })

  it('三角形 K3 返回 1', () => {
    const g = makeGraph([[1, 2], [2, 3], [3, 1]])
    expect(countTriangles(g)).toBe(1)
  })

  it('四个节点全连接 K4 返回 4', () => {
    const g = makeGraph([
      [1, 2], [1, 3], [1, 4],
      [2, 3], [2, 4],
      [3, 4],
    ])
    // K4 有 C(4,3) = 4 个三角形
    expect(countTriangles(g)).toBe(4)
  })

  it('两个三角形共享边', () => {
    const g = makeGraph([
      [1, 2], [2, 3], [3, 1], // △123
      [3, 4], [4, 1],         // △134（边 1-3 共享）
    ])
    expect(countTriangles(g)).toBe(2)
  })
})

describe('clusteringCoefficient', () => {
  it('节点不存在返回 0', () => {
    expect(clusteringCoefficient(makeGraph([[1, 2]]), 999)).toBe(0)
  })

  it('度 < 2 的节点返回 0', () => {
    const g = makeGraph([[1, 2], [2, 3]])
    expect(clusteringCoefficient(g, 1)).toBe(0) // degree of 1 = 1
  })

  it('完全 K3 中节点聚类系数为 1', () => {
    const g = makeGraph([[1, 2], [2, 3], [3, 1]])
    expect(clusteringCoefficient(g, 1)).toBe(1)
  })

  it('链式结构中心节点聚类系数为 0', () => {
    const g = makeGraph([[1, 2], [2, 3], [3, 4]])
    expect(clusteringCoefficient(g, 2)).toBe(0) // 2 的邻居 1 和 3 无边
  })

  it('仅 2/3 邻居相连 → 聚类系数 ~0.333', () => {
    // 节点 1 的邻居: 2,3,4; 只有 2-3 相连
    const g = makeGraph([
      [1, 2], [1, 3], [1, 4],
      [2, 3],
    ])
    // k=3, possible=3, edges=1 → 1/3 ≈ 0.333
    expect(clusteringCoefficient(g, 1)).toBeCloseTo(1 / 3, 5)
  })
})

describe('averageClusteringCoefficient', () => {
  it('空图返回 0', () => {
    expect(averageClusteringCoefficient(new Map())).toBe(0)
  })

  it('K4 全连接图返回 1', () => {
    const g = makeGraph([
      [1, 2], [1, 3], [1, 4],
      [2, 3], [2, 4],
      [3, 4],
    ])
    // K4 中所有节点的聚类系数都是 1
    expect(averageClusteringCoefficient(g)).toBe(1)
  })

  it('线型图返回 0', () => {
    const g = makeGraph([[1, 2], [2, 3], [3, 4]])
    expect(averageClusteringCoefficient(g)).toBe(0)
  })
})
