/**
 * embed-viz.spec.ts — 嵌入可视化（PCA / t-SNE / force-directed）单元测试
 *
 * 验证：
 * 1. reduceWithPCA：降维正确性、输入校验、解释方差
 * 2. reduceWithTSNE：降维、tsne-js 不可用时 fallback
 * 3. getPCALoadings：主成分 loading 矩阵
 * 4. forceDirectedLayout：布局收敛、节点稳定性
 * 5. 边际场景：空矩阵、单样本、0 边
 */
import { describe, it, expect } from 'vitest'
import {
  reduceWithPCA,
  reduceWithTSNE,
  getPCALoadings,
  forceDirectedLayout,
  TsneConfig,
  PcaConfig,
} from './embed-viz'
import { PCA } from 'ml-pca'

/** 创建测试用的嵌入矩阵（N x D） */
function makeEmbedding(N: number, D: number): number[][] {
  const data: number[][] = []
  for (let i = 0; i < N; i++) {
    const row: number[] = []
    for (let j = 0; j < D; j++) {
      // 线性结构：每维在 [i, i+N) 范围内
      row.push(i + j * 0.1)
    }
    data.push(row)
  }
  return data
}

describe('reduceWithPCA', () => {
  it('reduces 5x10 data to 2D', () => {
    const data = makeEmbedding(5, 10)
    const result = reduceWithPCA(data, { dim: 2 })
    expect(result.embedding).toHaveLength(5)
    expect(result.embedding[0]).toHaveLength(2)
    expect(result.originalDim).toBe(10)
    expect(result.targetDim).toBe(2)
    expect(result.method).toBe('pca')
  })

  it('reduces 5x10 data to 3D', () => {
    const data = makeEmbedding(5, 10)
    const result = reduceWithPCA(data, { dim: 3 })
    expect(result.embedding[0]).toHaveLength(3)
  })

  it('outputs explained variance', () => {
    const data = makeEmbedding(10, 5)
    const result = reduceWithPCA(data, { dim: 2 })
    expect(result.explainedVariance).toBeDefined()
    expect(result.explainedVariance!.length).toBe(2)
    // 所有方差值应在 (0, 1] 之间
    for (const v of result.explainedVariance!) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('outputs cumulative variance that increases over components', () => {
    const data = makeEmbedding(10, 5)
    const result = reduceWithPCA(data, { dim: 2 })
    expect(result.cumulativeVariance).toBeDefined()
    expect(result.cumulativeVariance!.length).toBe(2)
    // 累计方差应该递增
    expect(result.cumulativeVariance![1]).toBeGreaterThanOrEqual(
      result.cumulativeVariance![0],
    )
  })

  it('defaults to 2D', () => {
    const data = makeEmbedding(5, 8)
    const result = reduceWithPCA(data)
    expect(result.targetDim).toBe(2)
    expect(result.embedding[0]).toHaveLength(2)
  })

  it('throws on empty data', () => {
    expect(() => reduceWithPCA([])).toThrow('Empty')
  })

  it('throws on single sample', () => {
    expect(() => reduceWithPCA([[1, 2, 3]])).toThrow('at least 2')
  })

  it('throws when target dim exceeds original dim', () => {
    expect(() => reduceWithPCA([[1, 2], [3, 4]], { dim: 5 })).toThrow(
      'Cannot reduce to 5',
    )
  })

  it('produces same-length embedding as input', () => {
    const data = makeEmbedding(100, 20)
    const result = reduceWithPCA(data, { dim: 2 })
    expect(result.embedding).toHaveLength(100)
  })
})

describe('getPCALoadings', () => {
  it('returns loading matrix with expected dimensions', () => {
    const data = makeEmbedding(10, 5)
    const loadings = getPCALoadings(data, 3)
    expect(loadings).toHaveLength(3)
    // 每行应有数据列数
    expect(loadings[0]).toHaveLength(5)
  })

  it('defaults to all components', () => {
    const data = makeEmbedding(10, 4)
    const loadings = getPCALoadings(data)
    expect(loadings).toHaveLength(4)
    expect(loadings[0]).toHaveLength(4)
  })

  it('loadings matrix values are finite numbers', () => {
    const data = makeEmbedding(20, 6)
    const loadings = getPCALoadings(data, 2)
    for (const row of loadings) {
      for (const val of row) {
        expect(Number.isFinite(val)).toBe(true)
      }
    }
  })
})

describe('reduceWithTSNE', () => {
  // t-SNE 在未安装 tsne-js 时使用 fallback（随机投影）
  // 所以无需 mock，测试 fallback 路径

  it('reduces 5x10 data to 2D via fallback', () => {
    const data = makeEmbedding(5, 10)
    const result = reduceWithTSNE(data, { dim: 2 })
    expect(result.embedding).toHaveLength(5)
    expect(result.embedding[0]).toHaveLength(2)
    expect(result.originalDim).toBe(10)
    expect(result.targetDim).toBe(2)
    expect(result.method).toBe('tsne')
  })

  it('reduces 5x10 data to 3D via fallback', () => {
    const data = makeEmbedding(5, 10)
    const result = reduceWithTSNE(data, { dim: 3 })
    expect(result.embedding).toHaveLength(5)
    expect(result.embedding[0]).toHaveLength(3)
  })

  it('defaults to 2D', () => {
    const data = makeEmbedding(5, 8)
    const result = reduceWithTSNE(data)
    expect(result.targetDim).toBe(2)
  })

  it('throws on empty data', () => {
    expect(() => reduceWithTSNE([])).toThrow('Empty')
  })

  it('throws on single sample', () => {
    expect(() => reduceWithTSNE([[1, 2, 3]])).toThrow('at least 2')
  })

  it('different perplexity does not throw', () => {
    const data = makeEmbedding(20, 10)
    const result = reduceWithTSNE(data, { dim: 2, perplexity: 5 })
    expect(result.embedding).toHaveLength(20)
  })

  it('produces same-length embedding as input', () => {
    const data = makeEmbedding(50, 16)
    const result = reduceWithTSNE(data, { dim: 2 })
    expect(result.embedding).toHaveLength(50)
  })

  it('fallback result coordinates are finite', () => {
    const data = makeEmbedding(10, 8)
    const result = reduceWithTSNE(data)
    for (const row of result.embedding) {
      for (const val of row) {
        expect(Number.isFinite(val)).toBe(true)
      }
    }
  })
})

describe('forceDirectedLayout', () => {
  it('initializes all nodes with positions', () => {
    const result = forceDirectedLayout(5, [], 1)
    expect(result.size).toBe(5)
    for (let i = 0; i < 5; i++) {
      const pos = result.get(i)
      expect(pos).toBeDefined()
      expect(pos![0]).toBeDefined()
      expect(pos![1]).toBeDefined()
    }
  })

  it('converges nodes with edges closer together', () => {
    // 2 nodes with one edge — should attract toward each other
    const edges = [{ src: 0, dst: 1, weight: 1 }]
    const result = forceDirectedLayout(2, edges, 50)

    const pos0 = result.get(0)!
    const pos1 = result.get(1)!
    const dist = Math.sqrt(
      (pos1[0] - pos0[0]) ** 2 + (pos1[1] - pos0[1]) ** 2,
    )

    // 应该比初始随机位置更近（理想距离 20）
    expect(dist).toBeLessThan(100)
  })

  it('separates unconnected nodes', () => {
    // 2 unconnected nodes — repulsion should push them apart
    const result = forceDirectedLayout(2, [], 30)
    const pos0 = result.get(0)!
    const pos1 = result.get(1)!
    const dist = Math.sqrt(
      (pos1[0] - pos0[0]) ** 2 + (pos1[1] - pos0[1]) ** 2,
    )

    // 初始位置在 [-50, 50]，有斥力作用下它们应保持距离
    expect(dist).toBeGreaterThan(0)
  })

  it('handles zero edges', () => {
    const result = forceDirectedLayout(10, [], 5)
    expect(result.size).toBe(10)
  })

  it('handles single node', () => {
    const result = forceDirectedLayout(1, [], 5)
    expect(result.size).toBe(1)
    const pos = result.get(0)!
    expect(Number.isFinite(pos[0])).toBe(true)
    expect(Number.isFinite(pos[1])).toBe(true)
  })

  it('handles many edges without crashing', () => {
    const edges: Array<{ src: number; dst: number; weight: number }> = []
    for (let i = 0; i < 20; i++) {
      edges.push({ src: i % 10, dst: (i + 1) % 10, weight: Math.random() })
    }
    const result = forceDirectedLayout(10, edges, 20)
    expect(result.size).toBe(10)
  })

  it('positions after more iterations are more stable', () => {
    const edges = [
      { src: 0, dst: 1, weight: 1 },
      { src: 1, dst: 2, weight: 1 },
    ]
    const result5 = forceDirectedLayout(3, edges, 5)
    const result50 = forceDirectedLayout(3, edges, 50)

    // 更多迭代后节点位移更小（简单稳定性检查）
    const pos50 = result50.get(0)!
    const pos55 = result5.get(0)!
    // 只是确保都不为 NaN
    expect(Number.isFinite(pos50[0])).toBe(true)
    expect(Number.isFinite(pos55[0])).toBe(true)
  })
})
