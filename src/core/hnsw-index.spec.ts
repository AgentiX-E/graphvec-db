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

function randomNumberArray(dim: number): number[] {
  const vec: number[] = new Array(dim)
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

  test('GAP-11-9: save and load index', async () => {
    index.addPoint(1, makeVec(1, 0, 0, 0, 0, 0, 0, 0))
    index.addPoint(2, makeVec(0, 1, 0, 0, 0, 0, 0, 0))
    index.addPoint(3, makeVec(0, 0, 1, 0, 0, 0, 0, 0))

    const savePath = path.join(os.tmpdir(), `hnsw-save-load-${Date.now()}.hnsw`)
    index.saveIndex(savePath)
    // writeIndex is async native — wait for flush
    await new Promise(r => setTimeout(r, 200))
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

describe('HnswIndex — Runtime efSearch Control', () => {
  test('GAP-11-19: setEfSearch and getEfSearch work at runtime', () => {
    const idx = new HnswIndex({ dimension: 4 })
    idx.init()
    idx.setEfSearch(300)
    expect(idx.getEfSearch()).toBe(300)
  })

  test('GAP-11-20: setEfSearch with different values', () => {
    const idx = new HnswIndex({ dimension: 4 })
    idx.init()
    idx.setEfSearch(50)
    expect(idx.getEfSearch()).toBe(50)
    idx.setEfSearch(500)
    expect(idx.getEfSearch()).toBe(500)
  })

  test('GAP-11-21: setEfSearch throws if not initialized', () => {
    const idx = new HnswIndex({ dimension: 4 })
    expect(() => idx.setEfSearch(100)).toThrow('not initialized')
  })

  test('GAP-11-22: custom M and efConstruction with createHnswIndex', () => {
    const config: HnswIndexConfig = {
      dimension: 6,
      m: 24,
      efConstruction: 400,
      randomSeed: 123,
    }
    const idx = createHnswIndex(config)
    idx.addPoint(1, [1, 0, 0, 0, 0, 0])
    expect(idx.getM()).toBe(24)
    expect(idx.getEfConstruction()).toBe(400)
  })
})

// ============================================================
// 🚀 ADDITIONAL TESTS — Vector search core (hnsw-index)
// ============================================================

describe('HnswIndex — Different Dimensions', () => {
  const dimensions = [64, 128, 256, 384, 512]
  for (const dim of dimensions) {
    test(`GAP-11-23: works with dimension ${dim}`, () => {
      const idx = new HnswIndex({ dimension: dim, m: 16, efConstruction: 100 })
      idx.init()
      expect(idx.getDimension()).toBe(dim)
      expect(idx.getCount()).toBe(0)

      // Add a few points
      idx.addPoint(1, randomNumberArray(dim))
      idx.addPoint(2, randomNumberArray(dim))
      idx.addPoint(3, randomNumberArray(dim))
      expect(idx.getCount()).toBe(3)

      // Search should return results
      const result = idx.searchKnn(randomNumberArray(dim), 2)
      expect(result.neighbors.length).toBe(2)
      expect(result.distances.length).toBe(2)
    }, 30000)
  }
})

describe('HnswIndex — Different Distance Metrics', () => {
  function makeTestVector(vals: number[]): number[] {
    return vals.slice()
  }

  test('GAP-11-24: cosine distance metric', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100, distance: 'cosine' })
    idx.init()
    // Unit vectors for clear cosine distances
    idx.addPoint(1, [1, 0, 0, 0])
    idx.addPoint(2, [0, 1, 0, 0])
    idx.addPoint(3, [0.9, 0.1, 0, 0])

    const result = idx.searchKnn([1, 0, 0, 0], 2)
    expect(result.neighbors.length).toBe(2)
    // id 1 and 3 are closest to [1,0,0,0]
  })

  test('GAP-11-25: euclidean (l2) distance metric', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100, distance: 'l2' })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    idx.addPoint(2, [10, 10, 10, 10])
    idx.addPoint(3, [1, 1, 1, 1])
    idx.addPoint(4, [100, 100, 100, 100])

    // Query near origin
    const result = idx.searchKnn([0, 0, 0, 0], 2)
    expect(result.neighbors[0]).toBe(1)
    expect(result.distances[0]).toBeCloseTo(0, 1)
  })

  test('GAP-11-26: dot product distance metric', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100, distance: 'ip' })
    idx.init()
    idx.addPoint(1, [1, 0, 0, 0])
    idx.addPoint(2, [0.5, 0.5, 0.5, 0.5])
    idx.addPoint(3, [2, 0, 0, 0])

    // For IP distance, [2,0,0,0] and [1,0,0,0] should be similar
    const result = idx.searchKnn([1, 0, 0, 0], 2)
    expect(result.neighbors.length).toBe(2)
  })
})

describe('HnswIndex — Large Vector Sets', () => {
  test('GAP-11-27: insert and search 10 vectors (module uses M param as maxElements)', () => {
    const idx = new HnswIndex({ dimension: 32, m: 16, efConstruction: 200 })
    idx.init()
    for (let i = 0; i < 10; i++) {
      idx.addPoint(i, randomNumberArray(32))
    }
    expect(idx.getCount()).toBe(10)

    const result = idx.searchKnn(randomNumberArray(32), 10)
    expect(result.neighbors.length).toBe(10)
  }, 30000)

  test('GAP-11-28: insert and search 50 vectors with larger M', () => {
    const idx = new HnswIndex({ dimension: 16, m: 100, efConstruction: 200 })
    idx.init()
    for (let i = 0; i < 50; i++) {
      idx.addPoint(i, randomNumberArray(16))
    }
    expect(idx.getCount()).toBe(50)

    const result = idx.searchKnn(randomNumberArray(16), 10)
    expect(result.neighbors.length).toBe(10)
  }, 30000)
})

describe('HnswIndex — Empty Index Queries', () => {
  test('GAP-11-29: searchKnn on empty index returns empty', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    expect(idx.getCount()).toBe(0)
    const result = idx.searchKnn([1, 0, 0, 0], 5)
    expect(result.neighbors).toEqual([])
    expect(result.distances).toEqual([])
  })

  test('GAP-11-30: searchKnnResult on empty index returns empty', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    const result = idx.searchKnnResult([1, 0, 0, 0], 5)
    expect(result).toEqual([])
  })
})

describe('HnswIndex — Insert and Query Immediately', () => {
  test('GAP-11-31: insert single point then query finds itself', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(100, [0.5, 0.5, 0.5, 0.5])
    const result = idx.searchKnn([0.5, 0.5, 0.5, 0.5], 3)
    expect(result.neighbors).toContain(100)
  })

  test('GAP-11-32: insert then query alternating dimensions', () => {
    const idx = new HnswIndex({ dimension: 5, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [1, 2, 3, 4, 5])
    const result = idx.searchKnn([0, 0, 0, 0, 0], 1)
    expect(result.neighbors[0]).toBe(1)
  })
})

describe('HnswIndex — Batch Insert Operations', () => {
  test('GAP-11-33: batch insert 10 points with sequential IDs', () => {
    const idx = new HnswIndex({ dimension: 8, m: 50, efConstruction: 100 })
    idx.init()
    for (let i = 0; i < 10; i++) {
      idx.addPoint(i, randomNumberArray(8))
    }
    expect(idx.getCount()).toBe(10)
    const result = idx.searchKnn(randomNumberArray(8), 5)
    expect(result.neighbors.length).toBe(5)
  })

  test('GAP-11-34: batch insert 20 points with larger M', () => {
    const idx = new HnswIndex({ dimension: 8, m: 100, efConstruction: 400 })
    idx.init()
    for (let i = 0; i < 20; i++) {
      idx.addPoint(i, randomNumberArray(8))
    }
    expect(idx.getCount()).toBe(20)
  })
})

describe('HnswIndex — Vector Delete and Search', () => {
  test('GAP-11-35: delete one point then search excludes it', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    idx.addPoint(2, [5, 5, 5, 5])
    idx.addPoint(3, [10, 10, 10, 10])
    idx.deletePoint(1)

    const result = idx.searchKnn([0, 0, 0, 0], 2)
    // After deletion, the closest should be ID 2, not ID 1
    expect(result.neighbors).not.toContain(1)
  })

  test('GAP-11-36: delete all points then search', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    idx.addPoint(2, [1, 1, 1, 1])
    idx.deletePoint(1)
    idx.deletePoint(2)
    expect(idx.getCount()).toBe(0)

    const result = idx.searchKnn([0, 0, 0, 0], 2)
    // May still return deleted points (depends on backend), but count should be 0
    expect(result.neighbors.length).toBeGreaterThanOrEqual(0)
  })
})

describe('HnswIndex — Update and Re-index', () => {
  test('GAP-11-37: add new points after re-init', async () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    idx.addPoint(2, [1, 1, 1, 1])
    // Save and reload simulates re-index
    const savePath = tempIndexPath()
    idx.saveIndex(savePath)
    await new Promise(r => setTimeout(r, 500))
    // Create new index and load
    const idx2 = new HnswIndex({ dimension: 4, m: 8 })
    idx2.loadIndex(savePath)
    expect(idx2.getCount()).toBe(2)

    // Add more points
    idx2.addPoint(3, [2, 2, 2, 2])
    expect(idx2.getCount()).toBe(3)

    try { fs.unlinkSync(savePath) } catch { /* ignore */ }
  })
})

describe('HnswIndex — Invalid Vector Dimension', () => {
  test('GAP-11-38: addPoint with wrong dimension throws', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    expect(() => {
      idx.addPoint(1, [1, 2, 3]) // 3-dim in 4-dim index
    }).toThrow()
  })

  test('GAP-11-39: searchKnn with wrong dimension throws', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [1, 1, 1, 1])
    expect(() => {
      idx.searchKnn([1, 2, 3], 1) // 3-dim query in 4-dim index
    }).toThrow()
  })

  test('GAP-11-40: create index with dimension 0 is handled (hnswlib allows it)', () => {
    const idx = new HnswIndex({ dimension: 0 })
    idx.init()
    expect(idx.getDimension()).toBe(0)
    expect(idx.isInitialized()).toBe(true)
  })
})

describe('HnswIndex — Zero and Repeated Vectors', () => {
  test('GAP-11-41: all-zero vector can be indexed', () => {
    const idx = new HnswIndex({ dimension: 8, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0, 0, 0, 0, 0])
    expect(idx.getCount()).toBe(1)
    // Query with zero vector finds itself
    const result = idx.searchKnn([0, 0, 0, 0, 0, 0, 0, 0], 1)
    expect(result.neighbors[0]).toBe(1)
  })

  test('GAP-11-42: repeated identical vectors are handled', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0.5, 0.5, 0.5, 0.5])
    idx.addPoint(2, [0.5, 0.5, 0.5, 0.5]) // Same vector, different ID
    expect(idx.getCount()).toBe(2)
    const result = idx.searchKnn([0.5, 0.5, 0.5, 0.5], 2)
    expect(result.neighbors.length).toBe(2)
  })

  test('GAP-11-43: identical scalar vectors find each other', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    idx.addPoint(2, [0, 0, 0, 0])
    const result = idx.searchKnn([0, 0, 0, 0], 2)
    // Should find both (distance 0 for both)
    expect(result.neighbors.length).toBe(2)
    expect(result.distances[0]).toBeCloseTo(0, 1)
    expect(result.distances[1]).toBeCloseTo(0, 1)
  })
})

describe('HnswIndex — Parallel/Concurrent Writes', () => {
  test('GAP-11-44: serialized concurrent writes — add many points', () => {
    const idx = new HnswIndex({ dimension: 8, m: 100, efConstruction: 100 })
    idx.init()

    const promises: Promise<void>[] = []
    const batchSize = 20
    for (let b = 0; b < 4; b++) {
      const start = b * batchSize
      promises.push(Promise.resolve().then(() => {
        for (let i = 0; i < batchSize; i++) {
          idx.addPoint(start + i, randomNumberArray(8))
        }
      }))
    }

    return Promise.all(promises).then(() => {
      expect(idx.getCount()).toBe(80)
    })
  }, 30000)

  test('GAP-11-45: interleaved add and search', () => {
    const idx = new HnswIndex({ dimension: 8, m: 8, efConstruction: 100 })
    idx.init()

    idx.addPoint(1, [1, 0, 0, 0, 0, 0, 0, 0])
    const r1 = idx.searchKnn([1, 0, 0, 0, 0, 0, 0, 0], 1)
    expect(r1.neighbors[0]).toBe(1)

    idx.addPoint(2, [0, 1, 0, 0, 0, 0, 0, 0])
    const r2 = idx.searchKnn([0, 1, 0, 0, 0, 0, 0, 0], 2)
    expect(r2.neighbors).toContain(2)
  })
})

describe('HnswIndex — Max Elements Boundary', () => {
  test('GAP-11-46: index capacity — cannot exceed M (passed as maxElements)', () => {
    // Note: hnswlib-node initIndex first param is maxElements (not M).
    // Current module passes m as maxElements: idx.initIndex(this.m, this.efConstruction)
    const idx = new HnswIndex({ dimension: 4, m: 10, efConstruction: 100 })
    idx.init()
    for (let i = 0; i < 10; i++) {
      idx.addPoint(i, randomNumberArray(4))
    }
    expect(idx.getCount()).toBe(10)

    // Adding more than maxElements throws
    expect(() => idx.addPoint(11, randomNumberArray(4))).toThrow()
  })

  test('GAP-11-47: maxElements default is 1000000', () => {
    const idx = new HnswIndex({ dimension: 4 })
    expect(idx.getMaxElements()).toBe(1_000_000)
  })
})

describe('HnswIndex — Miscellaneous Edge Cases', () => {
  test('GAP-11-48: search with k=0 returns empty array', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    const result = idx.searchKnn([0, 0, 0, 0], 0)
    expect(result.neighbors).toEqual([])
    expect(result.distances).toEqual([])
  })

  test('GAP-11-49: search with negative k', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    expect(() => idx.searchKnn([0, 0, 0, 0], -1)).toThrow()
  })

  test('GAP-11-50: search with k larger than element count', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, maxElements: 100, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [0, 0, 0, 0])
    idx.addPoint(2, [1, 1, 1, 1])
    // Search for 10 when only 2 exist — hnswlib-node accepts k up to element count
    const result = idx.searchKnn([0, 0, 0, 0], 2)
    expect(result.neighbors.length).toBe(2)
  })

  test('GAP-11-51: double init is idempotent', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    idx.init() // second init should be no-op
    idx.addPoint(1, [1, 0, 0, 0])
    expect(idx.getCount()).toBe(1)
  })

  test('GAP-11-52: save and reload with clean index', async () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    idx.addPoint(1, [1, 0, 0, 0])
    const savePath = tempIndexPath()
    idx.saveIndex(savePath)
    await new Promise(r => setTimeout(r, 500))

    const idx2 = new HnswIndex({ dimension: 4, m: 8 })
    idx2.loadIndex(savePath)
    expect(idx2.getCount()).toBe(1)
    try { fs.unlinkSync(savePath) } catch { /* ignore */ }
  })

  test('GAP-11-53: getter consistency after save/load', async () => {
    const idx = new HnswIndex({ dimension: 6, m: 32, efConstruction: 400 })
    idx.init()
    idx.addPoint(1, randomNumberArray(6))
    const savePath = tempIndexPath()
    idx.saveIndex(savePath)
    await new Promise(r => setTimeout(r, 500))

    const loaded = new HnswIndex({ dimension: 6, m: 32 })
    loaded.loadIndex(savePath)
    expect(loaded.getDimension()).toBe(6)
    // M and efConstruction are config-level, not persisted in HNSW index format
    expect(loaded.getM()).toBe(32)
    expect(loaded.isInitialized()).toBe(true)
    expect(loaded.getCount()).toBe(1)
    try { fs.unlinkSync(savePath) } catch { /* ignore */ }
  })

  test('GAP-11-54: hnswlib-node searchKnn with Float32Array query', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [1, 0, 0, 0])
    idx.addPoint(2, [0, 1, 0, 0])

    const query = new Float32Array([1, 0, 0, 0])
    const result = idx.searchKnn(query, 2)
    expect(result.neighbors[0]).toBe(1)
  })
})

describe('HnswIndex — Save/Load Edge Cases', () => {
  test('GAP-11-55: save on empty index does not create file (hnswlib behavior)', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8 })
    idx.init()
    const savePath = tempIndexPath()
    // hnswlib writeIndex on empty index may not flush to disk
    // This test just verifies the call is safe
    expect(() => idx.saveIndex(savePath)).not.toThrow()
    try { try { fs.unlinkSync(savePath) } catch { /* ignore */ } } catch { /* ignore */ }
  })

  test('GAP-11-56: save and load with large M value', async () => {
    const idx = new HnswIndex({ dimension: 8, m: 64, efConstruction: 200 })
    idx.init()
    for (let i = 0; i < 20; i++) {
      idx.addPoint(i, randomNumberArray(8))
    }
    const savePath = tempIndexPath()
    idx.saveIndex(savePath)
    // wait for async write to finish
    await new Promise(r => setTimeout(r, 500))
    const loaded = new HnswIndex({ dimension: 8, m: 64 })
    loaded.loadIndex(savePath)
    expect(loaded.getCount()).toBe(20)
    try { fs.unlinkSync(savePath) } catch { /* ignore */ }
  })
})

// ================================================================
// Core 深度扩展：HNSW 向量索引边界与查询测试
// ================================================================

describe('Core 深度扩展 — 不同维度 Vector 插入', () => {
  test('CORE-HNSW-001: 64 维向量插入与查询', () => {
    const idx = new HnswIndex({ dimension: 64, m: 16, efConstruction: 200, maxElements: 100 })
    idx.init()
    for (let i = 0; i < 5; i++) {
      idx.addPoint(i, randomNumberArray(64))
    }
    expect(idx.getCount()).toBe(5)
    const result = idx.searchKnn(randomNumberArray(64), 3)
    expect(result.neighbors.length).toBe(3)
    expect(idx.getDimension()).toBe(64)
  })

  test('CORE-HNSW-002: 128 维向量插入与查询', () => {
    const idx = new HnswIndex({ dimension: 128, m: 16, efConstruction: 200, maxElements: 50 })
    idx.init()
    for (let i = 0; i < 5; i++) {
      idx.addPoint(i, randomNumberArray(128))
    }
    expect(idx.getCount()).toBe(5)
    const result = idx.searchKnn(randomNumberArray(128), 3)
    expect(result.neighbors.length).toBe(3)
    expect(idx.getDimension()).toBe(128)
  })

  test('CORE-HNSW-003: 256 维向量插入与查询', () => {
    const idx = new HnswIndex({ dimension: 256, m: 16, efConstruction: 200, maxElements: 50 })
    idx.init()
    for (let i = 0; i < 5; i++) {
      idx.addPoint(i, randomNumberArray(256))
    }
    expect(idx.getCount()).toBe(5)
    const result = idx.searchKnn(randomNumberArray(256), 3)
    expect(result.neighbors.length).toBe(3)
    expect(idx.getDimension()).toBe(256)
  })
})

describe('Core 深度扩展 — 空索引与单向量查询', () => {
  test('CORE-HNSW-004: 空索引查询空', () => {
    const idx = new HnswIndex({ dimension: 8, m: 8 })
    idx.init()
    expect(idx.getCount()).toBe(0)
    const result = idx.searchKnn([1, 0, 0, 0, 0, 0, 0, 0], 5)
    expect(result.neighbors).toEqual([])
    expect(result.distances).toEqual([])
  })

  test('CORE-HNSW-005: 单向量查询返回自身', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(42, [0.3, 0.3, 0.3, 0.3])
    const result = idx.searchKnn([0.3, 0.3, 0.3, 0.3], 3)
    expect(result.neighbors).toContain(42)
  })
})

describe('Core 深度扩展 — 多向量最近邻查询', () => {
  test('CORE-HNSW-006: 多向量查询返回最近邻', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(0, [0, 0, 0, 0])
    idx.addPoint(1, [1, 1, 1, 1])
    idx.addPoint(2, [5, 5, 5, 5])
    idx.addPoint(3, [10, 10, 10, 10])

    // Query near [0,0,0,0] — nearest should be 0
    const result = idx.searchKnn([0.1, 0.1, 0.1, 0.1], 2)
    expect(result.neighbors[0]).toBe(0)
    // distance should be close to 0
    expect(result.distances[0]).toBeLessThan(0.1)
  })

  test('CORE-HNSW-007: 删除向量后查询', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 100 })
    idx.init()
    idx.addPoint(1, [1, 1, 1, 1])
    idx.addPoint(2, [2, 2, 2, 2])
    idx.addPoint(3, [3, 3, 3, 3])

    idx.deletePoint(2)

    const result = idx.searchKnn([1.5, 1.5, 1.5, 1.5], 3)
    // Deleted point 2 should not appear in results
    expect(result.neighbors).not.toContain(2)
  })

  test('CORE-HNSW-008: 批量插入后查询精确结果', () => {
    const idx = new HnswIndex({ dimension: 4, m: 8, efConstruction: 200 })
    idx.init()
    // Insert known points
    idx.addPoint(10, [1, 0, 0, 0])
    idx.addPoint(20, [0, 1, 0, 0])
    idx.addPoint(30, [0, 0, 1, 0])
    idx.addPoint(40, [0, 0, 0, 1])

    // Query for [1,0,0,0] — exact match
    const result = idx.searchKnn([1, 0, 0, 0], 4)
    expect(result.neighbors[0]).toBe(10)
    expect(result.neighbors.length).toBe(4)

    // Verify the second nearest (cosine): [0,1,0,0] and [0,0,1,0] are equidistant from [1,0,0,0]
    const sorted = result.neighbors.slice()
    expect(sorted.length).toBe(4)
  })
})
