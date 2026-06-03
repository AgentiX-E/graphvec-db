/**
 * pagerank-stream.spec.ts — Streaming PageRank 单元测试
 *
 * 测试 AsyncIterable 分批输入模式。
 * 使用简化图确保流式结果与单次结果近似。
 */
import { describe, it, expect } from 'vitest'
import { pagerankStream } from './pagerank-stream'
import { pagerank } from './pagerank'

/** 将数组包装为 AsyncIterable */
function toAsyncIterable<T>(arr: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0
      return {
        next: async () => {
          if (i >= arr.length) return { done: true as const, value: undefined as any }
          return { done: false as const, value: arr[i++] }
        },
      }
    },
  }
}

describe('pagerankStream', () => {
  // 线性图: 0→1→2→3
  const linear = (n: number): number[] => {
    if (n >= 3) return []
    return [n + 1]
  }
  const linearRecords = [
    { id: 0, type: 1, name: '', props: {} },
    { id: 1, type: 1, name: '', props: {} },
    { id: 2, type: 1, name: '', props: {} },
    { id: 3, type: 1, name: '', props: {} },
  ]

  it('stream result matches single-thread result for linear graph', async () => {
    const streamResult = await pagerankStream(
      linear,
      toAsyncIterable([linearRecords]),
    )
    const singleResult = pagerank(linear, [0, 1, 2, 3]) as Map<number, number>

    expect(streamResult.size).toBe(4)
    for (const id of [0, 1, 2, 3]) {
      expect(streamResult.get(id)!).toBeCloseTo(singleResult.get(id)!, 2)
    }
  })

  // 强连通分量
  const scc = (n: number): number[] => [(n + 1) % 3]
  const sccRecords = [
    { id: 0, type: 1, name: '', props: {} },
    { id: 1, type: 1, name: '', props: {} },
    { id: 2, type: 1, name: '', props: {} },
  ]

  it('matches dense graph result', async () => {
    const streamResult = await pagerankStream(
      scc,
      toAsyncIterable([sccRecords]),
    )
    const singleResult = pagerank(scc, [0, 1, 2]) as Map<number, number>

    expect(streamResult.size).toBe(3)
    for (const id of [0, 1, 2]) {
      expect(streamResult.get(id)!).toBeCloseTo(singleResult.get(id)!, 2)
    }
  })

  // 分批输入
  it('handles multi-batch input', async () => {
    const batch1 = [linearRecords[0], linearRecords[1]]
    const batch2 = [linearRecords[2], linearRecords[3]]

    const streamResult = await pagerankStream(
      linear,
      toAsyncIterable([batch1, batch2]),
    )
    const singleResult = pagerank(linear, [0, 1, 2, 3]) as Map<number, number>

    for (const id of [0, 1, 2, 3]) {
      expect(streamResult.get(id)!).toBeCloseTo(singleResult.get(id)!, 1)
    }
  })

  // 空输入
  it('returns empty map for empty input', async () => {
    const result = await pagerankStream(linear, toAsyncIterable([]))
    expect(result.size).toBe(0)
  })

  // 单节点
  it('handles single node batch', async () => {
    const result = await pagerankStream(
      () => [],
      toAsyncIterable([[{ id: 42, type: 1, name: '', props: {} }]]),
    )
    expect(result.size).toBe(1)
    expect(result.get(42)!).toBeCloseTo(1, 2)
  })

  // 自定义选项
  it('supports custom damping factor', async () => {
    const result = await pagerankStream(
      linear,
      toAsyncIterable([linearRecords]),
      { dampingFactor: 0.9, localIterations: 10 },
    )
    const sum = Array.from(result.values()).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 2)
  })
})
