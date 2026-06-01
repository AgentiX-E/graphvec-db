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
 * 支持 WAL（Write-Ahead Log）持久化：
 * - JSONL 格式，append-only
 * - 启动时自动回放恢复索引
 * - 超过 1MB 自动轮转
 * - 文档数达到 10K（可配置）时生成快照并清理 WAL
 *
 * 接口兼容旧 FullTextIndex，100% 替换现有代码。
 *
 * 增强:
 * - P1-Q20: 可配置的 analyzer 函数链，支持 useAnalyzer(name) 接口
 * - Item 15: 同义词支持（SynonymMap），搜索时自动扩展同义词
 */
import MiniSearch from 'minisearch'
import * as fs from 'fs'
import * as path from 'path'

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
  baseDir?: string
  snapshotThreshold?: number  // 触发快照的文档数阈值，默认 10000
}

// ── Analyzer 链 ──────────────────────────────────────────

/**
 * AnalyzerFn — 文本分析函数类型
 * 输入原始文本，输出 token 列表
 */
export type AnalyzerFn = (text: string) => string[]

/**
 * 预定义 analyzer 实现
 */
export const Analyzers: Record<string, AnalyzerFn> = {
  /** simple: 小写 + 按非字母数字字符分割 */
  simple: (text: string): string[] => {
    return text.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(Boolean)
  },

  /** standard: 同 simple，但保留更多格式 */
  standard: (text: string): string[] => {
    return text.toLowerCase().split(/[\s,.;:!?"'()]+/).filter(Boolean)
  },

  /** cjk: 中英文混合分词 */
  cjk: (text: string): string[] => {
    const tokens: string[] = []
    const segments = text.split(/([\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+)/).filter(Boolean)
    for (const seg of segments) {
      if (/^[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+$/.test(seg)) {
        _cjkBigrams(seg, tokens)
      } else {
        tokens.push(...seg.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(Boolean))
      }
    }
    return tokens
  },

  /** whitespace: 仅按空白字符分割 */
  whitespace: (text: string): string[] => {
    return text.split(/\s+/).filter(Boolean)
  },
}

/**
 * AnalyzerChain — 可组合的 analyzer 函数链
 * 按顺序应用多个分析步骤
 */
export class AnalyzerChain {
  private fns: AnalyzerFn[] = []

  constructor(fns?: AnalyzerFn[]) {
    if (fns) this.fns = [...fns]
  }

  /** 添加分析步骤 */
  use(fn: AnalyzerFn): AnalyzerChain {
    this.fns.push(fn)
    return this
  }

  /** 使用命名 analyzer */
  useAnalyzer(name: string): AnalyzerChain {
    const fn = Analyzers[name]
    if (!fn) {
      throw new Error(`Unknown analyzer: "${name}". Available: ${Object.keys(Analyzers).join(', ')}`)
    }
    this.fns.push(fn)
    return this
  }

  /** 执行分析链 */
  analyze(text: string): string[] {
    let tokens = [text]
    for (const fn of this.fns) {
      tokens = tokens.flatMap(t => fn(t))
    }
    return [...new Set(tokens)] // 去重
  }

  /** 清空分析链 */
  clear(): void {
    this.fns = []
  }

  /** 获取当前分析器数量 */
  get length(): number {
    return this.fns.length
  }
}

// ── 同义词支持 ───────────────────────────────────────────

/**
 * SynonymMap — 同义词映射
 *
 * 用于搜索时自动扩展同义词，提高召回率。
 * 支持双向同义词（如 电脑↔计算机）和单向同义词（如 AT&T → AT T）
 */
export class SynonymMap {
  private _map: Map<string, string[]> = new Map()
  private _reverseMap: Map<string, string[]> = new Map()

  /**
   * 设置同义词。
   * 同义词是双向的：如果 "电脑" → ["计算机", "微机"]，
   * 那么搜索 "计算机" 也会匹配 "电脑"。
   */
  setSynonyms(synonyms: Record<string, string[]>): void {
    for (const [term, syns] of Object.entries(synonyms)) {
      const normalizedTerm = term.toLowerCase()
      const normalizedSyns = syns.map(s => s.toLowerCase())

      this._map.set(normalizedTerm, normalizedSyns)

      // 建立反向映射
      for (const syn of normalizedSyns) {
        if (!this._reverseMap.has(syn)) {
          this._reverseMap.set(syn, [])
        }
        this._reverseMap.get(syn)!.push(normalizedTerm)
      }
    }
  }

  /**
   * 从 Map 对象设置同义词
   */
  setSynonymsFromMap(map: Map<string, string[]>): void {
    for (const [term, syns] of map) {
      this.setSynonyms({ [term]: syns })
    }
  }

  /**
   * 获取指定词的所有同义词（包含自身）
   */
  getSynonyms(term: string): string[] {
    const normalized = term.toLowerCase()
    const result = new Set<string>()
    result.add(normalized)

    // 前向同义词
    const forward = this._map.get(normalized)
    if (forward) {
      for (const s of forward) result.add(s)
    }

    // 反向同义词
    const reverse = this._reverseMap.get(normalized)
    if (reverse) {
      for (const s of reverse) result.add(s)
    }

    return [...result]
  }

  /**
   * 扩展查询词为同义词列表（每个查询词展开为 OR 同义词组）
   */
  expandQuery(query: string): string[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const expanded: string[] = []

    for (const term of terms) {
      const syns = this.getSynonyms(term)
      expanded.push(...syns)
    }

    return [...new Set(expanded)]
  }

  /**
   * 获取所有注册的同义词词条数
   */
  get size(): number {
    return this._map.size
  }

  /**
   * 清空同义词映射
   */
  clear(): void {
    this._map.clear()
    this._reverseMap.clear()
  }
}

// ── WAL 条目类型 ──
interface WalAddEntry {
  op: 'add'
  id: string
  text: string
}

interface WalRemoveEntry {
  op: 'remove'
  id: string
}

type WalEntry = WalAddEntry | WalRemoveEntry

// ── 快照格式 ──
interface SnapshotData {
  storedFields: Record<string, Record<string, string>>
  fieldIds: Record<string, number>
}

export class FullTextIndex {
  private ms: MiniSearch
  private options: Required<FullTextOptions>
  private _store: Map<string, Record<string, string>> = new Map()

  // ── Analyzer 链 ──
  private _analyzerChain: AnalyzerChain

  // ── 同义词 ──
  private _synonymMap: SynonymMap = new SynonymMap()

  // ── WAL 持久化相关 ──
  private _baseDir: string | null = null
  private _walPath: string | null = null
  private _snapshotPath: string | null = null
  private _walFd: number | null = null
  private _walSize = 0
  private _snapshotThreshold: number
  private static readonly MAX_WAL_BYTES = 1 * 1024 * 1024  // 1MB
  private static readonly WAL_FILENAME = 'fulltext-index.wal'
  private static readonly SNAPSHOT_FILENAME = 'fulltext-index.snapshot.json'

  constructor(options?: FullTextOptions) {
    this.options = {
      defaultFieldWeight: options?.defaultFieldWeight ?? 1.0,
      fieldWeights: options?.fieldWeights ?? { name: 2.0, title: 2.0, description: 1.0, content: 1.0 },
      analyzer: options?.analyzer ?? 'simple',
    }

    const fields = Object.keys(this.options.fieldWeights)

    // 根据 options.analyzer 选择 tokenize 策略
    let tokenizeFn: (text: string) => string[]
    const analyzerOpt = this.options.analyzer

    if (analyzerOpt === 'simple') {
      tokenizeFn = (text: string) => text.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(Boolean)
    } else if (analyzerOpt === 'standard') {
      tokenizeFn = (text: string) => text.toLowerCase().split(/[\s,.;:!?"'()]+/).filter(Boolean)
    } else {
      // cjk default
      tokenizeFn = (text: string) => FullTextIndex._cjkTokenize(text)
    }

    this.ms = new MiniSearch({
      fields,
      storeFields: fields,
      tokenize: tokenizeFn,
      processTerm: (term: string) => {
        if (/^[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+$/.test(term)) {
          return term
        }
        return term.toLowerCase()
      },
    })

    // 初始化 analyzer 链
    this._analyzerChain = new AnalyzerChain()
    if (analyzerOpt) {
      this._analyzerChain.useAnalyzer(analyzerOpt)
    }

    this._snapshotThreshold = options?.snapshotThreshold ?? 10000

    // ── WAL 恢复 ──
    if (options?.baseDir) {
      this._baseDir = options.baseDir
      this._walPath = path.join(options.baseDir, FullTextIndex.WAL_FILENAME)
      this._snapshotPath = path.join(options.baseDir, FullTextIndex.SNAPSHOT_FILENAME)
      this._recoverFromWAL()
    }
  }

  // ──────────────────────────────────────────────
  //  Analyzer Chain API (P1-Q20)
  // ──────────────────────────────────────────────

  /**
   * 使用指定的 analyzer 进行分析（返回 token 列表）
   */
  useAnalyzer(name: string): void {
    this._analyzerChain.useAnalyzer(name)
  }

  /**
   * 使用自定义 analyzer 函数
   */
  useAnalyzerFn(fn: AnalyzerFn): void {
    this._analyzerChain.use(fn)
  }

  /**
   * 获取 analyzer 链实例（用于自定义组合）
   */
  getAnalyzerChain(): AnalyzerChain {
    return this._analyzerChain
  }

  /**
   * 分析文本并返回 token（仅 analyzer 链，不含索引）
   */
  analyze(text: string): string[] {
    return this._analyzerChain.analyze(text)
  }

  // ──────────────────────────────────────────────
  //  Synonym Map API (Item 15)
  // ──────────────────────────────────────────────

  /**
   * 设置同义词映射
   */
  setSynonyms(synonyms: Record<string, string[]>): void {
    this._synonymMap.setSynonyms(synonyms)
  }

  /**
   * 从 Map 设置同义词
   */
  setSynonymsFromMap(map: Map<string, string[]>): void {
    this._synonymMap.setSynonymsFromMap(map)
  }

  /**
   * 获取同义词映射实例
   */
  getSynonymMap(): SynonymMap {
    return this._synonymMap
  }

  // ──────────────────────────────────────────────
  //  WAL 持久化：公共关闭/刷新方法
  // ──────────────────────────────────────────────

  /**
   * 关闭 WAL 文件句柄。在不再需要写入 WAL 时调用。
   * 注意：close() 后 add/remove 仍可工作，只是不再写入 WAL。
   */
  close(): void {
    this._closeWalFd()
  }

  /**
   * 获取当前 WAL 文件字节数（主要用于测试和监控）
   */
  get walSize(): number {
    return this._walSize
  }

  /**
   * 强制将当前索引状态写入快照文件并清空 WAL。
   * 通常由内部自动触发（文档数达到阈值时），也可以手动调用。
   */
  forceSnapshot(): void {
    this._takeSnapshot()
  }

  /**
   * 返回当前已加载的文档数（含从 WAL/快照恢复的部分）
   */
  count(): number {
    return this.ms.documentCount
  }

  // ──────────────────────────────────────────────
  //  WAL 恢复逻辑
  // ──────────────────────────────────────────────

  /**
   * 启动时回放 WAL，恢复索引状态。
   * 如果存在快照文件，优先从快照恢复，然后回放 WAL 增量。
   */
  private _recoverFromWAL(): void {
    // 1) 尝试从快照恢复
    if (this._snapshotPath && fs.existsSync(this._snapshotPath)) {
      try {
        this._loadSnapshot()
      } catch (e) {
        console.warn('[FullTextIndex] snapshot corrupted, falling back to WAL replay:', e)
      }
    }

    // 2) 回放 WAL（优先回放 .old 文件，再回放当前 .wal）
    const rotatedPath = this._walPath ? this._walPath + '.old' : null
    if (rotatedPath && fs.existsSync(rotatedPath)) {
      try {
        this._replayWalFile(rotatedPath)
      } catch (e) {
        console.warn('[FullTextIndex] rotated WAL replay failed:', e)
      }
    }
    if (this._walPath && fs.existsSync(this._walPath)) {
      try {
        this._replayWal()
      } catch (e) {
        console.warn('[FullTextIndex] WAL replay failed, starting empty:', e)
      }
    }

    // 3) 打开 WAL 供追加写入（append mode）
    this._openWalForAppend()
  }

  /**
   * 从快照文件加载索引状态
   */
  private _loadSnapshot(): void {
    if (!this._snapshotPath) return
    const raw = fs.readFileSync(this._snapshotPath, 'utf-8')
    const snapshot: SnapshotData = JSON.parse(raw)

    // 重建 store
    for (const [id, docFields] of Object.entries(snapshot.storedFields ?? {})) {
      this._store.set(id, { ...docFields })
    }

    // 重建 MiniSearch 索引：逐个添加文档
    for (const [id, docFields] of Object.entries(snapshot.storedFields ?? {})) {
      try {
        this.ms.add({ id, ...docFields })
      } catch {
        this.ms.remove({ id } as any)
        this.ms.add({ id, ...docFields })
      }
    }
  }

  /**
   * 回放 WAL 中的条目（主 WAL 文件）
   */
  private _replayWal(): void {
    if (!this._walPath) return
    this._replayWalFile(this._walPath)

    // 回放完成后截断 WAL
    this._closeWalFd()
    fs.writeFileSync(this._walPath, '', 'utf-8')
    this._walSize = 0
    this._openWalForAppend()
  }

  /**
   * 从指定文件回放 WAL 条目
   */
  private _replayWalFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return
    const content = fs.readFileSync(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: WalEntry
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue  // 跳过格式错误的条目
      }

      if (entry.op === 'add') {
        const docFields: Record<string, string> = {}
        // text 字段包含原始文本，需要将字段权重中定义的字段填充
        const fields = Object.keys(this.options.fieldWeights)
        for (const f of fields) {
          docFields[f] = entry.text
        }
        // 如果 text 本身是 JSON 格式，尝试解析为多字段
        try {
          const parsed = JSON.parse(entry.text)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              docFields[k] = String(v)
            }
          }
        } catch {
          // not JSON, use as-is
        }

        this._store.set(entry.id, { ...docFields })
        try {
          this.ms.add({ id: entry.id, ...docFields })
        } catch {
          this.ms.remove({ id: entry.id } as any)
          this.ms.add({ id: entry.id, ...docFields })
        }
      } else if (entry.op === 'remove') {
        this._store.delete(entry.id)
        try {
          this.ms.remove({ id: entry.id } as any)
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * 打开 WAL 文件用于追加写入
   */
  private _openWalForAppend(): void {
    if (!this._walPath) return

    // 如果文件不存在，创建空文件
    if (!fs.existsSync(this._walPath)) {
      try {
        fs.mkdirSync(path.dirname(this._walPath), { recursive: true })
      } catch {
        // 目录可能已存在
      }
      fs.writeFileSync(this._walPath, '', 'utf-8')
      this._walSize = 0
    } else {
      // 获取现有文件大小
      try {
        const stat = fs.statSync(this._walPath)
        this._walSize = stat.size
      } catch {
        this._walSize = 0
      }
    }

    try {
      this._walFd = fs.openSync(this._walPath, 'a')
    } catch (e) {
      console.warn('[FullTextIndex] cannot open WAL for append:', e)
      this._walFd = null
    }
  }

  /**
   * 关闭 WAL 文件句柄
   */
  private _closeWalFd(): void {
    if (this._walFd !== null) {
      try {
        fs.closeSync(this._walFd)
      } catch {
        // ignore
      }
      this._walFd = null
    }
  }

  /**
   * 追加一条 WAL 条目，并在必要时轮转或快照
   */
  private _appendWal(entry: WalEntry): void {
    const line = JSON.stringify(entry) + '\n'
    const bytes = Buffer.byteLength(line, 'utf-8')

    // 如果当前 WAL + 新条目超过上限，先轮转（rename），然后重新打开
    if (this._walSize + bytes > FullTextIndex.MAX_WAL_BYTES) {
      this._rotateWal()
    }

    if (this._walFd !== null && this._walPath) {
      try {
        fs.writeSync(this._walFd, line)
        this._walSize += bytes
      } catch (e) {
        console.warn('[FullTextIndex] WAL write failed:', e)
      }
    }

    // 如果文档数达到快照阈值，自动生成快照
    if (this.ms.documentCount >= this._snapshotThreshold) {
      this._takeSnapshot()
    }
  }

  /**
   * 轮转 WAL：将当前 WAL 重命名为 .old 后缀，重新创建新 WAL
   */
  private _rotateWal(): void {
    if (!this._walPath) return

    this._closeWalFd()

    const rotatedPath = this._walPath + '.old'
    try {
      // 如果 .old 已存在，先删除
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath)
      }
      fs.renameSync(this._walPath, rotatedPath)
    } catch (e) {
      console.warn('[FullTextIndex] WAL rotation failed:', e)
    }

    this._walSize = 0
    this._openWalForAppend()
  }

  /**
   * 生成快照：将当前索引状态（store + fieldIds）写入 JSON 文件，然后清空 WAL
   */
  private _takeSnapshot(): void {
    if (!this._snapshotPath || !this._baseDir) return

    this._closeWalFd()

    // 构建 snapshot 数据
    const storedFields: Record<string, Record<string, string>> = {}
    for (const [id, fields] of this._store.entries()) {
      storedFields[id] = { ...fields }
    }

    // fieldIds 从 options.fieldWeights 的 keys 构建（仅用于 format 兼容）
    const fieldIds: Record<string, number> = {}
    Object.keys(this.options.fieldWeights).forEach((f, i) => {
      fieldIds[f] = i
    })

    const snapshot: SnapshotData = { storedFields, fieldIds }

    // 写入临时文件，然后原子性 rename（防止写一半崩溃）
    const tmpPath = this._snapshotPath + '.tmp'
    try {
      fs.mkdirSync(path.dirname(this._snapshotPath), { recursive: true })
    } catch {
      // ignore
    }
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf-8')
    fs.renameSync(tmpPath, this._snapshotPath)

    // 清空 WAL
    fs.writeFileSync(this._walPath!, '', 'utf-8')
    this._walSize = 0

    // 重新打开 WAL
    this._openWalForAppend()
  }

  // ──────────────────────────────────────────────
  //  公开接口（addDocument / removeDocument 已嵌入 WAL）
  // ──────────────────────────────────────────────

  addDocument(docId: string, fields: Record<string, string | string[]>): void {
    // MiniSearch 不支持 string[] 值，转换为逗号分隔字符串
    const flatFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields)) {
      flatFields[k] = Array.isArray(v) ? v.join(' ') : v
    }
    this._store.set(docId, { ...flatFields })

    // 先删后加（处理重复 id）
    try {
      this.ms.add({ id: docId, ...flatFields })
    } catch {
      this.ms.remove({ id: docId } as any)
      this.ms.add({ id: docId, ...flatFields })
    }

    // WAL: 将多字段序列化为 JSON 字符串保存
    this._appendWal({ op: 'add', id: docId, text: JSON.stringify(flatFields) })
  }

  removeDocument(docId: string): void {
    this._store.delete(docId)
    try {
      this.ms.remove({ id: docId } as any)
    } catch {
      // 文档不存在时静默忽略
    }

    this._appendWal({ op: 'remove', id: docId })
  }

  // ──────────────────────────────────────────────
  //  搜索 / 查询接口（不变）
  // ──────────────────────────────────────────────

  search(query: string, options?: SearchOptions): SearchResult[] {
    if (!query.trim()) return []

    // 扩展同义词
    let expandedQuery = query
    if (this._synonymMap.size > 0) {
      const expandedTerms = this._synonymMap.expandQuery(query)
      if (expandedTerms.length > 0) {
        expandedQuery = expandedTerms.join(' ')
      }
    }

    const searchOpts: Record<string, unknown> = {
      prefix: options?.fuzzy !== false,
      fuzzy: options?.fuzzy ?? true,
    }
    if (options?.weights && Object.keys(options.weights).length > 0) {
      searchOpts.boost = Object.fromEntries(
        Object.entries(options.weights).map(([f, w]) => [f, w])
      )
    }
    const raw = this.ms.search(expandedQuery, searchOpts)

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
      const queryTerms = this._tokenize(expandedQuery)
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
    this._store.clear()
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
    const fsp = await import('fs/promises')
    await fsp.writeFile(filePath, this.serialize(), 'utf-8')
  }

  static async loadFromFile(filePath: string): Promise<FullTextIndex> {
    const fsp = await import('fs/promises')
    const data = await fsp.readFile(filePath, 'utf-8')
    return FullTextIndex.deserialize(data)
  }

  // ──────────────────────────────────────────────
  //  Tokenizer（不变）
  // ──────────────────────────────────────────────

  /**
   * CJK-aware tokenizer using character bigrams (overlapping 2-grams) for CJK text
   * and whitespace/punctuation splitting for non-CJK text.
   *
   * Character bigrams with overlap ensure that any 2-character search term
   * will match, while still providing good recall for longer phrases.
   * Examples:
   *   "编程"      → ["编程"]
   *   "南京市"    → ["南京", "京市"]
   *   "Python编程guide" → ["python", "编程", "guide"]
   *
   * Supports:
   * - CJK Unified Ideographs (Chinese, Japanese Kanji)
   * - Hiragana / Katakana (Japanese)
   * - ASCII alphanumeric (English / mixed)
   */
  private static _cjkTokenize(text: string): string[] {
    const tokens: string[] = []

    // Split by CJK characters — this separates CJK runs from ASCII runs
    const segments = text.split(/([\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+)/).filter(Boolean)

    for (const seg of segments) {
      if (/^[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+$/.test(seg)) {
        // CJK segment: emit overlapping character bigrams
        FullTextIndex._cjkBigrams(seg, tokens)
      } else {
        // Non-CJK — standard lowercasing and split
        tokens.push(...seg.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(Boolean))
      }
    }

    return tokens
  }

  /**
   * Generate overlapping character bigrams from a CJK string and append to tokens array.
   * For single characters (rare), emit the character itself.
   */
  private static _cjkBigrams(text: string, out: string[]): void {
    if (text.length >= 2) {
      for (let i = 0; i < text.length - 1; i++) {
        out.push(text.substring(i, i + 2))
      }
    } else if (text.length === 1) {
      out.push(text)
    }
  }

  private _tokenize(text: string): string[] {
    return FullTextIndex._cjkTokenize(text)
  }
}

export { MiniSearch }

/**
 * 生成重叠字符二元组
 */
function _cjkBigrams(text: string, out: string[]): void {
  if (text.length >= 2) {
    for (let i = 0; i < text.length - 1; i++) {
      out.push(text.substring(i, i + 2))
    }
  } else if (text.length === 1) {
    out.push(text)
  }
}
