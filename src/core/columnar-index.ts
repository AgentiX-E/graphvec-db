/**
 * columnar-index.ts — 列式索引
 *
 * 为节点/边的属性列构建持久化 B-Tree 索引，加速属性范围扫描。
 *
 * 设计：
 * - 使用 `lmdb` 持久化列索引
 * - 键格式: `<column_name>:<value>:<node_id>`
 * - 支持 String 和 Number 类型的属性列索引
 * - 在写入时同步或异步维护索引
 *
 * 架构：
 *   OverGraphStorage.upsertNode()
 *     → ColumnarIndex.updateNodeIndexes(id, props)
 *       → 对每个已索引列：删除旧键 + 写入新键
 *
 *   OverGraphStorage.deleteNode()
 *     → ColumnarIndex.deleteNodeIndexes(id)
 *       → 扫描 db 中所有该 node_id 的条目并删除
 *
 *   scanNodes({ where: { age: { gt: 30 } } })
 *     → ColumnarIndex.rangeScan('age', 'gt', 30)
 *       → lmdb 前缀扫描 + 值过滤
 */

import { open, type Database, type RootDatabase } from 'lmdb'
import * as path from 'path'

export type CompareOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'

export interface ColumnarIndexConfig {
  /** 是否启用列索引 */
  enable: boolean
  /** 要索引的属性列名列表 */
  columns: string[]
  /** 索引存储路径，默认 {storagePath}/col-index/ */
  indexPath?: string
  /** 是否在写入时同步维护索引，默认 true */
  syncOnWrite?: boolean
}

/**
 * 归档节点 ID 及其列值，供范围扫描返回。
 */
export interface IndexEntry {
  nodeId: number
  value: string | number
}

/**
 * 序列化 LMDB 键。
 * 格式: `<column_name>:<value>:<node_id>`
 * 值使用定宽字符串以支持自然排序。
 */
function encodeKey(col: string, val: string | number, nodeId: number): string {
  // 数值补零到 20 位以支持字典序范围扫描
  const valStr = typeof val === 'number'
    ? val.toString().padStart(20, '0')
    : val
  return `${col}:${valStr}:${nodeId}`
}

/**
 * 解析 LMDB 键，提取列名和值。
 * 键格式: `<column_name>:<value>:<node_id>`
 */
export function parseKey(key: string): { col: string; val: string; nodeId: number } | null {
  // 拆分格式: col:val:nodeId — value 可能包含冒号，所以从右拆分
  const lastColon = key.lastIndexOf(':')
  if (lastColon === -1) return null
  const nodeIdStr = key.substring(lastColon + 1)
  const nodeId = parseInt(nodeIdStr, 10)
  if (isNaN(nodeId)) return null

  const rest = key.substring(0, lastColon)
  const firstColon = rest.indexOf(':')
  if (firstColon === -1) return null
  const col = rest.substring(0, firstColon)
  const val = rest.substring(firstColon + 1)

  return { col, val, nodeId }
}

/**
 * ColumnarIndex — 列式索引
 *
 * 使用 `lmdb` 持久化存储，键格式为 `<column>:<value>:<nodeId>`。
 * 支持 eq/gt/gte/lt/lte/between 范围扫描。
 */
export class ColumnarIndex {
  private _db: Database<string, string> | null = null
  private _rootDb: RootDatabase | null = null
  private config: ColumnarIndexConfig
  private storagePath: string

  constructor(config: ColumnarIndexConfig, storagePath: string) {
    this.config = {
      syncOnWrite: true,
      ...config,
    }
    this.storagePath = storagePath
  }

  get isOpen(): boolean {
    return this._db !== null
  }

  /**
   * 打开列索引数据库。
   */
  open(): void {
    if (this._db) return
    const indexPath = this.config.indexPath ?? path.join(this.storagePath, 'col-index')
    this._rootDb = open({ path: indexPath, encoding: 'string' })
    this._db = this._rootDb.openDB({ name: 'columnar', encoding: 'string' })
  }

  /**
   * 关闭列索引数据库。
   */
  close(): void {
    if (this._db) {
      this._db.close()
      this._db = null
    }
    if (this._rootDb) {
      this._rootDb.close()
      this._rootDb = null
    }
  }

  /**
   * 是否为已索引的列。
   */
  isIndexed(col: string): boolean {
    return this.config.enable && this.config.columns.includes(col)
  }

  /**
   * 返回所有已索引的列名。
   */
  getIndexedColumns(): string[] {
    return this.config.enable ? [...this.config.columns] : []
  }

  /**
   * 为指定列名构建/重建全量索引。
   * 遍历所有节点并构建索引条目。
   *
   * @param col - 要索引的列名
   * @param nodeIterator - 返回 [nodeId, props] 的迭代器或数组
   */
  buildForColumn(
    col: string,
    nodeIterator: Iterable<[number, Record<string, unknown>]>,
  ): void {
    if (!this._db) throw new Error('ColumnarIndex is not open')

    // 先删除该列的所有索引
    this._deleteColumn(col)

    // 遍历所有节点，构建索引
    for (const [nodeId, props] of nodeIterator) {
      const val = props[col]
      if (val !== undefined && val !== null && (typeof val === 'string' || typeof val === 'number')) {
        const key = encodeKey(col, val, nodeId)
        this._db!.putSync(key, '1')
      }
    }
  }

  /**
   * 删除某个列的所有索引条目。
   */
  private _deleteColumn(col: string): void {
    if (!this._db) return
    const prefix = `${col}:`
    // 用 lmdb 的 getRange 遍历
    for (const key of this._db.getKeys({ start: prefix, end: prefix + '\uffff' })) {
      this._db!.removeSync(key)
    }
  }

  /**
   * 范围扫描。
   *
   * @param col - 列名
   * @param op - 比较操作符
   * @param val - 比较值
   * @param val2 - between 操作符的右边界
   * @returns 匹配的节点 ID 列表
   */
  rangeScan(
    col: string,
    op: CompareOp,
    val: string | number,
    val2?: string | number,
  ): number[] {
    if (!this._db) throw new Error('ColumnarIndex is not open')
    if (!this.isIndexed(col)) {
      return [] // 列未索引，返回空（调用方应回退到全表扫描）
    }

    const prefix = `${col}:`
    const valStr = typeof val === 'number' ? val.toString().padStart(20, '0') : val
    const valStr2 = typeof val2 === 'number' ? val2.toString().padStart(20, '0') : val2

    const results: number[] = []

    switch (op) {
      case 'eq': {
        const start = `${prefix}${valStr}:`
        const end = `${prefix}${valStr}:\uffff`
        for (const key of this._db.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'gt': {
        // gt: value 之后的所有条目
        const start = `${prefix}${valStr}:\uffff` // 跳过 valStr 本身
        const end = `${prefix}\uffff`
        for (const key of this._db.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'gte': {
        // gte: value 及之后的所有条目
        const start = `${prefix}${valStr}:`
        const end = `${prefix}\uffff`
        for (const key of this._db.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'lt': {
        // lt: value 之前的所有条目
        const start = `${prefix}`
        const end = `${prefix}${valStr}:`
        for (const key of this._db.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'lte': {
        const start = `${prefix}`
        const end = `${prefix}${valStr}:\uffff`
        for (const key of this._db.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'between': {
        // between val and val2
        if (val2 === undefined) break
        const start = `${prefix}${valStr}:`
        const end = `${prefix}${valStr2}:\uffff`
        for (const key of this._db.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }
    }

    return results
  }

  /**
   * 等值查询的便捷方法。
   */
  eq(col: string, val: string | number): number[] {
    return this.rangeScan(col, 'eq', val)
  }

  /**
   * 删除某个节点的所有列索引条目。
   * 在 deleteNode 时调用。
   */
  deleteNodeIndexes(nodeId: number): void {
    if (!this._db) throw new Error('ColumnarIndex is not open')
    for (const col of this.config.columns) {
      // 扫描该列下所有包含此 nodeId 的条目
      const prefix = `${col}:`
      for (const key of this._db.getKeys({ start: prefix, end: prefix + '\uffff' })) {
        if (key.endsWith(`:${nodeId}`)) {
          this._db.removeSync(key)
        }
      }
    }
  }

  /**
   * 更新某个节点的列索引条目。
   * 在 upsertNode 时调用。
   * 先删除该节点的所有旧索引，再写入新值。
   */
  updateNodeIndexes(nodeId: number, props: Record<string, unknown>): void {
    if (!this._db) throw new Error('ColumnarIndex is not open')

    // 先删除该节点现有的所有索引
    this.deleteNodeIndexes(nodeId)

    // 对每个已索引列写入新值
    for (const col of this.config.columns) {
      const val = props[col]
      if (val !== undefined && val !== null && (typeof val === 'string' || typeof val === 'number')) {
        const key = encodeKey(col, val, nodeId)
        this._db.putSync(key, '1')
      }
    }
  }
}
