/**
 * embed-viz.ts — 嵌入可视化（t-SNE / PCA）
 *
 * 提供 t-SNE 和 PCA 降维方法，将高维嵌入向量降至 2D/3D
 * 用于可视化。
 *
 * GAP-13: 图嵌入可视化评估
 */

// 导入 PCA
// ml-pca 提供 ES module
// tsne-js 通过 import TSNE from 'tsne-js'

import { PCA } from 'ml-pca'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

/** t-SNE 配置 */
export interface TsneConfig {
  /** 降维目标维度 (2 或 3) */
  dim?: number
  /** 困惑度 (5~50) */
  perplexity?: number
  /** 学习率 */
  learningRate?: number
  /** 迭代次数 */
  nIter?: number
  /** 早期夸张系数 */
  earlyExaggeration?: number
}

/** PCA 配置 */
export interface PcaConfig {
  /** 降维目标维度 (默认 2) */
  dim?: number
  /** 是否中心化数据 */
  center?: boolean
  /** 是否缩放数据 */
  scale?: boolean
}

/** 降维结果 */
export interface ReductionResult {
  /** 降维后的坐标 (N x dim) */
  embedding: number[][]
  /** 原始嵌入维度 */
  originalDim: number
  /** 目标维度 */
  targetDim: number
  /** 降维方法 */
  method: 'tsne' | 'pca'
  /** 解释方差比例（仅 PCA） */
  explainedVariance?: number[]
  /** 累计解释方差比例（仅 PCA） */
  cumulativeVariance?: number[]
}

/** 加权边，用于 force-direct */
export interface WeightedEdge {
  src: number
  dst: number
  weight: number
}

// ──────────────────────────────────────────
// PCA 降维
// ──────────────────────────────────────────

/**
 * 使用 PCA 将嵌入向量降维到指定维度
 *
 * @param data N x D 原始嵌入矩阵（N 个节点，D 维）
 * @param config PCA 配置
 * @returns 降维结果
 */
export function reduceWithPCA(data: number[][], config: PcaConfig = {}): ReductionResult {
  const dim = config.dim || 2
  const originalDim = data[0]?.length || 0

  if (data.length === 0) {
    throw new Error('Empty data matrix')
  }

  if (data.length < 2) {
    throw new Error('Need at least 2 samples for PCA')
  }

  if (originalDim < dim) {
    throw new Error(`Cannot reduce to ${dim} dimensions from ${originalDim} original dimensions`)
  }

  // 使用 ml-pca
  const pca = new PCA(data, {
    center: config.center !== false,
    scale: config.scale === true,
  })

  // 获取降维结果
  const predicted = pca.predict(data, { nComponents: dim })
  const embedding: number[][] = predicted.to2DArray()

  // 解释方差
  const explainedVariance = pca.getExplainedVariance()
  const cumulativeVariance: number[] = []
  let cumSum = 0
  for (const v of explainedVariance) {
    cumSum += v
    cumulativeVariance.push(cumSum)
  }

  return {
    embedding,
    originalDim,
    targetDim: dim,
    method: 'pca',
    explainedVariance: explainedVariance.slice(0, dim),
    cumulativeVariance: cumulativeVariance.slice(0, dim),
  }
}

/**
 * 计算 PCA 并返回各主成分（loadings）
 * 可用于理解哪些原始维度最重要。
 */
export function getPCALoadings(data: number[][], nComponents?: number): number[][] {
  const pca = new PCA(data, { center: true })
  return pca.getLoadings().to2DArray().slice(0, nComponents || data[0].length)
}

// ──────────────────────────────────────────
// t-SNE 降维
// ──────────────────────────────────────────

/**
 * 使用 t-SNE 将嵌入向量降维到指定维度
 *
 * @param data N x D 原始嵌入矩阵
 * @param config t-SNE 配置
 * @returns 降维结果
 */
export function reduceWithTSNE(data: number[][], config: TsneConfig = {}): ReductionResult {
  if (data.length === 0) {
    throw new Error('Empty data matrix')
  }

  if (data.length < 2) {
    throw new Error('Need at least 2 samples for t-SNE')
  }

  const dim = config.dim || 2
  const originalDim = data[0]?.length || 0

  // 尝试使用 tsne-js
  try {
    const TSNE = require('tsne-js')
    const model = new TSNE({
      dim,
      perplexity: Math.min(config.perplexity || 30, data.length - 1),
      learningRate: config.learningRate || 1000,
      nIter: config.nIter || 1000,
      earlyExaggeration: config.earlyExaggeration || 4.0,
    })

    // tsne-js 需要特定格式
    model.init({ data, type: 'dense' })
    const [error] = model.run()
    const result = model.getOutputScaled()

    return {
      embedding: result,
      originalDim,
      targetDim: dim,
      method: 'tsne',
    }
  } catch (err) {
    // tsne-js 可能在某些环境中不可用，提供回退方案
    console.warn('tsne-js not available or failed, using random projection as fallback.')
    return fallbackTSNE(data, dim, originalDim)
  }
}

/**
 * t-SNE 的回退方案：随机投影
 */
function fallbackTSNE(data: number[][], dim: number, originalDim: number): ReductionResult {
  const n = data.length

  // 生成随机投影矩阵 D x dim
  const projection: number[][] = []
  for (let d = 0; d < originalDim; d++) {
    const row: number[] = []
    for (let d2 = 0; d2 < dim; d2++) {
      // Box-Muller 变换生成正态分布
      let u = 0; let v = 0
      while (u === 0) u = Math.random()
      while (v === 0) v = Math.random()
      row.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))
    }
    projection.push(row)
  }

  // 矩阵乘法: result = data × projection
  const embedding: number[][] = []
  for (let i = 0; i < n; i++) {
    const row: number[] = []
    for (let d2 = 0; d2 < dim; d2++) {
      let val = 0
      for (let d = 0; d < originalDim; d++) {
        val += data[i][d] * projection[d][d2]
      }
      row.push(val)
    }
    embedding.push(row)
  }

  return {
    embedding,
    originalDim,
    targetDim: dim,
    method: 'tsne',
  }
}

// ──────────────────────────────────────────
// Force-Directed 可视化布局
// ──────────────────────────────────────────

/**
 * 基于力的布局（Force-Directed Layout）
 * 使用边Info计算 2D 布局。
 *
 * 适用于不需要降维、而是利用图拓扑结构的场景。
 *
 * @param nodeCount 节点数量
 * @param edges 加权边列表
 * @param iterations 迭代次数
 * @returns 2D 坐标 { nodeId → [x, y] }
 */
export function forceDirectedLayout(
  nodeCount: number,
  edges: WeightedEdge[],
  iterations: number = 100,
  rng: () => number = Math.random,
): Map<number, [number, number]> {
  // 初始化随机位置
  const positions = new Map<number, [number, number]>()
  const velocities = new Map<number, [number, number]>()

  for (let i = 0; i < nodeCount; i++) {
    positions.set(i, [rng() * 100 - 50, rng() * 100 - 50])
    velocities.set(i, [0, 0])
  }

  const idealLength = 20
  const repulsionStrength = 5000
  const attractionStrength = 0.1
  const damping = 0.9

  for (let iter = 0; iter < iterations; iter++) {
    // 斥力（所有节点对）
    const forces = new Map<number, [number, number]>()
    for (let i = 0; i < nodeCount; i++) {
      forces.set(i, [0, 0])
    }

    for (let i = 0; i < nodeCount; i++) {
      const posI = positions.get(i)!
      for (let j = i + 1; j < nodeCount; j++) {
        const posJ = positions.get(j)!
        const dx = posJ[0] - posI[0]
        const dy = posJ[1] - posI[1]
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = repulsionStrength / (dist * dist)

        const fx = (dx / dist) * force
        const fy = (dy / dist) * force

        forces.get(i)![0] -= fx
        forces.get(i)![1] -= fy
        forces.get(j)![0] += fx
        forces.get(j)![1] += fy
      }
    }

    // 引力（边连接的节点）
    for (const edge of edges) {
      const posSrc = positions.get(edge.src)
      const posDst = positions.get(edge.dst)
      if (!posSrc || !posDst) continue

      const dx = posDst[0] - posSrc[0]
      const dy = posDst[1] - posSrc[1]
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const displacement = dist - idealLength
      const force = displacement * attractionStrength * (edge.weight || 1)

      const fx = (dx / dist) * force
      const fy = (dy / dist) * force

      forces.get(edge.src)![0] += fx
      forces.get(edge.src)![1] += fy
      forces.get(edge.dst)![0] -= fx
      forces.get(edge.dst)![1] -= fy
    }

    // 更新位置
    for (let i = 0; i < nodeCount; i++) {
      const vel = velocities.get(i)!
      const force = forces.get(i)!
      vel[0] = (vel[0] + force[0]) * damping
      vel[1] = (vel[1] + force[1]) * damping
      const pos = positions.get(i)!
      pos[0] += vel[0]
      pos[1] += vel[1]
    }
  }

  return positions
}
