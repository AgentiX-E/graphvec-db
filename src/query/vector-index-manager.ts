/**
 * vector-index-manager.ts — HNSW 向量索引管理器
 *
 * 使用 hnswlib-node 在内存中维护 label + property 粒度的 HNSW 索引。
 * 支持创建、添加、搜索、重建索引。
 *
 * hnswlib-node v3 API:
 *   - new HierarchicalNSW(spaceName: 'l2'|'ip'|'cosine', dimension: number)
 *   - index.initIndex(maxElements)
 *   - index.addPoint(array, id)
 *   - index.searchKnn(array, k) → { neighbors: number[], distances: number[] }
 */

import { HierarchicalNSW } from 'hnswlib-node'

/** 搜索返回的最近邻项 */
export interface VectorSearchResult {
  id: number
  distance: number
}

/** HNSW 索引创建选项 */
export interface VectorIndexCreateOptions {
  label: string
  property: string
  dimension: number
  maxElements?: number
  /** HNSW M parameter — connections per element. Default 16. */
  M?: number
  /** HNSW efConstruction — candidate list size during construction. Default 200. */
  efConstruction?: number
}

/** 索引标识符：无歧义地拼接 label 与 property */
type IndexKey = string

/**
 * 使用 NUL（`\u0000`）作为分隔符，而不是下划线。Cypher 的 label/property
 * 标识符本身可能包含下划线（例如 `My_Label`），用 `_` 拼接会产生歧义：
 * `makeKey('My_Label', 'vec')` 与 `makeKey('My', 'Label_vec')` 会碰撞成
 * 同一个 key `My_Label_vec`，导致两个不同索引互相覆盖。NUL 不出现在任何
 * 合法标识符中，因此是无歧义的。
 */
function makeKey(label: string, property: string): IndexKey {
  return `${label}\u0000${property}`
}

/** 存储每个索引的 HNSW 参数 */
interface IndexParams {
  dimension: number
  M: number
  efConstruction: number
}

/**
 * HNSW 向量索引管理器
 *
 * 管理多个 label.property → HNSW 索引的映射。
 * 每个索引由 (label, property) 唯一标识。
 */
export class VectorIndexManager {
  /**
   * IndexKey (label/property 组合) → HNSW 索引的映射
   *
   * HNSW 索引由 hnswlib-node v3 管理，使用 'l2' 空间。
   */
  private indices: Map<IndexKey, HierarchicalNSW> = new Map()

  /** 存储每个索引的维度 */
  private dimensions: Map<IndexKey, number> = new Map()

  /** 存储每个索引的 HNSW 参数 */
  private indexParams: Map<IndexKey, IndexParams> = new Map()

  /**
   * 存储每个索引的 (label, property) 元信息。
   *
   * `rebuildFromGraph` 需要按索引重建。`IndexKey` 虽然用 NUL 分隔符拼接、
   * 已无歧义，但从 key 反向拆分 label/property 仍显脆弱。因此单独记录
   * 结构化元信息，直接提供 (label, property)，避免任何解析。
   */
  private keyMeta: Map<IndexKey, { label: string; property: string }> = new Map()

  /**
   * 为 label.property 创建 HNSW 索引
   *
   * @param options - 索引创建选项（label, property, dimension, maxElements, M, efConstruction）
   * @throws 如果索引已存在
   *
   * Example: 
   * ```
   * mgr.createIndex({ label: 'Item', property: 'embedding', dimension: 128, M: 32, efConstruction: 400 })
   * ```
   */
  createIndex(options: VectorIndexCreateOptions): void
  /** @deprecated Use object parameter instead */
  createIndex(
    label: string,
    property: string,
    dimension: number,
    maxElements?: number,
  ): void
  createIndex(
    labelOrOpts: string | VectorIndexCreateOptions,
    property?: string,
    dimension?: number,
    maxElements: number = 10000,
  ): void {
    let label: string
    let prop: string
    let dim: number
    let m: number
    let efConstruction: number

    if (typeof labelOrOpts === 'string') {
      // Legacy signature
      label = labelOrOpts
      prop = property!
      dim = dimension!
      m = 16
      efConstruction = 200
    } else {
      label = labelOrOpts.label
      prop = labelOrOpts.property
      dim = labelOrOpts.dimension
      maxElements = labelOrOpts.maxElements ?? 10000
      m = labelOrOpts.M ?? 16
      efConstruction = labelOrOpts.efConstruction ?? 200
    }

    const key = makeKey(label, prop)
    if (this.indices.has(key)) {
      throw new Error(
        `Vector index already exists for ${label}.${prop}`,
      )
    }

    const index = new HierarchicalNSW('l2', dim)
    index.initIndex(maxElements, efConstruction)
    this.indices.set(key, index)
    this.dimensions.set(key, dim)
    this.indexParams.set(key, { dimension: dim, M: m, efConstruction })
    this.keyMeta.set(key, { label, property: prop })
  }

  /**
   * 添加向量到索引
   *
   * @param label - 节点标签
   * @param property - 向量属性名
   * @param id - Node ID（同时也是 hnswlib labeltype）
   * @param vector - 浮点数组向量
   * @throws 如果索引不存在
   */
  addVector(
    label: string,
    property: string,
    id: number,
    vector: Float32Array,
  ): void {
    const key = makeKey(label, property)
    const index = this.indices.get(key)
    if (!index) {
      throw new Error(
        `Vector index not found for ${label}.${property}. Call createIndex first.`,
      )
    }

    const vec: number[] = Array.from(vector)
    index.addPoint(vec, id)
  }

  /**
   * 搜索最近邻
   *
   * @param label - 节点标签
   * @param property - 向量属性名
   * @param query - 查询向量
   * @param topK - 返回的最近邻数量
   * @returns 按距离升序排列的结果数组
   * @throws 如果索引不存在
   */
  search(
    label: string,
    property: string,
    query: Float32Array,
    topK: number,
  ): VectorSearchResult[] {
    const key = makeKey(label, property)
    const index = this.indices.get(key)
    if (!index) {
      throw new Error(
        `Vector index not found for ${label}.${property}. Call createIndex first.`,
      )
    }

    const count = index.getCurrentCount()
    if (count === 0) {
      return []
    }

    const k = Math.min(topK, count)
    if (k <= 0) {
      return []
    }

    const result = index.searchKnn(Array.from(query), k)

    // searchKnn 返回 { neighbors: number[], distances: number[] }
    const neighbors = result.neighbors as number[]
    const distances = result.distances as number[]

    const searchResults: VectorSearchResult[] = []
    for (let i = 0; i < neighbors.length; i++) {
      searchResults.push({
        id: neighbors[i],
        distance: distances[i],
      })
    }

    return searchResults
  }

  /**
   * 删除索引
   *
   * @param label - 节点标签
   * @param property - 向量属性名
   * @throws 如果索引不存在
   */
  deleteIndex(label: string, property: string): void {
    const key = makeKey(label, property)
    if (!this.indices.has(key)) {
      throw new Error(
        `Vector index not found for ${label}.${property}. Cannot delete.`,
      )
    }
    this.indices.delete(key)
    this.dimensions.delete(key)
    this.keyMeta.delete(key)
  }

  /**
   * 重建索引：删除旧索引，重新创建空索引
   *
   * 重建时会保留原来创建时的 M 和 efConstruction 参数。
   *
   * @param label - 节点标签
   * @param property - 向量属性名
   * @param dimension - 向量的维度
   * @param maxElements - 索引最大容量
   * @throws 如果索引不存在
   */
  rebuildIndex(
    label: string,
    property: string,
    dimension: number,
    maxElements: number = 10000,
  ): void {
    const key = makeKey(label, property)
    const params = this.indexParams.get(key)
    this.deleteIndex(label, property)
    this.createIndex({
      label,
      property,
      dimension,
      maxElements,
      M: params?.M ?? 16,
      efConstruction: params?.efConstruction ?? 200,
    })
  }

  /**
   * 从图引擎批量重建所有索引
   *
   * @param engine - 图引擎实例（需有 scan(label) 方法）
   *
   * 遍历每个已注册的索引，扫描对应 label 的所有节点，
   * 提取向量属性重新添加。
   */
  rebuildFromGraph(engine: { scan: (label: string) => Iterable<{ id: number; props: Record<string, unknown> }> }): void {
    // Snapshot the keys first: we delete and re-create each index below, and
    // re-inserting the same key while iterating a live Map would cause the
    // iterator to re-visit it forever (an infinite loop).
    for (const key of Array.from(this.indices.keys())) {
      const meta = this.keyMeta.get(key)
      if (!meta) continue
      const { label, property } = meta

      const dim = this.dimensions.get(key) || 128
      this.indices.delete(key)
      this.dimensions.delete(key)
      this.keyMeta.delete(key)

      let nodeCount = 0
      for (const _node of engine.scan(label)) {
        nodeCount++
      }

      const maxElements = Math.max(nodeCount + 100, 1000)
      this.createIndex(label, property, dim, maxElements)

      for (const node of engine.scan(label)) {
        const vecRaw = node.props[property]
        if (vecRaw instanceof Float32Array) {
          this.addVector(label, property, node.id, vecRaw)
        } else if (Array.isArray(vecRaw)) {
          this.addVector(label, property, node.id, new Float32Array(vecRaw))
        }
      }
    }
  }

  /**
   * 检查索引是否存在
   */
  hasIndex(label: string, property: string): boolean {
    return this.indices.has(makeKey(label, property))
  }

  /**
   * 获取已注册索引数量
   */
  get indexCount(): number {
    return this.indices.size
  }

  /**
   * 获取索引中向量的数量
   */
  getVectorCount(label: string, property: string): number {
    const key = makeKey(label, property)
    const index = this.indices.get(key)
    if (!index) return 0
    return index.getCurrentCount()
  }

  /**
   * 获取索引维度
   */
  getDimension(label: string, property: string): number | undefined {
    return this.dimensions.get(makeKey(label, property))
  }

  /**
   * 获取索引的 HNSW M 参数
   */
  getM(label: string, property: string): number | undefined {
    return this.indexParams.get(makeKey(label, property))?.M
  }

  /**
   * 获取索引的 HNSW efConstruction 参数
   */
  getEfConstruction(label: string, property: string): number | undefined {
    return this.indexParams.get(makeKey(label, property))?.efConstruction
  }
}
