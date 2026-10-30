/**
 * backup-scheduler.spec.ts — Unit tests for BackupScheduler
 *
 * Covers: construction, start/stop lifecycle, isRunning, executeNow,
 * _cleanOldBackups (timestamp parsing + retention), double-start rejection,
 * and edge cases.
 */
import { BackupScheduler } from './backup-scheduler'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ── Mocks (must be before any imports of mocked modules) ──

const mockBackupFn = vi.fn()

vi.mock('node-cron', () => {
  const s = vi.fn((_expr: string, _cb: () => void) => ({ stop: vi.fn() }))
  return { schedule: s, default: { schedule: s }, __esModule: true }
})

vi.mock('./backup', () => ({
  Backup: vi.fn(function(this: any) {
    this.backup = mockBackupFn
  }),
}))

// ── Setup ──

let tmpRoot: string
let counter = 0

function tmpDir(label = 'bs') {
  counter++
  const d = path.join(tmpRoot, `${label}-${counter}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function fakeEngine() {
  return { open: vi.fn(), close: vi.fn(), upsertNode: vi.fn() } as any
}

beforeAll(() => { tmpRoot = path.join(os.tmpdir(), `bs-spec-${Date.now()}`); fs.mkdirSync(tmpRoot, { recursive: true }) })
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }) })
// Backup._execute creates destPath from timestamp, calls mockBackupFn(destPath),
// and returns result.path (the mock's return value). We set the mock to echo the
// input path back so the tests can assert on the generated timestamped path.

beforeEach(() => {
  mockBackupFn.mockReset()
  mockBackupFn.mockImplementation((destPath: string) => Promise.resolve({ path: destPath, size: 1024 }))
})

describe('BackupScheduler', () => {
  // ── start / stop ───────────────────────────────────
  it('starts and stops correctly', () => {
    const outDir = tmpDir()
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine() })
    expect(s.isRunning()).toBe(false)
    s.start()
    expect(s.isRunning()).toBe(true)
    s.stop()
    expect(s.isRunning()).toBe(false)
  })

  it('double start throws', () => {
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: tmpDir(), engine: fakeEngine() })
    s.start()
    expect(() => s.start()).toThrow('already started')
  })

  it('stop when not started is safe', () => {
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: tmpDir(), engine: fakeEngine() })
    expect(() => s.stop()).not.toThrow()
  })

  it('start creates output directory', () => {
    const outDir = path.join(tmpRoot, 'out-' + counter++)
    new BackupScheduler({ cronExpression: '* * * * *', outputDir: outDir, engine: fakeEngine() }).start()
    expect(fs.existsSync(outDir)).toBe(true)
  })

  // ── executeNow ─────────────────────────────────────
  it('executeNow calls backup and returns path', async () => {
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: tmpDir(), engine: fakeEngine() })
    const result = await s.executeNow()
    expect(result).toContain('graphvec-backup-')
    expect(mockBackupFn).toHaveBeenCalled()
  })

  it('executeNow without start works', async () => {
    mockBackupFn.mockResolvedValue({ path: '/manual.backup', size: 500 })
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: tmpDir(), engine: fakeEngine() })
    expect(await s.executeNow()).toBe('/manual.backup')
  })

  it('executeNow propagates backup failure', async () => {
    mockBackupFn.mockRejectedValue(new Error('disk full'))
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: tmpDir(), engine: fakeEngine() })
    await expect(s.executeNow()).rejects.toThrow('disk full')
  })

  // ── Retention cleanup ──────────────────────────────
  it('cleans old backups on start with maxRetentionDays', () => {
    const outDir = tmpDir()
    const oldFile = 'graphvec-backup-2020-01-01T00-00-00-000Z'
    fs.writeFileSync(path.join(outDir, oldFile), 'old')
    new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine(), maxRetentionDays: 30 }).start()
    expect(fs.existsSync(path.join(outDir, oldFile))).toBe(false)
  })

  it('keeps recent backups during cleanup', () => {
    const outDir = tmpDir()
    const recent = 'graphvec-backup-' + new Date().toISOString().replace(/[:.]/g, '-')
    fs.writeFileSync(path.join(outDir, recent), 'recent')
    new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine(), maxRetentionDays: 30 }).start()
    expect(fs.existsSync(path.join(outDir, recent))).toBe(true)
  })

  it('skips cleanup when maxRetentionDays is 0', () => {
    const outDir = tmpDir()
    const oldFile = 'graphvec-backup-2020-01-01T00-00-00-000Z'
    fs.writeFileSync(path.join(outDir, oldFile), 'old')
    new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine(), maxRetentionDays: 0 }).start()
    expect(fs.existsSync(path.join(outDir, oldFile))).toBe(true)
  })

  it('ignores non-backup files during cleanup', () => {
    const outDir = tmpDir()
    fs.writeFileSync(path.join(outDir, 'other.txt'), 'x')
    new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine(), maxRetentionDays: 1 }).start()
    expect(fs.existsSync(path.join(outDir, 'other.txt'))).toBe(true)
  })

  // ── Edge cases ─────────────────────────────────────
  it('stop-then-start restarts', () => {
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: tmpDir(), engine: fakeEngine() })
    s.start(); s.stop(); s.start()
    expect(s.isRunning()).toBe(true)
  })

  it('handles missing outputDir during cleanup gracefully', () => {
    const outDir = path.join(tmpRoot, 'no-exist-' + counter++)
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine(), maxRetentionDays: 7 })
    // mkdirSync creates the dir during start, so no crash
    expect(() => s.start()).not.toThrow()
  })

  it('cleanup ignores entries with unparseable timestamps', () => {
    const outDir = tmpDir()
    fs.writeFileSync(path.join(outDir, 'graphvec-backup-bad-format'), 'x')
    const s = new BackupScheduler({ cronExpression: '0 3 * * *', outputDir: outDir, engine: fakeEngine(), maxRetentionDays: 1 })
    expect(() => s.start()).not.toThrow()
  })
})