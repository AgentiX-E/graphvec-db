// ============================================================
// hnsw-index.spec.ts — HNSW Vector Index Tests
// ============================================================

import { describe, test, expect, beforeEach } from 'vitest'
import {
  HnswIndex,
  createHnswIndex,
  normalizeVector,
  HnswIndexConfig,
} from './hnsw-index'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function makeVec(...vals: number[]): number[] {
  return vals
}

function randomVector(dim: number): Float32Array {
  const vec = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.random() * 10
  }
  return vec
}

function tempIndexPath(): string {
  return path.join(os.tmpdir(), `hnsw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.hnsw`)
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('HnswIndex — Basic Operations', () => {
  let index: HnswIndex

  beforeEach(() => {
    index = new HnswIndex({ dimension: 8, m: 16, efConstruction: 200 })
    index.init()
  })

  test('GAP-11-1: init creates an index', () => {
    expect(index.isInitialized()).toBe(true)
    expect(index.getDimension()).toBe(8)
    expect(index.getM()).toBe(16)
    expect(index.getEfConstruction()).toBe(200)
  })

  test('GAP-11-2: getCount starts at 0', () => {
    expect(index.getCount()).toBe(0)
  })

  test('GAP-11-3: addPoint increases count', () => {
    const vec = makeVec(1, 0, 0, 0, 0, 0, 0, 0)
    index.addPoint(1, vec)
    expect(index.getCount()).toBe(1)
  })

  test('GAP-11-4: addPoint with Float32Array', () => {
    index.addPoint(1, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]))
    expect(index.getCount()).toBe(1)
  })

  test('GAP-11-5: add multiple points', () => {
    for (let i = 0; i < 10; i++) {
      index.addPoint(i, randomVector(8))
    }
    expect(index.getCount()).toBe(10)
  })

  test('GAP-11-6: searchKnn returns correct neighbors', () => {
    index.addPoint(1, makeVec(0, 0, 0, 0, 0, 0, 0, 0))
    index.addPoint(2, makeVec(1, 1, 1, 1, 1, 1, 1, 1))
    index.addPoint(3, makeVec(2, 2, 2, 2, 2, 2, 2, 2))
    index.addPoint(4, makeVec(9, 9, 9, 9, 9, 9, 9, 9))

    const result = index.searchKnn(makeVec(0, 0, 0, 0, 0, 0, 0, 0), 3)
    expect(result.neighbors.length).toBeGreaterThan(0)
    expect(result.distances.length).toBeGreaterThan(0)
    // The closest should be ID 1 (distance 0)
    expect(result.neighbors[0]).toBe(1)
    expect(result.distances[0]).toBeCloseTo(0, 1)
  })

  test('GAP-11-7: searchKnnResult returns structured neighbors', () => {
    index.addPoint(10, makeVec(5, 5, 5, 5, 5, 5, 5, 5))
    index.addPoint(20, makeVec(5.1, 5.1, 5.1, 5.1, 5.1, 5.1, 5.1, 5.1))
    index.addPoint(30, makeVec(9, 9, 9, 9, 9, 9, 9, 9))

    const neighbors = index.searchKnnResult(makeVec(5, 5, 5, 5, 5, 5, 5, 5), 2)
    expect(neighbors.length).toBe(2)
    expect(neighbors[0].id).toBe(10)
    expect(neighbors[0].distance).toBeCloseTo(0, 1)
  })

  test('GAP-11-8: deletePoint reduces count', () => {
    index.addPoint(1, makeVec(1, 0, 0, 0, 0, 0, 0, 0))
    index.addPoint(2, makeVec(2, 2, 0, 0, 0, 0, 0, 0))
    expect(index.getCount()).toBe(2)
    index.deletePoint(1)
    // Note: markDelete doesn't reduce getCurrentCount but our tracked count does
    expect(index.getCount()).toBe(1)
  })

  test('GAP-11-9: save and load index', () => {
    index.addPoint(1, makeVec(1, 0, 0, 0, 0, 0, 0, 0))
    index.addPoint(2, makeVec(0, 1, 0, 0, 0, 0, 0, 0))
    index.addPoint(3, makeVec(0, 0, 1, 0, 0, 0, 0, 0))

    const savePath = tempIndexPath()
    index.saveIndex(savePath)
    expect(fs.existsSync(savePath)).toBe(true)

    // Create a new index and load
    const loaded = new HnswIndex({ dimension: 8, m: 16 })
    loaded.loadIndex(savePath)

    expect(loaded.getDimension()).toBe(8)
    expect(loaded.isInitialized()).toBe(true)
    expect(loaded.getCount()).toBe(3)

    // Search should still work after load
    const result = loaded.searchKnn(makeVec(1, 0, 0, 0, 0, 0, 0, 0), 1)
    expect(result.neighbors.length).toBeGreaterThan(0)

    // Cleanup
    try { fs.unlinkSync(savePath) } catch { /* ignore */ }
  })

  test('GAP-11-10: uninitialized index throws', () => {
    const uninit = new HnswIndex({ dimension: 4 })
    expect(() => uninit.addPoint(1, [1, 0, 0, 0])).toThrow('not initialized')
    expect(() => uninit.searchKnn([1, 0, 0, 0], 1)).toThrow('not initialized')
  })

  test('GAP-11-11: createHnswIndex factory', () => {
    const idx = createHnswIndex({ dimension: 4, m: 8 })
    expect(idx.isInitialized()).toBe(true)
    expect(idx.getDimension()).toBe(4)
  })
})

describe('HnswIndex — Edge Cases', () => {
  test('GAP-11-12: index with minimal config', () => {
    const idx = new HnswIndex({ dimension: 2 })
    idx.init()
    expect(idx.getM()).toBe(16) // default
    expect(idx.getMaxElements()).toBe(1_000_000) // default
  })

  test('GAP-11-13: single-point search finds itself', () => {
    const idx = new HnswIndex({ dimension: 3, m: 8, efConstruction: 200 })
    idx.init()
    idx.addPoint(42, [1, 2, 3])
    const result = idx.searchKnn([1, 2, 3], 1)
    expect(result.neighbors[0]).toBe(42)
    expect(result.distances[0]).toBeCloseTo(0, 1)
  })

  test('GAP-11-14: inner product distance metric', () => {
    const idx = new HnswIndex({ dimension: 4, distance: 'ip' })
    idx.init()
    idx.addPoint(1, [1, 0, 0, 0])
    idx.addPoint(2, [0.5, 0.5, 0.5, 0.5])
    const result = idx.searchKnn([1, 0, 0, 0], 1)
    expect(result.neighbors.length).toBeGreaterThan(0)
  })
})

describe('HnswIndex — Config Overrides', () => {
  test('GAP-11-15: custom M and efConstruction', () => {
    const config: HnswIndexConfig = {
      dimension: 8,
      m: 32,
      efConstruction: 400,
      randomSeed: 42,
      maxElements: 50000,
    }
    const idx = new HnswIndex(config)
    idx.init()
    idx.addPoint(1, randomVector(8))
    expect(idx.getCount()).toBe(1)
    expect(idx.getM()).toBe(32)
    expect(idx.getMaxElements()).toBe(50000)
  })
})

describe('normalizeVector', () => {
  test('GAP-11-16: normalizes to unit length', () => {
    const vec = new Float32Array([3, 4])
    const normalized = normalizeVector(vec)
    const length = Math.sqrt(normalized[0] ** 2 + normalized[1] ** 2)
    expect(length).toBeCloseTo(1, 5)
  })

  test('GAP-11-17: zero vector returns same', () => {
    const vec = new Float32Array([0, 0, 0])
    const result = normalizeVector(vec)
    expect(result[0]).toBe(0)
    expect(result[1]).toBe(0)
    expect(result[2]).toBe(0)
  })

  test('GAP-11-18: works with number[] input', () => {
    const result = normalizeVector([1, 2, 2])
    const length = Math.sqrt(result[0] ** 2 + result[1] ** 2 + result[2] ** 2)
    expect(length).toBeCloseTo(1, 5)
  })
})
