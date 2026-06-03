/**
 * bfs-stream.spec.ts — Streaming BFS 单元测试
 *
 * 测试 bfsStream() AsyncIterable 分批输入模式。
 */
import { describe, it, expect } from 'vitest'
import { bfsStream } from './bfs-stream'

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

describe('bfsStream', () => {
  // 线性图并记录所有节点
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

  it('traverses a linear graph', async () => {
    const result = await bfsStream(
      linear,
      0,
      toAsyncIterable([linearRecords]),
    )
    expect(result.size).toBe(4)
    expect(result.get(0)!.distance).toBe(0)
    expect(result.get(1)!.distance).toBe(1)
    expect(result.get(2)!.distance).toBe(2)
    expect(result.get(3)!.distance).toBe(3)
  })

  // 星形入边: 0是中心
  const star = (n: number): number[] => {
    if (n === 0) return [1, 2, 3]
    return []
  }
  const starRecords = [
    { id: 0, type: 1, name: '', props: {} },
    { id: 1, type: 1, name: '', props: {} },
    { id: 2, type: 1, name: '', props: {} },
    { id: 3, type: 1, name: '', props: {} },
  ]

  it('traverses a star graph from center', async () => {
    const result = await bfsStream(
      star,
      0,
      toAsyncIterable([starRecords]),
    )
    expect(result.size).toBe(4)
    expect(result.get(0)!.distance).toBe(0)
    for (let i = 1; i <= 3; i++) {
      expect(result.get(i)!.distance).toBe(1)
    }
  })

  // 分批输入节点
  it('handles multi-batch input', async () => {
    const batch1 = [linearRecords[0], linearRecords[1]]
    const batch2 = [linearRecords[2], linearRecords[3]]

    const result = await bfsStream(
      linear,
      0,
      toAsyncIterable([batch1, batch2]),
    )
    expect(result.size).toBe(4)
    expect(result.get(3)!.distance).toBe(3)
  })

  // 空输入
  it('visits only start node with no batches', async () => {
    const result = await bfsStream(linear, 0, toAsyncIterable([]))
    expect(result.size).toBe(1)
    expect(result.get(0)!.distance).toBe(0)
  })

  // 单节点
  it('handles single node graph', async () => {
    const result = await bfsStream(
      () => [],
      42,
      toAsyncIterable([[{ id: 42, type: 1, name: '', props: {} }]]),
    )
    expect(result.size).toBe(1)
    expect(result.get(42)!.distance).toBe(0)
  })

  // 自定义 batchSize
  it('supports custom maxBatchSize', async () => {
    const result = await bfsStream(
      linear,
      0,
      toAsyncIterable([linearRecords]),
      { maxBatchSize: 2 },
    )
    expect(result.size).toBe(4)
  })
})
