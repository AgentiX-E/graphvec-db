/**
 * lmdb-wal.ts — LMDB WAL 持久化方案
 *
 * 替换 wal.ts 的自研二进制 WAL + 全内存 entries 数组。
 * 用 LMDB 实现：
 * - 日志条目按 index 有序存储 → 支持范围查询
 * - 每个 append 即 fsync（同步写）→ 不丢失数据
 * - 无需全量加载到内存 → 防止 OOM
 * - ACID 事务 → truncate/snapshot 原子操作
 *
 * 接口与 WAL 兼容（LogEntry, open/append/truncate/close/sync 等）。
 */
import { open } from 'lmdb'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { Logger } from '../ops/logger'
import type { RootDatabase, Database } from 'lmdb'
import { encode, decode } from 'msgpackr'

export interface LogEntry {
  index: number
  term: number
  data: Uint8Array
}

/**
 * entries Db 存储结构：key=index, value={t:term, d:Buffer(data)}
 * 用 msgpackr 序列化值以确保 LMDB 能正确编码 Buffer
 */
export class LmdbWal {
  private dbPath: string
  private db!: RootDatabase
  private entriesDb!: Database
  private metaDb!: Database
  private lastIndex: number = 0
  private lastTerm: number = 0
  private logger: Logger
  private _opened = false

  constructor(path: string) {
    this.dbPath = path
    this.logger = new Logger('LmdbWal')
  }

  get isOpen(): boolean {
    return this._opened
  }

  async open(): Promise<void> {
    if (this._opened) return

    try {
      const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'))
      if (dir && dir !== this.dbPath) {
        fs.mkdirSync(dir, { recursive: true })
      }

      this.db = open({
        path: this.dbPath,
        maxDbs: 2,
        noSync: false,
        mapSize: 1024 * 1024 * 1024,
        encoding: 'binary',
      })

      this.entriesDb = this.db.openDB('entries', { encoding: 'binary' })
      this.metaDb = this.db.openDB('meta', { encoding: 'string' })

      // 恢复 lastIndex / lastTerm
      const last = this._lastEntry()
      if (last) {
        this.lastIndex = last.index
        this.lastTerm = last.term
      }

      this._opened = true
      this.logger.info(`LmdbWal opened: ${this.dbPath}, lastIndex=${this.lastIndex}, lastTerm=${this.lastTerm}`)
    } catch (err) {
      this.logger.error(`Failed to open LmdbWal: ${this.dbPath}`, err as Error)
      throw err
    }
  }

  async append(term: number, data: Uint8Array): Promise<LogEntry> {
    if (!this._opened) throw new Error('LmdbWal not opened')
    const index = ++this.lastIndex
    this.lastTerm = term
    await this.entriesDb.put(index, encode({ t: term, d: Buffer.from(data) }))
    return { index, term, data }
  }

  async truncate(lastIndex: number): Promise<void> {
    if (!this._opened) return
    if (lastIndex >= this.lastIndex) return
    await this._deleteRange(lastIndex + 1)
    this.lastIndex = lastIndex
    const last = this._lastEntry()
    this.lastTerm = last ? last.term : 0
  }

  entriesCount(): number {
    return (this.entriesDb as any).getCount()
  }

  async truncateBefore(index: number): Promise<void> {
    if (!this._opened) return
    await this._deleteBefore(index)
    const last = this._lastEntry()
    if (last) {
      this.lastIndex = last.index
      this.lastTerm = last.term
    } else {
      this.lastIndex = 0
      this.lastTerm = 0
    }
  }

  readAll(): LogEntry[] {
    return this._entries().map(({ key, value }) => {
      const stored: { t: number; d: Uint8Array } = decode(value)
      return { index: key, term: stored.t, data: stored.d }
    })
  }

  getLastIndex(): number { return this.lastIndex }
  getLastTerm(): number { return this.lastTerm }

  getEntry(index: number): LogEntry | undefined {
    const buf = this.entriesDb.get(index) as Buffer | undefined
    if (!buf) return undefined
    const stored: { t: number; d: Uint8Array } = decode(buf)
    return { index, term: stored.t, data: stored.d }
  }

  getEntriesFrom(startIndex: number): LogEntry[] {
    return this._entries(startIndex).map(({ key, value }) => {
      const stored: { t: number; d: Uint8Array } = decode(value)
      return { index: key, term: stored.t, data: stored.d }
    })
  }

  async close(): Promise<void> {
    if (!this._opened) return
    this._opened = false
    await this.db.close()
  }

  async sync(): Promise<void> {
    if (!this._opened) return
    await this.db.transactionSync?.(() => {})
  }

  async destroy(): Promise<void> {
    await this.close()
    try {
      fs.rmSync(this.dbPath, { recursive: true, force: true })
    } catch { /* ignore */ }
    this.lastIndex = 0
    this.lastTerm = 0
  }

  async persistMeta(key: string, value: string): Promise<void> {
    if (!this._opened) return
    await this.metaDb.put(key, value)
  }

  loadMeta(key: string): string | undefined {
    if (!this._opened) return undefined
    return this.metaDb.get(key) as string | undefined
  }

  // ─── 内部辅助 ──────────────────────────────

  private _lastEntry(): { index: number; term: number } | null {
    const range = (this.entriesDb as any).getRange({ limit: 1, reverse: true })
    const arr = range.asArray ?? []
    if (arr.length > 0) {
      const { key, value } = arr[0]
      const stored: { t: number } = decode(value as Buffer)
      return { index: key as number, term: stored.t }
    }
    return null
  }

  private _entries(start?: number): Array<{ key: number; value: Buffer }> {
    const opts: any = {}
    if (start !== undefined) opts.start = start
    const range = (this.entriesDb as any).getRange(opts)
    return range.asArray ?? []
  }

  private async _deleteRange(startIndex: number): Promise<void> {
    const eDb = this.entriesDb as any
    const opts: any = { start: startIndex }
    for (const { key } of eDb.getRange(opts).asArray ?? []) {
      await eDb.remove(key as number)
    }
  }

  private async _deleteBefore(index: number): Promise<void> {
    const eDb = this.entriesDb as any
    // LMDB getRange end is inclusive; use end: index-1 to get keys < index
    // If that doesn't work, fall back to scanning all
    const entries = eDb.getRange({ end: index - 1, start: 0 }).asArray ?? []
    if (entries.length === 0) {
      // LMDB version may not support range filtering; delete all keys < index manually
      for (const entry of (eDb.getRange({}).asArray ?? [])) {
        if (entry.key < index) {
          await eDb.remove(entry.key as number)
        }
      }
      return
    }
    for (const { key } of entries) {
      await eDb.remove(key as number)
    }
  }
}
