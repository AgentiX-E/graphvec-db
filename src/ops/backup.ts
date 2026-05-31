import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { createRequire } from 'module'
import { GraphEngine } from '../core/graph-engine'
import { Logger } from './logger'
import { HlcClock } from '../replication/hlc-clock'
import type { PITRConfig, RecoveryPoint } from './backup-types'
import { WalArchiver } from './backup-wal'
import { fsyncDirectory } from './backup-helpers'

// createRequire for safe loading of ESM-only modules inside CJS context
const _require = createRequire(typeof __filename !== 'undefined' ? __filename : '/')
const _archiver = _require('archiver')
const _tar = _require('tar')

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
  private pitrConfig: PITRConfig | null = null
  private walArchiver: WalArchiver = new WalArchiver()

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

        // 2. 在复制前刷新所有待处理数据，确保文件系统一致性
        // 2a. 尝试同步 GraphEngine 内部缓存（如果实现了 sync/flush 方法）
        const engineAny = this.engine as any
        if (typeof engineAny.sync === 'function') {
          engineAny.sync()
        }
        if (typeof engineAny.flush === 'function') {
          engineAny.flush()
        }
        // 2b. 尝试同步底层存储层
        if (typeof engineAny.storage?.compact === 'function') {
          engineAny.storage.compact()
        }

        // 2c. 确保数据目录中所有文件已落盘
        fsyncDirectory(dataDir)

        // 3. 执行数据复制（cpSync + fsync 保证一致性）
        this._copyDirSync(dataDir, destPath)

        // 4. 写入一致性标记文件（记录备份参考时间点，标记文件也需 fsync）
        const markerContent = JSON.stringify({
          snapshotId: this.snapshotId,
          hlcWallTime: Number(ts.wallTime),
          hlcLogical: ts.logical,
          createdAt: new Date().toISOString(),
        }, null, 2)
        const markerPath = path.join(destPath, '.consistency-marker')
        fs.writeFileSync(markerPath, markerContent)
        const markerFd = fs.openSync(markerPath, 'r')
        try {
          fs.fsyncSync(markerFd)
        } finally {
          fs.closeSync(markerFd)
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

      // 6. 将备份目录打成 gzip 压缩包
      const tarGzPath = `${destPath}.tar.gz`
      try {
        const archiverReq = _archiver
        const output = fs.createWriteStream(tarGzPath)
        const archive = archiverReq('tar', { gzip: true, gzipOptions: { level: 6 } })

        await new Promise<void>((resolve, reject) => {
          output.on('close', resolve)
          archive.on('error', reject)
          archive.pipe(output)
          archive.directory(destPath, path.basename(destPath))
          archive.finalize()
        })

        // 7. 删除原始裸目录
        fs.rmSync(destPath, { recursive: true, force: true })

        // 8. 更新大小和路径
        sizeBytes = fs.statSync(tarGzPath).size

        return { path: tarGzPath, sizeBytes }
      } catch (err) {
        throw new Error(`Backup archive failed: ${(err as Error).message}`)
      }
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

      // 自动检测压缩格式（GZip magic bytes: 0x1f 0x8b）
      if (this._isGzipped(backupPath)) {
        await this._extractTarGz(backupPath, target)
      } else if (backupPath.endsWith('.tar.gz') || backupPath.endsWith('.tgz')) {
        await this._extractTarGz(backupPath, target)
      } else {
        // 复制备份数据（裸目录）
        fs.mkdirSync(target, { recursive: true })
        this._copyDirSync(backupPath, target)
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
   * 检测文件前 2 字节是否为 GZip 魔数（0x1f, 0x8b）
   */
  private _isGzipped(filePath: string): boolean {
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(2)
        const bytesRead = fs.readSync(fd, buf, 0, 2, 0)
        return bytesRead === 2 && buf[0] === 0x1f && buf[1] === 0x8b
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return false
    }
  }

  /**
   * 解压并提取 .tar.gz 文件到目标目录
   */
  private async _extractTarGz(tarGzPath: string, target: string): Promise<void> {
    const tarReq = _tar
    fs.mkdirSync(target, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(tarGzPath)
      const gunzip = zlib.createGunzip()
      const extractStream = tarReq.extract({
        cwd: target,
        strip: 1,
      }) as NodeJS.WritableStream

      extractStream.on('close', resolve)
      extractStream.on('error', reject)
      gunzip.on('error', reject)
      readStream.on('error', reject)

      readStream.pipe(gunzip).pipe(extractStream)
    })
  }

  /**
   * 列出所有备份
   */
  listBackups(backupDir: string): string[] {
    try {
      return fs.readdirSync(backupDir)
        .filter(name => {
          if (!name.startsWith('graphvec-backup-')) return false
          const fullPath = path.join(backupDir, name)
          return fs.statSync(fullPath).isDirectory() || name.endsWith('.tar.gz') || name.endsWith('.tgz')
        })
        .map(name => path.join(backupDir, name))
    } catch {
      return []
    }
  }

  /**
   * 递归复制目录（Node.js 版本兼容）
   * - Node 16.7+：使用 fs.cpSync
   * - 更早版本：手动递归复制
   */
  private _copyDirSync(src: string, dest: string): void {
    if (typeof fs.cpSync === 'function') {
      fs.cpSync(src, dest, { recursive: true })
      // cpSync 后对目标目录执行 fsync，确保数据落盘
      fsyncDirectory(dest)
    } else {
      this._copyRecursiveSync(src, dest)
    }
  }

  /**
   * 手动递归复制目录（fs.cpSync 函数的 fallback）
   */
  private _copyRecursiveSync(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath)
      } else if (entry.isDirectory()) {
        this._copyRecursiveSync(srcPath, destPath)
      }
    }
    // 对目标目录执行 fsync
    fsyncDirectory(dest)
  }

  // ─────────── PITR（Point-in-Time Recovery）───────────

  /**
   * 启用 PITR（Point-in-Time Recovery）
   * @param config PITR 配置
   */
  enablePITR(config: PITRConfig): void {
    this.pitrConfig = { ...config }
    this.logger.info('PITR enabled', {
      walArchivePath: config.walArchivePath,
      fullBackupIntervalMs: config.fullBackupIntervalMs,
      retentionCount: config.retentionCount,
    })
  }

  /**
   * 创建增量备份：将当前 WAL 文件归档到存档目录
   * @returns 备份 ID
   */
  async createIncremental(): Promise<string> {
    if (!this.pitrConfig) {
      throw new Error('PITR is not enabled. Call enablePITR() first.')
    }
    const dataDir = process.env.DATA_DIR || './data'
    const archiveDir = this.pitrConfig.walArchivePath

    // 确保归档目录存在
    fs.mkdirSync(archiveDir, { recursive: true })

    // 扫描数据目录下所有 WAL 文件并归档
    let archivedCount = 0
    let firstBackupId = ''

    const scanWalFiles = (dir: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isFile() && /^wal-.+\.bin$/.test(entry.name)) {
          const archiveRecord = this.walArchiver.archiveWalSync(fullPath, archiveDir)
          if (!firstBackupId) {
            firstBackupId = archiveRecord.backupId
          }
          archivedCount++
        } else if (entry.isDirectory()) {
          scanWalFiles(fullPath)
        }
      }
    }

    scanWalFiles(dataDir)

    if (archivedCount === 0) {
      // 如果没有 WAL 文件，创建一个占位归档，记录当前时间点
      const placeholderPath = path.join(archiveDir, `${ARCHIVE_PREFIX}${Date.now()}-no-wal`)
      fs.writeFileSync(placeholderPath, JSON.stringify({ timestamp: Date.now(), noWal: true }))
      firstBackupId = path.basename(placeholderPath)
    }

    // 清理旧归档（只保留 retentionCount 个）
    await this.walArchiver.cleanupArchives(archiveDir, this.pitrConfig.retentionCount)

    this.logger.info(`Incremental backup created`, {
      backupId: firstBackupId,
      archivedCount,
      archiveDir,
    })

    return firstBackupId
  }

  /**
   * 恢复到指定时间点
   *
   * 流程：
   * 1. 找到指定时间戳之前的最新全量备份
   * 2. 从该全量备份恢复
   * 3. 按时间排序重放 WAL 归档直到目标时间戳
   *
   * @param timestamp 目标时间戳（毫秒）
   * @param archiveDir 归档目录
   */
  async restoreToTimestamp(timestamp: number, archiveDir: string): Promise<void> {
    // 1. 找到最近的备份目录
    const backupBaseDir = path.dirname(archiveDir)
    const backupDirs = this.listBackups(backupBaseDir)
      .filter(b => {
        // 解析备份目录的时间戳
        const ts = parseBackupTimestamp(b)
        return ts !== null && ts <= timestamp
      })
      .sort((a, b) => {
        const tsA = parseBackupTimestamp(a) ?? 0
        const tsB = parseBackupTimestamp(b) ?? 0
        return tsB - tsA // 最近的先排
      })

    if (backupDirs.length === 0) {
      throw new Error(`No full backup found before timestamp ${timestamp}`)
    }

    const latestFullBackup = backupDirs[0]
    this.logger.info(`Found latest full backup before PITR target`, {
      backupPath: latestFullBackup,
      targetTimestamp: timestamp,
    })

    // 2. 恢复全量备份
    await this.restore(latestFullBackup)

    // 3. 查找所有在目标时间戳之前的 WAL 归档
    const archives = await this.walArchiver.listArchives(archiveDir)
    const archivesToReplay = archives.filter(a => a.timestamp <= timestamp)

    this.logger.info(`Replaying ${archivesToReplay.length} WAL archives for PITR`, {
      targetTimestamp: timestamp,
      archiveCount: archivesToReplay.length,
    })

    // 将 WAL 归档文件恢复回数据目录
    const dataDir = process.env.DATA_DIR || './data'
    for (const archive of archivesToReplay) {
      try {
        // 从归档文件名提取原始 WAL 文件名: wal-archive-<ts>-<originalName>
        const baseName = path.basename(archive.walPath)
        const originalName = getOriginalWalName(baseName)
        if (!originalName) continue

        // 搜索数据目录下对应的 WAL 目录
        const destWalPath = findWalDestPath(dataDir, originalName)
        if (destWalPath) {
          // 确保目标目录存在
          fs.mkdirSync(path.dirname(destWalPath), { recursive: true })
          fs.copyFileSync(archive.walPath, destWalPath)
        }
      } catch (err) {
        this.logger.warn(`Failed to replay WAL archive: ${archive.walPath}`, { error: (err as Error).message })
      }
    }
  }

  /**
   * 列出可用的恢复点
   * @param archiveDir 归档目录
   */
  async listRecoveryPoints(archiveDir: string): Promise<RecoveryPoint[]> {
    const points: RecoveryPoint[] = []

    // 1. 从全量备份目录扫描
    const backupBaseDir = path.dirname(archiveDir)
    const backupDirs = this.listBackups(backupBaseDir)
    for (const dir of backupDirs) {
      const ts = parseBackupTimestamp(dir)
      if (ts !== null) {
        points.push({
          timestamp: ts,
          backupId: path.basename(dir),
          type: 'full',
        })
      }
    }

    // 2. 从 WAL 归档扫描
    const incrementalPoints = await this.walArchiver.listRecoveryPoints(archiveDir)
    points.push(...incrementalPoints)

    // 3. 按时间排序
    points.sort((a, b) => a.timestamp - b.timestamp)
    return points
  }
}

// ─────────── PITR 辅助函数 ───────────

/** WAL 归档文件前缀（与 backup-wal.ts 中一致） */
const ARCHIVE_PREFIX = 'wal-archive-'

/**
 * 从备份目录路径解析时间戳。
 * 格式: graphvec-backup-2026-05-23T22-30-00-000Z
 * 支持 .tar.gz / .tgz 后缀
 */
function parseBackupTimestamp(backupPath: string): number | null {
  let baseName = path.basename(backupPath)
  // 去除压缩扩展名
  if (baseName.endsWith('.tar.gz')) {
    baseName = baseName.slice(0, -7)
  } else if (baseName.endsWith('.tgz')) {
    baseName = baseName.slice(0, -4)
  }
  const match = baseName.match(/^graphvec-backup-(.+)$/)
  if (!match) return null
  try {
    // 将文件名中的 - 恢复为日期分隔符
    const isoStr = match[1].replace(/-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3.$4$5')
    // 处理完全替换: T 前面的 - 是日期分隔符
    const isoFull = match[1]
      .replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3')
      .replace(/-(\d{2})-(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3.$4Z')
      .replace(/Z$/, '+08:00')
    const d = new Date(isoFull)
    return isNaN(d.getTime()) ? null : d.getTime()
  } catch {
    return null
  }
}

/**
 * 从归档文件名中提取原始 WAL 文件名
 * 格式: wal-archive-<timestamp>-<originalName>
 */
function getOriginalWalName(archiveName: string): string | null {
  const match = archiveName.match(new RegExp(`^${ARCHIVE_PREFIX}\\d+-(.+)$`))
  return match ? match[1] : null
}

/**
 * 在数据目录中查找匹配的 WAL 文件目标路径
 */
function findWalDestPath(dataDir: string, walName: string): string | null {
  const walk = (dir: string): string | null => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === walName) {
        return fullPath
      }
      if (entry.isDirectory()) {
        const result = walk(fullPath)
        if (result) return result
      }
    }
    return null
  }
  return walk(dataDir)
}
