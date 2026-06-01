import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { GraphEngine } from '../core/graph-engine'
import { Backup, parseBackupTimestamp } from './backup'
import { testEngineConfig } from '../../test/fixtures/test-graph'
import { createRequire } from 'module'

// Load real tar module (same way backup.ts does)
const _require = createRequire(__filename)
const _tar = _require('tar')

// Mock ESM-only modules for CJS compatibility
vi.mock('archiver', () => {
  function createArchiver() {
    const { PassThrough } = require('stream')
    const s = new PassThrough()
    s.directory = () => s
    s.finalize = () => { setImmediate(() => s.emit('close')) }
    return s
  }
  return createArchiver
})

describe('Backup - Consistency', () => {
  const BACKUP_DIR = './test-data/backup-test'
  const DATA_DIR = './test-data/backup-data'

  let engine: GraphEngine
  let backupInst: Backup

  beforeAll(() => {
    cleanDir(BACKUP_DIR)
    cleanDir(DATA_DIR)
    process.env.DATA_DIR = DATA_DIR
    const config = { ...testEngineConfig, path: DATA_DIR }
    engine = new GraphEngine(config)
    engine.open()
    backupInst = new Backup(engine)
  })

  afterAll(() => {
    engine.close()
    cleanDir(BACKUP_DIR)
    cleanDir(DATA_DIR)
    delete process.env.DATA_DIR
  })

  it('should close/reopen engine and preserve data', async () => {
    const n1 = await engine.upsertNode(1, 'persist-a')
    const n2 = await engine.upsertNode(1, 'persist-b')
    await engine.upsertEdge(n1, n2, 10)

    expect(engine.stats().nodeCount).toBe(2)
    expect(engine.stats().edgeCount).toBe(1)

    engine.close()
    engine.open()

    const stats = engine.stats()
    expect(stats.nodeCount).toBe(2)
    expect(stats.edgeCount).toBe(1)

    engine.close()
    cleanDir(DATA_DIR)
    engine.open()
  }, 15000)

  it('should restore from a raw directory backup with consistency marker', async () => {
    // Fresh engine state
    engine.close()
    cleanDir(DATA_DIR)
    cleanDir(BACKUP_DIR)
    fs.mkdirSync(DATA_DIR, { recursive: true })

    const config = { ...testEngineConfig, path: DATA_DIR }
    engine = new GraphEngine(config)
    engine.open()
    backupInst = new Backup(engine)

    // Write 5 nodes, 4 edges
    const r1 = await engine.upsertNode(1, 'restore-x')
    const r2 = await engine.upsertNode(1, 'restore-y')
    const r3 = await engine.upsertNode(1, 'restore-z')
    const r4 = await engine.upsertNode(1, 'restore-w')
    const r5 = await engine.upsertNode(1, 'restore-v')
    await engine.upsertEdge(r1, r2, 5)
    await engine.upsertEdge(r2, r3, 5)
    await engine.upsertEdge(r3, r4, 5)
    await engine.upsertEdge(r4, r5, 5)

    expect(engine.stats().nodeCount).toBe(5)
    expect(engine.stats().edgeCount).toBe(4)

    // Flush engine to disk so backup is consistent
    if (typeof (engine as any).storage?._db?.flush === 'function') {
      (engine as any).storage._db.flush()
    }

    // Create raw backup directory (simulates backup()'s _copyDirSync + fsync)
    const manualBackupDir = path.join(BACKUP_DIR, `backup-${Date.now()}`)
    fs.mkdirSync(manualBackupDir, { recursive: true })
    fs.cpSync(DATA_DIR, manualBackupDir, { recursive: true })

    // Write consistency marker
    const marker = {
      snapshotId: 42,
      hlcWallTime: 1700000000000,
      hlcLogical: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
    }
    fs.writeFileSync(path.join(manualBackupDir, '.consistency-marker'), JSON.stringify(marker, null, 2))
    // fsync the marker file
    const markerFd = fs.openSync(path.join(manualBackupDir, '.consistency-marker'), 'r')
    fs.fsyncSync(markerFd)
    fs.closeSync(markerFd)

    // Verify backup files
    expect(fs.existsSync(path.join(manualBackupDir, 'manifest.current'))).toBe(true)
    expect(fs.existsSync(path.join(manualBackupDir, '.consistency-marker'))).toBe(true)

    // Close engine and wipe data
    engine.close()
    cleanDir(DATA_DIR)
    expect(fs.existsSync(DATA_DIR)).toBe(false)

    // Create new engine and restore
    const config2 = { ...testEngineConfig, path: DATA_DIR }
    const engine2 = new GraphEngine(config2)
    const backup2 = new Backup(engine2)
    await backup2.restore(manualBackupDir, DATA_DIR)

    // Verify restored data
    expect(fs.existsSync(path.join(DATA_DIR, 'manifest.current'))).toBe(true)
    expect(fs.existsSync(path.join(DATA_DIR, '.consistency-marker'))).toBe(true)
    expect(fs.existsSync(path.join(DATA_DIR, 'segments'))).toBe(true)

    // Verify consistency marker content
    const restoredMarker = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.consistency-marker'), 'utf-8'))
    expect(restoredMarker.snapshotId).toBe(42)
    expect(restoredMarker.hlcWallTime).toBe(1700000000000)
    expect(restoredMarker.hlcLogical).toBe(1)
    expect(restoredMarker.createdAt).toBe('2025-01-01T00:00:00.000Z')

    // Verify nodes (getNode doesn't rely on cached stats)
    const nodeX = engine2.getNode(r1)
    expect(nodeX).not.toBeNull()
    expect(nodeX!.name).toBe('restore-x')

    const nodeZ = engine2.getNode(r3)
    expect(nodeZ).not.toBeNull()
    expect(nodeZ!.name).toBe('restore-z')

    const nodeW = engine2.getNode(r4)
    expect(nodeW).not.toBeNull()
    expect(nodeW!.name).toBe('restore-w')

    const nodeV = engine2.getNode(r5)
    expect(nodeV).not.toBeNull()
    expect(nodeV!.name).toBe('restore-v')

    // Verify edges
    expect(engine2.getEdge(r1, r2, 5)).not.toBeNull()
    expect(engine2.getEdge(r2, r3, 5)).not.toBeNull()
    expect(engine2.getEdge(r3, r4, 5)).not.toBeNull()
    expect(engine2.getEdge(r4, r5, 5)).not.toBeNull()

    // Verify edge properties are correct
    const e23 = engine2.getEdge(r2, r3, 5)!
    expect(e23.src).toBe(r2)
    expect(e23.dst).toBe(r3)
    expect(e23.type).toBe(5)

    // Cleanup
    engine2.close()
    cleanDir(manualBackupDir)
    cleanDir(DATA_DIR)
  }, 15000)

  it('should auto-detect gzip magic bytes on compressed restore', async () => {
    // Fresh engine state
    engine.close()
    cleanDir(DATA_DIR)
    cleanDir(BACKUP_DIR)
    fs.mkdirSync(DATA_DIR, { recursive: true })

    const config = { ...testEngineConfig, path: DATA_DIR }
    engine = new GraphEngine(config)
    engine.open()
    backupInst = new Backup(engine)

    // Write some test data
    const n1 = await engine.upsertNode(1, 'magic-a')
    const n2 = await engine.upsertNode(1, 'magic-b')
    await engine.upsertEdge(n1, n2, 20)

    // Flush engine to disk so data is persisted (keep engine open)
    // as done in the raw backup test
    if (typeof (engine as any).storage?._db?.flush === 'function') {
      (engine as any).storage._db.flush()
    }

    // Create a real tar.gz using the actual tar module.
    // Copy data while engine is still open (same pattern as raw backup test).
    const timestamp = Date.now()
    const backupName = `graphvec-backup-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}`
    const rawDir = path.join(BACKUP_DIR, backupName)

    fs.mkdirSync(rawDir, { recursive: true })
    fs.cpSync(DATA_DIR, rawDir, { recursive: true })

    // Write consistency marker
    fs.writeFileSync(path.join(rawDir, '.consistency-marker'), JSON.stringify({
      snapshotId: 99, hlcWallTime: timestamp, hlcLogical: 0, createdAt: new Date().toISOString(),
    }, null, 2))

    // Create valid tar.gz using the real tar module
    const tarGzPath = `${rawDir}.tar.gz`
    await _tar.create(
      { gzip: true, cwd: path.dirname(rawDir), file: tarGzPath },
      [path.basename(rawDir)]
    )

    // Verify it has gzip magic bytes
    const fd = fs.openSync(tarGzPath, 'r')
    const magicBuf = Buffer.alloc(2)
    fs.readSync(fd, magicBuf, 0, 2, 0)
    fs.closeSync(fd)
    expect(magicBuf[0]).toBe(0x1f)
    expect(magicBuf[1]).toBe(0x8b)

    // Now test that restore can auto-detect this compressed file
    engine.close()
    cleanDir(DATA_DIR)

    const config2 = { ...testEngineConfig, path: DATA_DIR }
    const engine2 = new GraphEngine(config2)
    const backup2 = new Backup(engine2)

    // Restore should work because _isGzipped detects magic bytes
    await backup2.restore(tarGzPath, DATA_DIR)

    // Verify data was restored
    expect(fs.existsSync(path.join(DATA_DIR, 'manifest.current'))).toBe(true)
    expect(fs.existsSync(path.join(DATA_DIR, '.consistency-marker'))).toBe(true)
    expect(fs.existsSync(path.join(DATA_DIR, 'segments'))).toBe(true)

    // Verify the restored node
    const nodeA = engine2.getNode(n1)
    expect(nodeA).not.toBeNull()
    expect(nodeA!.name).toBe('magic-a')

    const nodeB = engine2.getNode(n2)
    expect(nodeB).not.toBeNull()
    expect(nodeB!.name).toBe('magic-b')

    engine2.close()
    cleanDir(DATA_DIR)
    cleanDir(rawDir)
    if (fs.existsSync(tarGzPath)) fs.unlinkSync(tarGzPath)
  }, 30000)

  it('should detect gzip magic bytes correctly', () => {
    const backup = new Backup(engine)

    // Create a gzip file
    const gzPath = path.join(BACKUP_DIR, 'test.gz')
    const gzipped = zlib.gzipSync(Buffer.from('hello'))
    fs.mkdirSync(path.dirname(gzPath), { recursive: true })
    fs.writeFileSync(gzPath, gzipped)
    expect((backup as any)._isGzipped(gzPath)).toBe(true)

    // Create a non-gzip file
    const txtPath = path.join(BACKUP_DIR, 'test.txt')
    fs.writeFileSync(txtPath, 'hello')
    expect((backup as any)._isGzipped(txtPath)).toBe(false)

    // Create a file with gzip magic in middle (should not detect)
    const fakeGzPath = path.join(BACKUP_DIR, 'fake.gz')
    fs.writeFileSync(fakeGzPath, Buffer.from([0x00, 0x00, 0x1f, 0x8b]))
    expect((backup as any)._isGzipped(fakeGzPath)).toBe(false)

    // Non-existent file
    expect((backup as any)._isGzipped('/nonexistent')).toBe(false)

    fs.unlinkSync(gzPath)
    fs.unlinkSync(txtPath)
    fs.unlinkSync(fakeGzPath)
  })

  it('should list backups and filter correctly — only .tar.gz files', () => {
    cleanDir(BACKUP_DIR)
    fs.mkdirSync(BACKUP_DIR, { recursive: true })

    // Create raw directory backup (should be excluded now)
    const dirBackup = path.join(BACKUP_DIR, 'graphvec-backup-2026-05-31T10-00-00-000Z')
    fs.mkdirSync(dirBackup, { recursive: true })

    // Create compressed backup (.tar.gz)
    const gzBackup = path.join(BACKUP_DIR, 'graphvec-backup-2026-05-31T11-00-00-000Z.tar.gz')
    fs.writeFileSync(gzBackup, '')

    // Create compressed backup (.tgz)
    const tgzBackup = path.join(BACKUP_DIR, 'graphvec-backup-2026-05-31T12-00-00-000Z.tgz')
    fs.writeFileSync(tgzBackup, '')

    // Create unrelated file (should be filtered out)
    fs.writeFileSync(path.join(BACKUP_DIR, 'other-file.txt'), '')

    const backups = backupInst.listBackups(BACKUP_DIR)
    // 裸目录不再被视为有效备份
    expect(backups).not.toContain(dirBackup)
    // .tar.gz 文件仍被包含
    expect(backups).toContain(gzBackup)
    // .tgz 文件也被包含
    expect(backups).toContain(tgzBackup)
    // 无关文件被过滤
    expect(backups).not.toContain(path.join(BACKUP_DIR, 'other-file.txt'))
    // 验证 listBackups 只返回文件（所有返回值都应以 .tar.gz 或 .tgz 结尾）
    for (const b of backups) {
      expect(b.endsWith('.tar.gz') || b.endsWith('.tgz')).toBe(true)
    }

    cleanDir(BACKUP_DIR)
  })

  it('should verify backup integrity with consistency marker', async () => {
    const backupDir = path.join(BACKUP_DIR, 'verify-test')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, '.consistency-marker'), JSON.stringify({
      snapshotId: 1,
      hlcWallTime: 1000,
      hlcLogical: 0,
      createdAt: '2025-01-01T00:00:00.000Z',
    }))

    const result = await backupInst.verifyBackup(backupDir)
    expect(result).toBe(true)

    cleanDir(backupDir)
  })

  it('should reject backup without consistency marker', async () => {
    const backupDir = path.join(BACKUP_DIR, 'no-marker')
    fs.mkdirSync(backupDir, { recursive: true })

    const result = await backupInst.verifyBackup(backupDir)
    expect(result).toBe(false)

    cleanDir(backupDir)
  })
})

describe('parseBackupTimestamp', () => {
  it('should parse current backup filename format (YYYY-MM-DDTHH-mm-ss-SSSZ)', () => {
    // 当前格式: new Date().toISOString().replace(/[:.]/g, '-')
    const ts = parseBackupTimestamp(
      '/some/path/graphvec-backup-2026-06-01T10-30-00-000Z.tar.gz'
    )
    expect(ts).not.toBeNull()
    // 验证对应的是 2026-06-01T10:30:00.000Z
    expect(ts).toBe(new Date('2026-06-01T10:30:00.000Z').getTime())
  })

  it('should parse backup filename with .tgz extension', () => {
    const ts = parseBackupTimestamp(
      '/backups/graphvec-backup-2025-12-25T00-00-00-000Z.tgz'
    )
    expect(ts).not.toBeNull()
    expect(ts).toBe(new Date('2025-12-25T00:00:00.000Z').getTime())
  })

  it('should parse backup filename without compression extension (bare dir)', () => {
    const ts = parseBackupTimestamp(
      'graphvec-backup-2026-01-15T08-15-30-500Z'
    )
    expect(ts).not.toBeNull()
    expect(ts).toBe(new Date('2026-01-15T08:15:30.500Z').getTime())
  })

  it('should parse alternate ISO 8601 basic format (YYYYMMDDTHHmmssZ)', () => {
    const ts = parseBackupTimestamp(
      'graphvec-backup-20260601T103000Z.tar.gz'
    )
    expect(ts).not.toBeNull()
    expect(ts).toBe(new Date('2026-06-01T10:30:00.000Z').getTime())
  })

  it('should return null for unrecognized filenames', () => {
    expect(parseBackupTimestamp('random-file.txt')).toBeNull()
    expect(parseBackupTimestamp('graphvec-backup-invalid')).toBeNull()
    expect(parseBackupTimestamp('')).toBeNull()
  })
})

function cleanDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}
