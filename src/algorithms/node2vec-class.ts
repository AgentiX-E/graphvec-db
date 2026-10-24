// ============================================================
// Node2Vec (Class-based) — 图嵌入算法
//
// 基于 Node2Vec 论文 (Grover & Leskovec, 2016) 的类封装。
// 算法步骤：
//   1. 对每个节点执行 numWalks 次有偏随机游走（第二阶，p/q 参数）
//   2. 使用 SkipGram (Word2Vec 风格) 训练嵌入
//   3. 优化器：Negative Sampling SGD
//   4. 嵌入维度默认为 128
//
// 纯 TypeScript 实现，无外部 ML 依赖。
// ============================================================

import { NodeId } from '../types'

/**
 * Node2Vec 类：从 GraphEngine 学习图嵌入。
 */
export class Node2Vec {
  /** 嵌入维度 */
  dimensions: number = 128
  /** 随机游走长度 */
  walkLength: number = 80
  /** 每个节点的随机游走次数 */
  numWalks: number = 10
  /** 返回参数 p（高 p → 限制回溯） */
  p: number = 1
  /** 进出参数 q（高 q → 倾向局部，低 q → 倾向全局） */
  q: number = 1
  /** 上下文窗口大小 */
  windowSize: number = 10
  /** 负采样数量 */
  negativeSamples: number = 5
  /** 学习率 */
  learningRate: number = 0.025
  /** 训练迭代轮次 */
  epochs: number = 5
  /** 随机种子 */
  seed: number = 42

  /** nodeId → 嵌入向量 */
  private embeddings: Map<number, Float32Array> = new Map()
  /** nodeId → index */
  private nodeIndex: Map<number, number> = new Map()
  /** index → nodeId */
  private indexToNode: Map<number, number> = new Map()

  /** 是否已训练 */
  private trained: boolean = false

  constructor(options?: Partial<Node2VecOptions>) {
    if (options) {
      if (options.dimensions !== undefined) this.dimensions = options.dimensions
      if (options.walkLength !== undefined) this.walkLength = options.walkLength
      if (options.numWalks !== undefined) this.numWalks = options.numWalks
      if (options.p !== undefined) this.p = options.p
      if (options.q !== undefined) this.q = options.q
      if (options.windowSize !== undefined) this.windowSize = options.windowSize
      if (options.negativeSamples !== undefined) this.negativeSamples = options.negativeSamples
      if (options.learningRate !== undefined) this.learningRate = options.learningRate
      if (options.epochs !== undefined) this.epochs = options.epochs
      if (options.seed !== undefined) this.seed = options.seed
    }
  }

  /**
   * 从 GraphEngine 学习节点嵌入。
   *
   * 流程：
   * 1. 从 engine 获取所有节点和邻接关系
   * 2. 对每个节点执行有偏随机游走
   * 3. 使用 Skip-Gram + 负采样 SGD 训练
   */
  async fit(engine: any): Promise<void> {
    // ── 1. 获取图数据 ──
    const nodeIds = this._getAllNodeIds(engine)
    if (nodeIds.length === 0) {
      this.embeddings = new Map()
      this.nodeIndex = new Map()
      this.indexToNode = new Map()
      this.trained = true
      return
    }

    // nodeId → index 映射
    this.nodeIndex = new Map()
    this.indexToNode = new Map()
    for (let i = 0; i < nodeIds.length; i++) {
      this.nodeIndex.set(nodeIds[i], i)
      this.indexToNode.set(i, nodeIds[i])
    }
    const n = nodeIds.length

    // ── 2. 构建邻接表 ──
    const adjList = new Map<number, number[]>()
    for (const id of nodeIds) {
      adjList.set(id, this._getNeighbors(engine, id).filter(nb => nb !== id))
    }

    // ── 3. 初始化嵌入向量（Xavier 初始化）──
    const embedDim = this.dimensions
    const rng = this._createRng(this.seed)

    const embedVectors: Float64Array[] = []
    for (let i = 0; i < n; i++) {
      const vec = new Float64Array(embedDim)
      const scale = Math.sqrt(2.0 / embedDim)
      for (let j = 0; j < embedDim; j++) {
        vec[j] = this._gaussianRandom(rng) * scale
      }
      embedVectors.push(vec)
    }

    // context 向量（Skip-Gram 两套向量）
    const contextVectors: Float64Array[] = []
    for (let i = 0; i < n; i++) {
      const vec = new Float64Array(embedDim)
      const scale = Math.sqrt(2.0 / embedDim)
      for (let j = 0; j < embedDim; j++) {
        vec[j] = this._gaussianRandom(rng) * scale
      }
      contextVectors.push(vec)
    }

    // ── 4. 负采样分布（按节点度加权）──
    const negSampleProb = new Float64Array(n)
    let totalDegree = 0
    for (let i = 0; i < n; i++) {
      const deg = (adjList.get(this.indexToNode.get(i)!) ?? []).length
      negSampleProb[i] = Math.pow(deg + 1, 0.75)
      totalDegree += negSampleProb[i]
    }
    for (let i = 0; i < n; i++) {
      negSampleProb[i] /= totalDegree
    }
    const negAlias = this._buildAliasTable(negSampleProb)

    // 预计算 alias 表以加速有偏游走的第二步
    const aliasTables = new Map<number, { prob: Float64Array; alias: Int32Array }>()
    for (const id of nodeIds) {
      const nb = adjList.get(id) ?? []
      if (nb.length > 0) {
        const weights = new Float64Array(nb.length)
        for (let i = 0; i < nb.length; i++) weights[i] = 1.0
        aliasTables.set(id, this._buildAliasTable(weights))
      }
    }

    // ── 5. 训练循环 ──
    for (let epoch = 0; epoch < this.epochs; epoch++) {
      for (let wi = 0; wi < this.numWalks; wi++) {
        // 洗牌节点顺序
        const shuffled = [...nodeIds]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }

        for (const startNode of shuffled) {
          const walk = this._biasedRandomWalk(
            startNode,
            adjList,
            aliasTables,
            rng,
          )

          // Skip-Gram 训练
          for (let t = 0; t < walk.length; t++) {
            const centerIdx = this.nodeIndex.get(walk[t])!
            const start = Math.max(0, t - this.windowSize)
            const end = Math.min(walk.length - 1, t + this.windowSize)

            for (let c = start; c <= end; c++) {
              if (c === t) continue
              const contextIdx = this.nodeIndex.get(walk[c])!

              // 正样本
              this._sgdUpdate(
                embedVectors[centerIdx],
                contextVectors[contextIdx],
                true,
              )

              // 负样本
              for (let ns = 0; ns < this.negativeSamples; ns++) {
                const negIdx = this._sampleFromAlias(negAlias, rng)
                if (negIdx === contextIdx) continue
                this._sgdUpdate(
                  embedVectors[centerIdx],
                  contextVectors[negIdx],
                  false,
                )
              }
            }
          }
        }
      }
    }

    // ── 6. 整理结果 ──
    this.embeddings = new Map()
    for (let i = 0; i < n; i++) {
      const vec = new Float32Array(embedDim)
      for (let j = 0; j < embedDim; j++) {
        vec[j] = embedVectors[i][j]
      }
      this.embeddings.set(this.indexToNode.get(i)!, vec)
    }

    this.trained = true
  }

  /**
   * 获取指定节点的嵌入向量。
   * @param nodeId — Node ID
   * @returns Float32Array 或 null（节点不存在）
   */
  getEmbedding(nodeId: number): Float32Array | null {
    return this.embeddings.get(nodeId) ?? null
  }

  /**
   * 获取所有节点的嵌入向量。
   */
  getAllEmbeddings(): Map<number, Float32Array> {
    return new Map(this.embeddings)
  }

  /**
   * 将嵌入保存到文件（JSON 格式）。
   * @param path — 保存路径
   */
  save(path: string): void {
    const data: Node2VecSaveData = {
      dimensions: this.dimensions,
      embeddings: {},
    }
    for (const [nodeId, vec] of this.embeddings) {
      data.embeddings[String(nodeId)] = Array.from(vec)
    }
    const fs = require('fs')
    fs.writeFileSync(path, JSON.stringify(data), 'utf-8')
  }

  /**
   * 从文件加载嵌入。
   * @param path — 加载路径
   */
  load(path: string): void {
    const fs = require('fs')
    if (!fs.existsSync(path)) {
      throw new Error(`Embedding file not found: ${path}`)
    }
    const raw = fs.readFileSync(path, 'utf-8')
    const data: Node2VecSaveData = JSON.parse(raw)

    this.dimensions = data.dimensions
    this.embeddings = new Map()
    for (const [key, vec] of Object.entries(data.embeddings)) {
      this.embeddings.set(parseInt(key, 10), new Float32Array(vec))
    }
    this.trained = true
  }

  // ──────────────────────────────────────────────
  //  内部方法
  // ──────────────────────────────────────────────

  /**
   * 从 engine 获取所有Node ID.
   */
  private _getAllNodeIds(engine: any): number[] {
    try {
      if (typeof engine.getNodeIds === 'function') {
        return engine.getNodeIds()
      }
      if (typeof engine.getAllNodeIds === 'function') {
        return engine.getAllNodeIds()
      }
      if (engine.storage && typeof engine.storage.getAllNodeIds === 'function') {
        return engine.storage.getAllNodeIds()
      }
      // 遍历所有节点
      if (typeof engine.nodes === 'object' && engine.nodes instanceof Map) {
        return [...engine.nodes.keys()]
      }
      return []
    } catch {
      return []
    }
  }

  /**
   * 从 engine 获取邻居节点。
   */
  private _getNeighbors(engine: any, nodeId: number): number[] {
    try {
      if (typeof engine.neighbors === 'function') {
        const result = engine.neighbors(nodeId)
        if (Array.isArray(result)) {
          // An array may contain either raw numeric ids or { nodeId } objects.
          // Normalize each element to a numeric id so downstream code never
          // receives a non-numeric element (which would break nodeIndex lookups
          // and produce a contextVec out-of-bounds crash).
          return result.map((r: any) => {
            if (typeof r === 'number') return r
            if (r && typeof r.nodeId === 'number') return r.nodeId
            return r
          })
        }
        return []
      }
      if (typeof engine.getNeighbors === 'function') {
        const result = engine.getNeighbors(nodeId)
        return Array.isArray(result) ? result : []
      }
      return []
    } catch {
      return []
    }
  }

  /**
   * 有偏随机游走（Node2Vec 偏置）。
   */
  private _biasedRandomWalk(
    startNode: number,
    adjList: Map<number, number[]>,
    aliasTables: Map<number, { prob: Float64Array; alias: Int32Array }>,
    rng: () => number,
  ): number[] {
    const walk: number[] = [startNode]
    const { p, q } = this

    while (walk.length < this.walkLength) {
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
        const weights = new Float64Array(neighbors.length)
        const prevNeighbors = new Set(adjList.get(prev) ?? [])
        for (let i = 0; i < neighbors.length; i++) {
          const candidate = neighbors[i]
          if (candidate === prev) {
            weights[i] = 1.0 / p
          } else if (prevNeighbors.has(candidate)) {
            weights[i] = 1.0
          } else {
            weights[i] = 1.0 / q
          }
        }

        const alias = this._buildAliasTable(weights)
        const idx = this._sampleFromAlias(alias, rng)
        walk.push(neighbors[idx])
      }
    }

    return walk
  }

  /**
   * Skip-Gram SGD 更新。
   */
  private _sgdUpdate(
    embedVec: Float64Array,
    contextVec: Float64Array,
    positive: boolean,
  ): void {
    let dot = 0
    for (let j = 0; j < embedVec.length; j++) {
      dot += embedVec[j] * contextVec[j]
    }

    const label = positive ? 1.0 : 0.0
    const sigma = 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, dot))))
    const grad = sigma - label
    const gradTimesLr = grad * this.learningRate

    for (let j = 0; j < embedVec.length; j++) {
      const embedGrad = gradTimesLr * contextVec[j]
      const contextGrad = gradTimesLr * embedVec[j]
      embedVec[j] -= embedGrad
      contextVec[j] -= contextGrad
    }
  }

  /**
   * 构建别名表（Alias Method，用于 O(1) 加权采样）。
   */
  private _buildAliasTable(weights: Float64Array): { prob: Float64Array; alias: Int32Array } {
    const n = weights.length
    const prob = new Float64Array(n)
    const alias = new Int32Array(n)

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
  private _sampleFromAlias(table: { prob: Float64Array; alias: Int32Array }, rng: () => number): number {
    const n = table.prob.length
    const i = Math.floor(rng() * n)
    if (rng() < table.prob[i]) return i
    return table.alias[i]
  }

  /**
   * 创建基于种子的随机数生成器（mulberry32）。
   */
  private _createRng(seed: number): () => number {
    let state = seed | 0
    return function () {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /**
   * Box-Muller 生成高斯随机数。
   */
  private _gaussianRandom(rng: () => number): number {
    let u = 0, v = 0
    while (u === 0) u = rng()
    while (v === 0) v = rng()
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
  }
}

/** Node2Vec 构造选项 */
export interface Node2VecOptions {
  dimensions?: number
  walkLength?: number
  numWalks?: number
  p?: number
  q?: number
  windowSize?: number
  negativeSamples?: number
  learningRate?: number
  epochs?: number
  seed?: number
}

/** 保存/加载的数据格式 */
interface Node2VecSaveData {
  dimensions: number
  embeddings: Record<string, number[]>
}
