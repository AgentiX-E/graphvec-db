// ============================================================
// gnn-engine.integration.spec.ts — GnnInferenceEngine 真实 ONNX 集成测试
//
// 使用 /tmp/minimal_gnn.onnx（ReduceMean → Sigmoid 模型）做端到端真实推理。
// 绝不使用 vi.mock 或 vi.fn。
// ============================================================

import { describe, it, expect, beforeAll } from 'vitest'
import { GnnInferenceEngine, type FeatureEncoder } from './gnn-engine'

/** 模型路径（由 tasks build-onnx.sh 生成） */
const MODEL_PATH = '/tmp/minimal_gnn.onnx'

/**
 * 模型结构：
 *   Input:  input  shape=[1, 32]  float32
 *   Nodes:  ReduceMean → Sigmoid
 *   Output: output shape=[1, 1]   float32
 *
 * 对于 predictLink:
 *   - 拼接 source + target 特征，得到 shape [1, 32]
 *   - 所以 featureDimension = 16（16 + 16 = 32）
 *
 * 对于 computeEmbedding:
 *   - 单输入 shape [1, featureDimension]
 *   - 需要 featureDimension = 32 才能匹配模型输入
 */

// ── 常量 ──────────────────────────────────

/**
 * engine.runLinkPrediction() 的逻辑：
 *   1. ONNX 模型输出 sigmoid(mean)   ← 因为是 ReduceMean → Sigmoid
 *   2. 引擎读取该输出作为 "logit"，然后再次调用 logistic()（sigmoid）
 *   所以：引擎最终输出 = sigmoid(sigmoid(mean))
 */

/** sigmoid(sigmoid(1)) ≈ sigmoid(0.7310586) ≈ 0.675 */
const PROB_ALL1 = 1 / (1 + Math.exp(-(1 / (1 + Math.exp(-1)))))

/** sigmoid(sigmoid(0)) = sigmoid(0.5) ≈ 0.622 */
const PROB_ALL0 = 1 / (1 + Math.exp(-0.5))

/** sigmoid(sigmoid(-10)) ≈ sigmoid(4.5398e-5) ≈ 0.500011 */
const PROB_NEG10 = 1 / (1 + Math.exp(-(1 / (1 + Math.exp(10)))))

// ── Encoder 工厂 ──────────────────────────

/**
 * 创建一个编码器，为任何节点返回恒定的特征向量。
 * @param val 每个维度的值
 * @param dim 特征维度
 */
function constantEncoder(val: number, dim: number): FeatureEncoder {
  return () => {
    const arr = new Float32Array(dim)
    arr.fill(val)
    return arr
  }
}

// ── Tests ─────────────────────────────────

describe('GnnInferenceEngine — real ONNX integration', () => {
  const featureDim = 16 // source + target = 32 = 模型输入
  const embedDim = 32  // computeEmbedding 需要的特征维度

  // ── predictLink 引擎 ──────────────────

  let engineAll1: GnnInferenceEngine
  let engineAll0: GnnInferenceEngine
  let engineNeg10: GnnInferenceEngine

  beforeAll(async () => {
    engineAll1 = new GnnInferenceEngine(
      { featureDimension: featureDim },
      constantEncoder(1, featureDim),
    )
    await engineAll1.loadModel(MODEL_PATH)

    engineAll0 = new GnnInferenceEngine(
      { featureDimension: featureDim },
      constantEncoder(0, featureDim),
    )
    await engineAll0.loadModel(MODEL_PATH)

    engineNeg10 = new GnnInferenceEngine(
      { featureDimension: featureDim },
      constantEncoder(-10, featureDim),
    )
    await engineNeg10.loadModel(MODEL_PATH)
  })

  // ── predictLink — 全 1 ───────────────

  it('predictLink: all-1 features → prob ≈ sigmoid(sigmoid(1)) = 0.675', async () => {
    const result = await engineAll1.predictLink('A', 'B')
    // ONNX 输出 sigmoid(1) ≈ 0.731，引擎当作 logit 再次 sigmoid → 0.675
    expect(result.probability).toBeGreaterThan(0.5)
    expect(result.probability).toBeLessThan(0.8)
    expect(result.probability).toBeCloseTo(PROB_ALL1, 3)
    expect(result.logit).toBeCloseTo(1 / (1 + Math.exp(-1)), 3)
  })

  // ── predictLink — 全 0 ───────────────

  it('predictLink: all-0 features → prob ≈ sigmoid(sigmoid(0)) = 0.622', async () => {
    const result = await engineAll0.predictLink('X', 'Y')
    // ONNX 输出 sigmoid(0) = 0.5，引擎当作 logit 再次 sigmoid → 0.622
    expect(result.probability).toBeCloseTo(PROB_ALL0, 3)
    expect(result.probability).toBeGreaterThan(0.5)
    // ONNX 输出 sigmoid(0) = 0.5，引擎作为 "logit" 读取
    expect(result.logit).toBe(0.5)
  })

  // ── predictLink — 全 -10 ─────────────

  it('predictLink: all-(-10) features → prob ≈ sigmoid(sigmoid(-10)) ≈ 0.5', async () => {
    const result = await engineNeg10.predictLink('M', 'N')
    // ONNX 输出 sigmoid(-10) ≈ 4.5e-5，引擎当作 logit → sigmoid(~0) ≈ 0.5
    // 所以概率接近 0.5（非 0！），这正好揭示了 engine 对已用 sigmoid 的输出重复归一化的问题
    expect(result.probability).toBeGreaterThan(0.4)
    expect(result.probability).toBeLessThan(0.6)
    expect(result.probability).toBeCloseTo(PROB_NEG10, 3)
    expect(result.logit).toBeLessThan(0.001)
  })

  // ── predictLinksBatch — 多对输入 ────

  it('predictLinksBatch: returns correct results for multiple pairs', async () => {
    const pairs: Array<[string, string]> = [
      ['A', 'B'],
      ['C', 'D'],
      ['E', 'F'],
    ]
    const results = await engineAll1.predictLinksBatch(pairs)

    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.probability).toBeCloseTo(PROB_ALL1, 2)
    }
  })

  // ── recommend — 排序验证 ────────────

  it('recommend: returns sorted results (higher encoder value → higher prob)', async () => {
    // 创建编码器：不同节点不同特征值
    const encoder: FeatureEncoder = (nodeId: string) => {
      const arr = new Float32Array(featureDim)
      // 节点 'B' 给更高特征值
      if (nodeId === 'B') arr.fill(5)
      else if (nodeId === 'C') arr.fill(3)
      else arr.fill(1) // 'A', 'D', 'E', 'F'...
      return arr
    }

    const engine = new GnnInferenceEngine(
      { featureDimension: featureDim },
      encoder,
    )
    await engine.loadModel(MODEL_PATH)

    const result = await engine.recommend('A', ['B', 'C', 'D'], 2)

    expect(result).toHaveLength(2)
    // B (特征=5) 应该排在 C (特征=3) 前面
    expect(result[0].nodeId).toBe('B')
    expect(result[0].score).toBeGreaterThan(result[1].score)
  })

  // ── computeEmbedding — 返回值类型 ───

  it('computeEmbedding: returns Float32Array with correct length', async () => {
    // 创建单独引擎，featureDimension=32 匹配模型输入
    const engine = new GnnInferenceEngine(
      { featureDimension: embedDim },
      constantEncoder(1, embedDim),
    )
    await engine.loadModel(MODEL_PATH)

    const embedding = await engine.computeEmbedding('N1')

    expect(embedding).toBeInstanceOf(Float32Array)
    expect(embedding.length).toBe(128) // 默认 embeddingDimension
  })

  // ── unloaded engine 报错 ────────────

  it('predictLink: throws when model not loaded', async () => {
    const engine = new GnnInferenceEngine({ featureDimension: 16 })
    await expect(engine.predictLink('A', 'B')).rejects.toThrow(
      'GNN model not loaded',
    )
  })

  it('computeEmbedding: throws when model not loaded', async () => {
    const engine = new GnnInferenceEngine({ featureDimension: 16 })
    await expect(engine.computeEmbedding('A')).rejects.toThrow(
      'GNN model not loaded',
    )
  })

  it('predictLinksBatch: throws when model not loaded', async () => {
    const engine = new GnnInferenceEngine({ featureDimension: 16 })
    await expect(
      engine.predictLinksBatch([['A', 'B']]),
    ).rejects.toThrow('GNN model not loaded')
  })

  it('recommend: throws when model not loaded (non-empty candidates)', async () => {
    const engine = new GnnInferenceEngine({ featureDimension: 16 })
    await expect(engine.recommend('A', ['B'])).rejects.toThrow(
      'GNN model not loaded',
    )
  })

  // ── 加载后多次推理结果一致（确定性）─

  it('deterministic: same input produces same output across multiple calls', async () => {
    const engine = new GnnInferenceEngine(
      { featureDimension: featureDim },
      constantEncoder(0.5, featureDim),
    )
    await engine.loadModel(MODEL_PATH)

    const r1 = await engine.predictLink('A', 'B')
    const r2 = await engine.predictLink('A', 'B')
    const r3 = await engine.predictLink('A', 'B')

    expect(r1.probability).toBe(r2.probability)
    expect(r2.probability).toBe(r3.probability)
    expect(r1.logit).toBe(r2.logit)
  })

  // ── model path 为空/无效 ────────────

  it('loadModel: rejects empty path', async () => {
    const engine = new GnnInferenceEngine({ featureDimension: 16 })
    await expect(engine.loadModel('')).rejects.toThrow('modelPath is required')
  })

  it('loadModel: rejects non-existent path', async () => {
    const engine = new GnnInferenceEngine({ featureDimension: 16 })
    await expect(
      engine.loadModel('/nonexistent/path.onnx'),
    ).rejects.toThrow(/Failed to load ONNX model/)
  })
})
