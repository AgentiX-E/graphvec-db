/**
 * backup-wal.spec.ts — WalArchiver + WAL 读取工具单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { readWalLastIndex, readWalLsnSnapshots, getTotalLsn, WalArchiver } from './backup-wal'

const TMPDIR = path.join(__dirname, '__test_wal__')

/** 写入一个最小的 WAL 文件：header(12B) + data(N bytes) */
function writeMinimalWal(walPath: string, entryIndex: number, dataLen: number = 8): string {
  fs.mkdirSync(path.dirname(walPath), { recursive: true })
  const buf = Buffer.alloc(12 + dataLen)
  buf.writeUInt32BE(entryIndex, 0)   // index
  buf.writeUInt32BE(1, 4)             // term
  buf.writeUInt32BE(dataLen, 8)       // data length
  buf.fill(0xAB, 12)                  // dummy data
  fs.writeFileSync(walPath, buf)
  return walPath
}

/** 写入多条记录的 WAL 文件 */
function writeMultiEntryWal(walPath: string, entries: number[]): string {
  fs.mkdirSync(path.dirname(walPath), { recursive: true })
  const chunks: Buffer[] = []
  for (const idx of entries) {
    const buf = Buffer.alloc(12 + 8)
    buf.writeUInt32BE(idx, 0)  // index
    buf.writeUInt32BE(1, 4)    // term
    buf.writeUInt32BE(8, 8)    // data length
    buf.writeBigUInt64BE(BigInt(idx), 12)
    chunks.push(buf)
  }
  fs.writeFileSync(walPath, Buffer.concat(chunks))
  return walPath
}

describe('readWalLastIndex', () => {
  beforeEach(() => {
    fs.mkdirSync(TMPDIR, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(TMPDIR, { recursive: true, force: true })
  })

  it('returns 0 for non-existent file', () => {
    expect(readWalLastIndex('/nonexistent/wal.bin')).toBe(0)
  })

  it('returns 0 for empty file', () => {
    const p = path.join(TMPDIR, 'empty.bin')
    fs.mkdirSync(TMPDIR, { recursive: true })
    fs.writeFileSync(p, '')
    expect(readWalLastIndex(p)).toBe(0)
  })

  it('returns 0 for file smaller than header (12B)', () => {
    const p = path.join(TMPDIR, 'short.bin')
    fs.writeFileSync(p, Buffer.alloc(4))
    expect(readWalLastIndex(p)).toBe(0)
  })

  it('reads single entry WAL index', () => {
    const p = writeMinimalWal(path.join(TMPDIR, 'wal-single.bin'), 42, 16)
    expect(readWalLastIndex(p)).toBe(42)
  })

  it('reads last index from multi-entry WAL', () => {
    const p = writeMultiEntryWal(path.join(TMPDIR, 'wal-multi.bin'), [1, 5, 10, 99])
    expect(readWalLastIndex(p)).toBe(99)
  })

  it('handles truncated last entry gracefully', () => {
    const p = writeMinimalWal(path.join(TMPDIR, 'wal-truncated.bin'), 7, 100)
    // 截断文件：保留 20 字节（不够一个完整 entry）
    const fd = fs.openSync(p, 'r+')
    fs.ftruncateSync(fd, 20)
    fs.closeSync(fd)
    // 应该有 0 条完整记录
    expect(readWalLastIndex(p)).toBe(0)
  })
})

describe('readWalLsnSnapshots', () => {
  beforeEach(() => {
    fs.mkdirSync(TMPDIR, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(TMPDIR, { recursive: true, force: true })
  })

  it('returns empty snapshot for empty directory', () => {
    const snap = readWalLsnSnapshots(TMPDIR)
    expect(Object.keys(snap.files)).toHaveLength(0)
  })

  it('finds WAL files in subdirectories', () => {
    const subdir = path.join(TMPDIR, 'sub', 'dir')
    writeMultiEntryWal(path.join(subdir, 'wal-1.bin'), [3, 7])
    const snap = readWalLsnSnapshots(TMPDIR)
    expect(Object.keys(snap.files).length).toBeGreaterThanOrEqual(1)
    const relKey = Object.keys(snap.files).find(k => k.endsWith('wal-1.bin'))
    expect(relKey).toBeDefined()
    expect(snap.files[relKey!]).toBe(7)
  })

  it('only matches wal-*.bin pattern', () => {
    fs.writeFileSync(path.join(TMPDIR, 'random.txt'), 'hello')
    writeMinimalWal(path.join(TMPDIR, 'wal-test.bin'), 1)
    const snap = readWalLsnSnapshots(TMPDIR)
    for (const key of Object.keys(snap.files)) {
      expect(key).toMatch(/wal-.+\.bin$/)
    }
  })
})

describe('getTotalLsn', () => {
  it('returns 0 for empty snapshot', () => {
    expect(getTotalLsn({ files: {} })).toBe(0)
  })

  it('sums all file LSNs', () => {
    const snap = { files: { 'wal-a.bin': 10, 'wal-b.bin': 20, 'wal-c.bin': 30 } }
    expect(getTotalLsn(snap)).toBe(60)
  })
})

describe('WalArchiver', () => {
  let archiver: WalArchiver
  let walFile: string

  beforeEach(() => {
    fs.mkdirSync(TMPDIR, { recursive: true })
    archiver = new WalArchiver()
    walFile = writeMinimalWal(path.join(TMPDIR, 'source-wal.bin'), 1)
  })

  afterEach(() => {
    fs.rmSync(TMPDIR, { recursive: true, force: true })
  })

  it('archiveWal copies WAL to archive dir', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    const result = await archiver.archiveWal(walFile, archiveDir)
    expect(result.walPath).toMatch(archiveDir)
    expect(fs.existsSync(result.walPath)).toBe(true)
    // 内容一致
    const orig = fs.readFileSync(walFile)
    const copy = fs.readFileSync(result.walPath)
    expect(copy).toEqual(orig)
  })

  it('archiveWal assigns timestamp-based name', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    const result = await archiver.archiveWal(walFile, archiveDir)
    expect(result.backupId).toMatch(/^wal-archive-\d+-source-wal\.bin$/)
    expect(result.timestamp).toBeGreaterThan(0)
  })

  it('archiveWalSync works synchronously', () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    const result = archiver.archiveWalSync(walFile, archiveDir)
    expect(fs.existsSync(result.walPath)).toBe(true)
  })

  it('listArchives returns empty when archive dir missing', async () => {
    const archives = await archiver.listArchives('/nonexistent-dir')
    expect(archives).toEqual([])
  })

  it('listArchives returns archives sorted by timestamp', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    // 手动创建两个归档（用不同的时间戳）
    const f1 = path.join(archiveDir, 'wal-archive-1000-test1.bin')
    const f2 = path.join(archiveDir, 'wal-archive-2000-test2.bin')
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(f1, 'data1')
    fs.writeFileSync(f2, 'data2')
    const archives = await archiver.listArchives(archiveDir)
    expect(archives).toHaveLength(2)
    expect(archives[0].timestamp).toBe(1000)
    expect(archives[1].timestamp).toBe(2000)
  })

  it('listArchives ignores non-archive files', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, 'random.txt'), 'ignored')
    fs.writeFileSync(path.join(archiveDir, 'wal-archive-3000-test.bin'), 'real')
    const archives = await archiver.listArchives(archiveDir)
    expect(archives).toHaveLength(1)
  })

  it('cleanupArchives keeps only recent archives', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    // 创建 5 个归档，时间戳递增
    for (let i = 1; i <= 5; i++) {
      const ts = i * 1000
      fs.writeFileSync(path.join(archiveDir, `wal-archive-${ts}-wal-${i}.bin`), `data${i}`)
    }
    await archiver.cleanupArchives(archiveDir, 2)
    const remaining = await archiver.listArchives(archiveDir)
    expect(remaining).toHaveLength(2)
    // 保留的是最后 2 个（时间戳最大）
    expect(remaining[0].timestamp).toBe(4000)
    expect(remaining[1].timestamp).toBe(5000)
  })

  it('cleanupArchives does nothing when under retention count', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(archiveDir, `wal-archive-${i * 1000}-w.bin`), `data${i}`)
    }
    await archiver.cleanupArchives(archiveDir, 5)
    const remaining = await archiver.listArchives(archiveDir)
    expect(remaining).toHaveLength(3)
  })

  it('listRecoveryPoints returns RecoveryPoint entries', async () => {
    const archiveDir = path.join(TMPDIR, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, 'wal-archive-1000-a.bin'), 'data')
    const points = await archiver.listRecoveryPoints(archiveDir)
    expect(points).toHaveLength(1)
    expect(points[0].timestamp).toBe(1000)
    expect(points[0].backupId).toMatch(/wal-archive-1000-a\.bin/)
    expect(points[0].type).toBe('incremental')
  })
})
