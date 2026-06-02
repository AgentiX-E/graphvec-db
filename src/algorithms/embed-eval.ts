/**
 * embed-eval.ts — 嵌入质量评估
 *
 * 提供图嵌入（Node2Vec 等）的链接预测评估、节点分类评估、以及
 * 嵌入统计指标（分布、方差、维度重要度）。
 *
 * GAP-13: 图嵌入可视化评估
 */

// ──────────────────────────────────────────
// 嵌入指标（Embedding & Metrics）
// ──────────────────────────────────────────

/** 嵌入向量字典：nodeId → 向量 */
export type EmbeddingMap = Map<number, number[]>

/** 边 (src, dst, type) */
export interface EdgeTuple {
  src: number
  dst: number
  type: number
}

/** 链接预测评估结果 */
export interface LinkPredictionResult {
  /** AUC-ROC 分数 */
  aucRoc: number
  /** 平均精确率 */
  averagePrecision: number
  /** 正例数 */
  positiveCount: number
  /** 负例数 */
  negativeCount: number
  /** 正例分数统计 */
  positiveScores: { mean: number; std: number; min: number; max: number }
  /** 负例分数统计 */
  negativeScores: { mean: number; std: number; min: number; max: number }
  /** 阈值（最大化 F1） */
  bestThreshold: number
  /** 最佳阈值的 F1 分数 */
  bestF1: number
}

/** 节点分类评估结果 */
export interface NodeClassificationResult {
  /** 准确率 */
  accuracy: number
  /** 精确率（宏平均） */
  precisionMacro: number
  /** 召回率（宏平均） */
  recallMacro: number
  /** F1 分数（宏平均） */
  f1Macro: number
  /** 类别数量 */
  classCount: number
  /** 混淆矩阵 (N x N) */
  confusionMatrix: number[][]
  /** 每个类别的精确率/召回率/F1 */
  perClassMetrics: Array<{
    classLabel: number
    precision: number
    recall: number
    f1: number
    support: number
  }>
  /** 训练集 vs 测试集划分比 */
  trainTestSplit: { train: number; test: number }
}

/** 嵌入统计算法 */
export interface EmbeddingStatistics {
  /** 节点数 */
  nodeCount: number
  /** 嵌入维度 */
  dimension: number
  /** 每个维度的均值 */
  dimensionMeans: number[]
  /** 每个维度的方差 */
  dimensionVariances: number[]
  /** 每个维度的最大绝对值 */
  dimensionMaxAbs: number[]
  /** 全局均值 */
  globalMean: number
  /** 全局标准差 */
  globalStd: number
  /** 稀疏度（零值比例） */
  sparsity: number
  /** 嵌入向量 l2 范数统计 */
  normStats: { mean: number; std: number; min: number; max: number }
}

/** 余弦相似度结果 */
export interface CosineSimilarityResult {
  nodeA: number
  nodeB: number
  similarity: number
}

// ──────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dotProduct / denom
}

/**
 * 计算嵌入矩阵的余弦相似度矩阵 (N x N)
 */
export function cosineSimilarityMatrix(embeddings: Float64Array, dim: number): Float64Array {
  const n = embeddings.length / dim
  const result = new Float64Array(n * n)

  for (let i = 0; i < n; i++) {
    const vecI = embeddings.subarray(i * dim, (i + 1) * dim)
    result[i * n + i] = 1 // self-similarity
    for (let j = i + 1; j < n; j++) {
      const vecJ = embeddings.subarray(j * dim, (j + 1) * dim)
      let dot = 0
      let normI = 0
      let normJ = 0
      for (let k = 0; k < dim; k++) {
        dot += vecI[k] * vecJ[k]
        normI += vecI[k] * vecI[k]
        normJ += vecJ[k] * vecJ[k]
      }
      const sim = dot / (Math.sqrt(normI) * Math.sqrt(normJ) || 1)
      result[i * n + j] = sim
      result[j * n + i] = sim
    }
  }
  return result
}

// ──────────────────────────────────────────
// 链接预测评估
// ──────────────────────────────────────────

/**
 * 嵌入的链接预测评估
 *
 * 对每条边计算 src/dst 向量的余弦或点积相似度作为分数，
 * 与随机负采样边进行对比，计算 AUC-ROC。
 *
 * @param embeddings 嵌入向量映射 { nodeId → vector }
 * @param positiveEdges 真实存在的边
 * @param negativeEdges 负采样边（不存在的边）
 * @returns 链接预测评估结果
 */
export function evaluateLinkPrediction(
  embeddings: EmbeddingMap,
  positiveEdges: EdgeTuple[],
  negativeEdges: EdgeTuple[],
): LinkPredictionResult {
  if (positiveEdges.length === 0 || negativeEdges.length === 0) {
    throw new Error('Must provide both positive and negative edges')
  }

  // 计算正例分数
  const posScores: number[] = []
  for (const edge of positiveEdges) {
    const srcVec = embeddings.get(edge.src)
    const dstVec = embeddings.get(edge.dst)
    if (srcVec && dstVec) {
      posScores.push(cosineSimilarity(srcVec, dstVec))
    }
  }

  // 计算负例分数
  const negScores: number[] = []
  for (const edge of negativeEdges) {
    const srcVec = embeddings.get(edge.src)
    const dstVec = embeddings.get(edge.dst)
    if (srcVec && dstVec) {
      negScores.push(cosineSimilarity(srcVec, dstVec))
    }
  }

  // 计算 AUC-ROC
  const { aucRoc, bestThreshold, bestF1 } = computeAucRoc(posScores, negScores)

  // 平均精确率
  const averagePrecision = computeAveragePrecision(posScores, negScores)

  return {
    aucRoc,
    averagePrecision,
    positiveCount: posScores.length,
    negativeCount: negScores.length,
    positiveScores: computeStats(posScores),
    negativeScores: computeStats(negScores),
    bestThreshold,
    bestF1,
  }
}

/**
 * 根据正例/负例分数计算 AUC-ROC
 */
function computeAucRoc(posScores: number[], negScores: number[]): { aucRoc: number; bestThreshold: number; bestF1: number } {
  const allScores = [...posScores, ...negScores]
  const labels = [...posScores.map(() => 1), ...negScores.map(() => 0)]
  const n = allScores.length

  // 对分数排序（降序）
  const indices = allScores.map((_, i) => i).sort((a, b) => allScores[b] - allScores[a])

  let tp = 0
  let fp = 0
  const totalPos = posScores.length
  const totalNeg = negScores.length

  let auc = 0
  let prevFp = 0
  let prevTp = 0

  let bestF1 = 0
  let bestThreshold = 0
  let bestPrecision = 0
  let bestRecall = 0

  for (let i = 0; i < n; i++) {
    if (labels[indices[i]] === 1) {
      tp++
    } else {
      fp++
      // 梯形面积
      auc += (tp + prevTp) * (fp - prevFp) / (2 * totalPos * totalNeg)
      prevFp = fp
      prevTp = tp
    }

    // 计算当前 F1
    const precision = tp / (tp + fp) || 0
    const recall = tp / totalPos || 0
    const f1 = 2 * precision * recall / (precision + recall) || 0

    if (f1 > bestF1) {
      bestF1 = f1
      bestThreshold = i < n - 1 ? (allScores[indices[i]] + allScores[indices[i + 1]]) / 2 : allScores[indices[i]]
      bestPrecision = precision
      bestRecall = recall
    }
  }

  // 最后一段
  auc += (tp + prevTp) * (totalNeg - prevFp) / (2 * totalPos * totalNeg)

  return { aucRoc: auc, bestThreshold, bestF1 }
}

/**
 * 计算平均精确率（AP）
 */
function computeAveragePrecision(posScores: number[], negScores: number[]): number {
  const allScores = [...posScores, ...negScores]
  const labels = [...posScores.map(() => 1), ...negScores.map(() => 0)]
  const indices = allScores.map((_, i) => i).sort((a, b) => allScores[b] - allScores[a])

  let tp = 0
  let precisionSum = 0
  const totalPos = posScores.length

  for (const idx of indices) {
    if (labels[idx] === 1) {
      tp++
      const precision = tp / (tp + indices.indexOf(idx) - tp + tp) // precision at this rank
      // Simplified: precision = tp / rank
      const rank = indices.indexOf(idx) + 1
      precisionSum += tp / rank
    }
  }

  return precisionSum / totalPos
}

// ──────────────────────────────────────────
// 节点分类评估
// ──────────────────────────────────────────

/**
 * 节点分类评估
 *
 * 使用嵌入向量作为特征，训练逻辑回归分类器（通过梯度下降）
 * 预测节点类型。划分训练/测试集后计算分类指标。
 *
 * @param embeddings 嵌入向量映射 { nodeId → vector }
 * @param nodeLabels 节点标签映射 { nodeId → classLabel }
 * @param trainRatio 训练集比例 (0~1)
 * @param epochs 训练轮次
 * @param learningRate 学习率
 * @returns 节点分类评估结果
 */
export function evaluateNodeClassification(
  embeddings: EmbeddingMap,
  nodeLabels: Map<number, number>,
  trainRatio: number = 0.7,
  epochs: number = 200,
  learningRate: number = 0.01,
): NodeClassificationResult {
  const nodeIds = Array.from(embeddings.keys()).filter(id => nodeLabels.has(id))
  if (nodeIds.length === 0) {
    throw new Error('No nodes with labels found')
  }

  // 获取类别和维度
  const classes = Array.from(new Set(nodeLabels.values())).sort((a, b) => a - b)
  const classCount = classes.length
  const dim = embeddings.get(nodeIds[0])!.length

  // 构建特征矩阵 (N x dim) 和标签 (N)
  const featureVectors: number[][] = []
  const labelVector: number[] = []
  for (const id of nodeIds) {
    featureVectors.push(embeddings.get(id)!)
    labelVector.push(nodeLabels.get(id)!)
  }

  // 洗牌
  const shuffled = nodeIds.map((_, i) => i)
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  // 划分训练/测试
  const trainSize = Math.floor(shuffled.length * trainRatio)
  const trainIndices = shuffled.slice(0, trainSize)
  const testIndices = shuffled.slice(trainSize)

  // 逻辑回归 (softmax) — 使用梯度下降
  // 权重矩阵: [dim+1] x classCount (bias 在最后一行)
  const W = new Float64Array((dim + 1) * classCount)
  const biasFeature = 1.0

  function softmax(scores: number[]): number[] {
    const maxScore = Math.max(...scores)
    const exps = scores.map(s => Math.exp(s - maxScore))
    const sumExp = exps.reduce((a, b) => a + b, 0)
    return exps.map(e => e / sumExp)
  }

  // 训练
  for (let epoch = 0; epoch < epochs; epoch++) {
    // SGD (mini-batch = whole train set for simplicity)
    const grad = new Float64Array(W.length)

    for (const idx of trainIndices) {
      const x = [...featureVectors[idx], biasFeature]
      const scores: number[] = []
      for (let c = 0; c < classCount; c++) {
        let s = 0
        for (let d = 0; d <= dim; d++) {
          s += x[d] * W[d * classCount + c]
        }
        scores.push(s)
      }
      const probs = softmax(scores)
      const trueClass = classes.indexOf(labelVector[idx])

      for (let d = 0; d <= dim; d++) {
        for (let c = 0; c < classCount; c++) {
          const target = c === trueClass ? 1 : 0
          grad[d * classCount + c] += x[d] * (probs[c] - target)
        }
      }
    }

    // 更新权重
    for (let i = 0; i < W.length; i++) {
      W[i] -= learningRate * grad[i] / trainSize
    }
  }

  // 预测
  const predictions: number[] = []
  const groundTruth: number[] = []
  for (const idx of testIndices) {
    const x = [...featureVectors[idx], biasFeature]
    const scores: number[] = []
    for (let c = 0; c < classCount; c++) {
      let s = 0
      for (let d = 0; d <= dim; d++) {
        s += x[d] * W[d * classCount + c]
      }
      scores.push(s)
    }
    const probs = softmax(scores)
    const predicted = classes[probs.indexOf(Math.max(...probs))]
    predictions.push(predicted)
    groundTruth.push(labelVector[idx])
  }

  // 计算混淆矩阵
  const cm: number[][] = Array.from({ length: classCount }, () => new Array(classCount).fill(0))
  for (let i = 0; i < predictions.length; i++) {
    const trueIdx = classes.indexOf(groundTruth[i])
    const predIdx = classes.indexOf(predictions[i])
    cm[trueIdx][predIdx]++
  }

  // 计算每个类别的指标
  const perClass = classes.map((cls, i) => {
    const tp = cm[i][i]
    const fp = cm.reduce((sum, row, ri) => sum + (ri !== i ? row[i] : 0), 0)
    const fn = cm[i].reduce((sum, v, ci) => sum + (ci !== i ? v : 0), 0)
    const precision = tp / (tp + fp) || 0
    const recall = tp / (tp + fn) || 0
    const f1 = 2 * precision * recall / (precision + recall) || 0
    const support = cm[i].reduce((a, b) => a + b, 0)
    return { classLabel: cls, precision, recall, f1, support }
  })

  // 宏平均
  const accuracy = cm.reduce((sum, row, i) => sum + row[i], 0) / testIndices.length
  const precisionMacro = perClass.reduce((s, c) => s + c.precision, 0) / classCount
  const recallMacro = perClass.reduce((s, c) => s + c.recall, 0) / classCount
  const f1Macro = perClass.reduce((s, c) => s + c.f1, 0) / classCount

  return {
    accuracy,
    precisionMacro,
    recallMacro,
    f1Macro,
    classCount,
    confusionMatrix: cm,
    perClassMetrics: perClass,
    trainTestSplit: { train: trainSize, test: testIndices.length },
  }
}

// ──────────────────────────────────────────
// 嵌入统计
// ──────────────────────────────────────────

/**
 * 计算嵌入的统计指标
 */
export function computeEmbeddingStatistics(embeddings: EmbeddingMap): EmbeddingStatistics {
  const nodes = Array.from(embeddings.entries())
  if (nodes.length === 0) {
    throw new Error('Empty embedding map')
  }

  const dim = nodes[0][1].length
  const nodeCount = nodes.length

  // 维度均值和方差
  const dimensionMeans = new Array(dim).fill(0)
  const dimensionVariances = new Array(dim).fill(0)
  const dimensionMaxAbs = new Array(dim).fill(0)

  // 先计算均值
  for (const [, vec] of nodes) {
    for (let d = 0; d < dim; d++) {
      dimensionMeans[d] += vec[d]
    }
  }
  for (let d = 0; d < dim; d++) {
    dimensionMeans[d] /= nodeCount
  }

  // 再计算方差和 maxAbs
  let globalSum = 0
  let globalSumSq = 0
  let zeroCount = 0
  let totalCount = 0

  for (const [, vec] of nodes) {
    for (let d = 0; d < dim; d++) {
      const v = vec[d]
      const diff = v - dimensionMeans[d]
      dimensionVariances[d] += diff * diff
      dimensionMaxAbs[d] = Math.max(dimensionMaxAbs[d], Math.abs(v))
      globalSum += v
      globalSumSq += v * v
      totalCount++
      if (v === 0) zeroCount++
    }
  }

  for (let d = 0; d < dim; d++) {
    dimensionVariances[d] /= nodeCount
  }

  // L2 范数
  const norms = nodes.map(([, vec]) => {
    let sumSq = 0
    for (let d = 0; d < dim; d++) {
      sumSq += vec[d] * vec[d]
    }
    return Math.sqrt(sumSq)
  })

  const normMean = norms.reduce((a, b) => a + b, 0) / norms.length
  const normVariance = norms.reduce((sum, n) => sum + (n - normMean) ** 2, 0) / norms.length

  return {
    nodeCount,
    dimension: dim,
    dimensionMeans,
    dimensionVariances,
    dimensionMaxAbs,
    globalMean: globalSum / totalCount,
    globalStd: Math.sqrt(globalSumSq / totalCount - (globalSum / totalCount) ** 2),
    sparsity: zeroCount / totalCount,
    normStats: {
      mean: normMean,
      std: Math.sqrt(normVariance),
      min: Math.min(...norms),
      max: Math.max(...norms),
    },
  }
}

/**
 * 计算嵌入的均值（质心）
 */
export function computeEmbeddingMean(embeddings: EmbeddingMap): number[] {
  const nodes = Array.from(embeddings.values())
  if (nodes.length === 0) throw new Error('Empty embedding map')
  const dim = nodes[0].length
  const mean = new Array(dim).fill(0)
  for (const vec of nodes) {
    for (let i = 0; i < dim; i++) mean[i] += vec[i]
  }
  for (let i = 0; i < dim; i++) mean[i] /= nodes.length
  return mean
}

// ──────────────────────────────────────────
// 统计辅助
// ──────────────────────────────────────────

function computeStats(values: number[]): { mean: number; std: number; min: number; max: number } {
  if (values.length === 0) {
    return { mean: 0, std: 0, min: 0, max: 0 }
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}
