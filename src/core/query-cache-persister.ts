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
import { createHash } from 'node:crypto'
import { QueryResultCache, type QueryCacheEntry, type CacheTag } from './query-cache'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface CachePersisterConfig {
  /** WAL 文件路径（默认 ./data/cache.wal） */
  persistPath?: string
  /** 自动持久化间隔（毫秒，默认 5000）。0 表示禁用自动持久化。 */
  persistInterval?: number
  /** 最大恢复条目数（默认 1000） */
  maxRecoverEntries?: number
}

/** 持久化文件中的一行缓存条目 */
interface PersistedCacheEntry {
  /** 缓存键（SHA-256 hex） */
  k: string
  /** 缓存值 */
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

/**
 * QueryCachePersister — 查询缓存持久化器
 *
 * 将 QueryResultCache 的 set/put 操作异步写入 WAL JSONL 文件，
 * 并在启动时从文件恢复预热缓存。
 *
 * 用法：
 * ```ts
 * const cache = new QueryResultCache({ maxSize: 500 })
 * const persister = new QueryCachePersister(cache, {
 *   persistPath: './data/cache.wal',
 *   persistInterval: 5000,
 * })
 * await persister.start()  // 启动时恢复 + 启动自动持久化
 * // ...使用 cache 正常操作...
 * await persister.stop()   // 优雅关闭，强制落盘
 * ```
 */
export class QueryCachePersister {
  private cache: QueryResultCache
  private config: Required<CachePersisterConfig>
  private writeStream: fs.WriteStream | null = null
  private persistTimer: ReturnType<typeof setInterval> | null = null
  private pendingBuffer: PersistedCacheEntry[] = []
  private flushRunning = false
  private _started = false

  constructor(cache: QueryResultCache, config: CachePersisterConfig = {}) {
    this.cache = cache
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 启动持久化器：
   * 1. 确保持久化目录存在
   * 2. 打开 WAL 写入流
   * 3. 从文件恢复缓存（预热）
   * 4. 启动定时持久化（如果 persistInterval > 0）
   */
  async start(): Promise<void> {
    if (this._started) return
    this._started = true

    try {
      // 确保目录存在
      const dir = path.dirname(this.config.persistPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 打开追加写入流
      this.writeStream = fs.createWriteStream(this.config.persistPath, {
        flags: 'a',
        encoding: 'utf-8',
      })

      // 从文件恢复缓存（预热）
      await this.recover()
    } catch (err) {
      // 文件 I/O 失败时优雅降级，内存模式继续工作
      console.warn(
        `[QueryCachePersister] Failed to initialize persister: ${err instanceof Error ? err.message : String(err)}`,
      )
      this.writeStream = null
    }

    // 启动定时持久化
    if (this.config.persistInterval > 0) {
      this.persistTimer = setInterval(() => {
        this.flushPending().catch(() => { /* 非关键，静默失败 */ })
      }, this.config.persistInterval)
      if (typeof (this.persistTimer as any).unref === 'function') {
        ;(this.persistTimer as any).unref()
      }
    }
  }

  /**
   * 停止持久化器：
   * 1. 清空待写缓冲区
   * 2. 关闭写入流
   * 3. 停止定时器
   */
  async stop(): Promise<void> {
    if (!this._started) return
    this._started = false

    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = null
    }

    // 最后一次 flush
    await this.flushPending()

    if (this.writeStream) {
      await new Promise<void>((resolve) => {
        this.writeStream!.end(resolve)
      })
      this.writeStream = null
    }
  }

  /**
   * 将缓存条目加入待写缓冲区（异步非阻塞）
   *
   * 由 QueryResultCache 在写入缓存时调用。
   */
  enqueue(key: string, entry: QueryCacheEntry): void {
    if (!this._started) return

    this.pendingBuffer.push({
      k: key,
      v: {
        results: entry.results,
        query: entry.query,
        cachedAt: entry.cachedAt,
        tags: entry.tags,
      },
    })
  }

  /**
   * 从 WAL 文件恢复缓存条目
   *
   * @param maxEntries 最大恢复条目数（默认使用配置值）
   * @returns 实际恢复的条目数
   */
  async recover(maxEntries?: number): Promise<number> {
    const max = maxEntries ?? this.config.maxRecoverEntries
    const filePath = this.config.persistPath

    if (!fs.existsSync(filePath)) {
      return 0
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)

      // 只取最近 N 条（末尾）
      const startIdx = Math.max(0, lines.length - max)
      let recoveredCount = 0
      const now = Date.now()

      for (let i = startIdx; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]) as PersistedCacheEntry
          // 检查 TTL：如果已过期则跳过
          const entry = parsed.v
          if (entry.cachedAt > 0 && now > entry.cachedAt + 30000) {
            // 默认 TTL 30s，跳过过期条目
            continue
          }
          // 以 QueryCacheEntry 格式写回缓存
          const cacheEntry: QueryCacheEntry = {
            results: entry.results,
            query: entry.query,
            cachedAt: entry.cachedAt,
            tags: entry.tags,
          }
          // 直接用内部缓存 set 方法（需绕过 cache.set 的外部 TAG 索引，因为恢复时不更新 tagIndex）
          this.cache.set(parsed.k, cacheEntry.results, {
            query: cacheEntry.query,
            tags: cacheEntry.tags,
          })
          recoveredCount++
        } catch {
          // 跳过无法解析的行
        }
      }

      return recoveredCount
    } catch {
      // 文件读取失败，优雅降级
      return 0
    }
  }

  /**
   * 强制清空待写缓冲区到文件
   */
  async flushPending(): Promise<void> {
    if (this.flushRunning) return
    if (this.pendingBuffer.length === 0) return
    if (!this.writeStream) return

    this.flushRunning = true

    try {
      const batch = this.pendingBuffer.splice(0, this.pendingBuffer.length)
      for (const entry of batch) {
        const line = JSON.stringify(entry) + '\n'
        this.writeStream.write(line)
      }
    } catch {
      // 写入失败不阻塞
    } finally {
      this.flushRunning = false
    }
  }

  /**
   * 获取待写缓冲区大小（调试用）
   */
  get pendingCount(): number {
    return this.pendingBuffer.length
  }

  /**
   * 持久化器是否已启动
   */
  get started(): boolean {
    return this._started
  }
}
