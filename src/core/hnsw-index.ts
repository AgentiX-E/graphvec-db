// ============================================================
// hnsw-index.ts — HNSW (Hierarchical Navigable Small World) Vector Index
//
// Uses hnswlib-node for native HNSW index operations.
// Supports:
//   - addPoint(id, vector) — insert a vector
//   - searchKnn(vector, k) — k-nearest neighbors search
//   - deletePoint(id)      — remove a vector (mark deleted)
//   - saveIndex(path) / loadIndex(path) — persistence
//   - getCount()           — number of indexed vectors
//   - getDimension()       — vector dimension
//
// Distance metrics: 'l2' (Euclidean), 'ip' (inner product), or 'cosine'
// ============================================================

import { HierarchicalNSW } from 'hnswlib-node'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type HnswDistanceMetric = 'l2' | 'ip' | 'cosine'

export interface HnswIndexConfig {
  /** Vector dimension */
  dimension: number
  /** Number of connections per element (M). Default 16. */
  m?: number
  /** Size of the dynamic candidate list (efConstruction). Default 200. */
  efConstruction?: number
  /** Random seed. Default 100. */
  randomSeed?: number
  /** Distance metric. Default 'l2'. */
  distance?: HnswDistanceMetric
  /** Maximum number of elements. Default 1000000. */
  maxElements?: number
}

export interface SearchResult {
  /** Distance from query vector for each result */
  distances: number[]
  /** IDs of nearest neighbors */
  neighbors: number[]
}

/** Query result with id and distance */
export interface NeighborResult {
  id: number
  distance: number
}

// ──────────────────────────────────────────
// HNSW Index
// ──────────────────────────────────────────

/**
 * HNSW (Hierarchical Navigable Small World) Vector Index.
 *
 * Provides efficient approximate nearest neighbor (ANN) search
 * with O(log n) complexity. Uses hnswlib-node for native performance.
 */
export class HnswIndex {
  /** The underlying HNSW index from hnswlib-node, or a pure-JS fallback for save/load */
  private nativeIndex: InstanceType<typeof HierarchicalNSW> | null = null
  private dimension: number
  private m: number
  private efConstruction: number
  private randomSeed: number
  private distance: HnswDistanceMetric
  private maxElements: number
  private count = 0

  constructor(config: HnswIndexConfig) {
    this.dimension = config.dimension
    this.m = config.m ?? 16
    this.efConstruction = config.efConstruction ?? 200
    this.randomSeed = config.randomSeed ?? 100
    this.distance = config.distance ?? 'l2'
    this.maxElements = config.maxElements ?? 1_000_000
  }

  // ──────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────

  /**
   * Initialize the underlying HNSW index.
   * Must be called before any add/search operations.
   */
  init(): void {
    if (this.nativeIndex) return

    const spaceName = this.distance === 'cosine' ? 'cosine' : this.distance === 'ip' ? 'ip' : 'l2'
    const idx = new HierarchicalNSW(spaceName, this.dimension)
    // initIndex(M, efConstruction)
    idx.initIndex(this.m, this.efConstruction)
    this.nativeIndex = idx
    this.count = 0
  }

  /**
   * Check if the index has been initialized.
   */
  isInitialized(): boolean {
    return this.nativeIndex !== null
  }

  /**
   * Add a vector to the index.
   *
   * @param id   Unique numeric label for the vector
   * @param vec  number[] of dimension length
   */
  addPoint(id: number, vec: number[] | Float32Array): void {
    this.ensureInitialized()
    const v = Array.isArray(vec) ? vec : Array.from(vec)
    this.nativeIndex!.addPoint(v, id)
    this.count++
  }

  /**
   * Search for k nearest neighbors.
   *
   * @param query Query vector
   * @param k     Number of nearest neighbors to return
   * @returns     SearchResult with distances and neighbors arrays
   */
  searchKnn(query: number[] | Float32Array, k: number): SearchResult {
    this.ensureInitialized()
    const q = Array.isArray(query) ? query : Array.from(query)
    return this.nativeIndex!.searchKnn(q, k) as unknown as SearchResult
  }

  /**
   * Search for k nearest neighbors, returning structured results.
   */
  searchKnnResult(query: number[] | Float32Array, k: number): NeighborResult[] {
    const result = this.searchKnn(query, k)
    const neighbors: NeighborResult[] = []
    for (let i = 0; i < result.neighbors.length; i++) {
      neighbors.push({
        id: result.neighbors[i],
        distance: result.distances[i],
      })
    }
    return neighbors
  }

  /**
   * Mark a point as deleted from the index.
   */
  deletePoint(id: number): void {
    this.ensureInitialized()
    this.nativeIndex!.markDelete(id)
    this.count = Math.max(0, this.count - 1)
  }

  /**
   * Save the index to a file on disk.
   */
  saveIndex(path: string): void {
    this.ensureInitialized()
    this.nativeIndex!.writeIndex(path)
  }

  /**
   * Load a previously saved index from disk.
   */
  loadIndex(path: string): void {
    const spaceName = this.distance === 'cosine' ? 'cosine' : this.distance === 'ip' ? 'ip' : 'l2'
    const idx = new HierarchicalNSW(spaceName, this.dimension)
    idx.readIndexSync(path)
    this.nativeIndex = idx
    this.count = idx.getCurrentCount()
  }

  // ──────────────────────────────────────
  // Accessors
  // ──────────────────────────────────────

  /**
   * Number of vectors currently indexed.
   */
  getCount(): number {
    return this.count
  }

  /**
   * Vector dimension.
   */
  getDimension(): number {
    return this.dimension
  }

  /**
   * Maximum number of elements the index can hold.
   */
  getMaxElements(): number {
    return this.maxElements
  }

  /**
   * The HNSW M parameter (connections per node).
   */
  getM(): number {
    return this.m
  }

  /**
   * Current efConstruction value.
   */
  getEfConstruction(): number {
    return this.efConstruction
  }

  // ──────────────────────────────────────
  // Internal
  // ──────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.nativeIndex) {
      throw new Error('HnswIndex not initialized. Call init() first.')
    }
  }
}

// ──────────────────────────────────────────
// Factory
// ──────────────────────────────────────────

/**
 * Create a new HNSW index with the given configuration.
 */
export function createHnswIndex(config: HnswIndexConfig): HnswIndex {
  const index = new HnswIndex(config)
  index.init()
  return index
}

// ──────────────────────────────────────────
// Cosine Distance Helper
// ──────────────────────────────────────────

/**
 * Normalize a vector to unit length (L2 normalization).
 * Useful when using 'ip' space for cosine similarity.
 */
export function normalizeVector(vec: number[] | Float32Array): Float32Array {
  const arr = Array.isArray(vec) ? new Float32Array(vec) : vec
  let sumSq = 0
  for (let i = 0; i < arr.length; i++) {
    sumSq += arr[i] * arr[i]
  }
  const norm = Math.sqrt(sumSq)
  if (norm === 0) return arr
  const result = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    result[i] = arr[i] / norm
  }
  return result
}
