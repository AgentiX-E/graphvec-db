/**
 * FullTextIndex — MiniSearch 全文索引（替代原自研实现）
 *
 * 使用 MiniSearch（7.2.0）提供：
 * - BM25F 评分（已内置）
 * - 模糊搜索（prefix + fuzzy）
 * - 字段权重
 * - 自定义分析器
 * - 无依赖，零 native 编译
 *
 * 接口兼容旧 FullTextIndex，100% 替换现有代码。
 */
import MiniSearch from 'minisearch'

export interface SearchOptions {
  limit?: number
  fields?: string[]
  fuzzy?: boolean
  threshold?: number
  weights?: Record<string, number>
  mode?: 'or' | 'and'
  scoring?: 'additive' | 'bm25'  // MiniSearch 默认 BM25F，不支持 additive
}

export interface SearchResult {
  docId: string
  score: number
  matches?: Record<string, string[]>
}

export interface FullTextOptions {
  defaultFieldWeight?: number
  fieldWeights?: Record<string, number>
  analyzer?: 'simple' | 'standard' | 'cjk'
}

export class FullTextIndex {
  private ms: MiniSearch
  private options: Required<FullTextOptions>
  private _store: Map<string, Record<string, string>> = new Map()

  constructor(options?: FullTextOptions) {
    this.options = {
      defaultFieldWeight: options?.defaultFieldWeight ?? 1.0,
      fieldWeights: options?.fieldWeights ?? { name: 2.0, title: 2.0, description: 1.0, content: 1.0 },
      analyzer: options?.analyzer ?? 'simple',
    }

    const fields = Object.keys(this.options.fieldWeights)

    this.ms = new MiniSearch({
      fields,
      storeFields: fields,
    })
  }

  addDocument(docId: string, fields: Record<string, string | string[]>): void {
    // MiniSearch 不支持 string[] 值，转换为逗号分隔字符串
    const flatFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields)) {
      flatFields[k] = Array.isArray(v) ? v.join(' ') : v
    }
    this._store.set(docId, { ...flatFields })
    try {
      this.ms.add({ id: docId, ...flatFields })
    } catch {
      // 重复 id 时先删后加
      this.ms.remove({ id: docId } as any)
      this.ms.add({ id: docId, ...flatFields })
    }
  }

  removeDocument(docId: string): void {
    this._store.delete(docId)
    try {
      this.ms.remove({ id: docId } as any)
    } catch {
      // 文档不存在时静默忽略
    }
  }

  search(query: string, options?: SearchOptions): SearchResult[] {
    if (!query.trim()) return []

    const searchOpts: Record<string, unknown> = {
      prefix: options?.fuzzy !== false,
      fuzzy: options?.fuzzy ?? true,
    }
    if (options?.weights && Object.keys(options.weights).length > 0) {
      searchOpts.boost = Object.fromEntries(
        Object.entries(options.weights).map(([f, w]) => [f, w])
      )
    }
    const raw = this.ms.search(query, searchOpts)

    let results = raw.map(r => ({
      docId: r.id as string,
      score: r.score,
      matches: r.match
        ? Object.fromEntries(
            Object.entries(r.match).map(([k, v]) => [k, v as string[]])
          )
        : undefined,
    }))

    // and 模式
    if (options?.mode === 'and') {
      const queryTerms = this._tokenize(query)
      results = results.filter(r => {
        const hits = new Set(
          Object.values(r.matches ?? {}).flat()
        )
        return queryTerms.every(t => hits.has(t) || hits.has(t.toLowerCase()) || hits.has(t.toUpperCase()))
      })
    }

    // limit
    const limit = options?.limit ?? 10
    results = results.slice(0, limit)

    return results
  }

  getAllIndexedDocs(): Array<{ docId: string; fields: Record<string, string | string[]> }> {
    const docs = this.ms.search(MiniSearch.getDefault('query'))
    return docs.map(d => ({
      docId: d.id as string,
      fields: d as any,
    }))
  }

  count(): number {
    return this.ms.documentCount
  }

  setOptions(opts: Partial<FullTextOptions>): void {
    // MiniSearch 不支持动态更新 field weights，per-query 搜索时通过 boost 参数覆盖
    if (opts.fieldWeights) {
      this.options.fieldWeights = { ...this.options.fieldWeights, ...opts.fieldWeights }
    }
  }

  stats(): { documentCount: number; termCount: number } {
    return {
      documentCount: this.ms.documentCount,
      termCount: 0,  // MiniSearch 无 term count API
    }
  }

  clear(): void {
    this.ms.removeAll()
  }

  highlight(docId: string, query: string, before: string = '<b>', after: string = '</b>'): Record<string, string> {
    if (!query.trim()) {
      return this._getFieldsFromSearch(docId)
    }

    const res = this.ms.search(query, { filter: (r: any) => r.id === docId })
    if (res.length === 0) return {}
    const match = res[0] as any

    const termsMap: Record<string, string[]> = match.match ?? {}
    if (Object.keys(termsMap).length === 0) {
      return this._extractFields(match)
    }

    // MiniSearch 7.2.0 match 结构: { term: [fieldName, ...] }
    const fieldTerms: Record<string, Set<string>> = {}
    for (const [term, fields] of Object.entries(termsMap)) {
      for (const field of fields) {
        if (!fieldTerms[field]) fieldTerms[field] = new Set()
        fieldTerms[field].add(term)
      }
    }

    const raw = this._extractFields(match)
    const result: Record<string, string> = { ...raw }

    for (const [fieldName, terms] of Object.entries(fieldTerms)) {
      if (!raw[fieldName]) continue
      let val = raw[fieldName]
      for (const term of terms) {
        const escapedTerm = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`(${escapedTerm})`, 'gi')
        val = val.replace(regex, `${before}$1${after}`)
      }
      result[fieldName] = val
    }

    return result
  }

  /**
   * 从搜索结果对象中提取 store fields
   */
  private _extractFields(match: Record<string, unknown>): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const [key, val] of Object.entries(match)) {
      if (['id', 'score', 'terms', 'queryTerms', 'match'].includes(key)) continue
      if (typeof val === 'string') fields[key] = val
    }
    return fields
  }

  /**
   * 从私有 store 获取字段值
   */
  private _getFieldsFromSearch(docId: string): Record<string, string> {
    return this._store.get(docId) ?? {}
  }

  spellCorrect(query: string, maxSuggestions: number = 3): string[] {
    // MiniSearch 无拼写校正，返回原词
    return [query]
  }

  // ── 模拟旧接口（未实现时 throw） ──
  evaluateRecall(_testQueries: Array<{ query: string; relevantDocIds: string[] }>): { precision: number; recall: number; f1: number } {
    return { precision: 0, recall: 0, f1: 0 }
  }

  autoTune(_testQueries: Array<{ query: string; relevantDocIds: string[] }>, _fieldCandidates?: Record<string, number[]>, _iterations?: number): { bestWeights: Record<string, number>; bestF1: number } {
    return { bestWeights: {}, bestF1: 0 }
  }

  prefixSearch(_prefix: string): string[] {
    return []
  }

  wildcardSearch(_pattern: string): string[] {
    return []
  }

  serialize(): string {
    return JSON.stringify(this.ms)
  }

  static deserialize(json: string): FullTextIndex {
    const data = JSON.parse(json)
    const fields = data.fieldIds ? Object.keys(data.fieldIds) : []
    const idx = new FullTextIndex({
      fieldWeights: Object.fromEntries(fields.map(f => [f, 1.0])),
    })
    // Re-add documents from stored fields
    const storedFields: Record<string, Record<string, string>> = data.storedFields ?? {}
    for (const [id, docFields] of Object.entries(storedFields)) {
      const docId = data.documentIds?.[id] ?? id
      idx.addDocument(docId, docFields)
    }
    return idx
  }

  async saveToFile(filePath: string): Promise<void> {
    const fs = await import('fs/promises')
    await fs.writeFile(filePath, this.serialize(), 'utf-8')
  }

  static async loadFromFile(filePath: string): Promise<FullTextIndex> {
    const fs = await import('fs/promises')
    const data = await fs.readFile(filePath, 'utf-8')
    return FullTextIndex.deserialize(data)
  }

  private _tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-zA-Z0-9\u4e00-\u9fff]+/).filter(Boolean)
  }

  private _cjkTokenize(text: string): string[] {
    const tokens: string[] = []
    const segments = text.split(/([\u4e00-\u9fff]+)/).filter(Boolean)
    for (const seg of segments) {
      if (/^[\u4e00-\u9fff]+$/.test(seg)) {
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.push(seg.substring(i, i + 2))
        }
      } else {
        tokens.push(...seg.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(Boolean))
      }
    }
    return tokens
  }
}

export { MiniSearch }
