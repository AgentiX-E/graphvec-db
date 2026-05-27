/**
 * backup-scheduler.spec.ts — BackupScheduler 单元测试
 */

import * as fs from 'fs'
import * as path from 'path'
import { BackupScheduler } from './backup-scheduler'

// Mock Backup 模块 — 完全模拟，不依赖 backup.ts
vi.mock('./backup', () => ({
  Backup: vi.fn().mockImplementation(function() { return {
    backup: vi.fn().mockResolvedValue({
      path: '/mock/backup.tar.gz',
      sizeBytes: 1024,
    }),
  }}),
}))

describe('BackupScheduler', () => {
  const BACKUP_DIR = './test-data/backup-scheduler-test'

  beforeAll(() => {
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
  })

  afterAll(() => {
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
  })

  describe('lifecycle', () => {
    it('should start and stop the scheduler', () => {
      const scheduler = new BackupScheduler({
        cronExpression: '* * * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
      })

      expect(scheduler.isRunning()).toBe(false)

      scheduler.start()
      expect(scheduler.isRunning()).toBe(true)

      scheduler.stop()
      expect(scheduler.isRunning()).toBe(false)
    })

    it('should throw if start is called twice', () => {
      const scheduler = new BackupScheduler({
        cronExpression: '* * * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
      })

      scheduler.start()
      expect(() => scheduler.start()).toThrow('BackupScheduler already started')

      scheduler.stop()
    })
  })

  describe('executeNow', () => {
    it('should run a backup immediately and return a path', async () => {
      const scheduler = new BackupScheduler({
        cronExpression: '0 0 * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
      })

      scheduler.start()
      try {
        const resultPath = await scheduler.executeNow()
        expect(resultPath).toBeTruthy()
        expect(resultPath).toMatch(/\.tar\.gz$/)
      } finally {
        scheduler.stop()
      }
    })
  })

  describe('cleanOldBackups', () => {
    it('should clean backups older than maxRetentionDays', () => {
      // 创建旧备份文件（文件名中的时间戳决定年龄）
      const oldFile1 = path.join(BACKUP_DIR, 'graphvec-backup-2020-01-01T00-00-00-000Z.tar.gz')
      const oldFile2 = path.join(BACKUP_DIR, 'graphvec-backup-2020-06-15T00-00-00-000Z')
      const newFile = path.join(BACKUP_DIR, 'graphvec-backup-2099-01-01T00-00-00-000Z.tar.gz')

      fs.writeFileSync(oldFile1, 'old backup 1')
      fs.mkdirSync(oldFile2, { recursive: true })
      fs.writeFileSync(path.join(oldFile2, 'data.bin'), 'old data')
      fs.writeFileSync(newFile, 'new backup')

      expect(fs.existsSync(oldFile1)).toBe(true)
      expect(fs.existsSync(oldFile2)).toBe(true)
      expect(fs.existsSync(newFile)).toBe(true)

      const scheduler = new BackupScheduler({
        cronExpression: '0 0 * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
        maxRetentionDays: 365, // 保留 1 年，2099 年的文件会被保留
      })

      scheduler.start()

      expect(fs.existsSync(oldFile1)).toBe(false)
      expect(fs.existsSync(oldFile2)).toBe(false)
      expect(fs.existsSync(newFile)).toBe(true)

      scheduler.stop()
    })

    it('should not delete any backup when maxRetentionDays is not set', () => {
      const oldFile = path.join(BACKUP_DIR, 'graphvec-backup-2020-01-01T00-00-00-000Z.tar.gz')
      fs.writeFileSync(oldFile, 'old backup')

      const scheduler = new BackupScheduler({
        cronExpression: '0 0 * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
      })

      scheduler.start()
      expect(fs.existsSync(oldFile)).toBe(true)
      scheduler.stop()
    })

    it('should only delete graphvec-backup- prefixed files', () => {
      const oldBackup = path.join(BACKUP_DIR, 'graphvec-backup-2020-01-01T00-00-00-000Z.tar.gz')
      const unrelated = path.join(BACKUP_DIR, 'some-other-file.txt')

      fs.writeFileSync(oldBackup, 'old backup')
      fs.writeFileSync(unrelated, 'unrelated')

      const scheduler = new BackupScheduler({
        cronExpression: '0 0 * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
        maxRetentionDays: 1,
      })

      scheduler.start()
      expect(fs.existsSync(oldBackup)).toBe(false)
      expect(fs.existsSync(unrelated)).toBe(true)
      scheduler.stop()
    })

    it('should handle empty backup directory gracefully', () => {
      const scheduler = new BackupScheduler({
        cronExpression: '0 0 * * *',
        outputDir: BACKUP_DIR,
        engine: {} as any,
        maxRetentionDays: 7,
      })

      expect(() => scheduler.start()).not.toThrow()
      scheduler.stop()
    })
  })
})
