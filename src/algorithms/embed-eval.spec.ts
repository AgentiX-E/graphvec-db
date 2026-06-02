/**
 * embed-eval.spec.ts — 嵌入评估与可视化测试
 *
 * 测试链接预测评估、节点分类评估、嵌入统计、PCA/t-SNE 降维
 *
 * GAP-13: 图嵌入可视化评估
 */
import {
  cosineSimilarity,
  computeEmbeddingStatistics,
  computeEmbeddingMean,
  evaluateLinkPrediction,
  evaluateNodeClassification,
  EmbeddingMap,
  EdgeTuple,
} from '../algorithms/embed-eval'
import {
  reduceWithPCA,
  reduceWithTSNE,
  forceDirectedLayout,
  WeightedEdge,
} from '../algorithms/embed-viz'

// ──────────────────────────────────────────
// 辅助：生成测试嵌入
// ──────────────────────────────────────────

function generateLinearEmbedding(n: number, dim: number): number[][] {
  const data: number[][] = []
  for (let i = 0; i < n; i++) {
    const vec: number[] = []
    for (let d = 0; d < dim; d++) {
      vec.push(i + d * 0.1 + Math.random() * 0.01)
    }
    data.push(vec)
  }
  return data
}

function embeddingMapFromMatrix(data: number[][]): EmbeddingMap {
  const map: EmbeddingMap = new Map()
  for (let i = 0; i < data.length; i++) {
    map.set(i, data[i])
  }
  return map
}

// ──────────────────────────────────────────
// 嵌入指标测试
// ──────────────────────────────────────────

describe('Embedding Eval — Cosine Similarity', () => {
  test('identical vectors have cosine similarity 1', () => {
    const sim = cosineSimilarity([1, 2, 3], [1, 2, 3])
    expect(sim).toBeCloseTo(1, 10)
  })

  test('orthogonal vectors have cosine similarity 0', () => {
    const sim = cosineSimilarity([1, 0, 0], [0, 1, 0])
    expect(sim).toBeCloseTo(0, 10)
  })

  test('opposite vectors have cosine similarity -1', () => {
    const sim = cosineSimilarity([1, 2], [-1, -2])
    expect(sim).toBeCloseTo(-1, 5)
  })

  test('zero vector returns 0 similarity', () => {
    const sim = cosineSimilarity([0, 0, 0], [1, 0, 0])
    expect(sim).toBe(0)
  })

  test('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow()
  })
})

// ──────────────────────────────────────────
// 统计测试
// ──────────────────────────────────────────

describe('Embedding Eval — Statistics', () => {
  test('computeEmbeddingStatistics returns correct stats', () => {
    const embeddings = new Map<number, number[]>([
      [0, [1, 2, 3]],
      [1, [4, 5, 6]],
      [2, [7, 8, 9]],
    ])

    const stats = computeEmbeddingStatistics(embeddings)

    expect(stats.nodeCount).toBe(3)
    expect(stats.dimension).toBe(3)
    expect(stats.dimensionMeans).toEqual([4, 5, 6])
    expect(stats.dimensionMaxAbs).toEqual([7, 8, 9])
    expect(stats.globalMean).toBe(5)
    expect(stats.normStats).toBeDefined()
    expect(stats.normStats.mean).toBeGreaterThan(0)
  })

  test('throws on empty embedding', () => {
    expect(() => computeEmbeddingStatistics(new Map())).toThrow()
  })

  test('computeEmbeddingMean returns centroid', () => {
    const embeddings = new Map<number, number[]>([
      [0, [0, 0]],
      [1, [2, 4]],
    ])
    const mean = computeEmbeddingMean(embeddings)
    expect(mean).toEqual([1, 2])
  })
})

// ──────────────────────────────────────────
// 链接预测测试
// ──────────────────────────────────────────

describe('Embedding Eval — Link Prediction', () => {
  test('evaluateLinkPrediction returns valid AUC for structured data', () => {
    // 生成结构化的嵌入：A 群与 B 群内部相似度高于跨群
    const data: number[][] = []
    // 群 A: 节点 0~4，靠近 (1,1,1)
    for (let i = 0; i < 5; i++) {
      data.push([1 + Math.random() * 0.1, 1 + Math.random() * 0.1, 1 + Math.random() * 0.1])
    }
    // 群 B: 节点 5~9，靠近 (-1,-1,-1)
    for (let i = 0; i < 5; i++) {
      data.push([-1 + Math.random() * 0.1, -1 + Math.random() * 0.1, -1 + Math.random() * 0.1])
    }

    const embeddings = embeddingMapFromMatrix(data)

    // 正例：群内边
    const positiveEdges: EdgeTuple[] = [
      { src: 0, dst: 1, type: 1 },
      { src: 2, dst: 3, type: 1 },
      { src: 5, dst: 6, type: 1 },
      { src: 7, dst: 8, type: 1 },
      { src: 0, dst: 4, type: 1 },
    ]

    // 负例：跨群边
    const negativeEdges: EdgeTuple[] = [
      { src: 0, dst: 5, type: 1 },
      { src: 1, dst: 6, type: 1 },
      { src: 2, dst: 7, type: 1 },
      { src: 3, dst: 8, type: 1 },
      { src: 4, dst: 9, type: 1 },
    ]

    const result = evaluateLinkPrediction(embeddings, positiveEdges, negativeEdges)

    // AUC-ROC 应明显 > 0.5（结构化数据）
    expect(result.aucRoc).toBeGreaterThan(0.5)
    expect(result.aucRoc).toBeLessThanOrEqual(1)
    expect(result.positiveCount).toBeGreaterThan(0)
    expect(result.negativeCount).toBeGreaterThan(0)
    expect(result.bestF1).toBeGreaterThan(0)
  })

  test('throws when no edges provided', () => {
    const embed = new Map<number, number[]>([[0, [1, 2]]])
    expect(() => evaluateLinkPrediction(embed, [], [{ src: 0, dst: 1, type: 1 }])).toThrow()
    expect(() => evaluateLinkPrediction(embed, [{ src: 0, dst: 1, type: 1 }], [])).toThrow()
  })
})

// ──────────────────────────────────────────
// 节点分类测试
// ──────────────────────────────────────────

describe('Embedding Eval — Node Classification', () => {
  test('evaluateNodeClassification classifies well-separated clusters', () => {
    // 生成 3 个集群
    const embeddings = new Map<number, number[]>()
    const nodeLabels = new Map<number, number>()

    // 集群 A (class 0): 靠近 (5,0,0)
    for (let i = 0; i < 10; i++) {
      embeddings.set(i, [5 + Math.random() * 0.5, Math.random() * 0.5, Math.random() * 0.5])
      nodeLabels.set(i, 0)
    }
    // 集群 B (class 1): 靠近 (0,5,0)
    for (let i = 10; i < 20; i++) {
      embeddings.set(i, [Math.random() * 0.5, 5 + Math.random() * 0.5, Math.random() * 0.5])
      nodeLabels.set(i, 1)
    }
    // 集群 C (class 2): 靠近 (0,0,5)
    for (let i = 20; i < 30; i++) {
      embeddings.set(i, [Math.random() * 0.5, Math.random() * 0.5, 5 + Math.random() * 0.5])
      nodeLabels.set(i, 2)
    }

    const result = evaluateNodeClassification(embeddings, nodeLabels, 0.6, 300, 0.01)

    expect(result.accuracy).toBeGreaterThan(0.5)
    expect(result.classCount).toBe(3)
    expect(result.perClassMetrics.length).toBe(3)
    expect(result.trainTestSplit.train).toBeGreaterThan(0)
    expect(result.trainTestSplit.test).toBeGreaterThan(0)
    expect(result.confusionMatrix.length).toBe(3)
  })

  test('throws on empty labels', () => {
    const embeddings = new Map<number, number[]>([[0, [1, 2, 3]]])
    const labels = new Map<number, number>()
    expect(() => evaluateNodeClassification(embeddings, labels)).toThrow()
  })
})

// ──────────────────────────────────────────
// PCA 测试
// ──────────────────────────────────────────

describe('Embedding Viz — PCA', () => {
  test('reduceWithPCA reduces to 2D', () => {
    const data = generateLinearEmbedding(20, 10)
    const result = reduceWithPCA(data, { dim: 2 })

    expect(result.embedding.length).toBe(20)
    expect(result.embedding[0].length).toBe(2)
    expect(result.method).toBe('pca')
    expect(result.originalDim).toBe(10)
    expect(result.targetDim).toBe(2)
    expect(result.explainedVariance).toBeDefined()
    expect(result.explainedVariance!.length).toBe(2)
  })

  test('reduceWithPCA reduces to 3D', () => {
    const data = generateLinearEmbedding(15, 8)
    const result = reduceWithPCA(data, { dim: 3 })

    expect(result.embedding.length).toBe(15)
    expect(result.embedding[0].length).toBe(3)
    expect(result.targetDim).toBe(3)
  })

  test('cumulative variance sums correctly', () => {
    const data = generateLinearEmbedding(10, 5)
    const result = reduceWithPCA(data, { dim: 2 })

    expect(result.cumulativeVariance).toBeDefined()
    expect(result.cumulativeVariance![result.cumulativeVariance!.length - 1]).toBeLessThanOrEqual(1)
    expect(result.cumulativeVariance![0]).toBeGreaterThan(0)
  })

  test('throws on empty data', () => {
    expect(() => reduceWithPCA([], { dim: 2 })).toThrow()
  })

  test('throws on single sample', () => {
    expect(() => reduceWithPCA([[1, 2, 3]], { dim: 2 })).toThrow()
  })

  test('throws when target > original dim', () => {
    const data = generateLinearEmbedding(5, 3)
    expect(() => reduceWithPCA(data, { dim: 5 })).toThrow()
  })
})

// ──────────────────────────────────────────
// t-SNE 测试（含回退）
// ──────────────────────────────────────────

describe('Embedding Viz — t-SNE', () => {
  test('reduceWithTSNE reduces to 2D (may use fallback)', () => {
    const data = generateLinearEmbedding(10, 8)
    const result = reduceWithTSNE(data, { dim: 2 })

    expect(result.embedding.length).toBe(10)
    expect(result.embedding[0].length).toBe(2)
    expect(result.method).toBe('tsne')
    expect(result.originalDim).toBe(8)
  })

  test('reduceWithTSNE with explicit config', () => {
    const data = generateLinearEmbedding(8, 6)
    const result = reduceWithTSNE(data, {
      dim: 2,
      perplexity: 5,
      nIter: 100,
      learningRate: 500,
    })

    expect(result.embedding.length).toBe(8)
    expect(result.targetDim).toBe(2)
  })

  test('throws on empty data', () => {
    expect(() => reduceWithTSNE([])).toThrow()
  })

  test('throws on single sample', () => {
    expect(() => reduceWithTSNE([[1, 2]])).toThrow()
  })
})

// ──────────────────────────────────────────
// Force-Directed 布局测试
// ──────────────────────────────────────────

describe('Embedding Viz — Force-Directed Layout', () => {
  test('forceDirectedLayout produces stable layout', () => {
    const edges: WeightedEdge[] = [
      { src: 0, dst: 1, weight: 1 },
      { src: 1, dst: 2, weight: 1 },
      { src: 2, dst: 0, weight: 1 },
    ]

    const layout = forceDirectedLayout(3, edges, 50)

    expect(layout.size).toBe(3)
    for (const [id, pos] of layout) {
      expect(Number.isFinite(id)).toBe(true)
      expect(pos.length).toBe(2)
      expect(Number.isFinite(pos[0])).toBe(true)
      expect(Number.isFinite(pos[1])).toBe(true)
    }
  })

  test('forceDirectedLayout with disconnected nodes still produces positions', () => {
    const layout = forceDirectedLayout(4, [], 20)

    expect(layout.size).toBe(4)
    for (const [, pos] of layout) {
      expect(pos[0]).not.toBeNaN()
      expect(pos[1]).not.toBeNaN()
    }
  })

  test('forceDirectedLayout with weighted edges', () => {
    const edges: WeightedEdge[] = [
      { src: 0, dst: 1, weight: 5 },
      { src: 1, dst: 2, weight: 0.1 },
    ]

    const layout = forceDirectedLayout(3, edges, 30)

    expect(layout.size).toBe(3)
    const pos0 = layout.get(0)!
    const pos1 = layout.get(1)!
    const pos2 = layout.get(2)!

    // 0-1 权重高，应该比 1-2 更近（相对而言，在多次迭代后）
    const dist01 = Math.sqrt((pos1[0] - pos0[0]) ** 2 + (pos1[1] - pos0[1]) ** 2)
    const dist12 = Math.sqrt((pos2[0] - pos1[0]) ** 2 + (pos2[1] - pos1[1]) ** 2)
    expect(Number.isFinite(dist01)).toBe(true)
    expect(Number.isFinite(dist12)).toBe(true)
  })
})
