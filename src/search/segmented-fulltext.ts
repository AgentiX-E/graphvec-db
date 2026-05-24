// ============================================================
// SegmentedFullTextIndex — Lucene Segment 风格的分段全文索引
// 将文档分配到多个 FullTextIndex（segment）中，每个 segment
// 达到上限后冻结（read-only），新建 segment。搜索跨 segment
// 合并结果，防止单个 Map 膨胀导致 OOM。
// ============================================================

import { FullTextIndex, type SearchOptions, type SearchResult, type FullTextOptions } from './fulltext'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface IndexSegment {
  /** 段 ID（创建时的时间戳） */
  id: number
  /** 段内文档数 */
  documentCount: number
  /** 底层 FullTextIndex 实例 */
  index: FullTextIndex
  /** 是否已冻结（只读） */
  isReadOnly: boolean
}

export interface SegmentedFullTextOptions extends FullTextOptions {
  /** 每段最大文档数（默认 100000） */
  maxSegmentSize?: number
  /** 触发合并的最大段数（默认 4） */
  maxSegments?: number
  /** 合并策略：'largest-first'（合并最小的段）| 'oldest-first' */
  mergePolicy?: 'largest-first' | 'oldest-first'
}

// ──────────────────────────────────────────
// SegmentedFullTextIndex 类
// ──────────────────────────────────────────

export class SegmentedFullTextIndex {
  private segments: IndexSegment[] = []
  private activeSegment: IndexSegment | null = null
  private maxSegmentSize: number
  private maxSegments: number
  private mergePolicy: 'largest-first' | 'oldest-first'
  private totalDocs: number = 0

  constructor(options?: SegmentedFullTextOptions) {
    this.maxSegmentSize = options?.maxSegmentSize ?? 100000
    this.maxSegments = options?.maxSegments ?? 4
    this.mergePolicy = options?.mergePolicy ?? 'largest-first'
  }

  // ──────────────────────────────────────────
  // 公开 API
  // ──────────────────────────────────────────

  /**
   * 添加文档到当前活跃段
   * 活跃段满时自动轮转创建新段
   */
  addDocument(docId: string, fields: Record<string, string | string[]>): void {
    if (!this.activeSegment || this.activeSegment.documentCount >= this.maxSegmentSize) {
      this.rotateSegment()
    }

    const seg = this.activeSegment!
    seg.index.addDocument(docId, fields)
    seg.documentCount = seg.index.count()
    this.totalDocs++

    if (this.shouldMerge()) {
      this.merge()
    }
  }

  /**
   * 删除文档（在所有段中查找并删除）
   */
  removeDocument(docId: string): void {
    for (const seg of this.segments) {
      const before = seg.index.count()
      seg.index.removeDocument(docId)
      const after = seg.index.count()
      if (after < before) {
        this.totalDocs--
        seg.documentCount = after
        break
      }
    }
  }

  /**
   * 搜索所有段，合并排序结果
   */
  search(query: string, options?: SearchOptions): SearchResult[] {
    if (this.totalDocs === 0) return []

    const opts: Required<SearchOptions> = {
      limit: options?.limit ?? 10,
      fields: (options?.fields?.length ? options.fields : []) as unknown as string[],
      fuzzy: options?.fuzzy ?? false,
      threshold: options?.threshold ?? 0.8,
      weights: options?.weights ?? {},
      mode: options?.mode ?? 'or',
      scoring: options?.scoring ?? 'bm25',
    }

    // 每段独立搜索，取 limit * 2 以保障合并后有足够候选
    const perSegmentLimit = opts.limit * 2 * this.segments.length

    const segOpts: any = { ...opts }
    if (!segOpts.fields || segOpts.fields.length === 0) {
      delete segOpts.fields
    }

    const allResults: Map<string, { docId: string; score: number; matches?: SearchResult['matches'] }> = new Map()

    for (const seg of this.segments) {
      const results = seg.index.search(query, { ...segOpts, limit: perSegmentLimit })
      for (const r of results) {
        const existing = allResults.get(r.docId)
        if (!existing || r.score > existing.score) {
          allResults.set(r.docId, r)
        }
      }
    }

    const sorted = Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)

    return sorted.slice(0, opts.limit).map(r => ({
      docId: r.docId,
      score: r.score,
      matches: r.matches,
    }))
  }

  /**
   * 使用 BM25 评分搜索所有段，合并排序结果
   * 保证对所有段都使用 BM25 scoring
   */
  searchWithBM25(query: string, options?: SearchOptions): SearchResult[] {
    return this.search(query, { ...options, scoring: 'bm25' })
  }

  /**
   * 获取索引状态
   */
  stats(): { documentCount: number; totalSegments: number; segmentSizes: number[] } {
    return {
      documentCount: this.totalDocs,
      totalSegments: this.segments.length,
      segmentSizes: this.segments.map(s => s.documentCount),
    }
  }

  /**
   * 清空所有段
   */
  clear(): void {
    for (const seg of this.segments) {
      seg.index.clear()
    }
    this.segments = []
    this.activeSegment = null
    this.totalDocs = 0
  }

  // ──────────────────────────────────────────
  // 内部方法
  // ──────────────────────────────────────────

  /** 收集所有段中的字段名 */
  private _collectActiveFields(): Set<string> {
    const fields = new Set<string>()
    for (const seg of this.segments) {
      const json = seg.index.serialize()
      const data = JSON.parse(json)
      if (data.invertedIndex) {
        for (const [, fieldIndex] of data.invertedIndex) {
          for (const field of Object.keys(fieldIndex ?? {})) {
            fields.add(field)
          }
        }
      }
    }
    return fields
  }

  /**
   * 轮转创建新段
   */
  private rotateSegment(): void {
    if (this.activeSegment) {
      this.activeSegment.isReadOnly = true
    }

    const id = Date.now() + Math.floor(Math.random() * 1000)
    this.activeSegment = {
      id,
      documentCount: 0,
      index: new FullTextIndex(),
      isReadOnly: false,
    }
    this.segments.push(this.activeSegment)
  }

  /**
   * 判断是否需要触发合并
   */
  private shouldMerge(): boolean {
    return this.segments.length > this.maxSegments
  }

  /**
   * 合并小段（减少段数）
   *
   * 策略：当段数 > maxSegments 时，选择最小的段合并成一个新段
   */
  private merge(): void {
    if (this.segments.length <= this.maxSegments) return

    const mergeable = this.segments.filter(s => s.isReadOnly)
    if (mergeable.length < 2) return

    const sorted = [...mergeable].sort((a, b) => {
      if (this.mergePolicy === 'oldest-first') {
        return a.id - b.id
      }
      return a.documentCount - b.documentCount
    })

    const mergeCount = Math.min(sorted.length, Math.max(2, this.maxSegments - 1))
    const toMerge = sorted.slice(0, mergeCount)

    const mergedIndex = new FullTextIndex()
    let mergedDocs = 0

    for (const seg of toMerge) {
      const docs = seg.index.getAllIndexedDocs()
      for (const { docId, fields } of docs) {
        mergedIndex.addDocument(docId, fields)
        mergedDocs++
      }
    }

    const newSegment: IndexSegment = {
      id: Date.now(),
      documentCount: mergedDocs,
      index: mergedIndex,
      isReadOnly: true,
    }

    const toMergeSet = new Set(toMerge)
    this.segments = [
      ...this.segments.filter(s => !toMergeSet.has(s)),
      newSegment,
    ]

    this.totalDocs = this.segments.reduce((sum, s) => sum + s.documentCount, 0)

    if (this.activeSegment && !this.segments.includes(this.activeSegment)) {
      this.activeSegment = this.segments.find(s => !s.isReadOnly) ?? null
    }
  }

  /**
   * 序列化所有段为 JSON（用于持久化）
   */
  serialize(): string {
    const data = {
      version: 1,
      maxSegmentSize: this.maxSegmentSize,
      totalDocs: this.totalDocs,
      segments: this.segments.map(seg => ({
        id: seg.id,
        documentCount: seg.documentCount,
        isReadOnly: seg.isReadOnly,
        index: JSON.parse(seg.index.serialize()),
      })),
      activeSegmentId: this.activeSegment?.id ?? null,
    }
    return JSON.stringify(data)
  }

  /**
   * 从序列化的 JSON 恢复
   */
  static deserialize(json: string): SegmentedFullTextIndex {
    const data = JSON.parse(json)
    const index = new SegmentedFullTextIndex({
      maxSegmentSize: data.maxSegmentSize ?? 100000,
    })

    if (data.segments) {
      for (const segData of data.segments) {
        const fi = FullTextIndex.deserialize(JSON.stringify(segData.index))
        const seg: IndexSegment = {
          id: segData.id,
          documentCount: segData.documentCount,
          index: fi,
          isReadOnly: segData.isReadOnly,
        }
        index.segments.push(seg)
        if (segData.id === data.activeSegmentId) {
          index.activeSegment = seg
        }
      }

      if (!index.activeSegment && index.segments.length > 0) {
        index.activeSegment = index.segments[index.segments.length - 1]
      }
    }

    index.totalDocs = data.totalDocs ?? 0

    if (index.segments.length === 0) {
      index.rotateSegment()
    }

    return index
  }

  /**
   * 持久化到文件
   */
  async saveToFile(filePath: string): Promise<void> {
    const fs = await import('fs/promises')
    await fs.writeFile(filePath, this.serialize(), 'utf-8')
  }

  /**
   * 从文件加载
   */
  static async loadFromFile(filePath: string): Promise<SegmentedFullTextIndex> {
    const fs = await import('fs/promises')
    const data = await fs.readFile(filePath, 'utf-8')
    return SegmentedFullTextIndex.deserialize(data)
  }
}
