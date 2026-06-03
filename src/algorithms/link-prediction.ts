/**
 * link-prediction.ts — 链接预测完整 Pipeline
 *
 * 覆盖三种方法：
 * 1. 传统相似度：Jaccard / AdamicAdar / ResourceAllocation / PreferentialAttachment
 * 2. 嵌入向量相似度：cosine similarity
 * 3. GNN 推理：使用 GnnInferenceEngine 作为分类器
 *
 * 评估指标：AUC-ROC, F1, Precision, Recall, Precision@K
 *
 * @example
 * ```ts
 * const lp = new LinkPredictor(allNodes, adjacency)
 * const trainTest = lp.trainTestSplit(edges, { testRatio: 0.2 })
 * const negTest = lp.negativeSample(1000)
 *
 * // 传统方法
 * const resultAA = lp.evaluate('adamicAdar', trainTest.train, trainTest.test, negTest)
 * console.log(resultAA.aucRoc, resultAA.f1)
 *
 * // GNN 方法
 * const resultGNN = await lp.evaluateGNN(trainTest.train, trainTest.test, negTest, gnnEngine)
 * console.log(resultGNN.aucRoc, resultGNN.precisionAt10)
 * ```
 */

export type NodeId = number

export interface EdgeTuple {
  src: NodeId
  dst: NodeId
}

export type SimilarityMethod = 'jaccard' | 'adamicAdar' | 'resourceAllocation' | 'preferentialAttachment'

export interface LPResult {
  /** 方法名 */
  method: string
  /** AUC-ROC */
  aucRoc: number
  /** 最佳阈值下的 F1 */
  f1: number
  /** 最佳阈值下的 Precision */
  precision: number
  /** 最佳阈值下的 Recall */
  recall: number
  /** 最佳阈值 */
  bestThreshold: number
  /** Precision@K (K 默认 10) */
  precisionAtK: number
  /** 正例数量 */
  positiveCount: number
  /** 负例数量 */
  negativeCount: number
}

export interface TrainTestSplit {
  train: EdgeTuple[]
  test: EdgeTuple[]
}

/**
 * LinkPredictor — 链接预测完整 Pipeline
 */
export class LinkPredictor {
  private _nodeIds: Set<NodeId>
  private _adjacency: Map<NodeId, Set<NodeId>>
  private _rng: () => number

  constructor(
    allNodes: Iterable<NodeId>,
    /**
     * 邻接表：nodeId → 其邻居节点集合
     * 注意：自动创建双向（如果只传单向，会补全）
     */
    adjacency?: Map<NodeId, Set<NodeId>>,
    seed?: number,
  ) {
    this._nodeIds = new Set(allNodes)
    this._adjacency = adjacency ?? new Map()
    this._rng = seed !== undefined ? _seededRandom(seed) : Math.random

    // 确保邻接表双向
    this._ensureBidirectional()
  }

  // ── 核心评估 ─────────────────────────────

  /**
   * 用传统相似度方法评估链接预测
   *
   * @param method  相似度方法
   * @param train   训练集正例
   * @param test    测试集正例
   * @param negTest 测试集负例
   */
  evaluate(
    method: SimilarityMethod,
    train: EdgeTuple[],
    test: EdgeTuple[],
    negTest: EdgeTuple[],
  ): LPResult {
    // 用训练集重建邻接表（排除测试边）
    const trainAdj = this._buildTrainAdjacency(train)

    // 计算测试正例分数
    const posScores: number[] = test.map(e => this._similarity(method, e.src, e.dst, trainAdj))
    // 计算负例分数
    const negScores: number[] = negTest.map(e => this._similarity(method, e.src, e.dst, trainAdj))

    return this._computeMetrics(posScores, negScores, method)
  }

  /**
   * 用 GNN 推理引擎评估链接预测
   *
   * 使用 GnnInferenceEngine 为训练集提供特征，用 test/negTest 边构造推理请求
   */
  async evaluateGNN(
    train: EdgeTuple[],
    test: EdgeTuple[],
    negTest: EdgeTuple[],
    inferenceFn: (edges: EdgeTuple[]) => Float64Array | number[],
  ): Promise<LPResult> {
    const posScores = Array.from(await inferenceFn(test))
    const negScores = Array.from(await inferenceFn(negTest))

    return this._computeMetrics(posScores, negScores, 'gnn')
  }

  // ── 数据准备 ─────────────────────────────

  /**
   * 将边集按比例划分为训练集和测试集
   * 默认 80/20 划分，随机打乱
   */
  trainTestSplit(edges: EdgeTuple[], opts?: { testRatio?: number }): TrainTestSplit {
    const ratio = opts?.testRatio ?? 0.2
    const shuffled = [...edges].sort(() => this._rng() - 0.5)
    const splitIdx = Math.floor(shuffled.length * (1 - ratio))
    return {
      train: shuffled.slice(0, splitIdx),
      test: shuffled.slice(splitIdx),
    }
  }

  /**
   * 负采样：生成指定数量不存在的边
   *
   * 策略：
   * 1. 优先从同一节点对中排除已存在的边
   * 2. 如果不够，随机配对
   * 3. 去重，保证 src !== dst
   *
   * @param count 需要的负样本数
   * @param existingEdges 已知存在的边（用于避免采样到正例）
   */
  negativeSample(count: number, existingEdges?: EdgeTuple[]): EdgeTuple[] {
    const existingSet = new Set<string>()
    if (existingEdges) {
      for (const e of existingEdges) {
        existingSet.add(this._edgeKey(e.src, e.dst))
      }
    }

    // 也排除邻接表中已存在的边
    for (const [src, neighbors] of this._adjacency) {
      for (const dst of neighbors) {
        existingSet.add(this._edgeKey(src, dst))
      }
    }

    // 也排除自连
    for (const id of this._nodeIds) {
      existingSet.add(this._edgeKey(id, id))
    }

    const allNodes = Array.from(this._nodeIds)
    const result: EdgeTuple[] = []
    const seen = new Set<string>()
    const maxAttempts = count * 10

    for (let attempt = 0; attempt < maxAttempts && result.length < count; attempt++) {
      const src = allNodes[Math.floor(this._rng() * allNodes.length)]
      const dst = allNodes[Math.floor(this._rng() * allNodes.length)]
      const key = this._edgeKey(src, dst)

      if (existingSet.has(key)) continue
      if (seen.has(key)) continue
      if (src === dst) continue

      seen.add(key)
      result.push({ src, dst })
    }

    return result
  }

  // ── 内部 ─────────────────────────────

  private _ensureBidirectional(): void {
    const additions = new Map<NodeId, Set<NodeId>>()
    for (const [src, neighbors] of this._adjacency) {
      for (const dst of neighbors) {
        if (!this._adjacency.has(dst) || !this._adjacency.get(dst)!.has(src)) {
          let set = additions.get(dst)
          if (!set) {
            set = new Set()
            additions.set(dst, set)
          }
          set.add(src)
        }
      }
    }
    for (const [node, neighbors] of additions) {
      if (!this._adjacency.has(node)) {
        this._adjacency.set(node, new Set())
      }
      for (const n of neighbors) {
        this._adjacency.get(node)!.add(n)
      }
    }
  }

  private _buildTrainAdjacency(train: EdgeTuple[]): Map<NodeId, Set<NodeId>> {
    const adj = new Map<NodeId, Set<NodeId>>()
    // 从原始邻接表拷贝
    for (const [node, neighbors] of this._adjacency) {
      adj.set(node, new Set(neighbors))
    }

    // 从训练集添加边
    for (const { src, dst } of train) {
      if (!adj.has(src)) adj.set(src, new Set())
      if (!adj.has(dst)) adj.set(dst, new Set())
      adj.get(src)!.add(dst)
      adj.get(dst)!.add(src)
    }

    return adj
  }

  private _similarity(
    method: SimilarityMethod,
    src: NodeId,
    dst: NodeId,
    adjacency: Map<NodeId, Set<NodeId>>,
  ): number {
    const neighborsA = adjacency.get(src) ?? new Set()
    const neighborsB = adjacency.get(dst) ?? new Set()

    switch (method) {
      case 'jaccard':
        return this._jaccard(neighborsA, neighborsB)
      case 'adamicAdar':
        return this._adamicAdar(neighborsA, neighborsB, adjacency)
      case 'resourceAllocation':
        return this._resourceAllocation(neighborsA, neighborsB, adjacency)
      case 'preferentialAttachment':
        return this._preferentialAttachment(neighborsA, neighborsB)
      default:
        return 0
    }
  }

  private _jaccard(neighborsA: Set<NodeId>, neighborsB: Set<NodeId>): number {
    const intersection = new Set([...neighborsA].filter(x => neighborsB.has(x))).size
    const union = new Set([...neighborsA, ...neighborsB]).size
    return union === 0 ? 0 : intersection / union
  }

  private _adamicAdar(
    neighborsA: Set<NodeId>,
    neighborsB: Set<NodeId>,
    adjacency: Map<NodeId, Set<NodeId>>,
  ): number {
    const intersection = [...neighborsA].filter(x => neighborsB.has(x))
    let score = 0
    for (const common of intersection) {
      const degree = (adjacency.get(common) ?? new Set()).size
      score += degree > 1 ? 1 / Math.log(degree) : 1
    }
    return score
  }

  private _resourceAllocation(
    neighborsA: Set<NodeId>,
    neighborsB: Set<NodeId>,
    adjacency: Map<NodeId, Set<NodeId>>,
  ): number {
    const intersection = [...neighborsA].filter(x => neighborsB.has(x))
    let score = 0
    for (const common of intersection) {
      const degree = (adjacency.get(common) ?? new Set()).size
      score += degree > 0 ? 1 / degree : 0
    }
    return score
  }

  private _preferentialAttachment(
    neighborsA: Set<NodeId>,
    neighborsB: Set<NodeId>,
  ): number {
    return neighborsA.size * neighborsB.size
  }

  private _computeMetrics(posScores: number[], negScores: number[], method: string): LPResult {
    const sorted = [...posScores, ...negScores].sort((a, b) => b - a)
    const allLabels = [...posScores.map(() => 1), ...negScores.map(() => 0)]
    const nPos = posScores.length
    const nNeg = negScores.length

    // AUC-ROC: rank-based
    let aucRoc = 0.5
    if (nPos > 0 && nNeg > 0) {
      const ranks: number[] = []
      for (const score of posScores) {
        const rank = sorted.indexOf(score) + 1
        ranks.push(rank)
      }
      const meanRank = ranks.reduce((a, b) => a + b, 0) / nPos
      aucRoc = (meanRank - (nPos + 1) / 2) / nNeg
      aucRoc = Math.max(0, Math.min(1, aucRoc))
    }

    // 遍历阈值找最佳 F1
    const thresholds = [0, ...sorted, 1].filter((v, i, a) => a.indexOf(v) === i)
    let bestF1 = 0
    let bestPrecision = 0
    let bestRecall = 0
    let bestThreshold = 0.5

    for (const t of thresholds) {
      let tp = 0, fp = 0, fn = 0, tn = 0
      for (let i = 0; i < posScores.length; i++) {
        if (posScores[i] >= t) tp++
        else fn++
      }
      for (let i = 0; i < negScores.length; i++) {
        if (negScores[i] >= t) fp++
        else tn++
      }

      const precision = tp + fp > 0 ? tp / (tp + fp) : 0
      const recall = tp + fn > 0 ? tp / (tp + fn) : 0
      const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

      if (f1 > bestF1) {
        bestF1 = f1
        bestPrecision = precision
        bestRecall = recall
        bestThreshold = t
      }
    }

    // Precision@K
    const k = Math.min(10, posScores.length + negScores.length)
    const topK = sorted.slice(0, k)
    let hits = 0
    const sortedPos = [...posScores].sort((a, b) => b - a)
    for (let i = 0; i < Math.min(k, sortedPos.length); i++) {
      if (topK.includes(sortedPos[i])) hits++
    }
    const precisionAtK = k > 0 ? hits / k : 0

    return {
      method,
      aucRoc,
      f1: bestF1,
      precision: bestPrecision,
      recall: bestRecall,
      bestThreshold,
      precisionAtK,
      positiveCount: nPos,
      negativeCount: nNeg,
    }
  }

  private _edgeKey(src: NodeId, dst: NodeId): string {
    // 无向图：小ID在前
    return src <= dst ? `${src}-${dst}` : `${dst}-${src}`
  }
}

// ── 辅助函数 ─────────────────────────────

function _seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}
