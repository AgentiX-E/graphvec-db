/**
 * dfs.spec.ts — DFS 单元测试
 *
 * 测试 dfs() 纯函数：前序/后序、parent、环图、有向图、孤立节点
 */
import { describe, it, expect } from 'vitest'
import { dfs } from './dfs'

describe('dfs', () => {
  // 线性图: 0 → 1 → 2 → 3
  const linear: (n: number) => number[] = (n) => {
    if (n >= 3) return []
    return [n + 1]
  }

  it('returns pre and post order for linear graph', () => {
    const result = dfs(linear, 0)
    expect(result.pre).toEqual([0, 1, 2, 3])
    expect(result.post).toEqual([3, 2, 1, 0])
    expect(result.parent.get(0)).toBeNull()
    expect(result.parent.get(1)).toBe(0)
    expect(result.parent.get(3)).toBe(2)
  })

  // 有 4 个节点的环: 0↔1↔2↔3↔0
  const cycle: (n: number) => number[] = (n) => {
    return [(n + 1) % 4, (n + 3) % 4]
  }

  it('traverses a cycle without infinite loop', () => {
    const result = dfs(cycle, 0)
    expect(result.pre).toHaveLength(4)
    expect(result.post).toHaveLength(4)
    // 每个节点恰好访问一次
    expect(new Set(result.pre).size).toBe(4)
    expect(new Set(result.post).size).toBe(4)
    expect(result.parent.get(0)).toBeNull()
  })

  // 星形图: 0→1, 0→2, 0→3
  const star: (n: number) => number[] = (n) => {
    if (n === 0) return [1, 2, 3]
    return []
  }

  it('traverses a star graph from center', () => {
    const result = dfs(star, 0)
    expect(result.pre.length).toBe(4)
    // 前序：0 在第一位
    expect(result.pre[0]).toBe(0)
    // 后序：0 在最后一位
    expect(result.post[3]).toBe(0)
    for (let i = 1; i <= 3; i++) {
      expect(result.parent.get(i)).toBe(0)
    }
  })

  // 有向无环图: 0→1, 0→2, 1→3, 2→3
  const dag: (n: number) => number[] = (n) => {
    switch (n) {
      case 0: return [1, 2]
      case 1: return [3]
      case 2: return [3]
      default: return []
    }
  }

  it('traverses a DAG correctly', () => {
    const result = dfs(dag, 0)
    expect(result.pre).toHaveLength(4)
    expect(result.post).toHaveLength(4)
  })

  // 单个节点
  it('handles single node with no neighbors', () => {
    const result = dfs(() => [], 42)
    expect(result.pre).toEqual([42])
    expect(result.post).toEqual([42])
    expect(result.parent.get(42)).toBeNull()
  })

  // 孤立节点（从起始节点不可达）
  it('only visits reachable nodes from start', () => {
    const disconnected: (n: number) => number[] = (n) => {
      if (n < 3) return [n + 1]
      return []
    }
    const result = dfs(disconnected, 0)
    expect(result.pre).toHaveLength(4)
    expect(result.parent.has(4)).toBe(false)
  })

  // 自环节点
  it('handles self-loop (does not infinite loop)', () => {
    const selfLoop: (n: number) => number[] = () => [0]
    const result = dfs(selfLoop, 0)
    expect(result.pre).toEqual([0])
    expect(result.post).toEqual([0])
  })
})
