/**
 * backup-scheduler.ts — 定时自动备份调度器
 *
 * 使用 node-cron 定时执行备份操作，支持：
 * - 自定义 cron 表达式
 * - 过期备份自动清理
 * - start/stop 生命周期控制
 */

import * as fs from 'fs'
import * as path from 'path'
import * as cron from 'node-cron'
import { GraphEngine } from '../core/graph-engine'
import { Backup } from './backup'
import type { PITRConfig } from './backup-types'
import { Logger } from './logger'

/**
 * 备份调度器配置
 */
export interface BackupSchedulerConfig {
  /** cron 表达式，如 '0 3 * * *'（每天凌晨 3 点） */
  cronExpression: string

  /** 备份输出根目录 */
  outputDir: string

  /** 要备份的 GraphEngine 实例 */
  engine: GraphEngine

  /** PITR 配置（可选，启用后每次备份会同时创建增量备份） */
  pitrConfig?: PITRConfig

  /** 保留天数，超过此天数的旧备份会被自动清理 */
  maxRetentionDays?: number
}

/**
 * 定时备份调度器
 *
 * @example
 * ```ts
 * const scheduler = new BackupScheduler({
 *   cronExpression: '0 3 * * *',
 *   outputDir: '/backups/graphvec',
 *   engine,
 *   maxRetentionDays: 30,
 * })
 * scheduler.start()
 * // 运行期间每天凌晨 3 点自动备份
 * scheduler.stop()
 * ```
 */
export class BackupScheduler {
  private task: cron.ScheduledTask | null = null
  private config: BackupSchedulerConfig
  private backupInstance: Backup
  private logger: Logger

  constructor(config: BackupSchedulerConfig) {
    this.config = config
    this.backupInstance = new Backup(config.engine)
    this.logger = new Logger('BackupScheduler')
  }

  /**
   * 启动定时备份任务
   * @throws 如果调度器已经开始
   */
  start(): void {
    if (this.task) {
      throw new Error('BackupScheduler already started')
    }

    // 确保输出目录存在
    fs.mkdirSync(this.config.outputDir, { recursive: true })

    this.task = cron.schedule(this.config.cronExpression, () => {
      this._execute().catch(err => {
        this.logger.error(`Scheduled backup failed:`, err instanceof Error ? err : new Error(String(err)))
      })
    })

    // 启动时立即清理过期备份
    if (this.config.maxRetentionDays && this.config.maxRetentionDays > 0) {
      this._cleanOldBackups()
    }
  }

  /**
   * 停止定时备份任务
   */
  stop(): void {
    if (this.task) {
      this.task.stop()
      this.task = null
    }
  }

  /**
   * 获取当前调度器状态
   */
  isRunning(): boolean {
    return this.task !== null
  }

  /**
   * 立即手动执行一次备份（不受 cron 调度影响）
   */
  async executeNow(): Promise<string> {
    return this._execute()
  }

  /**
   * 执行定时备份操作
   */
  private async _execute(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const destPath = path.join(this.config.outputDir, `graphvec-backup-${timestamp}`)

    // 确保目标目录存在
    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    const result = await this.backupInstance.backup(destPath)

    // 清理过期备份
    if (this.config.maxRetentionDays && this.config.maxRetentionDays > 0) {
      this._cleanOldBackups()
    }

    return result.path
  }

  /**
   * 清理超过保留天数的旧备份
   *
   * 判断依据：优先解析文件名中的 ISO 时间戳（如 backup-2026-05-23T22-30-00-000Z.tar.gz），
   * 若解析失败则回退到文件 mtime。
   */
  private _cleanOldBackups(): void {
    if (!this.config.maxRetentionDays || this.config.maxRetentionDays <= 0) return

    const cutoff = Date.now() - this.config.maxRetentionDays * 24 * 60 * 60 * 1000

    let entries: string[]
    try {
      entries = fs.readdirSync(this.config.outputDir)
    } catch {
      return
    }

    for (const entry of entries) {
      // 只匹配备份相关的文件/目录（.tar.gz 或备份目录）
      if (!entry.startsWith('graphvec-backup-')) continue

      const fullPath = path.join(this.config.outputDir, entry)

      // 优先解析文件名中的时间戳
      let fileTime = this._parseBackupTimestamp(entry)
      if (fileTime === null) {
        // 回退到文件 mtime
        try {
          fileTime = fs.statSync(fullPath).mtimeMs
        } catch {
          continue
        }
      }

      if (fileTime < cutoff) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true })
        } catch (err) {
          this.logger.error(`Failed to remove old backup: ${fullPath}`, err instanceof Error ? err : new Error(String(err)))
        }
      }
    }
  }

  /**
   * 从备份文件名解析 ISO 时间戳（毫秒）
   * 格式: graphvec-backup-2026-05-23T22-30-00-000Z.tar.gz
   *       graphvec-backup-2026-05-23T22-30-00-000Z
   */
  private _parseBackupTimestamp(entry: string): number | null {
    const baseName = entry.replace(/\.tar\.gz$/, '').replace(/\.zip$/, '')
    const match = baseName.match(/^graphvec-backup-(.+)$/)
    if (!match) return null

    try {
      // 转换回 ISO 格式: 先将 T 之前的 - 恢复，再将时分秒的 - 恢复
      // graphvec-backup-2026-05-23T22-30-00-000Z
      // 实际 node-cron 安全的文件名是替换 : 和 . 为 -
      // 所以原始 ISO: 2026-05-23T22:30:00.000Z
      // 文件中的形式: 2026-05-23T22-30-00-000Z? 要看 backup() 的实现
      // backup() 中使用: new Date().toISOString().replace(/[:.]/g, '-')
      // 所以: 2026-05-23T22-30-00-000Z
      // 需要还原: T22-30-00-000Z → T22:30:00.000Z
      const tsPart = match[1]
      // 找到 T 之后的部分
      const tIndex = tsPart.indexOf('T')
      if (tIndex === -1) return null
      const datePart = tsPart.substring(0, tIndex)   // 2026-05-23
      const timePart = tsPart.substring(tIndex + 1)  // 22-30-00-000Z

      // 将 timePart 的 - 还原为 : 和 .
      const parts = timePart.split('-')
      if (parts.length < 3) return null
      const hours = parts[0]
      const minutes = parts[1]
      const seconds = parts[2]
      const millisAndTz = parts.slice(3).join('-') // 000Z

      const isoStr = `${datePart}T${hours}:${minutes}:${seconds}.${millisAndTz}`
      const d = new Date(isoStr)
      return isNaN(d.getTime()) ? null : d.getTime()
    } catch {
      return null
    }
  }
}
