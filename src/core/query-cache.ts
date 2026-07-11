/**
 * query-cache.ts — 查询结果缓存
 *
 * 为 Cypher 查询和 Fluent API 查询结果提供缓存。
 * 复用 GraphEngine 中的 LRUCache 实现作为底层。
 *
 * 缓存策略：
 * - TTL 过期（默认 30s）
 * - 写时失效：节点/边写入后根据标签/类型清除相关缓存项
 * - 全量失效：任意图结构变更时Optional清除全部
 *
 * 统计：hits / misses / entries
 */

import { createHash } from 'node:crypto'

// ──────────────────────────────────────────
// LRU Cache with per-entry TTL
// ──────────────────────────────────────────

interface LRUNode<K, V> {
  key: K
  value: V
  expiresAt: number
  prev: LRUNode<K, V> | null
  next: LRUNode<K, V> | null
}

class LRUCache<K, V> {
  private readonly _map = new Map<K, LRUNode<K, V>>()
  private _head: LRUNode<K, V> | null = null
  private _tail: LRUNode<K, V> | null = null
  private readonly _maxSize: number
  private readonly _defaultTTLMs: number

  constructor(maxSize: number = 1000, defaultTTLSec: number = 60) {
    this._maxSize = maxSize
    this._defaultTTLMs = defaultTTLSec * 1000
  }

  get(key: K): V | undefined {
    const node = this._map.get(key)
    if (!node) return undefined
    if (Date.now() > node.expiresAt) {
      this._removeNode(node)
      this._map.delete(key)
      return undefined
    }
    this._moveToHead(node)
    return node.value
  }

  set(key: K, value: V, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this._defaultTTLMs)
    const existing = this._map.get(key)
    if (existing) {
      existing.value = value
      existing.expiresAt = expiresAt
      this._moveToHead(existing)
      return
    }
    if (this._map.size >= this._maxSize) {
      this._evictOne()
    }
    const node: LRUNode<K, V> = { key, value, expiresAt, prev: null, next: null }
    this._map.set(key, node)
    this._prepend(node)
  }

  delete(key: K): boolean {
    const node = this._map.get(key)
    if (!node) return false
    this._removeNode(node)
    this._map.delete(key)
    return true
  }

  clear(): void {
    this._map.clear()
    this._head = null
    this._tail = null
  }

  get size(): number {
    return this._map.size
  }

  keys(): K[] {
    return Array.from(this._map.keys())
  }

  private _prepend(node: LRUNode<K, V>): void {
    node.prev = null
    node.next = this._head
    if (this._head) this._head.prev = node
    this._head = node
    if (!this._tail) this._tail = node
  }

  private _removeNode(node: LRUNode<K, V>): void {
    if (node.prev) node.prev.next = node.next
    else this._head = node.next
    if (node.next) node.next.prev = node.prev
    else this._tail = node.prev
    node.prev = null
    node.next = null
  }

  private _moveToHead(node: LRUNode<K, V>): void {
    if (node === this._head) return
    this._removeNode(node)
    this._prepend(node)
  }

  private _evictOne(): void {
    if (!this._tail) return
    const tail = this._tail
    this._removeNode(tail)
    this._map.delete(tail.key)
  }

  evictExpired(): number {
    let count = 0
    let node = this._tail
    while (node) {
      const prev = node.prev
      if (Date.now() > node.expiresAt) {
        this._removeNode(node)
        this._map.delete(node.key)
        count++
      }
      node = prev
    }
    return count
  }
}

// ──────────────────────────────────────────
// 缓存标签映射
// ──────────────────────────────────────────

/**
 * 为每个缓存条目关联一组标签。
 * 标签可以是节点类型 ID、边类型 ID、或预定义的通配符。
 * 写操作时，通过标签级联失效相关缓存项。
 */
export type CacheTag = string | number

// ──────────────────────────────────────────
// QueryResultCache
// ──────────────────────────────────────────

export interface QueryCacheEntry {
  /** 缓存的结果数据 */
  results: unknown
  /** 缓存的查询文本（用于Debug） */
  query: string
  /** 缓存创建时间戳 */
  cachedAt: number
  /** 关联的标签列表 */
  tags: CacheTag[]
}

export interface QueryCacheStats {
  hits: number
  misses: number
  entries: number
  hitRate: number
}

export interface QueryCacheConfig {
  /** 最大缓存条目数，默认 500 */
  maxSize?: number
  /** 默认 TTL（秒），默认 30 */
  ttlSec?: number
  /** 是否启用写时失效，默认 true */
  writeInvalidate?: boolean
}

const DEFAULT_CONFIG: Required<QueryCacheConfig> = {
  maxSize: 500,
  ttlSec: 30,
  writeInvalidate: true,
}

/**
 * 根据查询文本生成缓存键（SHA-256 hash）
 */
export function makeQueryCacheKey(query: string): string {
  return createHash('sha256').update(query).digest('hex')
}

/**
 * 查询结果缓存
 *
 * 使用Example: 
 * ```ts
 * const cache = new QueryResultCache({ maxSize: 500, ttlSec: 30 })
 *
 * // 检查缓存
 * const key = makeQueryCacheKey('MATCH (n:Person) RETURN n')
 * const cached = cache.get(key)
 * if (cached) return cached.results
 *
 * // 执行查询后缓存
 * const results = await executeQuery(query)
 * cache.set(key, results, { query, tags: ['Person'] })
 *
 * // 写入节点后失效
 * cache.invalidateByLabel('Person')
 * ```
 */
export class QueryResultCache {
  private cache: LRUCache<string, QueryCacheEntry>
  /** 标签 → 缓存键集合 */
  private tagIndex: Map<CacheTag, Set<string>> = new Map()
  private _hits = 0
  private _misses = 0
  private config: Required<QueryCacheConfig>

  constructor(config: QueryCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.cache = new LRUCache<string, QueryCacheEntry>(
      this.config.maxSize,
      this.config.ttlSec,
    )
  }

  /**
   * 获取缓存结果
   */
  get(key: string): QueryCacheEntry | undefined {
    const entry = this.cache.get(key)
    if (entry === undefined) {
      this._misses++
      return undefined
    }
    this._hits++
    return entry
  }

  /**
   * 设置缓存条目
   *
   * @param key 缓存键（由 makeQueryCacheKey 生成）
   * @param results 查询结果
   * @param meta 元数据（原始查询文本、关联标签）
   */
  set(key: string, results: unknown, meta: { query: string; tags?: CacheTag[] }): void {
    const tags = meta.tags ?? []
    const entry: QueryCacheEntry = {
      results,
      query: meta.query,
      cachedAt: Date.now(),
      tags,
    }
    this.cache.set(key, entry)

    // 建立标签索引
    for (const tag of tags) {
      let set = this.tagIndex.get(tag)
      if (!set) {
        set = new Set()
        this.tagIndex.set(tag, set)
      }
      set.add(key)
    }
  }

  /**
   * 根据标签失效缓存条目
   * 例如当写入 typeId=1 的节点时，调用 invalidateByLabel(1)
   * 会清除所有关联了标签 `1` 的缓存项
   */
  invalidateByLabel(label: CacheTag): number {
    const keys = this.tagIndex.get(label)
    if (!keys || keys.size === 0) return 0

    let count = 0
    for (const key of keys) {
      this.cache.delete(key)
      count++
    }
    this.tagIndex.delete(label)
    return count
  }

  /**
   * 按Node ID 失效（遍历包含该Node ID 标签的缓存条目）
   */
  invalidateByNode(nodeId: number | string): number {
    return this.invalidateByLabel(String(nodeId))
  }

  /**
   * 全量失效 — 清除所有缓存
   */
  invalidateAll(): void {
    this.cache.clear()
    this.tagIndex.clear()
  }

  /**
   * 缓存统计
   */
  get stats(): QueryCacheStats {
    const total = this._hits + this._misses
    return {
      hits: this._hits,
      misses: this._misses,
      entries: this.cache.size,
      hitRate: total > 0 ? this._hits / total : 0,
    }
  }

  /**
   * 重置统计计数器
   */
  resetStats(): void {
    this._hits = 0
    this._misses = 0
  }

  /**
   * 当写入发生时调用（写时失效）
   * 根据 config.writeInvalidate 决定是否执行失效
   *
   * @returns 失效的条目数
   */
  onWrite(labels?: CacheTag[]): number {
    if (!this.config.writeInvalidate) return 0

    if (labels && labels.length > 0) {
      // 按标签级失效
      let count = 0
      for (const label of labels) {
        count += this.invalidateByLabel(label)
      }
      return count
    }

    // 无标签 → 全量失效
    const prevCount = this.cache.size
    this.invalidateAll()
    return prevCount
  }

  /**
   * 获取缓存中所有键（Debug用）
   */
  get keys(): string[] {
    return this.cache.keys()
  }
}
