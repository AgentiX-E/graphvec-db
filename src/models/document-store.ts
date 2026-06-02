// ============================================================
// DocumentStore — 文档模型存储（多模型支持）
//
// 在 LMDB 上叠加的文档存储抽象，对标 ArangoDB 的 document collection。
// 每个 collection 使用独立的 LMDB database（子数据库）。
// 文档与图节点共享同一个 LMDB 环境，共享加密和事务。
//
// 用法：
// ```ts
// const store = new DocumentStore('./data/db', { encryptionKey })
// const users = store.collection('users')
// const { _key, _rev } = await users.save({ name: 'Alice', age: 30 })
// const doc = await users.get(key)
// const results = await users.query({ age: { $gt: 25 } })
// await users.delete(key)
// ```
// ============================================================

import * as lmdb from 'lmdb'
import { v4 as uuidv4 } from 'uuid'
import { pack, unpack } from 'msgpackr'
import { createHash } from 'node:crypto'

// ── Types ─────────────────────────────────

export interface DocumentMeta {
  /** 文档主键（自动生成或由用户指定） */
  _key: string
  /** 修订版本哈希（基于内容） */
  _rev: string
}

export interface DocumentRecord<T = Record<string, unknown>> extends DocumentMeta {
  /** 文档主体 */
  body: T
}

export type DocumentBody = Record<string, unknown>

export interface CollectionConfig {
  /** Collection 名称 */
  name: string
  /**
   * LMDB 选项（覆盖默认）
   * 注意：name 字段由 collection 管理，不应在此处传递
   */
  lmdbOptions?: Omit<lmdb.DatabaseOptions, 'name'>
}

export interface QueryOptions {
  /** 返回结果上限 */
  limit?: number
  /** 跳过前 N 条 */
  offset?: number
  /** 排序字段 */
  sort?: Record<string, 1 | -1>
}

export interface DocumentStoreConfig {
  /** LMDB 数据库路径 */
  path: string
  /** 可选的加密密钥（256-bit hex） */
  encryptionKey?: string
  /**
   * LMDB 映射大小（字节），默认 256MB
   * 调整此值以控制数据库大小上限
   */
  mapSize?: number
}

/**
 * 查询操作符类型
 */
type QueryOperator = '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$exists'

/**
 * 文档查询过滤器
 */
export type DocumentFilter = {
  [field: string]:
    | string
    | number
    | boolean
    | null
    | Array<string | number>
    | { [op in QueryOperator]?: string | number | boolean | null | Array<string | number> }
}

// ── Constants ─────────────────────────────

const DEFAULT_MAP_SIZE = 256 * 1024 * 1024 // 256MB

// ── DocumentCollection 类 ────────────────

/**
 * DocumentCollection — 对标 ArangoDB Collection
 *
 * 每个 collection 使用独立的 LMDB database（子数据库）
 */
export class DocumentCollection<T = DocumentBody> {
  private db: lmdb.Database<DocumentRecord<T>, string>
  private _name: string

  constructor(name: string, env: lmdb.RootDatabase<any>, lmdbOpts?: lmdb.DatabaseOptions) {
    this._name = name
    this.db = env.openDB<DocumentRecord<T>, string>({
      name: `collection_${name}`,
      ...lmdbOpts,
    })
  }

  /** Collection 名称 */
  get name(): string {
    return this._name
  }

  /**
   * 保存文档
   *
   * - 如果 body 中包含 _key，使用该值作为主键
   * - 否则自动生成 UUID 作为 _key
   * - 自动计算 _rev（基于内容 SHA-256）
   *
   * @param body 文档内容
   * @returns 文档元数据 { _key, _rev }
   */
  async save(body: Partial<DocumentMeta> & T): Promise<DocumentMeta> {
    if (!body || typeof body !== 'object') {
      throw new Error('Document body must be a non-null object')
    }

    // 提取或生成 _key
    const key = (body as any)._key ?? uuidv4()

    // 计算 _rev
    const rev = this.computeRev(body as Record<string, unknown>)

    const record: DocumentRecord<T> = {
      _key: key,
      _rev: rev,
      body: body as T,
    }

    await this.db.put(key, record)
    return { _key: key, _rev: rev }
  }

  /**
   * 按主键获取文档
   *
   * @param key 文档主键
   * @returns 文档记录，不存在则返回 null
   */
  async get(key: string): Promise<DocumentRecord<T> | null> {
    if (!key) {
      throw new Error('Document key is required')
    }

    const record = this.db.get(key)
    return record ?? null
  }

  /**
   * 查询文档
   *
   * 支持简单的字段过滤和排序。查询采用全表扫描 + 过滤器模式
   * （类似于低数据量下的 MongoDB 查询）。
   *
   * 支持的查询操作符：
   * - $eq: 等于（默认）
   * - $ne: 不等于
   * - $gt: 大于
   * - $gte: 大于等于
   * - $lt: 小于
   * - $lte: 小于等于
   * - $in: 在列表中
   * - $nin: 不在列表中
   * - $exists: 字段存在
   *
   * @param filter 查询过滤器
   * @param opts 查询选项
   * @returns 匹配的文档列表
   */
  async query(
    filter: DocumentFilter = {},
    opts: QueryOptions = {},
  ): Promise<DocumentRecord<T>[]> {
    // 遍历所有文档并过滤
    const results: DocumentRecord<T>[] = []

    for (const { value } of this.db.getRange()) {
      if (this.matchesFilter(value, filter)) {
        results.push(value)
      }
    }

    // 排序
    if (opts.sort) {
      this.applySort(results, opts.sort)
    }

    // 分页
    const offset = opts.offset ?? 0
    const limit = opts.limit ?? results.length
    return results.slice(offset, offset + limit)
  }

  /**
   * 按主键删除文档
   *
   * @param key 文档主键
   * @returns 是否成功删除
   */
  async delete(key: string): Promise<boolean> {
    if (!key) {
      throw new Error('Document key is required')
    }

    const exists = this.db.get(key)
    if (!exists) {
      return false
    }

    await this.db.remove(key)
    return true
  }

  /**
   * 获取 collection 中的文档总数
   */
  async count(): Promise<number> {
    let count = 0
    for (const _ of this.db.getRange()) {
      count++
    }
    return count
  }

  /**
   * 检查文档是否存在
   *
   * @param key 文档主键
   */
  async exists(key: string): Promise<boolean> {
    if (!key) return false
    return this.db.doesExist(key)
  }

  /**
   * 清空 collection
   */
  async clear(): Promise<void> {
    // LMDB 的 clear 方法清空当前 database
    await this.db.clearAsync()
  }

  // ── Private Helpers ──────────────────────

  /**
   * 基于文档内容的 SHA-256 哈希计算修订版本号
   */
  private computeRev(data: Record<string, unknown>): string {
    // 排除 _rev 字段避免循环，排除 _key 以允许 key 不变时内容变更
    const { _key, _rev, ...body } = data as any
    const serialized = pack(body)
    const hash = createHash('sha256').update(serialized).digest('hex')
    return hash.substring(0, 12) // 取前 12 字符作为简短修订号
  }

  /**
   * 检查文档是否匹配过滤器
   */
  private matchesFilter(
    record: DocumentRecord<T>,
    filter: DocumentFilter,
  ): boolean {
    const body = record.body as Record<string, unknown>

    for (const [field, condition] of Object.entries(filter)) {
      const actualValue = body[field]

      // 简单值比较
      if (
        typeof condition === 'string' ||
        typeof condition === 'number' ||
        typeof condition === 'boolean' ||
        condition === null
      ) {
        if (!this.compareEq(actualValue, condition)) {
          return false
        }
      } else if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        // 操作符比较
        const ops = condition as Record<string, any>

        for (const [op, expected] of Object.entries(ops)) {
          switch (op) {
            case '$eq':
              if (!this.compareEq(actualValue, expected)) return false
              break
            case '$ne':
              if (this.compareEq(actualValue, expected)) return false
              break
            case '$gt':
              if (typeof actualValue !== 'number' || actualValue <= (expected as number))
                return false
              break
            case '$gte':
              if (typeof actualValue !== 'number' || actualValue < (expected as number))
                return false
              break
            case '$lt':
              if (typeof actualValue !== 'number' || actualValue >= (expected as number))
                return false
              break
            case '$lte':
              if (typeof actualValue !== 'number' || actualValue > (expected as number))
                return false
              break
            case '$in':
              if (!Array.isArray(expected) || !expected.some((e) => this.compareEq(actualValue, e)))
                return false
              break
            case '$nin':
              if (!Array.isArray(expected) || expected.some((e) => this.compareEq(actualValue, e)))
                return false
              break
            case '$exists':
              if (expected === true && actualValue === undefined) return false
              if (expected === false && actualValue !== undefined) return false
              break
            default:
              // 未知操作符，跳过
              break
          }
        }
      }
    }

    return true
  }

  /**
   * 宽松相等比较（处理类型差异）
   */
  private compareEq(a: unknown, b: unknown): boolean {
    // null/undefined 处理
    if (a === undefined || a === null || b === undefined || b === null) {
      return a === b
    }
    // 如果两者都是 number，可以安全比较
    if (typeof a === 'number' && typeof b === 'number') {
      return a === b
    }
    // 字符串比较
    return String(a) === String(b)
  }

  /**
   * 对查询结果排序
   */
  private applySort(
    results: DocumentRecord<T>[],
    sort: Record<string, 1 | -1>,
  ): void {
    const fields = Object.entries(sort)

    results.sort((a, b) => {
      const bodyA = a.body as Record<string, unknown>
      const bodyB = b.body as Record<string, unknown>

      for (const [field, order] of fields) {
        const valA = bodyA[field]
        const valB = bodyB[field]

        if (valA === valB || (valA === undefined && valB === undefined)) {
          continue
        }
        if (valA === undefined) return 1
        if (valB === undefined) return -1

        const cmp =
          typeof valA === 'number' && typeof valB === 'number'
            ? valA - valB
            : String(valA).localeCompare(String(valB))

        if (cmp !== 0) return cmp * order
      }
      return 0
    })
  }
}

// ── DocumentStore 类 ──────────────────────

/**
 * DocumentStore — 文档存储管理器
 *
 * 管理多个 DocumentCollection，每个 collection 使用独立的 LMDB database。
 * 所有 collection 共享同一个 LMDB 环境（加密、事务）。
 */
export class DocumentStore {
  private env: lmdb.Database<any, any>
  private collections: Map<string, DocumentCollection> = new Map()
  private _path: string
  private _closed = false

  constructor(config: DocumentStoreConfig) {
    this._path = config.path

    const lmdbOptions: lmdb.DatabaseOptions & { path?: string; mapSize?: number } = {
      path: config.path,
      mapSize: config.mapSize ?? DEFAULT_MAP_SIZE,
    }

    if (config.encryptionKey) {
      // LMDB 加密要求 key 为 32 字节 Buffer
      const keyBuffer = Buffer.from(config.encryptionKey, 'hex')
      if (keyBuffer.length !== 32) {
        throw new Error(
          `Encryption key must be 32 bytes (64 hex chars), got ${keyBuffer.length} bytes`,
        )
      }
      ;(lmdbOptions as any).encryptionKey = keyBuffer
    }

    this.env = lmdb.open(lmdbOptions as any)
  }

  /** 数据库路径 */
  get path(): string {
    return this._path
  }

  /**
   * 获取或创建文档 collection
   *
   * @param name Collection 名称
   * @param config 可选的 Collection 配置
   * @returns DocumentCollection 实例
   */
  collection<T = DocumentBody>(
    name: string,
    config?: CollectionConfig,
  ): DocumentCollection<T> {
    if (!name || typeof name !== 'string') {
      throw new Error('Collection name must be a non-empty string')
    }

    const existing = this.collections.get(name)
    if (existing) {
      return existing as unknown as DocumentCollection<T>
    }

    const collection = new DocumentCollection<T>(name, this.env, config?.lmdbOptions)
    this.collections.set(name, collection as unknown as DocumentCollection)
    return collection
  }

  /**
   * 删除 collection（关闭并移除）
   *
   * @param name Collection 名称
   */
  async dropCollection(name: string): Promise<boolean> {
    const collection = this.collections.get(name)
    if (!collection) {
      return false
    }

    // 清空数据
    await collection.clear()
    this.collections.delete(name)
    return true
  }

  /**
   * 获取所有 collection 名称列表
   */
  listCollections(): string[] {
    return Array.from(this.collections.keys())
  }

  /**
   * 关闭文档存储并释放 LMDB 资源
   */
  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.collections.clear()
    await this.env.close()
  }
}

// ── 辅助函数 ──────────────────────────────

/**
 * 生成文档 key（使用 UUID v4）
 */
export function generateKey(): string {
  return uuidv4()
}
