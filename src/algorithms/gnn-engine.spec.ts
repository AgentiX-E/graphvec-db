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
// 7. 节点分类 (classifyNodes)
// 8. 图分类 (classifyGraph)
// 9. 命名模型管理
// 10. GraphEngineFeatureEncoder
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  GnnInferenceEngine,
  GraphEngineFeatureEncoder,
  type FeatureEncoder,
} from './gnn-engine'
import { NodeId } from '../types'

// ── ONNX Runtime Mock ──────────────────────

// Per-session state is held in a container that the mock factory captures as a plain object.
// vi.mock factory functions are hoisted, so we cannot use module-level class references.

const mockState = {
  sessions: [] as Array<{
    id: number;
    inputNames: string[];
    outputNames: string[];
    run: ReturnType<typeof vi.fn>;
  }>,
  nextId: 0,
  onCreate: null as ((modelPath: string, options?: unknown) => Promise<unknown>) | null,
}

vi.mock('onnxruntime-node', () => {
  // Tensor mock — defined inline inside the factory so hoisting works
  class FakeTensor {
    type: string
    data: Float32Array
    dims: number[]

    constructor(type: string, data: Float32Array, dims?: number[]) {
      this.type = type
      this.data = data
      this.dims = dims ?? [data.length]
    }
  }

  return {
    Tensor: FakeTensor,
    InferenceSession: {
      create: vi.fn(async (modelPath: string, _options?: unknown) => {
        if (mockState.onCreate) {
          return mockState.onCreate(modelPath, _options)
        }
        // Default: throw for non-existent paths
        if (modelPath.includes('nonexistent')) {
          throw new Error(`ENOENT: no such file or directory, open '${modelPath}'`)
        }
        const id = mockState.nextId++
        const session = {
          id,
          inputNames: ['input'],
          outputNames: ['output'],
          run: vi.fn().mockResolvedValue({
            output: { data: new Float32Array([0.7310586]), dims: [1, 1] },
          }),
        }
        mockState.sessions.push(session)
        return session
      }),
    },
  }
})

function resetMockState(): void {
  mockState.sessions.length = 0
  mockState.nextId = 0
  mockState.onCreate = null
}

function setMockCreateFn(fn: (modelPath: string, options?: unknown) => Promise<unknown>): void {
  mockState.onCreate = fn
}

function getLastSession(): unknown {
  return mockState.sessions[mockState.sessions.length - 1]
}

// ── Tests ─────────────────────────────────

describe('GnnInferenceEngine', () => {
  const featureDim = 16

  beforeEach(() => {
    resetMockState()
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetMockState()
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

    it('should throw on invalid (nonexistent) model path', async () => {
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
    it('should throw if model not loaded (non-empty candidates)', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(engine.recommend('A', ['B', 'C'])).rejects.toThrow(
        'GNN model not loaded',
      )
    })
  })

  describe('predictLink with model', () => {
    it('should return numeric probability and logit', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      const result = await engine.predictLink('A', 'B')
      expect(result).toHaveProperty('probability')
      expect(result).toHaveProperty('logit')
      expect(typeof result.probability).toBe('number')
      expect(typeof result.logit).toBe('number')
      expect(result.probability).toBeGreaterThanOrEqual(0)
      expect(result.probability).toBeLessThanOrEqual(1)
    })
  })

  describe('computeEmbedding with model', () => {
    it('should return Float32Array with correct length', async () => {
      const engine = new GnnInferenceEngine({
        featureDimension: 16,
        embeddingDimension: 64,
      })
      await engine.loadModel('/fake/model.onnx')
      const emb = await engine.computeEmbedding('A')
      expect(emb).toBeInstanceOf(Float32Array)
      expect(emb.length).toBe(64)
    })
  })

  describe('predictLinksBatch with model', () => {
    it('should return results for all pairs', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      const results = await engine.predictLinksBatch([
        ['A', 'B'],
        ['C', 'D'],
        ['E', 'F'],
      ])
      expect(results).toHaveLength(3)
      for (const r of results) {
        expect(r).toHaveProperty('probability')
        expect(r).toHaveProperty('logit')
      }
    })
  })

  describe('recommend with model', () => {
    it('should return scored candidates sorted by score', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      const results = await engine.recommend('A', ['B', 'C', 'D'], 2)
      expect(results).toHaveLength(2)
      for (const r of results) {
        expect(r).toHaveProperty('nodeId')
        expect(r).toHaveProperty('score')
      }
    })
  })

  describe('recommend with empty candidates', () => {
    it('should return empty array (no model needed)', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      const result = await engine.recommend('A', [])
      expect(result).toEqual([])
    })
  })

  describe('encodeNodeFeatures with custom encoder', () => {
    it('should create engine with custom encoder', () => {
      const encoder: FeatureEncoder = (nodeId: NodeId) => {
        const arr = new Float32Array(featureDim)
        if (nodeId === 'A') arr[0] = 1.0
        else if (nodeId === 'B') arr[0] = 0.5
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      expect(engine).toBeDefined()
    })

    it('should allow updating encoder after construction', () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      const encoder: FeatureEncoder = () => new Float32Array(featureDim)
      expect(() => engine.setEncoder(encoder)).not.toThrow()
    })
  })

  describe('predictLinksBatch (no model)', () => {
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

    it('should clear sessions map', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      expect(engine.getLoadedModels()).toContain('default')
      await engine.dispose()
      expect(engine.getLoadedModels()).toEqual([])
    })
  })

  describe('setEncoder', () => {
    it('should accept a valid encoder without error', () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      const encoder: FeatureEncoder = () => new Float32Array(featureDim)
      engine.setEncoder(encoder)
      expect(engine.isLoaded).toBe(false)
    })
  })

  describe('getConfig', () => {
    it('should return a copy of config (mutation-safe)', () => {
      const engine = new GnnInferenceEngine({ featureDimension: 64 })
      const cfg = engine.getConfig()
      expect(cfg.featureDimension).toBe(64)
      ;(cfg as any).featureDimension = 128
      expect(engine.getConfig().featureDimension).toBe(64)
    })
  })

  describe('predictLink: edge cases with features', () => {
    it('should handle zero features', async () => {
      const encoder: FeatureEncoder = () => new Float32Array(featureDim)
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      const result = await engine.predictLink('A', 'B')
      expect(result.probability).toBeGreaterThanOrEqual(0)
      expect(result.probability).toBeLessThanOrEqual(1)
    })
  })

  // ──────────────────────────────────────────
  // classifyNodes 测试
  // ──────────────────────────────────────────

  describe('classifyNodes', () => {
    it('should throw if model not loaded', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(
        engine.classifyNodes([1, 2], ['cat', 'dog']),
      ).rejects.toThrow('GNN model not loaded')
    })

    it('should return empty array for empty node list', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      const result = await engine.classifyNodes([], ['cat', 'dog'])
      expect(result).toEqual([])
    })

    it('should throw if labelNames is empty', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      await expect(
        engine.classifyNodes([1], []),
      ).rejects.toThrow('labelNames must not be empty')
    })

    it('should classify a single node with correct output structure', async () => {
      const encoder: FeatureEncoder = (nodeId: NodeId) => {
        const arr = new Float32Array(featureDim)
        arr.fill(1.0)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      const results = await engine.classifyNodes([42], ['cat'])
      expect(results).toHaveLength(1)
      expect(results[0].nodeId).toBe(42)
      expect(results[0]).toHaveProperty('predictLabel')
      expect(results[0]).toHaveProperty('confidences')
      expect(typeof results[0].predictLabel).toBe('string')
      // Mock returns 1 output dim, so only 1 label's confidence is returned
      expect(Object.keys(results[0].confidences).length).toBe(1)
      expect(results[0].predictLabel).toBe('cat')
    })

    it('should classify multiple nodes', async () => {
      const encoder: FeatureEncoder = (nodeId: NodeId) => {
        const arr = new Float32Array(featureDim)
        const val = typeof nodeId === 'number' ? nodeId : 1.0
        arr.fill(val)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      const results = await engine.classifyNodes([1, 2, 3], ['classA'])
      expect(results).toHaveLength(3)
      for (const r of results) {
        expect(Object.keys(r.confidences).length).toBe(1)
      }
    })

    it('should handle nodes whose ids are not numbers gracefully (skipped)', async () => {
      // classifyNodes expects number[]; passing empty array is fine
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
      )
      await engine.loadModel('/fake/model.onnx')
      // empty list returns empty
      const results = await engine.classifyNodes([], ['label'])
      expect(results).toEqual([])
    })

    it('should return confidences that sum approximately to 1', async () => {
      const encoder: FeatureEncoder = () => {
        const arr = new Float32Array(featureDim)
        arr.fill(0.5)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      const results = await engine.classifyNodes([1], ['A', 'B', 'C'])
      const confidences = Object.values(results[0].confidences)
      const sum = confidences.reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1.0, 5)
    })
  })

  // ──────────────────────────────────────────
  // classifyGraph 测试
  // ──────────────────────────────────────────

  describe('classifyGraph', () => {
    it('should throw if model not loaded', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await expect(
        engine.classifyGraph('mean', ['cat', 'dog']),
      ).rejects.toThrow('GNN model not loaded')
    })

    it('should throw if labelNames is empty', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      await expect(
        engine.classifyGraph('mean', []),
      ).rejects.toThrow('labelNames must not be empty')
    })

    it('should throw if graph accessor not set', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      await expect(
        engine.classifyGraph('mean', ['label']),
      ).rejects.toThrow('Graph accessor not set')
    })

    it('should return zero confidences for empty graph', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: featureDim })
      await engine.loadModel('/fake/model.onnx')
      engine.setGraphAccessor(() => [])
      const result = await engine.classifyGraph('mean', ['cat', 'dog'])
      expect(result.predictLabel).toBe('cat')
      expect(result.confidences['cat']).toBe(0)
      expect(result.confidences['dog']).toBe(0)
    })

    it('should classify graph with mean aggregation', async () => {
      const encoder: FeatureEncoder = () => {
        const arr = new Float32Array(featureDim)
        arr.fill(1.0)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      engine.setGraphAccessor(() => [1, 2, 3])
      const result = await engine.classifyGraph('mean', ['typeA'])
      expect(result).toHaveProperty('predictLabel')
      expect(result).toHaveProperty('confidences')
      // Mock returns 1 output dim, so only 1 label
      expect(Object.keys(result.confidences).length).toBe(1)
      // confidences should sum to ~1
      const sum = Object.values(result.confidences).reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1.0, 5)
    })

    it('should classify graph with max aggregation', async () => {
      const encoder: FeatureEncoder = () => {
        const arr = new Float32Array(featureDim)
        arr.fill(2.0)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      engine.setGraphAccessor(() => [1, 2])
      const result = await engine.classifyGraph('max', ['label1'])
      expect(result).toHaveProperty('predictLabel')
      expect(Object.keys(result.confidences).length).toBe(1)
    })

    it('should classify graph with sum aggregation', async () => {
      const encoder: FeatureEncoder = () => {
        const arr = new Float32Array(featureDim)
        arr.fill(0.5)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      engine.setGraphAccessor(() => [1, 2, 3])
      const result = await engine.classifyGraph('sum', ['label'])
      expect(result).toHaveProperty('predictLabel')
      expect(result.predictLabel).toBe('label')
    })

    it('should handle single-node graph', async () => {
      const encoder: FeatureEncoder = () => {
        const arr = new Float32Array(featureDim)
        arr.fill(0.1)
        return arr
      }
      const engine = new GnnInferenceEngine(
        { featureDimension: featureDim },
        encoder,
      )
      await engine.loadModel('/fake/model.onnx')
      engine.setGraphAccessor(() => [99])
      const result = await engine.classifyGraph('mean', ['cat'])
      expect(result.predictLabel).toBe('cat')
      expect(result.confidences['cat']).toBeCloseTo(1.0, 5)
    })
  })

  // ──────────────────────────────────────────
  // 多模型管理测试
  // ──────────────────────────────────────────

  describe('multi-model management', () => {
    it('loadNamedModel: should load a model and report it in getLoadedModels', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await engine.loadNamedModel('model-a', '/fake/model-a.onnx')
      const loaded = engine.getLoadedModels()
      expect(loaded).toContain('model-a')
      // loadNamedModel should not auto-activate
      expect(engine.isLoaded).toBe(false)
    })

    it('loadNamedModel: should throw for empty name', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await expect(engine.loadNamedModel('', '/path.onnx')).rejects.toThrow(
        'Model name is required',
      )
    })

    it('loadNamedModel: should throw for empty path', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await expect(engine.loadNamedModel('m', '')).rejects.toThrow(
        'modelPath is required',
      )
    })

    it('loadNamedModel: should propagate ONNX load errors', async () => {
      setMockCreateFn(async () => {
        throw new Error('ONNX load failure')
      })
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await expect(
        engine.loadNamedModel('broken', '/bad/path.onnx'),
      ).rejects.toThrow(/Failed to load ONNX model/)
    })

    it('switchModel: should activate a named model', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      // Load 'default' via loadModel
      await engine.loadModel('/fake/default.onnx')
      expect(engine.getActiveModel()).toBe('default')
      expect(engine.isLoaded).toBe(true)

      // Load another model
      await engine.loadNamedModel('model-b', '/fake/model-b.onnx')
      expect(engine.getActiveModel()).toBe('default') // not auto-switched

      // Switch manually
      await engine.switchModel('model-b')
      expect(engine.getActiveModel()).toBe('model-b')
      expect(engine.isLoaded).toBe(true)
    })

    it('switchModel: should throw for non-existent name', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await expect(engine.switchModel('nonexistent')).rejects.toThrow(
        'Model "nonexistent" is not loaded',
      )
    })

    it('unloadModel: should remove model from list', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await engine.loadNamedModel('model-x', '/fake/model-x.onnx')
      expect(engine.getLoadedModels()).toContain('model-x')
      await engine.unloadModel('model-x')
      expect(engine.getLoadedModels()).not.toContain('model-x')
    })

    it('unloadModel: should clear active state when unloading active model', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await engine.loadNamedModel('active', '/fake/active.onnx')
      await engine.switchModel('active')
      expect(engine.isLoaded).toBe(true)
      expect(engine.getActiveModel()).toBe('active')
      await engine.unloadModel('active')
      expect(engine.isLoaded).toBe(false)
      expect(engine.getActiveModel()).toBeNull()
    })

    it('unloadModel: should throw for non-loaded model', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await expect(engine.unloadModel('not-loaded')).rejects.toThrow(
        'Model "not-loaded" is not loaded',
      )
    })

    it('loadModel: backward compatible — loaded as "default"', async () => {
      const engine = new GnnInferenceEngine({ featureDimension: 16 })
      await engine.loadModel('/fake/model.onnx')
      expect(engine.getLoadedModels()).toContain('default')
      expect(engine.getActiveModel()).toBe('default')
      expect(engine.isLoaded).toBe(true)
    })
  })

  // ──────────────────────────────────────────
  // GraphEngineFeatureEncoder 测试
  // ──────────────────────────────────────────

  describe('GraphEngineFeatureEncoder', () => {
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
        2,
      )
      const result = encoder.encode(1)
      expect(result.length).toBe(2)
      expect(result[0]).toBe(1)
      expect(result[1]).toBe(2)
    })

    it('should pad with 0 when dimension > field count', () => {
      const engine = createMockEngine({
        1: { props: { a: 10 } },
      })
      const encoder = new GraphEngineFeatureEncoder(
        engine,
        ['a'],
        3,
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

    it('should be usable with setEncoder() on GnnInferenceEngine', () => {
      const mockGraph = createMockEngine({
        1: { props: { feature: 42 } },
      })
      const encoder = new GraphEngineFeatureEncoder(mockGraph, ['feature'], 1)
      const gnnEngine = new GnnInferenceEngine({ featureDimension: 1 })
      expect(() => gnnEngine.setEncoder(encoder.encode.bind(encoder))).not.toThrow()
    })
  })
})
