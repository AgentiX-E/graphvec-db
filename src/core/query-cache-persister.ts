/**
 * query-cache-persister.ts — 查询结果缓存持久化
 *
 * 基于 WAL JSONL 模式将 QueryResultCache 的缓存条目异步落盘。
 * 启动时从文件恢复最近 N 条有效（未过期）缓存条目。
 *
 * 设计目标：
 * - 异步追加写入（非阻塞）
 * - 启动时有限预热（默认最近 1000 条）
 * - TTL 过滤（跳过已过期条目）
 * - 文件 I/O 失败时优雅降级
 *
 * 借鉴 QuerySlowLog._recoverFromFile() 的恢复模式。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { QueryResultCache, type QueryCacheEntry, type CacheTag } from './query-cache'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface CachePersisterConfig {
  persistPath?: string
  persistInterval?: number
  maxRecoverEntries?: number
}

interface PersistedCacheEntry {
  k: string
  v: {
    results: unknown
    query: string
    cachedAt: number
    tags: CacheTag[]
  }
}

const DEFAULT_CONFIG: Required<CachePersisterConfig> = {
  persistPath: './data/cache.wal',
  persistInterval: 5000,
  maxRecoverEntries: 1000,
}

export class QueryCachePersister {
  private cache: QueryResultCache
  private config: Required<CachePersisterConfig>
  private persistTimer: ReturnType<typeof setInterval> | null = null
  private pendingBuffer: PersistedCacheEntry[] = []
  private flushRunning = false
  private _started = false

  constructor(cache: QueryResultCache, config: CachePersisterConfig = {}) {
    this.cache = cache
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async start(): Promise<void> {
    if (this._started) return
    this._started = true
    try {
      const dir = path.dirname(this.config.persistPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      await this.recover()
    } catch (err) {
      console.warn(`[QueryCachePersister] ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.config.persistInterval > 0) {
      this.persistTimer = setInterval(() => { this.flushPending().catch(() => {}) }, this.config.persistInterval)
      if (typeof (this.persistTimer as any).unref === 'function') (this.persistTimer as any).unref()
    }
  }

  async stop(): Promise<void> {
    if (!this._started) return
    this._started = false
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null }
    await this.flushPending()
  }

  enqueue(key: string, entry: QueryCacheEntry): void {
    if (!this._started) return
    this.pendingBuffer.push({
      k: key,
      v: { results: entry.results, query: entry.query, cachedAt: entry.cachedAt, tags: entry.tags },
    })
  }

  async recover(maxEntries?: number): Promise<number> {
    const max = maxEntries ?? this.config.maxRecoverEntries
    const filePath = this.config.persistPath
    if (!fs.existsSync(filePath)) return 0
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      const startIdx = Math.max(0, lines.length - max)
      let recoveredCount = 0
      const now = Date.now()
      for (let i = startIdx; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]) as PersistedCacheEntry
          const entry = parsed.v
          if (entry.cachedAt > 0 && now > entry.cachedAt + 30000) continue
          this.cache.set(parsed.k, entry.results, { query: entry.query, tags: entry.tags })
          recoveredCount++
        } catch {}
      }
      return recoveredCount
    } catch { return 0 }
  }

  async flushPending(): Promise<void> {
    if (this.flushRunning || this.pendingBuffer.length === 0) return
    this.flushRunning = true
    try {
      const batch = this.pendingBuffer.splice(0, this.pendingBuffer.length)
      const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n'
      const dir = path.dirname(this.config.persistPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(this.config.persistPath, lines, 'utf-8')
    } catch {} finally { this.flushRunning = false }
  }

  get pendingCount(): number { return this.pendingBuffer.length }
  get started(): boolean { return this._started }
}
