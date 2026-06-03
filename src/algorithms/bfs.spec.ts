/**
 * bfs.spec.ts — BFS 单元测试
 *
 * 测试 bfs() 纯函数：距离、parent、环形图、有向图、孤立节点
 */
import { describe, it, expect } from 'vitest'
import { bfs } from './bfs'

describe('bfs', () => {
  // 线性图: 0 → 1 → 2 → 3
  const linear: (n: number) => number[] = (n) => {
    if (n >= 3) return []
    return [n + 1]
  }

  it('traverses a linear graph from start', () => {
    const result = bfs(linear, 0)
    expect(result.size).toBe(4)
    expect(result.get(0)!.distance).toBe(0)
    expect(result.get(1)!.distance).toBe(1)
    expect(result.get(2)!.distance).toBe(2)
    expect(result.get(3)!.distance).toBe(3)
    expect(result.get(0)!.parent).toBeNull()
    expect(result.get(3)!.parent).toBe(2)
  })

  // 有 4 个节点的环: 0↔1↔2↔3↔0
  const cycle: (n: number) => number[] = (n) => {
    return [(n + 1) % 4, (n + 3) % 4]
  }

  it('traverses a cycle returning correct distances', () => {
    const result = bfs(cycle, 0)
    expect(result.size).toBe(4)
    expect(result.get(0)!.distance).toBe(0)
    expect(result.get(1)!.distance).toBe(1)
    expect(result.get(3)!.distance).toBe(1)
    expect(result.get(2)!.distance).toBe(2)
  })

  // 星形图: 0→1, 0→2, 0→3
  const star: (n: number) => number[] = (n) => {
    if (n === 0) return [1, 2, 3]
    return []
  }

  it('traverses a star graph from center', () => {
    const result = bfs(star, 0)
    expect(result.size).toBe(4)
    for (let i = 1; i <= 3; i++) {
      expect(result.get(i)!.distance).toBe(1)
      expect(result.get(i)!.parent).toBe(0)
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
    const result = bfs(dag, 0)
    expect(result.get(0)!.distance).toBe(0)
    expect(result.get(1)!.distance).toBe(1)
    expect(result.get(2)!.distance).toBe(1)
    expect(result.get(3)!.distance).toBe(2)
  })

  // 单个节点
  it('handles single node with no neighbors', () => {
    const result = bfs(() => [], 42)
    expect(result.size).toBe(1)
    expect(result.get(42)!.distance).toBe(0)
    expect(result.get(42)!.parent).toBeNull()
  })

  // 孤立节点（从起始节点不可达）
  it('only visits reachable nodes from start', () => {
    const disconnected: (n: number) => number[] = (n) => {
      if (n < 3) return [n + 1]
      return []
    }
    const result = bfs(disconnected, 0)
    // 节点 4 不可达
    expect(result.size).toBe(4)
    expect(result.has(4)).toBe(false)
  })

  // 自环节点
  it('handles self-loop (does not infinite loop)', () => {
    const selfLoop: (n: number) => number[] = () => [0]
    const result = bfs(selfLoop, 0)
    expect(result.size).toBe(1)
    expect(result.get(0)!.distance).toBe(0)
  })
})
