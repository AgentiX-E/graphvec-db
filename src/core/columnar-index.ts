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
 * GAP-61: 在线重建 — Double-Buffer 交换方案
 * - 新增 `buildForColumnDoubleBuffer()` 在备用库完成重建后原子交换
 * - 重建期间 activeDb 继续服务查询
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
  /** 是否启用 double-buffer 在线重建，默认 false */
  doubleBufferRebuild?: boolean
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
 *
 * GAP-61: Double-Buffer 在线重建
 * - _activeDb: 当前服务查询的数据库
 * - _replicaDb: 重建时使用的备库
 * - _isRebuilding: 是否正在重建中
 */
export class ColumnarIndex {
  private _activeDb: Database<string, string> | null = null
  private _replicaDb: Database<string, string> | null = null
  private _activeRootDb: RootDatabase | null = null
  private _replicaRootDb: RootDatabase | null = null
  private _isRebuilding: boolean = false
  /** 当前 active db 的名字，用于 double-buffer 交替 */
  private _activeDbName: string = 'columnar'
  /** 当前 replica db 的名字 */
  private _replicaDbName: string = 'columnar-rebuild'
  private config: ColumnarIndexConfig
  private storagePath: string

  constructor(config: ColumnarIndexConfig, storagePath: string) {
    this.config = {
      syncOnWrite: true,
      doubleBufferRebuild: false,
      ...config,
    }
    this.storagePath = storagePath
  }

  get isOpen(): boolean {
    return this._activeDb !== null
  }

  /** 是否正在执行 double-buffer 重建 */
  get isRebuilding(): boolean {
    return this._isRebuilding
  }

  /**
   * 打开列索引数据库。
   */
  open(): void {
    if (this._activeDb) return
    const indexPath = this.config.indexPath ?? path.join(this.storagePath, 'col-index')
    this._activeRootDb = open({ path: indexPath, encoding: 'string' })
    this._activeDb = this._activeRootDb.openDB({ name: 'columnar', encoding: 'string' })
  }

  /**
   * 关闭列索引数据库（包括重建中的备库）。
   */
  close(): void {
    if (this._replicaRootDb) {
      this._replicaRootDb.close()
      this._replicaRootDb = null
      this._replicaDb = null
    }
    if (this._activeDb) {
      this._activeDb.close()
      this._activeDb = null
    }
    if (this._activeRootDb) {
      this._activeRootDb.close()
      this._activeRootDb = null
    }
    this._isRebuilding = false
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
    if (!this._activeDb) throw new Error('ColumnarIndex is not open')

    // 先删除该列的所有索引
    this._deleteColumn(col, this._activeDb)

    // 遍历所有节点，构建索引
    for (const [nodeId, props] of nodeIterator) {
      const val = props[col]
      if (val !== undefined && val !== null && (typeof val === 'string' || typeof val === 'number')) {
        const key = encodeKey(col, val, nodeId)
        this._activeDb!.putSync(key, '1')
      }
    }
  }

  // ── GAP-61: Double-Buffer 在线重建 ──────────

  /**
   * Double-Buffer 在线重建索引。
   * 在备用库上执行全量重建，完成后原子交换 active/replica。
   *
   * 流程：
   * 1. 打开备用库（在同一 LMDB 环境下使用不同 dbName）
   * 2. 在备用库上完成全量构建
   * 3. 原子交换：关闭 active 库，将 replica 提升为 active
   * 4. 旧 active 库关闭并丢弃
   *
   * 优势：
   * - 重建期间 activeDb 继续服务所有查询
   * - 切换瞬间（微秒级）完成
   * - 失败时自动回滚（仅丢弃备用库，不影响 active）
   *
   * @param col - 要索引的列名
   * @param nodeIterator - 返回 [nodeId, props] 的迭代器或数组
   * @throws Error 如果没有启用 doubleBuffer 或 db 未打开
   */
  buildForColumnDoubleBuffer(
    col: string,
    nodeIterator: Iterable<[number, Record<string, unknown>]>,
  ): void {
    if (!this._activeDb) throw new Error('ColumnarIndex is not open')
    if (!this.config.doubleBufferRebuild) {
      // 未启用 double-buffer 时降级为普通重建
      this.buildForColumn(col, nodeIterator)
      return
    }

    this._isRebuilding = true
    try {
      // 1. 打开备用库
      this._ensureReplicaDb()

      // 2. 在备用库上重建（先删除旧索引）
      this._deleteColumn(col, this._replicaDb!)
      for (const [nodeId, props] of nodeIterator) {
        const val = props[col]
        if (val !== undefined && val !== null && (typeof val === 'string' || typeof val === 'number')) {
          const key = encodeKey(col, val, nodeId)
          this._replicaDb!.putSync(key, '1')
        }
      }

      // 3. 原子交换：关闭 active，将 replica 提升为 active
      this._swapDatabases()
    } finally {
      this._isRebuilding = false
    }
  }

  /**
   * 确保备用库已打开（在同一个 LMDB RootDatabase 下）。
   * 使用交替的 dbName 来隔离数据（防止同名字段冲突）。
   */
  private _ensureReplicaDb(): void {
    if (this._replicaDb) return // 如果已有备库，复用

    if (!this._activeRootDb) {
      // 如果 activeRootDb 也不存在，重新打开
      const indexPath = this.config.indexPath ?? path.join(this.storagePath, 'col-index')
      this._activeRootDb = open({ path: indexPath, encoding: 'string' })
      this._activeDb = this._activeRootDb.openDB({ name: this._activeDbName, encoding: 'string' })
    }

    // 切换 replica db 名，确保不与 active 冲突
    // 首次: columnar-rebuild
    // 如果 active 当前是 columnar-rebuild，则用 columnar-rebuild-2
    let replicaName = 'columnar-rebuild'
    if (this._activeDbName === replicaName) {
      replicaName = 'columnar-rebuild-2'
    }
    this._replicaDbName = replicaName

    this._replicaRootDb = null // 共享同一个 RootDatabase
    this._replicaDb = this._activeRootDb!.openDB({
      name: this._replicaDbName,
      encoding: 'string',
    })
  }

  /**
   * 原子交换 active 和 replica 库。
   *
   * 交换步骤：
   * 1. 关闭旧的 activeDb（但不关闭 rootDb）
   * 2. 将 replica 提升为 active（db 引用交换）
   * 3. 更新 active/replica db 名称记录
   * 4. 清空 replica 引用（下一次 rebuild 会重新打开）
   */
  private _swapDatabases(): void {
    // 1. 关闭旧的 activeDb（sub-db，只关闭 db 引用，不关 rootDb）
    if (this._activeDb) {
      this._activeDb.close()
    }

    // 2. 交换：replica → active
    this._activeDb = this._replicaDb
    this._activeDbName = this._replicaDbName

    // 3. 清空 replica 引用（下一次 rebuild 会重新打开，使用不同的 name）
    this._replicaDb = null
    this._replicaRootDb = null
  }

  /**
   * 删除某个列的所有索引条目。
   */
  private _deleteColumn(col: string, db: Database<string, string>): void {
    const prefix = `${col}:`
    // 用 lmdb 的 getRange 遍历
    for (const key of db.getKeys({ start: prefix, end: prefix + '\uffff' })) {
      db.removeSync(key)
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
    if (!this._activeDb) throw new Error('ColumnarIndex is not open')
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
        for (const key of this._activeDb.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'gt': {
        // gt: value 之后的所有条目
        const start = `${prefix}${valStr}:\uffff` // 跳过 valStr 本身
        const end = `${prefix}\uffff`
        for (const key of this._activeDb.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'gte': {
        // gte: value 及之后的所有条目
        const start = `${prefix}${valStr}:`
        const end = `${prefix}\uffff`
        for (const key of this._activeDb.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'lt': {
        // lt: value 之前的所有条目
        const start = `${prefix}`
        const end = `${prefix}${valStr}:`
        for (const key of this._activeDb.getKeys({ start, end })) {
          const parsed = parseKey(key)
          if (parsed) results.push(parsed.nodeId)
        }
        break
      }

      case 'lte': {
        const start = `${prefix}`
        const end = `${prefix}${valStr}:\uffff`
        for (const key of this._activeDb.getKeys({ start, end })) {
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
        for (const key of this._activeDb.getKeys({ start, end })) {
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
    if (!this._activeDb) throw new Error('ColumnarIndex is not open')
    for (const col of this.config.columns) {
      // 扫描该列下所有包含此 nodeId 的条目
      const prefix = `${col}:`
      for (const key of this._activeDb.getKeys({ start: prefix, end: prefix + '\uffff' })) {
        if (key.endsWith(`:${nodeId}`)) {
          this._activeDb.removeSync(key)
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
    if (!this._activeDb) throw new Error('ColumnarIndex is not open')

    // 先删除该节点现有的所有索引
    this.deleteNodeIndexes(nodeId)

    // 对每个已索引列写入新值
    for (const col of this.config.columns) {
      const val = props[col]
      if (val !== undefined && val !== null && (typeof val === 'string' || typeof val === 'number')) {
        const key = encodeKey(col, val, nodeId)
        this._activeDb.putSync(key, '1')
      }
    }
  }
}
