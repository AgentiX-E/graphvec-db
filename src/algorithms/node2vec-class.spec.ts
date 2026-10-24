// ============================================================
// node2vec-class.spec.ts — Node2Vec 类测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Node2Vec } from './node2vec-class'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 创建一个模拟 GraphEngine，提供 getNodeIds 和 neighbors 方法。
 */
function createMockEngine(adjacency: Record<number, number[]>): any {
  return {
    getNodeIds: () => Object.keys(adjacency).map(Number),
    neighbors: (nodeId: number) => adjacency[nodeId] ?? [],
    getNode: (id: number) => ({ id, props: {} }),
  }
}

describe('Node2Vec (class-based)', () => {
  // ── 基本训练：小图（5 节点）训练后嵌入不崩溃 ──
  it('should train on a small graph (5 nodes) without crashing', async () => {
    // 线图：0-1-2-3-4
    const adj: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3],
    }

    const engine = createMockEngine(adj)
    const n2v = new Node2Vec({
      dimensions: 8,
      walkLength: 10,
      numWalks: 3,
      epochs: 2,
      negativeSamples: 3,
      seed: 42,
    })

    await n2v.fit(engine)

    const allEmbeddings = n2v.getAllEmbeddings()
    expect(allEmbeddings.size).toBe(5)

    // 所有嵌入值应为有效数字
    for (const [nodeId, vec] of allEmbeddings) {
      expect(vec.length).toBe(8)
      for (let i = 0; i < vec.length; i++) {
        expect(Number.isFinite(vec[i])).toBe(true)
      }
    }
  })

  // ── 嵌入维度正确 ──
  it('should produce embeddings of the correct dimension', async () => {
    const adj: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
    }

    const engine = createMockEngine(adj)
    const n2v = new Node2Vec({
      dimensions: 64,
      walkLength: 10,
      numWalks: 2,
      epochs: 1,
      seed: 42,
    })

    await n2v.fit(engine)

    const emb = n2v.getEmbedding(0)
    expect(emb).not.toBeNull()
    expect(emb!.length).toBe(64)
  })

  // ── 相似节点有更近的嵌入 ──
  it('should produce closer embeddings for structurally similar nodes', async () => {
    // 两个对称子图
    // 子图 A: 0-1-2  子图 B: 3-4-5
    const adj: Record<number, number[]> = {
      0: [1],
      1: [0, 2],
      2: [1],
      3: [4],
      4: [3, 5],
      5: [4],
    }

    const engine = createMockEngine(adj)
    const n2v = new Node2Vec({
      dimensions: 16,
      walkLength: 20,
      numWalks: 5,
      epochs: 3,
      seed: 42,
    })

    await n2v.fit(engine)

    // 节点 0 和节点 3 都是链式端点，嵌入应具正相似性
    const emb0 = n2v.getEmbedding(0)!
    const emb3 = n2v.getEmbedding(3)!

    // 计算余弦相似度
    const cosSim = cosineSimilarity(emb0, emb3)
    expect(cosSim).toBeGreaterThan(0)
  })

  // ── 保存/加载 ──
  it('should save and load embeddings correctly', async () => {
    const tmpFile = `/tmp/node2vec-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`

    try {
      const adj: Record<number, number[]> = {
        0: [1],
        1: [0, 2],
        2: [1],
      }

      const engine = createMockEngine(adj)
      const n2v = new Node2Vec({
        dimensions: 8,
        walkLength: 10,
        numWalks: 2,
        epochs: 1,
        seed: 42,
      })

      await n2v.fit(engine)

      const emb0Before = n2v.getEmbedding(0)!
      expect(emb0Before).not.toBeNull()

      // 保存
      n2v.save(tmpFile)
      expect(fs.existsSync(tmpFile)).toBe(true)

      // 重新加载到新实例
      const n2v2 = new Node2Vec({ dimensions: 8 })
      n2v2.load(tmpFile)

      const emb0After = n2v2.getEmbedding(0)!
      expect(emb0After).not.toBeNull()
      expect(emb0After.length).toBe(8)

      // 验证数值一致性
      for (let i = 0; i < emb0Before.length; i++) {
        expect(emb0Before[i]).toBeCloseTo(emb0After[i], 5)
      }

      // 验证 getAllEmbeddings
      const allAfter = n2v2.getAllEmbeddings()
      expect(allAfter.size).toBe(3)
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  })

  // ── getEmbedding 不存在的节点 → null ──
  it('should return null for non-existent node', async () => {
    const adj: Record<number, number[]> = {
      0: [1],
      1: [0],
    }

    const engine = createMockEngine(adj)
    const n2v = new Node2Vec({
      dimensions: 4,
      walkLength: 5,
      numWalks: 2,
      epochs: 1,
      seed: 42,
    })

    await n2v.fit(engine)

    const emb = n2v.getEmbedding(999)
    expect(emb).toBeNull()
  })

  // ── 空图训练 → 空嵌入映射 ──
  it('should return empty embeddings for empty graph', async () => {
    const engine = createMockEngine({})
    const n2v = new Node2Vec({
      dimensions: 8,
      walkLength: 10,
      numWalks: 2,
      epochs: 1,
      seed: 42,
    })

    await n2v.fit(engine)

    const allEmbeddings = n2v.getAllEmbeddings()
    expect(allEmbeddings.size).toBe(0)

    const emb = n2v.getEmbedding(0)
    expect(emb).toBeNull()
  })

  // ── 隔离节点（无边）训练不崩溃 ──
  it('should handle isolated nodes without crashing', async () => {
    // 3 个孤立节点
    const adj: Record<number, number[]> = {
      0: [],
      1: [],
      2: [],
    }

    const engine = createMockEngine(adj)
    const n2v = new Node2Vec({
      dimensions: 4,
      walkLength: 5,
      numWalks: 2,
      epochs: 1,
      seed: 42,
    })

    await n2v.fit(engine)

    const allEmbeddings = n2v.getAllEmbeddings()
    expect(allEmbeddings.size).toBe(3)

    // 所有嵌入都应包含有效数值
    for (const [, vec] of allEmbeddings) {
      for (let i = 0; i < vec.length; i++) {
        expect(Number.isFinite(vec[i])).toBe(true)
      }
    }
  })

  // ── 非默认 p/q 偏置参数训练不崩溃并产生有效嵌入 ──
  it('trains with non-default p/q bias parameters without crashing', async () => {
    // Triangle graph (0-1-2-0) guarantees backtracking opportunities so the
    // p (return) and q (in/out) branches of _biasedRandomWalk are exercised.
    const adj: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1],
    }

    const engine = createMockEngine(adj)
    const n2v = new Node2Vec({
      dimensions: 6,
      walkLength: 30,
      numWalks: 4,
      epochs: 1,
      seed: 7,
      p: 2.0,   // high p discourages backtracking
      q: 0.5,   // low q encourages outward exploration
    })

    await n2v.fit(engine)

    const all = n2v.getAllEmbeddings()
    expect(all.size).toBe(3)
    for (const [, vec] of all) {
      expect(vec.length).toBe(6)
      for (let i = 0; i < vec.length; i++) {
        expect(Number.isFinite(vec[i])).toBe(true)
      }
    }
  })

  // ── getAllNodeIds fallback: engine.nodes Map ──
  it('falls back to engine.nodes map when getNodeIds is unavailable', async () => {
    const engine: any = {
      nodes: new Map([[0, { id: 0 }], [1, { id: 1 }]]),
      neighbors: (id: number) => (id === 0 ? [1] : [0]),
      getNode: (id: number) => ({ id, props: {} }),
    }
    const n2v = new Node2Vec({ dimensions: 4, walkLength: 5, numWalks: 2, epochs: 1, seed: 42 })
    await n2v.fit(engine)
    expect(n2v.getAllEmbeddings().size).toBe(2)
  })

  // ── _getNeighbors fallback: neighbors returns object array ──
  it('handles neighbors() returning node objects with nodeId', async () => {
    const engine: any = {
      getNodeIds: () => [0, 1],
      neighbors: (id: number) => (id === 0 ? [{ nodeId: 1, props: {} }] : [{ nodeId: 0, props: {} }]),
      getNode: (id: number) => ({ id, props: {} }),
    }
    const n2v = new Node2Vec({ dimensions: 4, walkLength: 5, numWalks: 2, epochs: 1, seed: 42 })
    await n2v.fit(engine)
    expect(n2v.getAllEmbeddings().size).toBe(2)
  })

  // ── _getNeighbors fallback: getNeighbors returns array ──
  it('handles getNeighbors() returning a plain array', async () => {
    const engine: any = {
      getNodeIds: () => [0, 1],
      getNeighbors: (id: number) => (id === 0 ? [1] : [0]),
      getNode: (id: number) => ({ id, props: {} }),
    }
    const n2v = new Node2Vec({ dimensions: 4, walkLength: 5, numWalks: 2, epochs: 1, seed: 42 })
    await n2v.fit(engine)
    expect(n2v.getAllEmbeddings().size).toBe(2)
  })

  // ── getAllNodeIds fallback: storage.getAllNodeIds ──
  it('reads node ids via storage.getAllNodeIds fallback', async () => {
    const engine: any = {
      storage: { getAllNodeIds: () => [0, 1] },
      neighbors: (id: number) => (id === 0 ? [1] : [0]),
      getNode: (id: number) => ({ id, props: {} }),
    }
    const n2v = new Node2Vec({ dimensions: 4, walkLength: 5, numWalks: 2, epochs: 1, seed: 42 })
    await n2v.fit(engine)
    expect(n2v.getAllEmbeddings().size).toBe(2)
  })

  // ── getAllNodeIds fallback: getAllNodeIds method ──
  it('reads node ids via getAllNodeIds method fallback', async () => {
    const engine: any = {
      getAllNodeIds: () => [0, 1, 2],
      neighbors: (id: number) => [1, 2].filter((n) => n !== id),
      getNode: (id: number) => ({ id, props: {} }),
    }
    const n2v = new Node2Vec({ dimensions: 4, walkLength: 5, numWalks: 2, epochs: 1, seed: 42 })
    await n2v.fit(engine)
    expect(n2v.getAllEmbeddings().size).toBe(3)
  })

  // ── load 不存在的文件 → 抛错 ──
  it('load throws when the embedding file does not exist', () => {
    const n2v = new Node2Vec({ dimensions: 4 })
    const missingPath = `/tmp/node2vec-missing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    expect(() => n2v.load(missingPath)).toThrow(/not found/)
  })
})

/**
 * 计算两个 Float32Array 的余弦相似度。
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
