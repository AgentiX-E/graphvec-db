// ============================================================
// FulltextIndex — 基于 MiniSearch 的标签化全文索引
//
// 为不同 label 维护独立的 MiniSearch 实例，支持：
// - 按 label 添加/搜索
// - 模糊搜索、前缀搜索
// - 从 GraphEngine 批量重建
// ============================================================

import MiniSearch from 'minisearch'

export interface SearchOptions {
  fuzzy?: boolean
  prefix?: boolean
  topK?: number
}

export interface SearchHit {
  id: number
  score: number
}

/**
 * 标签化全文索引。
 * 每个 label 对应一个独立的 MiniSearch 实例。
 */
export class FulltextIndex {
  /** label → MiniSearch 实例 */
  private indices: Map<string, MiniSearch>

  /** label → 内部文档 ID 自增计数器 */
  private counters: Map<string, number>

  /** label → 文档 id → 存储字段快照（用于重建等场景） */
  private stores: Map<string, Map<number, Record<string, string>>>

  constructor() {
    this.indices = new Map()
    this.counters = new Map()
    this.stores = new Map()
  }

  /**
   * 为指定 label 注册索引字段。
   * label 为 "" 时不影响搜索，仅用于分层索引。
   * @param label — 标签名称
   * @param textFields — 要索引的字段名列表
   */
  addLabel(label: string, textFields: string[]): void {
    if (this.indices.has(label)) {
      // 已存在，更新字段（仅当 fields 变化时重建）
      const existing = this.indices.get(label)!
      // MiniSearch 不支持动态添加字段，因此重新创建
      const ms = new MiniSearch({
        fields: textFields,
        storeFields: textFields,
      })
      // 迁移已有文档
      const store = this.stores.get(label)
      if (store) {
        for (const [docId, fields] of store) {
          try {
            ms.add({ id: String(docId), ...fields })
          } catch {
            // 跳过冲突文档
          }
        }
      }
      this.indices.set(label, ms)
      return
    }

    const ms = new MiniSearch({
      fields: textFields,
      storeFields: textFields,
    })
    this.indices.set(label, ms)
    this.stores.set(label, new Map())
    this.counters.set(label, 0)
  }

  /**
   * 向指定 label 的索引中插入一条文档。
   * @param label — 标签名
   * @param id — 文档 ID（整数）
   * @param doc — 文档字段
   */
  index(label: string, id: number, doc: Record<string, string>): void {
    let ms = this.indices.get(label)
    if (!ms) {
      // 自动创建索引（使用 doc 的所有字段）
      const fields = Object.keys(doc)
      this.addLabel(label, fields)
      ms = this.indices.get(label)!
    }

    // 更新内部存储
    const store = this.stores.get(label)!
    store.set(id, { ...doc })

    // 向 MiniSearch 添加（先删后加以处理重复 id）
    try {
      ms.add({ id: String(id), ...doc })
    } catch {
      try {
        ms.remove({ id: String(id) } as any)
        ms.add({ id: String(id), ...doc })
      } catch {
        // 兜底
      }
    }

    // 更新计数器
    const counter = this.counters.get(label) ?? 0
    if (id >= counter) {
      this.counters.set(label, id + 1)
    }
  }

  /**
   * 在指定 label 中搜索。
   * @param label — 标签名
   * @param query — 搜索词
   * @param options — 搜索选项
   * @returns 匹配结果数组（按评分降序）
   */
  search(
    label: string,
    query: string,
    options?: SearchOptions,
  ): SearchHit[] {
    const ms = this.indices.get(label)
    if (!ms) {
      return []
    }

    if (!query || query.trim().length === 0) {
      return []
    }

    const searchOpts: Record<string, unknown> = {}
    if (options?.fuzzy === true) {
      searchOpts.fuzzy = true
    }
    if (options?.prefix === true) {
      searchOpts.prefix = true
    }
    const topK = options?.topK ?? 10

    const raw = ms.search(query, searchOpts)
    return raw.slice(0, topK).map(r => ({
      id: parseInt(String(r.id), 10),
      score: r.score,
    }))
  }

  /**
   * 从 GraphEngine 批量重建索引。
   *
   * 遍历引擎中所有节点，按节点的 label/type 分组，
   * 将文本属性字段（如 name, title, description, content 等）索引到对应 label。
   *
   * @param engine — GraphEngine 实例
   */
  rebuildFromEngine(engine: any): void {
    // 清空所有现有索引
    this.indices.clear()
    this.stores.clear()
    this.counters.clear()

    // 获取所有节点 ID
    let nodeIds: number[]
    try {
      if (typeof engine.getNodeIds === 'function') {
        nodeIds = engine.getNodeIds()
      } else if (typeof engine.getAllNodeIds === 'function') {
        nodeIds = engine.getAllNodeIds()
      } else {
        // 尝试从 storage 获取
        nodeIds = engine.storage?.getAllNodeIds?.() ?? []
      }
    } catch {
      nodeIds = []
    }

    if (nodeIds.length === 0) return

    // 文本字段候选列表
    const textFieldCandidates = ['name', 'title', 'description', 'content', 'label', 'tags', 'summary', 'text']

    // 遍历节点，按类型分组索引
    const labelDocs = new Map<string, Array<{ id: number; fields: Record<string, string> }>>()

    for (const nodeId of nodeIds) {
      try {
        const node = engine.getNode(nodeId)
        if (!node) continue

        // 确定 label：优先使用 type/label 字段
        let label = 'default'
        if (node.label && typeof node.label === 'string') {
          label = node.label
        } else if (node.type !== undefined) {
          label = String(node.type)
        }

        // 提取文本字段
        const props: Record<string, unknown> = {}
        if (node.props && typeof node.props === 'object') {
          Object.assign(props, node.props)
        }

        const fields: Record<string, string> = {}
        for (const field of textFieldCandidates) {
          const val = props[field] ?? (node as any)[field]
          if (val !== undefined && val !== null) {
            fields[field] = String(val)
          }
        }

        if (Object.keys(fields).length === 0) continue

        if (!labelDocs.has(label)) {
          labelDocs.set(label, [])
        }
        labelDocs.get(label)!.push({ id: nodeId, fields })
      } catch {
        // 跳过有问题的节点
      }
    }

    // 为每个 label 创建索引
    for (const [label, docs] of labelDocs) {
      if (docs.length === 0) continue

      // 收集所有出现过的字段
      const fieldSet = new Set<string>()
      for (const doc of docs) {
        for (const key of Object.keys(doc.fields)) {
          fieldSet.add(key)
        }
      }
      const fields = [...fieldSet]

      this.addLabel(label, fields)
      for (const doc of docs) {
        this.index(label, doc.id, doc.fields)
      }
    }
  }

  /**
   * 获取所有已注册的 label。
   */
  getLabels(): string[] {
    return [...this.indices.keys()]
  }

  /**
   * 返回指定 label 下的文档数。
   */
  count(label: string): number {
    const ms = this.indices.get(label)
    if (!ms) return 0
    return ms.documentCount
  }

  /**
   * 清空指定 label 的索引。
   */
  clearLabel(label: string): void {
    this.indices.delete(label)
    this.stores.delete(label)
    this.counters.delete(label)
  }

  /**
   * 清空所有索引。
   */
  clearAll(): void {
    this.indices.clear()
    this.stores.clear()
    this.counters.clear()
  }
}
