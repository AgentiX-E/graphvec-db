import * as fs from 'fs'
import * as path from 'path'
import { GraphEngine } from '../core/graph-engine'
import { Backup } from './backup'
import { testEngineConfig } from '../../test/fixtures/test-graph'

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

vi.mock('tar', () => ({ extract: async () => {} }))

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
})

function cleanDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}
