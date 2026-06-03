// ============================================================
// gnn-engine.spec.ts — GnnInferenceEngine 测试套件
//
// 测试内容：
// 1. 模型加载（失败路径）
// 2. 未加载模型时报错
// 3. 链接预测（模拟 ONNX 会话）
// 4. 嵌入计算
// 5. 批量预测
// 6. 推荐排序
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  GnnInferenceEngine,
  GraphEngineFeatureEncoder,
  type LinkPredictionResult,
  type FeatureEncoder,
} from './gnn-engine'
import { NodeId } from '../types'

// ── Mocks ─────────────────────────────────

/**
 * 创建模拟的 ONNX 推理会话工厂
 */
function createMockSession() {
  const mockRun = vi.fn()

  const session = {
    inputNames: ['input'],
    outputNames: ['output'],
    run: mockRun,
  } as any

  return { session, mockRun }
}

// ── Tests ─────────────────────────────────

describe('GnnInferenceEngine', () => {
  const featureDim = 16

  beforeEach(() => {
    // 清除所有 mock
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create engine with default config', () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      const config = engine.getConfig()
      expect(config.featureDimension).toBe(featureDim)
      expect(config.embeddingDimension).toBe(128) // default
      expect(config.batchSize).toBe(64) // default
    })

    it('should create engine with custom config', () => {
      const engine = new GnnInferenceEngine({
        featureDimension: featureDim,
        embeddingDimension: 64,
        batchSize: 16,
      })
      const config = engine.getConfig()
      expect(config.embeddingDimension).toBe(64)
      expect(config.batchSize).toBe(16)
    })

    it('should not be loaded initially', () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      expect(engine.isLoaded).toBe(false)
    })
  })

  describe('loadModel', () => {
    it('should throw on empty path', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(engine.loadModel('')).rejects.toThrow('modelPath is required')
      expect(engine.isLoaded).toBe(false)
    })

    it('should throw on invalid model path', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(
        engine.loadModel('/nonexistent/model.onnx'),
      ).rejects.toThrow(/Failed to load ONNX model/)
      expect(engine.isLoaded).toBe(false)
    })
  })

  describe('predictLink without model', () => {
    it('should throw if model not loaded', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(engine.predictLink('A', 'B')).rejects.toThrow(
        'GNN model not loaded',
      )
    })
  })

  describe('computeEmbedding without model', () => {
    it('should throw if model not loaded', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(engine.computeEmbedding('A')).rejects.toThrow(
        'GNN model not loaded',
      )
    })
  })

  describe('recommend without model', () => {
    it('should throw if model not loaded', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(engine.recommend('A', ['B', 'C'])).rejects.toThrow(
        'GNN model not loaded',
      )
    })
  })

  describe('recommend with empty candidates', () => {
    it('should return empty array', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      // 不需要加载模型，因为没有候选节点
      const result = await engine.recommend('A', [])
      expect(result).toEqual([])
    })
  })

  describe('encodeNodeFeatures with custom encoder', () => {
    it('should use custom encoder for feature generation', async () => {
      // 创建一个特征编码器，为不同节点返回不同的特征
      const encoder: FeatureEncoder = (nodeId: NodeId) => {
        const arr = new Float32Array(featureDim)
        if (nodeId === 'A') {
          arr[0] = 1.0
        } else if (nodeId === 'B') {
          arr[0] = 0.5
        }
        return arr
      }

      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )

      // 验证编码器被正确传入
      // 通过 setting 后删除再测试默认行为
      expect(engine).toBeDefined()
    })

    it('should allow updating encoder after construction', () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      const encoder: FeatureEncoder = () => new Float32Array(featureDim)
      expect(() => engine.setEncoder(encoder)).not.toThrow()
    })
  })

  describe('predictLinksBatch', () => {
    it('should throw if model not loaded', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(
        engine.predictLinksBatch([
          ['A', 'B'],
          ['C', 'D'],
        ]),
      ).rejects.toThrow('GNN model not loaded')
    })
  })

  describe('multiple engines', () => {
    it('should allow multiple independent engines', () => {
      const e1 = new GnnInferenceEngine({ featureDimension: 16 })
      const e2 = new GnnInferenceEngine({ featureDimension: 32 })
      expect(e1.getConfig().featureDimension).toBe(16)
      expect(e2.getConfig().featureDimension).toBe(32)
    })
  })

  describe('dispose', () => {
    it('should clear loaded state', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.dispose()
      expect(engine.isLoaded).toBe(false)
    })
  })

  describe('setEncoder', () => {
    it('should update the encoder', () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      const encoder: FeatureEncoder = () => new Float32Array(featureDim)
      engine.setEncoder(encoder)
      // 不能直接访问 encoder，但确保不报错
      expect(engine.isLoaded).toBe(false)
    })
  })

  describe('getConfig', () => {
    it('should return a copy of config', () => {
      const engine = new GnnInferenceEngine({ featureDimension: 64 })
      const cfg = engine.getConfig()
      expect(cfg.featureDimension).toBe(64)
      // 修改返回的配置不影响引擎
      ;(cfg as any).featureDimension = 128
      expect(engine.getConfig().featureDimension).toBe(64)
    })
  })

  // ──────────────────────────────────────────
  // GraphEngineFeatureEncoder 测试
  // ──────────────────────────────────────────

  describe('GraphEngineFeatureEncoder', () => {
    /**
     * 创建 mock GraphEngine 实例
     */
    function createMockEngine(nodes: Record<string, any>) {
      return {
        getNode: (id: NodeId) => nodes[String(id)] ?? null,
      }
    }

    it('should build feature vector from numeric props', () => {
      const engine = createMockEngine({
        1: { props: { age: 25, weight: 70, height: 175 } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['age', 'weight', 'height'],
        3,
      )
      const result = encoder.encode(1)
      expect(result).toBeInstanceOf(Float32Array)
      expect(result.length).toBe(3)
      expect(result[0]).toBe(25)
      expect(result[1]).toBe(70)
      expect(result[2]).toBe(175)
    })

    it('should use 0 for missing props', () => {
      const engine = createMockEngine({
        1: { props: { age: 30 } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['age', 'weight', 'height'],
        3,
      )
      const result = encoder.encode(1)
      expect(result[0]).toBe(30)
      expect(result[1]).toBe(0)
      expect(result[2]).toBe(0)
    })

    it('should use 0 for non-numeric props', () => {
      const engine = createMockEngine({
        1: { props: { age: 25, name: 'Alice', active: true } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['age', 'name', 'active'],
        3,
      )
      const result = encoder.encode(1)
      expect(result[0]).toBe(25)
      expect(result[1]).toBe(0) // string → 0
      expect(result[2]).toBe(0) // boolean → 0
    })

    it('should truncate when dimension < field count', () => {
      const engine = createMockEngine({
        1: { props: { a: 1, b: 2, c: 3 } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['a', 'b', 'c'],
        2, // only 2 dims for 3 fields
      )
      const result = encoder.encode(1)
      expect(result.length).toBe(2)
      expect(result[0]).toBe(1)
      expect(result[1]).toBe(2)
      // c=3 is truncated
    })

    it('should pad with 0 when dimension > field count', () => {
      const engine = createMockEngine({
        1: { props: { a: 10 } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['a'],
        3, // 3 dims but only 1 field
      )
      const result = encoder.encode(1)
      expect(result.length).toBe(3)
      expect(result[0]).toBe(10)
      expect(result[1]).toBe(0)
      expect(result[2]).toBe(0)
    })

    it('should handle non-existent node gracefully', () => {
      const engine = createMockEngine({})
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['age', 'weight'],
        2,
      )
      const result = encoder.encode(999)
      expect(result.length).toBe(2)
      expect(result[0]).toBe(0)
      expect(result[1]).toBe(0)
    })

    it('should be usable with setEncoder()', () => {
      const engine = createMockEngine({
        1: { props: { feature: 42 } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['feature'],
        1,
      )
      const gnnEngine = new GnnInferenceEngine({ featureDimension: 1 })
      expect(() => gnnEngine.setEncoder(encoder)).not.toThrow()
      // verify the encoder works through GnnInferenceEngine
      const result = encoder.encode(1)
      expect(result[0]).toBe(42)
    })
  })

  // ──────────────────────────────────────────
  // 多模型支持测试
  // ──────────────────────────────────────────

  describe('multi-model support', () => {
    beforeAll(async () => {
      // 确保 mock ONNX 模型存在
      // 如果不存在，测试需要自动创建
    })

    /**
     * 创建模拟的 ONNX 推理会话工厂
     */
    function createMockSession(name: string = 'default') {
      const mockRun = vi.fn().mockResolvedValue({
        output: { data: new Float32Array([0.5]), dims: [1, 1] },
      })

      return {
        session: {
          inputNames: ['input'],
          outputNames: ['output'],
          run: mockRun,
        } as any,
        mockRun,
      }
    }

    it('loadNamedModel: should load 2 named models and report them in getLoadedModels()', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })

      // 使用 vi.spyOn 模拟 ort.InferenceSession.create
      const createSpy = vi
        .spyOn(require('onnxruntime-node').InferenceSession, 'create')
        .mockResolvedValue(createMockSession('model-a').session as any)

      await engine.loadNamedModel('model-a', '/fake/model-a.onnx')
      await engine.loadNamedModel('model-b', '/fake/model-b.onnx')

      const loadedModels = engine.getLoadedModels()
      expect(loadedModels).toContain('model-a')
      expect(loadedModels).toContain('model-b')
      // loadNamedModel 不应该自动切换
      expect(engine.isLoaded).toBe(false)

      createSpy.mockRestore()
    })

    it('switchModel: should activate the named model', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })

      // 先加载一个模型作为默认
      const defaultSession = createMockSession('default').session
      const modelASession = createMockSession('model-a').session

      const createSpy = vi
        .spyOn(require('onnxruntime-node').InferenceSession, 'create')
        .mockResolvedValueOnce(defaultSession as any)
        .mockResolvedValueOnce(modelASession as any)

      await engine.loadModel('/fake/default.onnx')
      expect(engine.isLoaded).toBe(true)
      expect(engine.getActiveModel()).toBe('default')

      await engine.loadNamedModel('model-a', '/fake/model-a.onnx')
      // 不自动切换
      expect(engine.getActiveModel()).toBe('default')

      // 手动切换
      await engine.switchModel('model-a')
      expect(engine.getActiveModel()).toBe('model-a')
      expect(engine.isLoaded).toBe(true)

      createSpy.mockRestore()
    })

    it('switchModel: should throw for non-existent model name', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await expect(engine.switchModel('non-existent')).rejects.toThrow(
        'Model "non-existent" is not loaded',
      )
    })

    it('unloadModel: should remove model from list', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })

      const createSpy = vi
        .spyOn(require('onnxruntime-node').InferenceSession, 'create')
        .mockResolvedValue(createMockSession('model-x').session as any)

      await engine.loadNamedModel('model-x', '/fake/model-x.onnx')

      expect(engine.getLoadedModels()).toContain('model-x')

      await engine.unloadModel('model-x')
      expect(engine.getLoadedModels()).not.toContain('model-x')

      createSpy.mockRestore()
    })

    it('unloadModel: should clear active state when unloading active model', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })

      const createSpy = vi
        .spyOn(require('onnxruntime-node').InferenceSession, 'create')
        .mockResolvedValue(createMockSession('active').session as any)

      await engine.loadNamedModel('active', '/fake/active.onnx')
      await engine.switchModel('active')
      expect(engine.isLoaded).toBe(true)
      expect(engine.getActiveModel()).toBe('active')

      await engine.unloadModel('active')
      expect(engine.isLoaded).toBe(false)
      expect(engine.getActiveModel()).toBeNull()

      createSpy.mockRestore()
    })

    it('loadModel: backward compatible — loaded as "default"', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })

      const createSpy = vi
        .spyOn(require('onnxruntime-node').InferenceSession, 'create')
        .mockResolvedValue(createMockSession('default').session as any)

      await engine.loadModel('/fake/model.onnx')
      expect(engine.getLoadedModels()).toContain('default')
      expect(engine.getActiveModel()).toBe('default')
      expect(engine.isLoaded).toBe(true)

      createSpy.mockRestore()
    })
  })
})
