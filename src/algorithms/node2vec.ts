// ============================================================
// Node2Vec — 图嵌入算法
//
// 基于随机游走（Random Walk）+ Skip-Gram（负采样）的图嵌入。
// 参考：node2vec: Scalable Feature Learning for Networks (Grover & Leskovec, 2016)
//
// 提供：
// - 灵活的有偏随机游走（p, q 参数控制 BFS/DFS 倾向）
// - Skip-Gram 训练（负采样）
// - 学习到的节点嵌入向量
// - Jaccard 邻接相似度（无嵌入也可使用）
//
// 依赖：ml-matrix, random-js
// ============================================================

import { NodeId } from '../types'

/**
 * Node2Vec 配置选项
 */
export interface Node2VecOptions {
  /** 嵌入维度（默认 128） */
  dimensions?: number
  /** 每个节点开始的随机游走次数（默认 10） */
  walksPerNode?: number
  /** 每条随机游走的长度（默认 80） */
  walkLength?: number
  /** 上下文窗口大小（默认 10） */
  windowSize?: number
  /** 返回参数 p（高 p → 倾向 BFS，低 p → 倾向 DFS）（默认 1.0） */
  p?: number
  /** 进出参数 q（高 q → 倾向局部，低 q → 倾向全局）（默认 1.0） */
  q?: number
  /** 负采样数量（默认 5） */
  negativeSamples?: number
  /** 学习率（默认 0.025） */
  learningRate?: number
  /** 训练迭代轮次（默认 5） */
  epochs?: number
  /** 随机种子（Optional，用于可重复结果） */
  seed?: number
  /** 用于序列化的嵌入向量是否包含偏置项（默认 false） */
  includeBias?: boolean
}

/**
 * Node2Vec 结果
 */
export interface Node2VecResult {
  /** Node ID → 嵌入向量 */
  embeddings: Map<NodeId, number[]>
  /** 训练配置副本 */
  options: Required<Node2VecOptions>
  /** 总计训练步数 */
  steps: number
}

/**
 * Jaccard 邻接相似度结果
 */
export interface JaccardSimilarityResult {
  /** 节点对及其 Jaccard 相似度 */
  pairs: Array<{ nodeA: NodeId; nodeB: NodeId; similarity: number }>
}

// ──────────────────────────────────────────────
//  Node2Vec 主实现
// ──────────────────────────────────────────────

/**
 * 执行 Node2Vec 图嵌入训练。
 *
 * @param nodeIds - 所有Node ID
 * @param getNeighbors - 返回邻居Node ID 的函数
 * @param options - Optional配置
 * @returns Node2VecResult
 */
export function node2vec(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
  options?: Node2VecOptions,
): Node2VecResult {
  const opts: Required<Node2VecOptions> = {
    dimensions: options?.dimensions ?? 128,
    walksPerNode: options?.walksPerNode ?? 10,
    walkLength: options?.walkLength ?? 80,
    windowSize: options?.windowSize ?? 10,
    p: options?.p ?? 1.0,
    q: options?.q ?? 1.0,
    negativeSamples: options?.negativeSamples ?? 5,
    learningRate: options?.learningRate ?? 0.025,
    epochs: options?.epochs ?? 5,
    seed: options?.seed ?? 42,
    includeBias: options?.includeBias ?? false,
  }

  if (nodeIds.length === 0) {
    return { embeddings: new Map(), options: opts, steps: 0 }
  }

  // 建立 nodeId → index 映射
  const nodeIndex = new Map<NodeId, number>()
  const indexToNode = new Map<number, NodeId>()
  for (let i = 0; i < nodeIds.length; i++) {
    nodeIndex.set(nodeIds[i], i)
    indexToNode.set(i, nodeIds[i])
  }
  const n = nodeIds.length

  // 预计算邻接表（排除自环）
  const adjList = new Map<NodeId, NodeId[]>()
  for (const id of nodeIds) {
    adjList.set(id, getNeighbors(id).filter(nb => nb !== id))
  }

  // 预计算别名表以加速加权采样（Alias Method）
  const aliasTables = new Map<NodeId, { prob: Float64Array; alias: Int32Array }>()
  for (const id of nodeIds) {
    const nb = adjList.get(id) ?? []
    if (nb.length > 0) {
      const weights = new Float64Array(nb.length)
      for (let i = 0; i < nb.length; i++) weights[i] = 1.0
      aliasTables.set(id, _buildAliasTable(weights))
    }
  }

  // ── 初始化嵌入向量 ──
  // 使用 Xavier 初始化
  const rng = _createRng(opts.seed)
  const embedDim = opts.dimensions

  // embedVectors[nodeIdx][dim] = weight
  const embedVectors: Float64Array[] = []
  for (let i = 0; i < n; i++) {
    const vec = new Float64Array(embedDim)
    const scale = Math.sqrt(2.0 / embedDim)
    for (let j = 0; j < embedDim; j++) {
      vec[j] = _gaussianRandom(rng) * scale
    }
    embedVectors.push(vec)
  }

  // contextVectors: 与 embedVectors 相同结构（Skip-Gram 使用两套向量）
  const contextVectors: Float64Array[] = []
  for (let i = 0; i < n; i++) {
    const vec = new Float64Array(embedDim)
    const scale = Math.sqrt(2.0 / embedDim)
    for (let j = 0; j < embedDim; j++) {
      vec[j] = _gaussianRandom(rng) * scale
    }
    contextVectors.push(vec)
  }

  // ── 负采样分布（按节点度加权）──
  const negSampleProb = new Float64Array(n)
  let totalDegree = 0
  for (let i = 0; i < n; i++) {
    const deg = (adjList.get(indexToNode.get(i)!) ?? []).length
    negSampleProb[i] = Math.pow(deg + 1, 0.75) // 指数 0.75 按论文
    totalDegree += negSampleProb[i]
  }
  for (let i = 0; i < n; i++) {
    negSampleProb[i] /= totalDegree
  }
  const negAlias = _buildAliasTable(negSampleProb)

  let totalSteps = 0
  const lr = opts.learningRate
  const negSamples = opts.negativeSamples
  const windowSize = opts.windowSize

  // ── 训练循环 ──
  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    // 为每个节点生成 walksPerNode 条随机游走
    for (let wi = 0; wi < opts.walksPerNode; wi++) {
      // 洗牌节点顺序
      const shuffled = [...nodeIds]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }

      for (const startNode of shuffled) {
        const walk = _biasedRandomWalk(startNode, opts.walkLength, adjList, aliasTables, opts)

        // Skip-Gram 训练
        for (let t = 0; t < walk.length; t++) {
          const centerNode = walk[t]
          const centerIdx = nodeIndex.get(centerNode)!
          const start = Math.max(0, t - windowSize)
          const end = Math.min(walk.length - 1, t + windowSize)

          for (let c = start; c <= end; c++) {
            if (c === t) continue
            const contextNode = walk[c]
            const contextIdx = nodeIndex.get(contextNode)!

            // 正样本梯度更新
            _updateEmbedding(
              embedVectors[centerIdx],
              contextVectors[contextIdx],
              true, // positive
              lr,
            )

            // 负样本梯度更新
            for (let ns = 0; ns < negSamples; ns++) {
              const negIdx = _sampleFromAlias(negAlias, rng)
              if (negIdx === contextIdx) continue
              _updateEmbedding(
                embedVectors[centerIdx],
                contextVectors[negIdx],
                false, // negative
                lr,
              )
            }

            totalSteps++
          }
        }
      }
    }
  }

  // ── 整理结果 ──
  const embeddings = new Map<NodeId, number[]>()
  for (let i = 0; i < n; i++) {
    const vec: number[] = []
    for (let j = 0; j < embedDim; j++) {
      vec.push(embedVectors[i][j])
    }
    embeddings.set(indexToNode.get(i)!, vec)
  }

  return { embeddings, options: opts, steps: totalSteps }
}

// ──────────────────────────────────────────────
//  有偏随机游走
// ──────────────────────────────────────────────

/**
 * 执行一次有偏随机游走（Node2Vec 偏置随机游走）。
 * 参数 p（返回）和 q（进出）控制搜索策略。
 */
function _biasedRandomWalk(
  startNode: NodeId,
  walkLength: number,
  adjList: Map<NodeId, NodeId[]>,
  aliasTables: Map<NodeId, { prob: Float64Array; alias: Int32Array }>,
  opts: Required<Node2VecOptions>,
): NodeId[] {
  const walk: NodeId[] = [startNode]
  const { p, q } = opts
  const rng = _createRng(opts.seed + startNode)

  while (walk.length < walkLength) {
    const cur = walk[walk.length - 1]
    const neighbors = adjList.get(cur)
    if (!neighbors || neighbors.length === 0) break

    if (walk.length === 1) {
      // 第一步：均匀采样
      const idx = Math.floor(rng() * neighbors.length)
      walk.push(neighbors[idx])
    } else {
      const prev = walk[walk.length - 2]

      // 计算偏置权重
      // d_{tx} 为 0（回到上一步），1（上一步的邻居），2（其他）
      const weights = new Float64Array(neighbors.length)
      const prevNeighbors = new Set(adjList.get(prev) ?? [])
      for (let i = 0; i < neighbors.length; i++) {
        const candidate = neighbors[i]
        if (candidate === prev) {
          // 返回上一步：权重 1/p
          weights[i] = 1.0 / p
        } else if (prevNeighbors.has(candidate)) {
          // 上一步的邻居：权重 1.0
          weights[i] = 1.0
        } else {
          // 其他节点：权重 1/q
          weights[i] = 1.0 / q
        }
      }

      // 用别名表按权重采样
      const alias = _buildAliasTable(weights)
      const idx = _sampleFromAlias(alias, rng)
      walk.push(neighbors[idx])
    }
  }

  return walk
}

// ──────────────────────────────────────────────
//  Skip-Gram 梯度更新
// ──────────────────────────────────────────────

/**
 * 更新嵌入向量（一次正样本或负样本的 SGD 更新）。
 * 使用 sigmoid 二分类损失。
 */
function _updateEmbedding(
  embedVec: Float64Array,
  contextVec: Float64Array,
  positive: boolean,
  lr: number,
): void {
  // 计算内积
  let dot = 0
  for (let j = 0; j < embedVec.length; j++) {
    dot += embedVec[j] * contextVec[j]
  }

  // Sigmoid 梯度
  // sigma = 1 / (1 + exp(-dot))
  // dL/d(dot) = sigma - label
  const label = positive ? 1.0 : 0.0
  const sigma = 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, dot))))
  const grad = sigma - label

  // 更新
  const gradTimesLr = grad * lr
  for (let j = 0; j < embedVec.length; j++) {
    const embedGrad = gradTimesLr * contextVec[j]
    const contextGrad = gradTimesLr * embedVec[j]
    embedVec[j] -= embedGrad
    contextVec[j] -= contextGrad
  }
}

// ──────────────────────────────────────────────
//  Alias Method（别名表采样）
// ──────────────────────────────────────────────

interface AliasTable {
  prob: Float64Array
  alias: Int32Array
}

/**
 * 构建别名表用于 O(1) 加权随机采样。
 */
function _buildAliasTable(weights: Float64Array | number[]): AliasTable {
  const n = weights.length
  const prob = new Float64Array(n)
  const alias = new Int32Array(n)

  // 归一化
  let sum = 0
  for (let i = 0; i < n; i++) sum += weights[i]
  const scaled = new Float64Array(n)
  for (let i = 0; i < n; i++) scaled[i] = (weights[i] / sum) * n

  const small: number[] = []
  const large: number[] = []

  for (let i = 0; i < n; i++) {
    if (scaled[i] < 1.0) small.push(i)
    else large.push(i)
  }

  while (small.length > 0 && large.length > 0) {
    const s = small.pop()!
    const l = large.pop()!
    prob[s] = scaled[s]
    alias[s] = l
    scaled[l] = scaled[l] - (1.0 - scaled[s])
    if (scaled[l] < 1.0) small.push(l)
    else large.push(l)
  }

  while (large.length > 0) {
    const l = large.pop()!
    prob[l] = 1.0
  }
  while (small.length > 0) {
    const s = small.pop()!
    prob[s] = 1.0
  }

  return { prob, alias }
}

/**
 * 从别名表采样一个元素。
 */
function _sampleFromAlias(table: AliasTable, rng: () => number): number {
  const n = table.prob.length
  const i = Math.floor(rng() * n)
  if (rng() < table.prob[i]) return i
  return table.alias[i]
}

// ──────────────────────────────────────────────
//  随机数工具
// ──────────────────────────────────────────────

/**
 * 创建基于种子的随机数生成器（0-1 均匀分布）。
 * 使用乘同余法（LCG）——简单自包含，不依赖 random-js 外部运行时。
 */
function _createRng(seed: number): () => number {
  // 使用 mulberry32
  let state = seed | 0
  return function () {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Box-Muller: 生成approximate标准正态分布随机数。
 */
function _gaussianRandom(rng: () => number): number {
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

// ──────────────────────────────────────────────
//  嵌入向量工具
// ──────────────────────────────────────────────

/**
 * 计算两个嵌入向量的余弦相似度。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

// ──────────────────────────────────────────────
//  Jaccard 邻接相似度
// ──────────────────────────────────────────────

/**
 * 计算两个节点之间的 Jaccard 邻接相似度。
 *
 * J(A, B) = |N(A) ∩ N(B)| / |N(A) ∪ N(B)|
 *
 * 其中 N(X) 是节点 X 的邻居集合（不含 X 自身）。
 */
export function jaccardSimilarity(
  nodeA: NodeId,
  nodeB: NodeId,
  getNeighbors: (nodeId: NodeId) => NodeId[],
): number {
  const aNeighbors = new Set(getNeighbors(nodeA))
  const bNeighbors = new Set(getNeighbors(nodeB))

  // 排除自身
  aNeighbors.delete(nodeA)
  bNeighbors.delete(nodeB)

  let intersection = 0
  for (const n of aNeighbors) {
    if (bNeighbors.has(n)) intersection++
  }

  const union = aNeighbors.size + bNeighbors.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 计算所有节点对的 Jaccard 邻接相似度（仅对有边的节点对）。
 *
 * @param nodeIds - 所有Node ID
 * @param getNeighbors - 返回邻居Node ID 的函数
 * @param threshold - 仅返回高于此阈值的相似度（默认 0）
 * @returns JaccardSimilarityResult
 */
export function allPairsJaccard(
  nodeIds: NodeId[],
  getNeighbors: (nodeId: NodeId) => NodeId[],
  threshold: number = 0,
): JaccardSimilarityResult {
  const pairs: Array<{ nodeA: NodeId; nodeB: NodeId; similarity: number }> = []

  for (let i = 0; i < nodeIds.length; i++) {
    const a = nodeIds[i]
    const aNeighbors = getNeighbors(a)
    for (const b of aNeighbors) {
      if (b <= a) continue // 避免重复对
      if (!nodeIds.includes(b)) continue
      const sim = jaccardSimilarity(a, b, getNeighbors)
      if (sim >= threshold) {
        pairs.push({ nodeA: a, nodeB: b, similarity: sim })
      }
    }
  }

  // 按相似度降序排列
  pairs.sort((a, b) => b.similarity - a.similarity)

  return { pairs }
}
