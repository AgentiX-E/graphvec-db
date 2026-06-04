/**
 * dijkstra.spec.ts — Dijkstra 最短路径单元测试
 *
 * 测试 dijkstra() 纯函数：最短距离、加权图、不可达节点、单节点
 */
import { describe, it, expect } from 'vitest'
import { dijkstra } from './dijkstra'

describe('dijkstra', () => {
  // 简单的加权线性图: 0 -1→ 1 -2→ 2 -3→ 3
  const linear = (n: number) => {
    const weights: Record<number, number> = { 0: 1, 1: 2, 2: 3 }
    if (n >= 3) return []
    return [{ nodeId: n + 1, weight: weights[n] ?? 1 }]
  }

  it('finds shortest paths on a linear weighted graph', () => {
    const result = dijkstra(linear, 0)
    expect(result.get(0)!.distance).toBe(0)
    expect(result.get(1)!.distance).toBe(1)
    expect(result.get(2)!.distance).toBe(3) // 1 + 2
    expect(result.get(3)!.distance).toBe(6) // 1 + 2 + 3
    expect(result.get(0)!.parent).toBeNull()
    expect(result.get(3)!.parent).toBe(2)
  })

  // 三角图：0 →1→ 1, 0 →4→ 2, 1 →1→ 2
  // 0→2 最短路径：0→1→2 = 2（不是 0→2 = 4）
  const triangle = (n: number) => {
    switch (n) {
      case 0: return [
        { nodeId: 1, weight: 1 },
        { nodeId: 2, weight: 4 },
      ]
      case 1: return [{ nodeId: 2, weight: 1 }]
      default: return []
    }
  }

  it('finds shortest path through intermediate node', () => {
    const result = dijkstra(triangle, 0)
    expect(result.get(0)!.distance).toBe(0)
    expect(result.get(1)!.distance).toBe(1)
    expect(result.get(2)!.distance).toBe(2) // 0→1→2 = 2, not 4
    expect(result.get(2)!.parent).toBe(1)
  })

  // 星形加权图：0→1:5, 0→2:3, 0→3:7
  const star = (n: number) => {
    if (n === 0) return [
      { nodeId: 1, weight: 5 },
      { nodeId: 2, weight: 3 },
      { nodeId: 3, weight: 7 },
    ]
    return []
  }

  it('finds shortest paths on a star graph', () => {
    const result = dijkstra(star, 0)
    expect(result.get(1)!.distance).toBe(5)
    expect(result.get(2)!.distance).toBe(3)
    expect(result.get(3)!.distance).toBe(7)
    expect(result.get(1)!.parent).toBe(0)
  })

  // 单节点
  it('handles single node with no neighbors', () => {
    const result = dijkstra(() => [], 42)
    expect(result.size).toBe(1)
    expect(result.get(42)!.distance).toBe(0)
    expect(result.get(42)!.parent).toBeNull()
  })

  // 孤立节点
  it('only visits reachable nodes', () => {
    const disconnected = (n: number) => {
      if (n < 3) return [{ nodeId: n + 1, weight: 1 }]
      return []
    }
    const result = dijkstra(disconnected, 0)
    expect(result.size).toBe(4)
    expect(result.has(4)).toBe(false)
  })

  // 多条路径到同一节点，验证取最短
  const diamond = (n: number) => {
    switch (n) {
      case 0: return [
        { nodeId: 1, weight: 2 },
        { nodeId: 2, weight: 4 },
      ]
      case 1: return [{ nodeId: 3, weight: 1 }]
      case 2: return [{ nodeId: 3, weight: 1 }]
      default: return []
    }
  }

  it('picks the shortest path among multiple alternatives', () => {
    const result = dijkstra(diamond, 0)
    // 0→1→3 = 3  <  0→2→3 = 5
    expect(result.get(3)!.distance).toBe(3)
    expect(result.get(3)!.parent).toBe(1)
  })

  // 自环节点
  it('handles self-loop with non-negative weight', () => {
    const selfLoop = (n: number) => n === 0
      ? [{ nodeId: 0, weight: 5 }]
      : []
    const result = dijkstra(selfLoop, 0)
    expect(result.get(0)!.distance).toBe(0) // 自环不会被选择（距离更差）
    expect(result.size).toBe(1)
  })

  // 完全图 K4 — 所有其他节点距离 = 最小边权重
  it('complete graph K4 — shortest paths to all nodes', () => {
    const k4 = (n: number) => [0, 1, 2, 3]
      .filter(x => x !== n)
      .map(nodeId => ({
        nodeId,
        weight: nodeId === 0 ? 1 : nodeId === 1 ? 2 : nodeId === 2 ? 3 : 4,
      }))
    const result = dijkstra(k4, 0)
    expect(result.get(1)!.distance).toBe(2)
    expect(result.get(2)!.distance).toBe(3)
    expect(result.get(3)!.distance).toBe(4)
  })

  // 两条路径到达同一节点 — 验证选择较短的
  it('two paths to same node — picks shorter', () => {
    const twoPaths = (n: number) => {
      if (n === 0) return [
        { nodeId: 1, weight: 10 },
        { nodeId: 2, weight: 1 },
      ]
      if (n === 2) return [{ nodeId: 1, weight: 1 }]
      return []
    }
    const result = dijkstra(twoPaths, 0)
    expect(result.get(1)!.distance).toBe(2) // 0→2→1 = 2, not 10
    expect(result.get(1)!.parent).toBe(2)
  })

  // 大图测试 — 1 条链 10 个节点
  it('long chain graph — works correctly', () => {
    const chain = (n: number) =>
      n < 9 ? [{ nodeId: n + 1, weight: 1 }] : []
    const result = dijkstra(chain, 0)
    for (let i = 0; i <= 9; i++) {
      expect(result.get(i)!.distance).toBe(i)
    }
  })
})
