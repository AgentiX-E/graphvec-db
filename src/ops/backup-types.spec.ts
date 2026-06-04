/**
 * backup-types.spec.ts — 备份类型定义测试
 *
 * 覆盖：
 * - BackupResult 接口结构
 * - WalLsnSnapshot 接口结构
 * - PITRConfig 接口默认值
 * - RecoveryPoint 接口结构
 * - 各种字段类型校验
 */
import { describe, it, expect } from 'vitest'
import type {
  BackupResult,
  WalLsnSnapshot,
  PITRConfig,
  RecoveryPoint,
} from './backup-types'

describe('BackupResult', () => {
  it('应能创建完整结构', () => {
    const result: BackupResult = {
      path: '/backups/snap-abc123',
      sizeBytes: 1048576,
      verified: true,
      isIncremental: false,
      lsnRange: { from: 0, to: 100 },
    }
    expect(result.path).toBe('/backups/snap-abc123')
    expect(result.sizeBytes).toBe(1048576)
    expect(result.verified).toBe(true)
    expect(result.isIncremental).toBe(false)
    expect(result.lsnRange.from).toBe(0)
    expect(result.lsnRange.to).toBe(100)
  })

  it('支持增量备份结果', () => {
    const result: BackupResult = {
      path: '/backups/snap-inc-456',
      sizeBytes: 512000,
      verified: true,
      isIncremental: true,
      lsnRange: { from: 100, to: 150 },
    }
    expect(result.isIncremental).toBe(true)
    expect(result.lsnRange.from).toBe(100)
    expect(result.lsnRange.to).toBe(150)
  })

  it('支持未验证的备份', () => {
    const result: BackupResult = {
      path: '/backups/snap-unverified',
      sizeBytes: 0,
      verified: false,
      isIncremental: false,
      lsnRange: { from: 0, to: 0 },
    }
    expect(result.verified).toBe(false)
  })

  it('支持零字节备份', () => {
    const result: BackupResult = {
      path: '/backups/empty',
      sizeBytes: 0,
      verified: true,
      isIncremental: false,
      lsnRange: { from: 0, to: 0 },
    }
    expect(result.sizeBytes).toBe(0)
  })
})

describe('WalLsnSnapshot', () => {
  it('应能创建空的 WAL 快照', () => {
    const snapshot: WalLsnSnapshot = {
      files: {},
    }
    expect(Object.keys(snapshot.files)).toHaveLength(0)
  })

  it('应能包含多个 WAL 文件', () => {
    const snapshot: WalLsnSnapshot = {
      files: {
        '00000001.log': 42,
        '00000002.log': 128,
        '00000003.log': 256,
      },
    }
    expect(snapshot.files['00000001.log']).toBe(42)
    expect(snapshot.files['00000002.log']).toBe(128)
    expect(snapshot.files['00000003.log']).toBe(256)
    expect(Object.keys(snapshot.files)).toHaveLength(3)
  })

  it('支持日志索引 0', () => {
    const snapshot: WalLsnSnapshot = {
      files: {
        '00000000.log': 0,
      },
    }
    expect(snapshot.files['00000000.log']).toBe(0)
  })
})

describe('PITRConfig', () => {
  it('应能创建启用配置', () => {
    const config: PITRConfig = {
      enabled: true,
      fullBackupIntervalMs: 86400000,
      walArchivePath: '/wal-archive/',
      retentionCount: 7,
    }
    expect(config.enabled).toBe(true)
    expect(config.fullBackupIntervalMs).toBe(86400000)
    expect(config.walArchivePath).toBe('/wal-archive/')
    expect(config.retentionCount).toBe(7)
  })

  it('应能创建禁用配置', () => {
    const config: PITRConfig = {
      enabled: false,
      fullBackupIntervalMs: 0,
      walArchivePath: '',
      retentionCount: 0,
    }
    expect(config.enabled).toBe(false)
  })

  it('支持目标恢复时间戳', () => {
    const ts = Date.now()
    const config: PITRConfig = {
      enabled: true,
      fullBackupIntervalMs: 3600000,
      walArchivePath: '/wal-archive/',
      retentionCount: 3,
      targetTimestamp: ts,
    }
    expect(config.targetTimestamp).toBe(ts)
  })

  it('targetTimestamp 可选', () => {
    const config: PITRConfig = {
      enabled: true,
      fullBackupIntervalMs: 86400000,
      walArchivePath: '/wal-archive/',
      retentionCount: 7,
    }
    expect(config.targetTimestamp).toBeUndefined()
  })
})

describe('RecoveryPoint', () => {
  it('应能创建全量恢复点', () => {
    const ts = Date.now()
    const point: RecoveryPoint = {
      timestamp: ts,
      backupId: 'snap-full-001',
      type: 'full',
    }
    expect(point.timestamp).toBe(ts)
    expect(point.backupId).toBe('snap-full-001')
    expect(point.type).toBe('full')
  })

  it('应能创建增量恢复点', () => {
    const point: RecoveryPoint = {
      timestamp: 1700000000000,
      backupId: 'snap-inc-002',
      type: 'incremental',
    }
    expect(point.type).toBe('incremental')
  })

  it('type 只能是 full 或 incremental', () => {
    const full: RecoveryPoint = { timestamp: 1, backupId: 'a', type: 'full' }
    const inc: RecoveryPoint = { timestamp: 1, backupId: 'b', type: 'incremental' }
    expect(full.type).toBe('full')
    expect(inc.type).toBe('incremental')
  })
})
