/**
 * lmdb-wal.spec.ts — LMDB WAL 单元测试
 *
 * 测试 LmdbWal 的 append/truncate/readAll/destroy 等操作。
 * 使用临时目录存储 LMDB 数据库。
 *
 * 注意：LMDB 依赖本机 C 扩展；如果环境中没有 lmdb 原生库，
 * 通过 try/catch 捕获并跳过测试。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { LmdbWal } from './lmdb-wal'

function randomDir(): string {
  return path.join(tmpdir(), `lmdb-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
}

describe('LmdbWal', () => {
  let wal: LmdbWal
  let dbPath: string

  beforeEach(() => {
    dbPath = randomDir()
    wal = new LmdbWal(dbPath)
  })

  afterEach(async () => {
    try { await wal.destroy() } catch { /* ignore */ }
  })

  it('opens and reports isOpen', async () => {
    expect(wal.isOpen).toBe(false)
    await wal.open()
    expect(wal.isOpen).toBe(true)
  })

  it('appends entries and increments index', async () => {
    await wal.open()
    const e1 = await wal.append(1, Buffer.from([0x01]))
    expect(e1.index).toBe(1)
    expect(e1.term).toBe(1)
    expect(e1.data).toEqual(Buffer.from([0x01]))

    const e2 = await wal.append(1, Buffer.from([0x02]))
    expect(e2.index).toBe(2)
    expect(e2.term).toBe(1)
  })

  it('readAll returns all entries', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('hello'))
    await wal.append(2, Buffer.from('world'))
    const entries = wal.readAll()
    expect(entries).toHaveLength(2)
    expect(entries[0].index).toBe(1)
    expect(entries[1].index).toBe(2)
    expect(Buffer.from(entries[0].data).toString()).toBe('hello')
    expect(Buffer.from(entries[1].data).toString()).toBe('world')
  })

  it('getLastIndex and getLastTerm', async () => {
    await wal.open()
    expect(wal.getLastIndex()).toBe(0)
    expect(wal.getLastTerm()).toBe(0)
    await wal.append(5, Buffer.from('x'))
    expect(wal.getLastIndex()).toBe(1)
    expect(wal.getLastTerm()).toBe(5)
  })

  it('getEntry returns specific entry', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('a'))
    const e = wal.getEntry(1)
    expect(e).toBeDefined()
    expect(e!.index).toBe(1)
    expect(Buffer.from(e!.data).toString()).toBe('a')
  })

  it('getEntry returns undefined for missing', async () => {
    await wal.open()
    expect(wal.getEntry(99)).toBeUndefined()
  })

  it('getEntriesFrom returns entries from a given start index', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('a'))
    await wal.append(1, Buffer.from('b'))
    await wal.append(1, Buffer.from('c'))
    const from = wal.getEntriesFrom(2)
    expect(from).toHaveLength(2)
    expect(from[0].index).toBe(2)
    expect(from[1].index).toBe(3)
  })

  it('truncate removes entries after lastIndex', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('a'))
    await wal.append(1, Buffer.from('b'))
    await wal.append(1, Buffer.from('c'))
    await wal.truncate(1)
    expect(wal.getLastIndex()).toBe(1)
    const entries = wal.readAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].index).toBe(1)
  })

  it('truncateBefore removes entries before index', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('a'))
    await wal.append(1, Buffer.from('b'))
    await wal.append(1, Buffer.from('c'))
    await wal.truncateBefore(2)
    expect(wal.getLastIndex()).toBe(3)
    const entries = wal.readAll()
    expect(entries).toHaveLength(2)
    expect(entries[0].index).toBe(2)
  })

  it('entriesCount returns number of entries', async () => {
    await wal.open()
    expect(wal.entriesCount()).toBe(0)
    await wal.append(1, Buffer.from('x'))
    expect(wal.entriesCount()).toBe(1)
    await wal.append(1, Buffer.from('y'))
    expect(wal.entriesCount()).toBe(2)
  })

  it('persistMeta and loadMeta', async () => {
    await wal.open()
    await wal.persistMeta('snapshot', '3')
    expect(wal.loadMeta('snapshot')).toBe('3')
    await wal.persistMeta('snapshot', '5')
    expect(wal.loadMeta('snapshot')).toBe('5')
  })

  it('reopens and recovers lastIndex', async () => {
    await wal.open()
    await wal.append(3, Buffer.from('data'))
    await wal.close()
    // 重新打开
    const wal2 = new LmdbWal(dbPath)
    await wal2.open()
    expect(wal2.getLastIndex()).toBe(1)
    expect(wal2.getLastTerm()).toBe(3)
    const entries = wal2.readAll()
    expect(entries).toHaveLength(1)
    await wal2.destroy()
  })

  it('destroy removes database file', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('x'))
    await wal.destroy()
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(wal.isOpen).toBe(false)
  })

  it('append throws when not opened', async () => {
    await expect(wal.append(1, Buffer.from('x'))).rejects.toThrow('not opened')
  })

  it('truncate beyond current index is no-op', async () => {
    await wal.open()
    await wal.append(1, Buffer.from('a'))
    await wal.truncate(10)
    expect(wal.getLastIndex()).toBe(1)
  })
})
