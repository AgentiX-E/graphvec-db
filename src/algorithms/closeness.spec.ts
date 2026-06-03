/**
 * closeness.spec.ts — Closeness Centrality 单元测试
 *
 * 测试 closeness() 纯函数：归一化、原始、孤立节点、单节点
 */
import { describe, it, expect } from 'vitest'
import { closeness } from './closeness'

describe('closeness', () => {
  // 线性有向图: 0 → 1 → 2 → 3
  const linear = (n: number) => {
    if (n >= 3) return []
    return [n + 1]
  }
  const linearNodes = [0, 1, 2, 3]

  it('computes closeness for all nodes in a directed linear path', () => {
    const scores = closeness(linear, linearNodes)
    expect(scores.size).toBe(4)
    // 0: reachable=3, sumDist=1+2+3=6 → 3/6=0.5
    // 1: reachable=3, sumDist=1+1+2=4 → 3/4=0.75
    // 2: reachable=3, sumDist=1+1+2=4 → 3/4=0.75
    // 3: reachable=3, sumDist=3+2+1=6 → 3/6=0.5
    // wait — BFS 是双向的？不，getNeighbors 只返回出边。
    // 从节点 3 出发：reachable 只有自身（无出边），reachableCount=0 → score=0
    
    // 实际 BFS 从每个节点遍历可达节点：
    // 0→{0,1,2,3}, 1→{1,2,3}, 2→{2,3}, 3→{3}
    expect(scores.get(0)).toBeCloseTo(3 / 6, 2)   // 0.5
    expect(scores.get(1)).toBeCloseTo(2 / 3, 2)   // 0.667
    expect(scores.get(2)).toBeCloseTo(1 / 1, 2)   // 1.0
    expect(scores.get(3)).toBe(0)  // 孤立（无出边）
  })

  // 星形图: 0→1, 0→2, 0→3
  const star = (n: number) => {
    if (n === 0) return [1, 2, 3]
    return []
  }
  const starNodes = [0, 1, 2, 3]

  it('center has highest closeness in star graph', () => {
    const scores = closeness(star, starNodes)
    // star 是有向的：中心有出边到 3 个 leaf，leaf 无出边
    // center: reachable=3, sumDist=1+1+1=3 → 3/3=1
    // leaf: reachable=0（无出边）→ score=0
    expect(scores.get(0)).toBe(1)
    expect(scores.get(1)).toBe(0)
  })

  // disconnected: 0→1→2, 3→4, 5 孤立
  const disconnected = (n: number): number[] => {
    if (n < 2) return [n + 1]
    return []
  }
  const disconnectedNodes = [0, 1, 2, 3, 4, 5]

  it('disconnected components have their own closeness scores', () => {
    const scores = closeness(disconnected, disconnectedNodes)
    expect(scores.get(0)).toBeGreaterThan(0)
    expect(scores.get(5)).toBe(0) // 孤立节点 reachableCount=0
  })

  // 单节点
  it('returns 0 for single node', () => {
    const scores = closeness(() => [], [42])
    expect(scores.get(42)).toBe(0)
  })

  // 全连接图：任意节点可直接到达其他 3 个
  const complete = (n: number) => {
    const neighbors = [0, 1, 2, 3]
    return neighbors.filter(x => x !== n)
  }
  const completeNodes = [0, 1, 2, 3]

  it('all nodes have equal and high closeness in complete graph', () => {
    const scores = closeness(complete, completeNodes)
    for (const id of completeNodes) {
      expect(scores.get(id)).toBe(1)
    }
  })

  it('non-normalized closeness returns 1/sumDist', () => {
    const scores = closeness(star, starNodes, { normalize: false })
    // center: 1/(1+1+1) = 1/3; leaf: 1/(1+2) = 1/3
    expect(scores.get(0)!).toBeCloseTo(1 / 3, 4)
  })
})
