// ============================================================
// CompositeIndex — 复合索引引擎
//
// 支持多字段复合索引，包括：
// - addRecord / removeRecord 维护索引记录
// - query 支持精确匹配、范围查询、前缀匹配
// - 跨字段复合查询（AND 逻辑）
// - indexName / clear 等方法
// - 唯一约束持久化（用 OverGraph 特殊节点存储）
// ============================================================

export interface IndexRecord {
  id: string
  fields: Record<string, string | number | boolean>
}

export interface QueryCondition {
  field: string
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'prefix'
  value: string | number | boolean
}

export interface IndexStats {
  name: string
  recordCount: number
  fieldKeys: string[]
}

/** 唯一约束配置 */
export interface UniqueConstraint {
  /** 唯一约束名称 */
  name: string
  /** 约束包含的字段列表 */
  fields: string[]
  /** 是否启用（可暂时关闭） */
  enabled: boolean
}

/** 唯一约束持久化使用的特殊节点键名 */
const UNIQUE_CONSTRAINT_NODE_PREFIX = '__sys_uc_'
/** 持久化中存储所有约束的元键 */
const ALL_CONSTRAINTS_KEY = '__sys_all_unique_constraints'
/** 持久化文件，使用普通 JSON 文件存储（兼容性优于 OverGraph 特殊节点） */
const UNIQUE_CONSTRAINTS_FILE = '.unique-constraints'

import * as fs from 'fs'
import * as path from 'path'

/**
 * 安全解析并验证唯一约束持久化数据
 */
function parseUniqueConstraints(content: string): UniqueConstraint[] {
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c: any) => c && typeof c.name === 'string' && Array.isArray(c.fields),
    )
  } catch {
    return []
  }
}

export class CompositeIndex {
  private records: Map<string, IndexRecord> = new Map()
  private fieldIndex: Map<string, Map<string, Set<string>>> = new Map() // field → value → record ids
  private numericIndex: Map<string, Map<number, Set<string>>> = new Map() // field → number value → record ids

  /** 唯一约束列表 */
  private uniqueConstraints: UniqueConstraint[] = []
  /** 持久化路径（设置后启用自动持久化） */
  private persistPath: string | null = null

  constructor(public readonly name: string) {}

  // ─────────── 唯一约束 ───────────

  /**
   * 添加唯一约束
   * 约束生效后，addRecord 若导致指定字段组合重复则会抛出异常
   */
  addUniqueConstraint(name: string, fields: string[]): void {
    // 检查同名约束
    if (this.uniqueConstraints.some(c => c.name === name)) {
      throw new Error(`Unique constraint "${name}" already exists`)
    }

    this.uniqueConstraints.push({ name, fields, enabled: true })
    this._persistConstraints().catch(() => {
      // 持久化失败仅记录日志，不阻止操作
    })
  }

  /**
   * 移除唯一约束
   */
  removeUniqueConstraint(name: string): void {
    const idx = this.uniqueConstraints.findIndex(c => c.name === name)
    if (idx === -1) {
      throw new Error(`Unique constraint "${name}" not found`)
    }
    this.uniqueConstraints.splice(idx, 1)
    this._persistConstraints().catch(() => {})
  }

  /**
   * 启用/禁用唯一约束
   */
  setUniqueConstraintEnabled(name: string, enabled: boolean): void {
    const constraint = this.uniqueConstraints.find(c => c.name === name)
    if (!constraint) {
      throw new Error(`Unique constraint "${name}" not found`)
    }
    constraint.enabled = enabled
    this._persistConstraints().catch(() => {})
  }

  /**
   * 获取所有唯一约束
   */
  getUniqueConstraints(): UniqueConstraint[] {
    return [...this.uniqueConstraints]
  }

  /**
   * 检查记录是否满足所有已启用的唯一约束
   * 如果违反约束，返回第一个违例的约束名称；否则返回 null
   */
  checkUniqueConstraints(record: IndexRecord): string | null {
    for (const constraint of this.uniqueConstraints) {
      if (!constraint.enabled) continue

      // 检查该记录是否所有必填字段都有值
      const missing = constraint.fields.filter(f => !(f in record.fields))
      if (missing.length > 0) continue // 不完整字段不触发约束（允许部分更新）

      // 构建组合键
      const compositeKey = this._buildCompositeKey(record, constraint.fields)

      // 搜索已存在的记录，看是否有冲突
      // 对于每个约束字段，在索引中查找具有相同值的其他记录
      const conflictingIds = this._findByFields(constraint.fields, record)

      // 排除当前记录自身
      const otherIds = conflictingIds.filter(id => id !== record.id)
      if (otherIds.length > 0) {
        return constraint.name
      }
    }
    return null
  }

  /** 添加记录到索引 */
  addRecord(record: IndexRecord): void {
    // 检查唯一约束（如果记录已存在，检查时排除自身）
    const oldRecord = this.records.get(record.id)
    if (oldRecord) {
      // 先移除旧记录，再检查约束
      this._removeFromIndex(record.id)
    }

    // 检查唯一约束
    const violation = this.checkUniqueConstraints(record)
    if (violation !== null) {
      // 恢复旧记录（如果之前移除了）
      if (oldRecord) {
        this._addToIndex(oldRecord)
      }
      throw new Error(
        `Unique constraint violation: "${violation}" on record "${record.id}"`,
      )
    }

    this._addToIndex(record)
  }

  /** 从索引中移除记录 */
  removeRecord(recordId: string): boolean {
    const record = this.records.get(recordId)
    if (!record) return false

    this._removeFromIndex(recordId)
    return true
  }

  /** 精确查询 */
  queryExact(field: string, value: string | number | boolean): string[] {
    if (typeof value === 'number') {
      const numMap = this.numericIndex.get(field)
      if (!numMap) return []
      const set = numMap.get(value)
      return set ? Array.from(set) : []
    }
    const strValue = String(value)
    const strMap = this.fieldIndex.get(field)
    if (!strMap) return []
    const set = strMap.get(strValue)
    return set ? Array.from(set) : []
  }

  /** 范围查询（仅支持数值） */
  queryRange(field: string, min?: number, max?: number): string[] {
    const numMap = this.numericIndex.get(field)
    if (!numMap) return []

    const result: Set<string> = new Set()
    for (const [numVal, ids] of numMap.entries()) {
      if (min !== undefined && numVal < min) continue
      if (max !== undefined && numVal > max) continue
      for (const id of ids) {
        result.add(id)
      }
    }
    return Array.from(result)
  }

  /** 前缀查询（仅支持字符串值） */
  queryPrefix(field: string, prefix: string): string[] {
    const strMap = this.fieldIndex.get(field)
    if (!strMap) return []

    const result: Set<string> = new Set()
    for (const [strVal, ids] of strMap.entries()) {
      if (strVal.startsWith(prefix)) {
        for (const id of ids) {
          result.add(id)
        }
      }
    }
    return Array.from(result)
  }

  /** 通用查询（支持精确/范围/前缀条件，多个条件 AND 合并） */
  query(conditions: QueryCondition[]): string[] {
    if (conditions.length === 0) {
      return Array.from(this.records.keys())
    }

    let result: string[] | null = null

    for (const condition of conditions) {
      let ids: string[] = []

      switch (condition.operator) {
        case 'eq':
          ids = this.queryExact(condition.field, condition.value)
          break
        case 'gt':
          {
            const val = Number(condition.value)
            ids = this.queryRange(condition.field, val + 1)
          }
          break
        case 'gte':
          {
            const val = Number(condition.value)
            ids = this.queryRange(condition.field, val)
          }
          break
        case 'lt':
          {
            const val = Number(condition.value)
            ids = this.queryRange(condition.field, undefined, val - 1)
          }
          break
        case 'lte':
          {
            const val = Number(condition.value)
            ids = this.queryRange(condition.field, undefined, val)
          }
          break
        case 'prefix':
          ids = this.queryPrefix(condition.field, String(condition.value))
          break
      }

      const resultSet = new Set(ids)
      if (result === null) {
        result = ids
      } else {
        result = result.filter(id => resultSet.has(id))
      }
    }

    return result ?? []
  }

  /** 获取索引名称 */
  indexName(): string {
    return this.name
  }

  /** 清空索引 */
  clear(): void {
    this.records.clear()
    this.fieldIndex.clear()
    this.numericIndex.clear()
    this.uniqueConstraints = []
  }

  /** 获取统计信息 */
  stats(): IndexStats {
    const fieldKeys = new Set<string>()
    for (const [, record] of this.records) {
      for (const key of Object.keys(record.fields)) {
        fieldKeys.add(key)
      }
    }
    return {
      name: this.name,
      recordCount: this.records.size,
      fieldKeys: Array.from(fieldKeys),
    }
  }

  /** 获取记录数 */
  get size(): number {
    return this.records.size
  }

  // ─────────── 持久化 ───────────

  /**
   * 启用唯一约束持久化
   * 在持久化存储目录中保存唯一约束配置
   * @param storagePath 存储目录路径
   */
  enablePersistence(storagePath: string): void {
    this.persistPath = storagePath
    // 确保目录存在
    fs.mkdirSync(storagePath, { recursive: true })
    // 尝试从文件加载
    this._loadConstraints()
  }

  /**
   * 禁用持久化
   */
  disablePersistence(): void {
    this.persistPath = null
  }

  /**
   * 从文件加载唯一约束
   */
  private _loadConstraints(): void {
    if (!this.persistPath) return

    const filePath = path.join(this.persistPath, UNIQUE_CONSTRAINTS_FILE)
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        const loaded = parseUniqueConstraints(content)
        if (loaded.length > 0) {
          this.uniqueConstraints = loaded
        }
      }
    } catch {
      // 加载失败不阻断
    }
  }

  /**
   * 持久化唯一约束到文件（同步写入，确保重启后约束生效）
   */
  private async _persistConstraints(): Promise<void> {
    if (!this.persistPath) return

    const filePath = path.join(this.persistPath, UNIQUE_CONSTRAINTS_FILE)
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const content = JSON.stringify(this.uniqueConstraints, null, 2)
      fs.writeFileSync(filePath, content, 'utf-8')
    } catch {
      // 持久化失败时静默处理
    }
  }

  // ─────────── 内部方法 ───────────

  /**
   * 将记录添加到索引（不检查唯一约束）
   */
  private _addToIndex(record: IndexRecord): void {
    this.records.set(record.id, record)

    for (const [field, value] of Object.entries(record.fields)) {
      if (typeof value === 'number') {
        if (!this.numericIndex.has(field)) {
          this.numericIndex.set(field, new Map())
        }
        const numMap = this.numericIndex.get(field)!
        if (!numMap.has(value)) {
          numMap.set(value, new Set())
        }
        numMap.get(value)!.add(record.id)
      } else {
        const strValue = String(value)
        if (!this.fieldIndex.has(field)) {
          this.fieldIndex.set(field, new Map())
        }
        const strMap = this.fieldIndex.get(field)!
        if (!strMap.has(strValue)) {
          strMap.set(strValue, new Set())
        }
        strMap.get(strValue)!.add(record.id)
      }
    }
  }

  /**
   * 从索引中移除记录（不验证记录是否存在）
   */
  private _removeFromIndex(recordId: string): void {
    const record = this.records.get(recordId)
    if (!record) return

    for (const [field, value] of Object.entries(record.fields)) {
      if (typeof value === 'number') {
        const numMap = this.numericIndex.get(field)
        if (numMap) {
          const set = numMap.get(value)
          if (set) {
            set.delete(recordId)
            if (set.size === 0) numMap.delete(value)
          }
          if (numMap.size === 0) this.numericIndex.delete(field)
        }
      } else {
        const strValue = String(value)
        const strMap = this.fieldIndex.get(field)
        if (strMap) {
          const set = strMap.get(strValue)
          if (set) {
            set.delete(recordId)
            if (set.size === 0) strMap.delete(strValue)
          }
          if (strMap.size === 0) this.fieldIndex.delete(field)
        }
      }
    }

    this.records.delete(recordId)
  }

  /**
   * 查找具有相同字段组合的其他记录
   */
  private _findByFields(fields: string[], record: IndexRecord): string[] {
    if (fields.length === 0) return []

    // 使用第一个字段的精确查询初步筛选
    const firstField = fields[0]
    const firstValue = record.fields[firstField]
    if (firstValue === undefined) return []

    let candidates = this.queryExact(firstField, firstValue)

    // 逐步缩小范围
    for (let i = 1; i < fields.length; i++) {
      const field = fields[i]
      const value = record.fields[field]
      if (value === undefined) {
        // 如果记录缺少约束中的某个字段，不算冲突
        return []
      }
      const fieldMatches = this.queryExact(field, value)
      const matchSet = new Set(fieldMatches)
      candidates = candidates.filter(id => matchSet.has(id))
    }

    return candidates
  }

  /**
   * 构建复合键字符串
   */
  private _buildCompositeKey(record: IndexRecord, fields: string[]): string {
    return fields.map(f => `${f}=${record.fields[f] ?? ''}`).join('|')
  }
}
