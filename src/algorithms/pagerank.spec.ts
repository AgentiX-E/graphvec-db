/**
 * pagerank.spec.ts — PageRank 算法单元测试
 *
 * 测试单线程 mode（默认）、收敛性、悬挂节点、空图等。
 * 多线程 mode（numThreads > 1）异步测试用单独的 describe。
 */
import { describe, it, expect } from 'vitest'
import { pagerank } from './pagerank'

describe('PageRank (single-thread)', () => {
  // 线性图: 0→1, 1→2, 2→3, 3（悬挂）
  const linear = (n: number): number[] => {
    if (n >= 3) return []
    return [n + 1]
  }
  const linearNodes = [0, 1, 2, 3]

  it('computes PageRank for a linear graph', () => {
    const pr = pagerank(linear, linearNodes) as Map<number, number>
    expect(pr.size).toBe(4)
    // 所有 rank 之和应为 1
    const sum = Array.from(pr.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 4)
  })

  // 强连通分量
  const scc = (n: number): number[] => [(n + 1) % 3]
  const sccNodes = [0, 1, 2]

  it('computes balanced ranks in a strongly connected graph', () => {
    const pr = pagerank(scc, sccNodes) as Map<number, number>
    expect(pr.size).toBe(3)
    const sum = Array.from(pr.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 4)
    // 完全对称 → 大致相等
    const vals = Array.from(pr.values())
    expect(vals[0]).toBeCloseTo(1 / 3, 2)
    expect(vals[1]).toBeCloseTo(1 / 3, 2)
    expect(vals[2]).toBeCloseTo(1 / 3, 2)
  })

  // 星形入边: 1→0, 2→0, 3→0（0 是汇聚节点）
  const hub = (n: number): number[] => {
    if (n > 0) return [0]
    return []
  }
  const hubNodes = [0, 1, 2, 3]

  it('gives highest rank to the hub node with most incoming links', () => {
    const pr = pagerank(hub, hubNodes) as Map<number, number>
    const vals = Array.from(pr.entries())
    vals.sort((a, b) => b[1] - a[1])
    // 节点 0（汇聚节点）应该有最高 rank
    expect(vals[0][0]).toBe(0)
  })

  // 空图
  it('returns empty map for empty node list', () => {
    const pr = pagerank(() => [], []) as Map<number, number>
    expect(pr.size).toBe(0)
  })

  // 单节点
  it('returns rank=1 for single node', () => {
    const pr = pagerank(() => [], [42]) as Map<number, number>
    expect(pr.size).toBe(1)
    expect(pr.get(42)).toBeCloseTo(1, 4)
  })

  // 全部悬挂节点
  it('handles all dangling nodes (no outgoing edges)', () => {
    const pr = pagerank(() => [], [0, 1, 2]) as Map<number, number>
    const sum = Array.from(pr.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 4)
    // 理论上 dgle 全阻尼 → 均匀分布
    expect(pr.get(0)).toBeCloseTo(1 / 3, 2)
  })

  // 收敛阈值（快速迭代）
  it('converges within max iterations', () => {
    const pr = pagerank(linear, linearNodes, {
      maxIterations: 5,
      convergenceThreshold: 1e-10,
    }) as Map<number, number>
    const sum = Array.from(pr.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 3)
  })

  // 自定义 damping factor
  it('supports custom damping factor', () => {
    const pr = pagerank(linear, linearNodes, {
      dampingFactor: 0.9,
    }) as Map<number, number>
    const sum = Array.from(pr.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 4)
  })

  // 收敛性保证（足够迭代后 rank 变化很小）
  it('ranks stabilize after sufficient iterations', () => {
    const pr1 = pagerank(scc, sccNodes, { maxIterations: 10 }) as Map<number, number>
    const pr2 = pagerank(scc, sccNodes, { maxIterations: 100 }) as Map<number, number>
    // 两个结果应该非常接近
    for (const node of sccNodes) {
      expect(pr1.get(node)!).toBeCloseTo(pr2.get(node)!, 4)
    }
  })
})

describe('PageRank (multi-thread)', () => {
  it('multi-thread result matches single-thread', async () => {
    const scc = (n: number): number[] => [(n + 1) % 3]
    const sccNodes = [0, 1, 2]

    const single = pagerank(scc, sccNodes) as Map<number, number>
    const multi = (await pagerank(scc, sccNodes, {
      numThreads: 2,
    })) as Map<number, number>

    for (const node of sccNodes) {
      expect(single.get(node)!).toBeCloseTo(multi.get(node)!, 3)
    }
  })

  it('multi-thread with 4 threads converges', async () => {
    // 使用较大图确保分片有意义
    const getNeighbors = (n: number): number[] => {
      if (n < 10) return [n + 1]
      return []
    }
    const nodes = Array.from({ length: 20 }, (_, i) => i)

    const pr = (await pagerank(getNeighbors, nodes, {
      numThreads: 4,
    })) as Map<number, number>

    const sum = Array.from(pr.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 2)
  })
})
