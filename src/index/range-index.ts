/**
 * range-index.ts — 基于 SortedMap 的数字属性范围索引
 *
 * 支持对节点的数字属性进行 lt, gt, lte, gte, between 等范围查询。
 * 底层使用 SortedMap (TreeMap 风格)，保证：
 *   - 插入: O(log n)
 *   - 查询: O(k + log n) (k = 结果数)
 *   - 范围遍历: O(log n + k)
 *
 * 使用示例:
 *   const index = new RangeIndex('age')
 *   index.add(1, 25)    // nodeId=1, age=25
 *   index.add(2, 30)
 *   index.add(3, 18)
 *   index.lt(30)        // → [1, 3]  (nodeIds with age < 30)
 */

export type NodeId = number

/**
 * 内部有序映射：基于排序数组实现，适合小到中等数量的索引条目。
 * 对于数百万级别的条目，建议替换为真正的 B-Tree 实现。
 */
class SortedMap<V> {
  private _keys: number[] = []
  private _values: V[] = []

  /** 插入键值对 */
  set(key: number, value: V): void {
    const idx = this._lowerBound(key)
    if (idx < this._keys.length && this._keys[idx] === key) {
      this._values[idx] = value
    } else {
      this._keys.splice(idx, 0, key)
      this._values.splice(idx, 0, value)
    }
  }

  /** 获取值 */
  get(key: number): V | undefined {
    const idx = this._lowerBound(key)
    if (idx < this._keys.length && this._keys[idx] === key) {
      return this._values[idx]
    }
    return undefined
  }

  /** 删除键 */
  delete(key: number): boolean {
    const idx = this._lowerBound(key)
    if (idx < this._keys.length && this._keys[idx] === key) {
      this._keys.splice(idx, 1)
      this._values.splice(idx, 1)
      return true
    }
    return false
  }

  /** 判断键是否存在 */
  has(key: number): boolean {
    const idx = this._lowerBound(key)
    return idx < this._keys.length && this._keys[idx] === key
  }

  /** 获取所有键（有序） */
  keys(): number[] {
    return [...this._keys]
  }

  /** 获取大小 */
  get size(): number {
    return this._keys.length
  }

  /** 获取所有条目 */
  entries(): Array<[number, V]> {
    return this._keys.map((k, i) => [k, this._values[i]])
  }

  /** 清空 */
  clear(): void {
    this._keys = []
    this._values = []
  }

  /** 从指定 key 开始的所有条目 (inclusive) */
  entriesFrom(key: number): Array<[number, V]> {
    const idx = this._lowerBound(key)
    return this._keys.slice(idx).map((k, i) => [k, this._values[idx + i]])
  }

  /** 到指定 key 结束的所有条目 (inclusive) */
  entriesTo(key: number): Array<[number, V]> {
    const idx = this._upperBound(key)
    return this._keys.slice(0, idx).map((k, i) => [k, this._values[i]])
  }

  /** 大于 key 的所有条目 (exclusive) */
  entriesGreaterThan(key: number): Array<[number, V]> {
    const idx = this._upperBound(key)
    return this._keys.slice(idx).map((k, i) => [k, this._values[idx + i]])
  }

  /** 第一个键 */
  firstKey(): number | undefined {
    return this._keys[0]
  }

  /** 最后一个键 */
  lastKey(): number | undefined {
    return this._keys[this._keys.length - 1]
  }

  // ── 二分查找 ──────────────────────────────

  private _lowerBound(key: number): number {
    let lo = 0
    let hi = this._keys.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this._keys[mid] < key) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private _upperBound(key: number): number {
    let lo = 0
    let hi = this._keys.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this._keys[mid] <= key) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

/**
 * RangeIndex — 数字属性范围索引
 *
 * 支持 lt, gt, lte, gte, between 五种范围查询。
 * 底层存储: 属性值 → Set<NodeId> 的有序映射。
 */
export class RangeIndex {
  private _propertyName: string
  private _map: SortedMap<Set<NodeId>>
  private _reverseMap: Map<NodeId, Set<number>>  // nodeId → 所有索引值（用于删除）

  constructor(propertyName: string) {
    this._propertyName = propertyName
    this._map = new SortedMap()
    this._reverseMap = new Map()
  }

  get propertyName(): string {
    return this._propertyName
  }

  /** 索引总数 */
  get size(): number {
    return this._map.size
  }

  /** 添加节点到索引 */
  add(nodeId: NodeId, value: number): void {
    let nodeSet = this._map.get(value)
    if (!nodeSet) {
      nodeSet = new Set<NodeId>()
      this._map.set(value, nodeSet)
    }
    nodeSet.add(nodeId)

    // 维护反向索引
    let reverseSet = this._reverseMap.get(nodeId)
    if (!reverseSet) {
      reverseSet = new Set<number>()
      this._reverseMap.set(nodeId, reverseSet)
    }
    reverseSet.add(value)
  }

  /** 从索引中移除节点 */
  remove(nodeId: NodeId): boolean {
    const reverseSet = this._reverseMap.get(nodeId)
    if (!reverseSet) return false

    for (const value of reverseSet) {
      const nodeSet = this._map.get(value)
      if (nodeSet) {
        nodeSet.delete(nodeId)
        if (nodeSet.size === 0) {
          this._map.delete(value)
        }
      }
    }

    this._reverseMap.delete(nodeId)
    return true
  }

  /** 批量添加节点 */
  addMany(entries: Array<{ nodeId: NodeId; value: number }>): void {
    for (const { nodeId, value } of entries) {
      this.add(nodeId, value)
    }
  }

  /**
   * 范围查询：值 < bound
   */
  lt(bound: number): NodeId[] {
    const result: NodeId[] = []
    // entryTo with bound-1 will include all keys <= bound-1 (i.e., keys < bound)
    const entries = this._map.entriesTo(bound)
    for (const [key, nodeSet] of entries) {
      if (key >= bound) break
      for (const id of nodeSet) result.push(id)
    }
    return result
  }

  /**
   * 范围查询：值 <= bound
   */
  lte(bound: number): NodeId[] {
    const result: NodeId[] = []
    const entries = this._map.entriesTo(bound)
    for (const [, nodeSet] of entries) {
      for (const id of nodeSet) result.push(id)
    }
    return result
  }

  /**
   * 范围查询：值 > bound
   */
  gt(bound: number): NodeId[] {
    const result: NodeId[] = []
    const entries = this._map.entriesGreaterThan(bound)
    for (const [, nodeSet] of entries) {
      for (const id of nodeSet) result.push(id)
    }
    return result
  }

  /**
   * 范围查询：值 >= bound
   */
  gte(bound: number): NodeId[] {
    const result: NodeId[] = []
    const entries = this._map.entriesFrom(bound)
    for (const [, nodeSet] of entries) {
      for (const id of nodeSet) result.push(id)
    }
    return result
  }

  /**
   * 范围查询：min <= 值 <= max
   */
  between(min: number, max: number): NodeId[] {
    if (min > max) return []
    const result: NodeId[] = []
    const entries = this._map.entriesFrom(min)
    for (const [key, nodeSet] of entries) {
      if (key > max) break
      for (const id of nodeSet) result.push(id)
    }
    return result
  }

  /** 精确匹配 */
  exact(value: number): NodeId[] {
    const nodeSet = this._map.get(value)
    return nodeSet ? [...nodeSet] : []
  }

  /** 清空索引 */
  clear(): void {
    this._map.clear()
    this._reverseMap.clear()
  }

  /** 获取所有值的分布统计 */
  stats(): { min: number | undefined; max: number | undefined; count: number } {
    return {
      min: this._map.firstKey(),
      max: this._map.lastKey(),
      count: this._reverseMap.size,
    }
  }
}
