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

/** 索引标识符：label_property */
type IndexKey = string

function makeKey(label: string, property: string): IndexKey {
  return `${label}_${property}`
}

/**
 * HNSW 向量索引管理器
 *
 * 管理多个 label.property → HNSW 索引的映射。
 * 每个索引由 (label, property) 唯一标识。
 */
export class VectorIndexManager {
  /**
   * label_property → HNSW 索引的映射
   *
   * HNSW 索引由 hnswlib-node v3 管理，使用 'l2' 空间。
   */
  private indices: Map<IndexKey, HierarchicalNSW> = new Map()

  /** 存储每个索引的维度 */
  private dimensions: Map<IndexKey, number> = new Map()

  /**
   * 为 label.property 创建 HNSW 索引
   *
   * @param label - 节点标签（如 'Item'）
   * @param property - 向量属性名（如 'embedding'）
   * @param dimension - 向量的维度
   * @param maxElements - 索引最大容量（默认 10000）
   * @throws 如果索引已存在
   */
  createIndex(
    label: string,
    property: string,
    dimension: number,
    maxElements: number = 10000,
  ): void {
    const key = makeKey(label, property)
    if (this.indices.has(key)) {
      throw new Error(
        `Vector index already exists for ${label}.${property}`,
      )
    }

    const index = new HierarchicalNSW('l2', dimension)
    index.initIndex(maxElements)
    this.indices.set(key, index)
    this.dimensions.set(key, dimension)
  }

  /**
   * 添加向量到索引
   *
   * @param label - 节点标签
   * @param property - 向量属性名
   * @param id - 节点 ID（同时也是 hnswlib labeltype）
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
  }

  /**
   * 重建索引：删除旧索引，重新创建空索引
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
    this.deleteIndex(label, property)
    this.createIndex(label, property, dimension, maxElements)
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
    for (const [key] of this.indices) {
      const underscoreIdx = key.indexOf('_')
      if (underscoreIdx === -1) continue
      const label = key.substring(0, underscoreIdx)
      const property = key.substring(underscoreIdx + 1)

      const dim = this.dimensions.get(key) || 128
      this.indices.delete(key)
      this.dimensions.delete(key)

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
}
