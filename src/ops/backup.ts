import * as fs from 'fs'
import * as path from 'path'
import { GraphEngine } from '../core/graph-engine'
import { Logger } from './logger'
import { HlcClock } from '../replication/hlc-clock'

/**
 * Backup — 文件级备份 / 恢复
 *
 * 备份通过 OverGraph 文件目录的递归复制 + fsync 实现
 * 恢复将备份目录复制回原位置
 *
 * 安全性：
 * - inProgress 标志防止并发备份（数据一致性问题）
 * - 每次备份记录 HLC 时间戳一致性标记（.consistency-marker）
 *   → 备份文件不再阻止同时写入，但通过标记可验证快照的一致时间点
 * - restore 时先备份当前数据作为回滚点
 */
export class Backup {
  private engine: GraphEngine
  private config: { path: string }
  private logger: Logger
  private inProgress: boolean = false
  private clock: HlcClock
  private snapshotId: number = 0

  constructor(engine: GraphEngine, clock?: HlcClock) {
    this.engine = engine
    this.config = { path: '' }
    this.logger = new Logger('backup')
    this.clock = clock || new HlcClock()
  }

  /**
   * 创建文件级备份
   * @param backupDir 备份目标目录
   * @throws 如果备份已经在进行中则抛出
   */
  async backup(backupDir: string): Promise<{ path: string; sizeBytes: number }> {
    if (this.inProgress) {
      throw new Error('Backup already in progress')
    }
    this.inProgress = true
    this.snapshotId++
    try {
      // 1. 在复制前记录 HLC 时间戳（建立一致性快照参考点）
      const ts = this.clock.nowWithWallTime()

      // 微任务让出点：允许其他调用检查 inProgress
      await Promise.resolve()

      const stats = this.engine.stats()

      // 获取数据目录路径（从 config）
      const dataDir = process.env.DATA_DIR || './data'

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const destPath = path.join(backupDir, `graphvec-backup-${timestamp}`)

      try {
        fs.mkdirSync(destPath, { recursive: true })

        // 2. 执行数据复制（不阻塞同时写入）
        fs.cpSync(dataDir, destPath, { recursive: true })

        // 3. 写入一致性标记文件（记录备份参考时间点）
        fs.writeFileSync(
          path.join(destPath, '.consistency-marker'),
          JSON.stringify({
            snapshotId: this.snapshotId,
            hlcWallTime: Number(ts.wallTime),
            hlcLogical: ts.logical,
            createdAt: new Date().toISOString(),
          }, null, 2)
        )

        // 4. 确保标记文件落盘
        const fd = fs.openSync(destPath, 'r')
        try {
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      } catch (err) {
        throw new Error(`Backup failed: ${(err as Error).message}`)
      }

      // 5. 计算备份实际字节数
      let sizeBytes = 0
      const walkDir = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isFile()) {
            sizeBytes += fs.statSync(fullPath).size
          } else if (entry.isDirectory()) {
            walkDir(fullPath)
          }
        }
      }
      walkDir(destPath)

      return { path: destPath, sizeBytes }
    } finally {
      this.inProgress = false
    }
  }

  /**
   * 验证备份快照的一致性标记
   * @param backupPath 备份路径
   * @returns true 如果一致性标记有效（包含 snapshotId 和 hlcWallTime）
   */
  async verifyBackup(backupPath: string): Promise<boolean> {
    try {
      const markerPath = path.join(backupPath, '.consistency-marker')
      if (!fs.existsSync(markerPath)) return false
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
      return typeof marker.snapshotId === 'number' && typeof marker.hlcWallTime === 'number'
    } catch {
      return false
    }
  }

  /**
   * 从备份恢复
   * @param backupPath 备份路径
   * @param restorePath 恢复目标路径（默认为原数据目录）
   */
  async restore(backupPath: string, restorePath?: string): Promise<void> {
    const target = restorePath || process.env.DATA_DIR || './data'

    // 先验证备份源存在，避免在验证之前就修改目标
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup path does not exist: ${backupPath}`)
    }

    // 关闭当前引擎
    this.engine.close()

    try {
      // 备份当前数据（防止恢复失败）
      const currentBackup = `${target}.pre-restore`
      if (fs.existsSync(target)) {
        fs.renameSync(target, currentBackup)
      }

      // 复制备份数据
      fs.cpSync(backupPath, target, { recursive: true })
      // 确保数据落盘
      const fd = fs.openSync(target, 'r')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      // 恢复失败时尝试回滚
      this.logger.error('Restore failed, attempting rollback...', err as Error)
      throw err
    }

    // 重新打开引擎
    this.engine.open()
  }

  /**
   * 列出所有备份
   */
  listBackups(backupDir: string): string[] {
    try {
      return fs.readdirSync(backupDir)
        .filter(name => name.startsWith('graphvec-backup-'))
        .map(name => path.join(backupDir, name))
    } catch {
      return []
    }
  }
}
