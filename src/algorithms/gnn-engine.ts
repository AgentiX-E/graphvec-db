// ============================================================
// GnnInferenceEngine — GNN 推理引擎（Phase 1: ONNX 推理桥接）
//
// 基于 ONNX Runtime 的图神经网络推理引擎。用于：
// - 加载预训练的 GNN 模型（ONNX 格式）
// - 链接预测（两个节点间是否存在边的概率）
// - 节点嵌入计算（通过 GNN 模型的前向传播）
//
// 训练过程在外部（Python/DGL/PyG）完成，导出为 ONNX，
// 本引擎仅负责推理（Phase 1）。
//
// 依赖：onnxruntime-node, ml-matrix
// ============================================================

import * as ort from 'onnxruntime-node'
import { NodeId } from '../types'

// ── Types ─────────────────────────────────

export interface GnnEngineConfig {
  /** 特征维度（必须与训练时一致） */
  featureDimension: number
  /** 嵌入向量维度（默认 128） */
  embeddingDimension?: number
  /** 推理批处理大小（默认 64） */
  batchSize?: number
}

export interface LinkPredictionResult {
  /** 链接概率 [0, 1] */
  probability: number
  /** 原始 logit 值 */
  logit: number
}

export interface EmbeddingResult {
  /** Node ID */
  nodeId: NodeId
  /** 嵌入向量 */
  embedding: Float32Array
}

export interface NodeClassificationResult {
  nodeId: number
  predictLabel: string
  confidences: Record<string, number>
}

export interface GraphClassificationResult {
  predictLabel: string
  confidences: Record<string, number>
}

// ── Constants ─────────────────────────────

const DEFAULT_EMBEDDING_DIM = 128
const DEFAULT_BATCH_SIZE = 64

/**
 * 默认的节点特征编码器 —— 基于 Node2Vec 嵌入或其他特征构建特征向量。
 * 对于不在图中的节点（未见节点），使用默认的零向量。
 */
export type FeatureEncoder = (nodeId: NodeId) => Float32Array

/**
 * GraphEngineFeatureEncoder — 从 GraphEngine 读取节点属性构建特征向量
 *
 * 用法：
 * ```ts
 * const encoder = new GraphEngineFeatureEncoder(engine, ['age', 'weight'], 2)
 * engine.setEncoder(encoder)
 * ```
 */
export class GraphEngineFeatureEncoder {
  /**
   * @param engine - GraphEngine 实例
   * @param featureFields - 要作为特征的属性字段名列表
   * @param dimension - 特征向量总维度（必须 = 字段数）
   */
  constructor(
    private engine: any,
    private featureFields: string[],
    private dimension: number,
  ) {}

  /**
   * 将Node ID 编码为特征向量
   * - 从 GraphEngine 读取节点 props
   * - 只取数值类型的 prop 值
   * - null/undefined/非数值 → 0
   * - dimension > field 数 → 剩余位置补 0
   * - dimension < field 数 → 截断
   */
  encode(nodeId: NodeId): Float32Array {
    const node = this.engine.getNode(nodeId)
    const result = new Float32Array(this.dimension)
    const limit = Math.min(this.featureFields.length, this.dimension)
    for (let i = 0; i < limit; i++) {
      const field = this.featureFields[i]
      const val = node?.props?.[field]
      result[i] = typeof val === 'number' ? val : 0
    }
    return result
  }
}

/**
 * GnnInferenceEngine — ONNX 驱动的 GNN 推理引擎
 *
 * 用法：
 * ```ts
 * const engine = new GnnInferenceEngine({ featureDimension: 64 })
 * await engine.loadModel('/path/to/model.onnx')
 * const prob = await engine.predictLink(1, 2)
 * const emb = await engine.computeEmbedding(5)
 * ```
 */
export class GnnInferenceEngine {
  private sessions: Map<string, ort.InferenceSession> = new Map()
  private activeSession: ort.InferenceSession | null = null
  private activeModelName: string | null = null
  private config: Required<GnnEngineConfig>
  private encoder: FeatureEncoder | null = null
  private modelLoaded = false

  /**
   * 创建 GNN 推理引擎
   * @param config 引擎配置
   * @param encoder Optional的节点特征编码器（默认使用零向量）
   */
  constructor(
    config: GnnEngineConfig,
    encoder?: FeatureEncoder,
  ) {
    this.config = {
      featureDimension: config.featureDimension,
      embeddingDimension: config.embeddingDimension ?? DEFAULT_EMBEDDING_DIM,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    }
    this.encoder = encoder ?? null
  }

  /**
   * 加载 ONNX 模型（向后兼容，命名为 'default'）
   * @param modelPath ONNX 模型文件路径
   */
  async loadModel(modelPath: string): Promise<void> {
    if (!modelPath) {
      throw new Error('modelPath is required')
    }

    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      })
      this.sessions.set('default', session)
      this.activeSession = session
      this.activeModelName = 'default'
      this.modelLoaded = true
    } catch (err) {
      this.modelLoaded = false
      throw new Error(
        `Failed to load ONNX model from "${modelPath}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 加载命名模型，与原有 loadModel 互不干扰
   * @param name 模型名称
   * @param modelPath ONNX 模型文件路径
   */
  async loadNamedModel(name: string, modelPath: string): Promise<void> {
    if (!name) {
      throw new Error('Model name is required')
    }
    if (!modelPath) {
      throw new Error('modelPath is required')
    }
    if (name === 'default') {
      // 'default' 名称由 loadModel 管理，但允许通过 loadNamedModel 覆盖
    }

    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      })
      this.sessions.set(name, session)
      // 不自动切换激活
    } catch (err) {
      throw new Error(
        `Failed to load ONNX model "${name}" from "${modelPath}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 切换到已加载的命名模型
   * @param name 模型名称
   */
  async switchModel(name: string): Promise<void> {
    const session = this.sessions.get(name)
    if (!session) {
      throw new Error(`Model "${name}" is not loaded. Call loadNamedModel() first.`)
    }
    this.activeSession = session
    this.activeModelName = name
    this.modelLoaded = true
  }

  /**
   * 卸载模型
   * @param name 模型名称
   */
  async unloadModel(name: string): Promise<void> {
    if (!this.sessions.has(name)) {
      throw new Error(`Model "${name}" is not loaded.`)
    }
    // 如果卸载的是当前激活的模型，清除激活状态
    if (this.activeModelName === name) {
      this.activeSession = null
      this.activeModelName = null
      this.modelLoaded = false
    }
    this.sessions.delete(name)
  }

  /**
   * 返回已加载的模型名字列表
   */
  getLoadedModels(): string[] {
    return Array.from(this.sessions.keys())
  }

  /**
   * 返回当前激活的模型名
   */
  getActiveModel(): string | null {
    return this.activeModelName
  }

  /**
   * 检查模型是否已加载
   */
  get isLoaded(): boolean {
    return this.modelLoaded && this.activeSession !== null
  }

  /**
   * 链接预测 —— 评估两个节点之间存在边的概率
   *
   * 对于 ONNX 模型，典型的输入格式为：
   * - input_node_features: [2, feature_dim] 拼接的特征向量
   * - 或 source_features, target_features 分开的输入
   *
   * @param source 源Node ID
   * @param target 目标Node ID
   * @returns 链接预测结果（概率 [0,1] + logit）
   */
  async predictLink(
    source: NodeId,
    target: NodeId,
  ): Promise<LinkPredictionResult> {
    this.ensureLoaded()

    const sourceEmb = this.encodeNodeFeatures(source)
    const targetEmb = this.encodeNodeFeatures(target)

    return this.runLinkPrediction(sourceEmb, targetEmb)
  }

  /**
   * 计算节点嵌入向量
   *
   * 利用 GNN 模型的前向传播计算节点的嵌入表示。
   * 即使节点在训练时不可见（未见节点），也能通过其特征计算嵌入。
   *
   * @param nodeId Node ID
   * @returns 嵌入向量
   */
  async computeEmbedding(nodeId: NodeId): Promise<Float32Array> {
    this.ensureLoaded()

    const features = this.encodeNodeFeatures(nodeId)

    // 构建 ONNX 推理输入
    const feeds: Record<string, ort.Tensor> = {}

    // 尝试推断模型输入名称
    const inputNames = this.activeSession!.inputNames

    if (inputNames.length === 0) {
      throw new Error('Model has no input nodes')
    }

    // 单输入模型：直接传入特征
    if (inputNames.length === 1) {
      feeds[inputNames[0]] = new ort.Tensor(
        'float32',
        features,
        [1, features.length],
      )
    } else {
      // 多输入模型：期望 feature 输入
      const featureInput = inputNames.find(
        (n) =>
          n.toLowerCase().includes('feature') ||
          n.toLowerCase().includes('input') ||
          n.toLowerCase().includes('node'),
      )
      if (featureInput) {
        feeds[featureInput] = new ort.Tensor(
          'float32',
          features,
          [1, features.length],
        )
      } else {
        feeds[inputNames[0]] = new ort.Tensor(
          'float32',
          features,
          [1, features.length],
        )
      }
    }

    const results = await this.activeSession!.run(feeds)
    const outputNames = this.activeSession!.outputNames
    const embeddingOutput = outputNames.find(
      (n) =>
        n.toLowerCase().includes('embed') ||
        n.toLowerCase().includes('output') ||
        n.toLowerCase().includes('representation'),
    ) ?? outputNames[0]

    const outputTensor = results[embeddingOutput]
    if (!outputTensor) {
      throw new Error(
        `Expected output "${embeddingOutput}" not found in model outputs`,
      )
    }

    // 返回嵌入向量（展平为一维 Float32Array）
    const data = outputTensor.data as Float32Array
    const dim = this.config.embeddingDimension
    const result = new Float32Array(dim)
    for (let i = 0; i < Math.min(data.length, dim); i++) {
      result[i] = data[i]
    }

    return result
  }

  /**
   * 批量链接预测
   * @param pairs 节点对列表
   * @returns 每个节点对的预测概率
   */
  async predictLinksBatch(
    pairs: Array<[NodeId, NodeId]>,
  ): Promise<LinkPredictionResult[]> {
    this.ensureLoaded()

    const results: LinkPredictionResult[] = []
    const batchSize = this.config.batchSize

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize)
      const batchPromises = batch.map(([src, tgt]) =>
        this.predictLink(src, tgt),
      )
      const batchResults = await Promise.all(batchPromises)
      results.push(...batchResults)
    }

    return results
  }

  /**
   * 基于链接预测的个性化推荐
   *
   * 对候选节点列表做链接预测评分，返回 Top-K
   *
   * @param startNode 起始节点
   * @param candidates 候选节点列表
   * @param topK 返回 Top-K 结果
   * @returns 排序后的推荐结果
   */
  async recommend(
    startNode: NodeId,
    candidates: NodeId[],
    topK: number = 10,
  ): Promise<Array<{ nodeId: NodeId; score: number }>> {
    if (candidates.length === 0) {
      return []
    }

    const pairs: Array<[NodeId, NodeId]> = candidates.map(
      (candidate) => [startNode, candidate] as [NodeId, NodeId],
    )
    const predictions = await this.predictLinksBatch(pairs)

    const scored = candidates.map((nodeId, i) => ({
      nodeId,
      score: predictions[i].probability,
    }))

    // 按概率降序排序
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, topK)
  }

  /**
   * 设置图数据访问器（用于获取所有Node ID）
   * @param getAllNodeIds 返回图中所有Node ID 的函数
   */
  setGraphAccessor(getAllNodeIds: () => number[]): void {
    this._getAllNodeIds = getAllNodeIds
  }

  private _getAllNodeIds: (() => number[]) | null = null

  /**
   * 批量节点分类
   *
   * 对每个 nodeId 提取特征，运行 ONNX 推理，将 softmax 输出 argmax 映射到 label 名。
   *
   * @param nodeIds Node ID 列表
   * @param labelNames 标签名称列表（顺序与模型输出类对应）
   * @returns 节点分类结果列表（不存在的节点被跳过）
   */
  async classifyNodes(
    nodeIds: number[],
    labelNames: string[],
  ): Promise<NodeClassificationResult[]> {
    this.ensureLoaded()

    if (nodeIds.length === 0) {
      return []
    }

    if (labelNames.length === 0) {
      throw new Error('labelNames must not be empty')
    }

    const results: NodeClassificationResult[] = []

    for (const nodeId of nodeIds) {
      try {
        const features = this.encodeNodeFeatures(nodeId)
        const confidences = await this._runMultiClassInference(features, labelNames)
        results.push({
          nodeId,
          predictLabel: confidences[0].label,
          confidences: Object.fromEntries(confidences.map(c => [c.label, c.confidence])),
        })
      } catch {
        // 节点不存在或无法编码 — 跳过
        continue
      }
    }

    return results
  }

  /**
   * 图分类
   *
   * 获取图中所有节点的特征，按指定聚合方式（mean | max | sum）合并为全局嵌入，
   * 运行 ONNX 推理得到图级分类结果。
   *
   * @param aggregation 聚合方式：'mean' | 'max' | 'sum'
   * @param labelNames 标签名称列表
   * @returns 图分类结果
   */
  async classifyGraph(
    aggregation: 'mean' | 'max' | 'sum',
    labelNames: string[],
  ): Promise<GraphClassificationResult> {
    this.ensureLoaded()

    if (!labelNames || labelNames.length === 0) {
      throw new Error('labelNames must not be empty')
    }

    // 获取所有Node ID
    const getAllNodeIds = this._getAllNodeIds
    if (!getAllNodeIds) {
      throw new Error('Graph accessor not set. Call setGraphAccessor() first.')
    }

    const allNodeIds = getAllNodeIds()
    if (allNodeIds.length === 0) {
      // 无节点时，返回全零 confidence
      const zeroConfidences = Object.fromEntries(labelNames.map(l => [l, 0]))
      return { predictLabel: labelNames[0], confidences: zeroConfidences }
    }

    // 收集所有节点特征
    const embeddings: Float32Array[] = []
    for (const nodeId of allNodeIds) {
      try {
        const features = this.encodeNodeFeatures(nodeId)
        embeddings.push(features)
      } catch {
        // 跳过无法编码的节点
        continue
      }
    }

    if (embeddings.length === 0) {
      const zeroConfidences = Object.fromEntries(labelNames.map(l => [l, 0]))
      return { predictLabel: labelNames[0], confidences: zeroConfidences }
    }

    // 聚合
    const dim = this.config.featureDimension
    const aggregated = new Float32Array(dim)
    if (aggregation === 'mean' || aggregation === 'sum') {
      for (const emb of embeddings) {
        for (let i = 0; i < dim; i++) {
          aggregated[i] += emb[i]
        }
      }
      if (aggregation === 'mean' && embeddings.length > 0) {
        for (let i = 0; i < dim; i++) {
          aggregated[i] /= embeddings.length
        }
      }
    } else if (aggregation === 'max') {
      for (let i = 0; i < dim; i++) {
        let maxVal = -Infinity
        for (const emb of embeddings) {
          if (emb[i] > maxVal) maxVal = emb[i]
        }
        aggregated[i] = maxVal === -Infinity ? 0 : maxVal
      }
    }

    // 运行 ONNX 推理获取预测
    const confidences = await this._runMultiClassInference(aggregated, labelNames)
    return {
      predictLabel: confidences[0].label,
      confidences: Object.fromEntries(confidences.map(c => [c.label, c.confidence])),
    }
  }

  /**
   * 获取配置Info
   */
  getConfig(): GnnEngineConfig {
    return { ...this.config }
  }

  /**
   * 设置或更新特征编码器
   */
  setEncoder(encoder: FeatureEncoder): void {
    this.encoder = encoder
  }

  /**
   * 释放模型资源
   */
  async dispose(): Promise<void> {
    // Always release every resource: active session state AND the full session
    // registry. The previous guard (`if (this.activeSession)`) leaked named
    // sessions that were loaded but never activated (activeSession == null).
    this.activeSession = null
    this.activeModelName = null
    this.modelLoaded = false
    this.sessions.clear()
  }

  // ── Private Helpers ──────────────────────

  private ensureLoaded(): void {
    if (!this.modelLoaded || !this.activeSession) {
      throw new Error(
        'GNN model not loaded. Call loadModel() first with a valid ONNX model path.',
      )
    }
  }

  /**
   * 将Node ID 编码为特征向量
   * - If any自定义编码器，使用之
   * - 否则返回零向量
   */
  private encodeNodeFeatures(nodeId: NodeId): Float32Array {
    if (this.encoder) {
      return this.encoder(nodeId)
    }

    // 默认零向量
    return new Float32Array(this.config.featureDimension)
  }

  /**
   * 执行链接预测的 ONNX 推理
   */
  private async runLinkPrediction(
    sourceEmb: Float32Array,
    targetEmb: Float32Array,
  ): Promise<LinkPredictionResult> {
    const session = this.activeSession!
    const inputNames = session.inputNames

    // 拼接源和目标特征作为模型输入
    const combinedFeatures = new Float32Array(
      sourceEmb.length + targetEmb.length,
    )
    combinedFeatures.set(sourceEmb)
    combinedFeatures.set(targetEmb, sourceEmb.length)

    const feeds: Record<string, ort.Tensor> = {}

    // 推断模型输入格式
    if (inputNames.length === 1) {
      // 单输入模型：拼接特征
      feeds[inputNames[0]] = new ort.Tensor(
        'float32',
        combinedFeatures,
        [1, combinedFeatures.length],
      )
    } else if (inputNames.length >= 2) {
      // 双输入模型：源和目标特征分开
      const srcInput = inputNames.find(
        (n) =>
          n.toLowerCase().includes('source') ||
          n.toLowerCase().includes('src') ||
          n.toLowerCase().includes('a'),
      ) ?? inputNames[0]
      const tgtInput = inputNames.find(
        (n) =>
          n.toLowerCase().includes('target') ||
          n.toLowerCase().includes('tgt') ||
          n.toLowerCase().includes('dst') ||
          n.toLowerCase().includes('b'),
      ) ?? inputNames[1]

      feeds[srcInput] = new ort.Tensor('float32', sourceEmb, [
        1,
        sourceEmb.length,
      ])
      feeds[tgtInput] = new ort.Tensor('float32', targetEmb, [
        1,
        targetEmb.length,
      ])
    }

    const results = await session.run(feeds)

    // 获取输出 —— 通常是一个 sigmoid 概率值
    const outputName =
      session.outputNames.find(
        (n) =>
          n.toLowerCase().includes('prob') ||
          n.toLowerCase().includes('score') ||
          n.toLowerCase().includes('output'),
      ) ?? session.outputNames[0]

    const outputTensor = results[outputName]
    if (!outputTensor) {
      throw new Error(
        `Expected output "${outputName}" not found in model outputs`,
      )
    }

    const data = outputTensor.data as Float32Array
    const logit = data.length > 0 ? data[0] : 0

    // 如果输出已经是概率（sigmoid 激活），直接使用
    // 否则通过 sigmoid 归一化到 [0, 1]
    const probability = logistic(logit)

    return {
      probability: clamp(probability, 0, 1),
      logit,
    }
  }

  /**
   * 执行多分类 ONNX 推理
   *
   * 输入: [1, featureDimension] 特征向量
   * 输出: [1, numClasses] softmax 概率
   *
   * @param features 特征向量
   * @param labelNames 标签名称列表
   * @returns 按置信度降序排列的标签-置信度对
   */
  private async _runMultiClassInference(
    features: Float32Array,
    labelNames: string[],
  ): Promise<Array<{ label: string; confidence: number }>> {
    const session = this.activeSession!
    const inputNames = session.inputNames

    // 构建输入 feeds
    const feeds: Record<string, ort.Tensor> = {}

    // 如果模型有多个输入，尝试匹配特征输入
    if (inputNames.length === 1) {
      feeds[inputNames[0]] = new ort.Tensor(
        'float32',
        features,
        [1, features.length],
      )
    } else {
      const featureInput = inputNames.find(
        (n) =>
          n.toLowerCase().includes('feature') ||
          n.toLowerCase().includes('input') ||
          n.toLowerCase().includes('data'),
      ) ?? inputNames[0]
      feeds[featureInput] = new ort.Tensor('float32', features, [
        1,
        features.length,
      ])
    }

    // 运行推理
    const results = await session.run(feeds)
    const outputName = session.outputNames[0]
    const outputTensor = results[outputName]

    if (!outputTensor) {
      throw new Error(`Expected output "${outputName}" not found in model outputs`)
    }

    const data = outputTensor.data as Float32Array
    const numClasses = Math.min(labelNames.length, data.length)

    // 对输出应用 softmax 得到概率分布
    const probabilities = softmax(Array.from(data).slice(0, numClasses))

    // 构造 label -> confidence 映射
    const labelConfidences = labelNames.slice(0, numClasses).map((label, i) => ({
      label,
      confidence: probabilities[i],
    }))

    // 按置信度降序排列
    labelConfidences.sort((a, b) => b.confidence - a.confidence)

    return labelConfidences
  }
}

// ── 工具函数 ──────────────────────────────

/**
 * Logistic (sigmoid) 函数
 */
function logistic(x: number): number {
  // 防止 exp 溢出
  if (x > 0) {
    return 1 / (1 + Math.exp(-x))
  }
  const ex = Math.exp(x)
  return ex / (1 + ex)
}

/**
 * 将值限定在 [min, max] 范围内
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Softmax 函数 */
function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits)
  const exps = logits.map((l) => Math.exp(l - maxLogit))
  const sumExps = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => (sumExps > 0 ? e / sumExps : 0))
}
