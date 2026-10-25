/**
 * range-index.ts — 基于 BTree 的数字属性范围索引
 *
 * 支持对节点的数字属性进行 lt, gt, lte, gte, between 等范围查询。
 * 底层使用 sorted-btree (B+Tree)，保证：
 *   - 插入/删除: O(log n)
 *   - 查询: O(k + log n) (k = 结果数)
 *   - 范围遍历: O(k + log n)
 *
 * 使用示例:
 *   const index = new RangeIndex('age')
 *   index.add(1, 25)    // nodeId=1, age=25
 *   index.add(2, 30)
 *   index.add(3, 18)
 *   index.lt(30)        // → [1, 3]  (nodeIds with age < 30)
 */

export type NodeId = number

// ── sorted-btree 类型 ────────────────────────────────
// sorted-btree@2.1.0 exports a default BTree class.
// We import it lazily (via require) to avoid top-level ESM issues.
function createBTree<V>(): SortedBTree<V> {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
  const { default: BTree } = require('sorted-btree') as {
    default: new <K, V>(comparator?: (a: K, b: K) => number) => SortedBTree<V>
  }
  return new BTree<number, V>() as unknown as SortedBTree<V>
}

interface SortedBTree<V> {
  set(key: number, value: V): void
  get(key: number): V | undefined
  has(key: number): boolean
  delete(key: number): void
  readonly size: number
  clear(): void
  entries(): IterableIterator<[number, V]>
  entries(lo: number | undefined): IterableIterator<[number, V]>
  keys(): IterableIterator<number>
}

/**
 * 内部有序映射：基于 BTree 实现，保证 O(log n) 操作。
 */
class SortedMap<V> {
  private _tree: SortedBTree<V>

  constructor() {
    this._tree = createBTree()
  }

  set(key: number, value: V): void {
    this._tree.set(key, value)
  }

  get(key: number): V | undefined {
    return this._tree.get(key)
  }

  delete(key: number): boolean {
    if (this._tree.has(key)) {
      this._tree.delete(key)
      return true
    }
    return false
  }

  has(key: number): boolean {
    return this._tree.has(key)
  }

  keys(): number[] {
    return [...this._tree.keys()]
  }

  get size(): number {
    return this._tree.size
  }

  entries(): Array<[number, V]> {
    return [...this._tree.entries()]
  }

  clear(): void {
    this._tree.clear()
  }

  entriesFrom(key: number): Array<[number, V]> {
    const result: Array<[number, V]> = []
    for (const [k, v] of this._tree.entries(key)) {
      result.push([k, v])
    }
    return result
  }

  entriesTo(key: number): Array<[number, V]> {
    const result: Array<[number, V]> = []
    for (const [k, v] of this._tree.entries()) {
      if (k > key) break
      result.push([k, v])
    }
    return result
  }

  entriesGreaterThan(key: number): Array<[number, V]> {
    const result: Array<[number, V]> = []
    for (const [k, v] of this._tree.entries()) {
      if (k > key) result.push([k, v])
    }
    return result
  }

  firstKey(): number | undefined {
    for (const [k] of this._tree.entries()) return k
    return undefined
  }

  lastKey(): number | undefined {
    let last: number | undefined
    for (const [k] of this._tree.entries()) last = k
    return last
  }
}

/**
 * RangeIndex — 数字属性范围索引
 *
 * 支持 lt, gt, lte, gte, between 五种范围查询。
 * 底层存储: 属性值 → Set<NodeId> 的有序映射 (B+Tree, O(log n))。
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
