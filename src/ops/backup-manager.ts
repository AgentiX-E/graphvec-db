/**
 * backup-manager.ts — 增量备份/恢复管理器
 *
 * 基于 WAL segment 序列号（seq）的增量 checkpoint 备份系统：
 *   1. fullBackup() — 全量备份（拷贝完整数据目录）
 *   2. incrementalBackup() — 增量备份（只拷贝上次全量后变更的 segment）
 *   3. listSnapshots() — 列出所有可用快照（含 metadata）
 *   4. restore(snapshotId) — 从指定快照恢复
 *
 * 使用 metadata.json 跟踪备份链：
 *   {
 *     "type": "full" | "incremental",
 *     "snapshotId": "snap-xxxx",
 *     "timestamp": 1700000000000,
 *     "walSeqMax": 42,          // 备份时 WAL 的最大 seq
 *     "prevSnapshotId": null,   // 增量备份时指向前一个快照
 *     "fileCount": 100,
 *     "sizeBytes": 1048576
 *   }
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { Logger } from './logger'
import { collectFileInfo, fsyncDirectory } from './backup-helpers'

// ── Types ─────────────────────────────────────────────────

/** 快照类型 */
export type SnapshotType = 'full' | 'incremental'

/** 快照元数据 */
export interface SnapshotMetadata {
  snapshotId: string
  type: SnapshotType
  timestamp: number
  walSeqMax: number
  prevSnapshotId: string | null
  nextSnapshotIds: string[]
  fileCount: number
  sizeBytes: number
  dataDir: string
}

/** 备份管理器配置 */
export interface BackupManagerConfig {
  /** 备份存放目录 */
  backupDir: string
  /** 数据目录路径 */
  dataDir: string
  /** 全量备份间隔（毫秒），默认 86400000 (24h) */
  fullIntervalMs?: number
  /** 增量备份间隔（毫秒），默认 3600000 (1h) */
  incrementalIntervalMs?: number
  /** 最大保留快照数（全量+增量），默认 7 */
  maxSnapshots?: number
}

/** 备份结果 */
export interface BackupResult {
  snapshotId: string
  type: SnapshotType
  timestamp: number
  path: string
  fileCount: number
  sizeBytes: number
}

/** 快照摘要（用于列表展示） */
export interface SnapshotSummary {
  snapshotId: string
  type: SnapshotType
  timestamp: number
  walSeqMax: number
  prevSnapshotId: string | null
  chainLength: number
  sizeBytes: number
}

// ── Constants ─────────────────────────────────────────────

const METADATA_FILE = 'metadata.json'
const SNAPSHOT_DIR_PREFIX = 'snap-'

// ── IncrementalBackupManager ──────────────────────────────

/**
 * IncrementalBackupManager — 增量备份管理器
 *
 * 备份链逻辑：
 *   1. 第一次备份总是全量备份
 *   2. 之后的备份是增量备份（只变更 segment 文件）
 *   3. 恢复时从最近的全量备份开始，按顺序应用增量
 *   4. 过期快照自动清理（保留 maxSnapshots 个）
 */
export class IncrementalBackupManager {
  private _config: BackupManagerConfig
  private _logger: Logger
  private _running: boolean = false
  private _lastFullTime: number = 0
  private _lastIncrementalTime: number = 0
  private _metadataCache: Map<string, SnapshotMetadata> = new Map()

  constructor(config: BackupManagerConfig) {
    this._config = {
      ...config,
      fullIntervalMs: config.fullIntervalMs ?? 86400000,
      incrementalIntervalMs: config.incrementalIntervalMs ?? 3600000,
      maxSnapshots: config.maxSnapshots ?? 7,
    }
    this._logger = new Logger('backup-manager')
    this._ensureBackupDir()
  }

  // ── Public API ──────────────────────────────────────────

  /** 获取当前 WAL 最大 seq（模拟 — 读取数据目录中的 segment 文件） */
  getCurrentWalSeq(): number {
    return this._scanWalSegmentSeq()
  }

  /**
   * 执行全量备份
   */
  async fullBackup(): Promise<BackupResult> {
    if (this._running) {
      throw new Error('Backup already in progress')
    }
    this._running = true
    try {
      const walSeq = this.getCurrentWalSeq()
      const snapshotId = this._generateSnapshotId()
      const destDir = path.join(this._config.backupDir, SNAPSHOT_DIR_PREFIX + snapshotId)

      // 创建目录
      fs.mkdirSync(destDir, { recursive: true })

      // 拷贝整个数据目录
      const fileCount = this._copyAllFiles(this._config.dataDir, destDir)

      // 计算大小
      const sizeBytes = this._calculateDirSize(destDir)

      // 写入 metadata
      const metadata: SnapshotMetadata = {
        snapshotId,
        type: 'full',
        timestamp: Date.now(),
        walSeqMax: walSeq,
        prevSnapshotId: null,
        nextSnapshotIds: [],
        fileCount,
        sizeBytes,
        dataDir: this._config.dataDir,
      }
      this._writeMetadata(destDir, metadata)
      this._metadataCache.set(snapshotId, metadata)

      // 更新前一个快照的 nextSnapshotIds（如果有增量链）
      this._updatePrevSnapshotLinks(snapshotId)

      // 清理过期快照
      this._cleanupOldSnapshots()

      this._lastFullTime = Date.now()
      this._logger.info(`Full backup completed: ${snapshotId}, files=${fileCount}, size=${sizeBytes}`)

      return { snapshotId, type: 'full', timestamp: metadata.timestamp, path: destDir, fileCount, sizeBytes }
    } finally {
      this._running = false
    }
  }

  /**
   * 执行增量备份
   * 只拷贝从上一个全量/增量备份以来变更的 WAL segment 文件。
   * 如果没有前置快照，自动做全量。
   */
  async incrementalBackup(): Promise<BackupResult> {
    if (this._running) {
      throw new Error('Backup already in progress')
    }

    // 找到最新的快照作为基线
    const latestSnapshot = this._findLatestSnapshot()
    if (!latestSnapshot) {
      this._logger.info('No prior snapshot found, performing full backup instead')
      return this.fullBackup()
    }

    this._running = true
    try {
      const walSeq = this.getCurrentWalSeq()
      const snapshotId = this._generateSnapshotId()
      const destDir = path.join(this._config.backupDir, SNAPSHOT_DIR_PREFIX + snapshotId)

      // 创建目录
      fs.mkdirSync(destDir, { recursive: true })

      // 只拷贝变更的 segment 文件
      const changedFiles = this._copyChangedSegmentFiles(
        this._config.dataDir,
        destDir,
        latestSnapshot.walSeqMax,
      )

      // 拷贝 metadata 和 marker 文件（它们不含实际数据，但用于恢复链追踪）
      this._copyNonWalFiles(this._config.dataDir, destDir)

      const fileCount = changedFiles.nonWalCount + changedFiles.walCount
      const sizeBytes = this._calculateDirSize(destDir)

      // 写入 metadata
      const metadata: SnapshotMetadata = {
        snapshotId,
        type: 'incremental',
        timestamp: Date.now(),
        walSeqMax: walSeq,
        prevSnapshotId: latestSnapshot.snapshotId,
        nextSnapshotIds: [],
        fileCount,
        sizeBytes,
        dataDir: this._config.dataDir,
      }
      this._writeMetadata(destDir, metadata)
      this._metadataCache.set(snapshotId, metadata)

      // 更新前一个快照的 nextSnapshotIds
      this._updatePrevSnapshotLinks(snapshotId)

      // 清理过期快照
      this._cleanupOldSnapshots()

      this._lastIncrementalTime = Date.now()
      this._logger.info(
        `Incremental backup completed: ${snapshotId}, ` +
        `walFiles=${changedFiles.walCount}, nonWalFiles=${changedFiles.nonWalCount}, ` +
        `size=${sizeBytes}`,
      )

      return { snapshotId, type: 'incremental', timestamp: metadata.timestamp, path: destDir, fileCount, sizeBytes }
    } finally {
      this._running = false
    }
  }

  /**
   * 列出所有可用快照
   */
  async listSnapshots(): Promise<SnapshotSummary[]> {
    this._reloadMetadata()
    const snapshots = Array.from(this._metadataCache.values())

    // 构建链长度
    const chainMap = new Map<string, number>()
    for (const snap of snapshots) {
      chainMap.set(snap.snapshotId, this._computeChainLength(snap.snapshotId))
    }

    return snapshots
      .map(snap => ({
        snapshotId: snap.snapshotId,
        type: snap.type,
        timestamp: snap.timestamp,
        walSeqMax: snap.walSeqMax,
        prevSnapshotId: snap.prevSnapshotId,
        chainLength: chainMap.get(snap.snapshotId) ?? 1,
        sizeBytes: snap.sizeBytes,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * 从指定快照恢复
   * 如果是增量快照，先找最近的全量祖先，然后按链顺序恢复
   */
  async restore(snapshotId: string): Promise<void> {
    const targetSnap = this._getMetadata(snapshotId)
    if (!targetSnap) {
      throw new Error(`Snapshot not found: ${snapshotId}`)
    }

    // 构建恢复链：从最近的全量祖先开始，到目标快照结束
    const chain = this._buildRestoreChain(snapshotId)
    if (chain.length === 0) {
      throw new Error(`Cannot build restore chain for snapshot: ${snapshotId}`)
    }

    const dataDir = this._config.dataDir
    this._logger.info(`Restore chain: ${chain.map(s => `${s.snapshotId}(${s.type})`).join(' → ')}`)

    // 清空数据目录
    this._clearDir(dataDir)

    // 全量恢复：拷贝第一个快照的所有文件
    const fullSnap = chain[0]
    this._logger.info(`Restoring full snapshot: ${fullSnap.snapshotId}`)
    this._copyAllFiles(this._snapshotDir(fullSnap.snapshotId), dataDir)

    // 增量应用：按顺序拷贝后续增量快照中的文件
    for (let i = 1; i < chain.length; i++) {
      const incSnap = chain[i]
      this._logger.info(`Applying incremental snapshot: ${incSnap.snapshotId}`)
      this._copyAllFiles(this._snapshotDir(incSnap.snapshotId), dataDir, true /* overwrite */)
    }

    // fsync 确保数据落盘
    fsyncDirectory(dataDir)
    this._logger.info(`Restore completed from snapshot: ${snapshotId}`)
  }

  /**
   * 检查是否需要全量备份
   */
  shouldTakeFullBackup(): boolean {
    return (Date.now() - this._lastFullTime) >= this._config.fullIntervalMs!
  }

  /**
   * 检查是否需要增量备份
   */
  shouldTakeIncrementalBackup(): boolean {
    return (Date.now() - this._lastIncrementalTime) >= this._config.incrementalIntervalMs!
  }

  /**
   * 获取配置
   */
  get config(): BackupManagerConfig {
    return { ...this._config }
  }

  // ── Private helpers ───────────────────────────────────

  private _ensureBackupDir(): void {
    fs.mkdirSync(this._config.backupDir, { recursive: true })
  }

  private _generateSnapshotId(): string {
    const ts = Date.now().toString(36)
    const rand = crypto.randomBytes(4).toString('hex')
    return `${ts}-${rand}`
  }

  private _snapshotDir(snapshotId: string): string {
    return path.join(this._config.backupDir, SNAPSHOT_DIR_PREFIX + snapshotId)
  }

  /**
   * 扫描数据目录中的 WAL segment 文件，返回最大 seq
   */
  private _scanWalSegmentSeq(): number {
    let maxSeq = 0
    const dataDir = this._config.dataDir
    try {
      const entries = fs.readdirSync(dataDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && /^\d+\.log$/.test(entry.name)) {
          const seq = parseInt(entry.name.split('.')[0], 10)
          if (seq > maxSeq) maxSeq = seq
        }
      }
    } catch {
      // 目录不存在返回 0
    }
    return maxSeq
  }

  /**
   * 拷贝所有文件（全量）
   */
  private _copyAllFiles(srcDir: string, destDir: string, overwrite: boolean = false): number {
    let count = 0
    try {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name)
        const dstPath = path.join(destDir, entry.name)
        if (entry.isFile()) {
          if (!overwrite && fs.existsSync(dstPath)) continue
          const dstParent = path.dirname(dstPath)
          fs.mkdirSync(dstParent, { recursive: true })
          fs.copyFileSync(srcPath, dstPath)
          count++
        }
      }
    } catch {
      // 忽略单个文件拷贝失败
    }
    return count
  }

  /**
   * 只拷贝 WAL segment seq 大于指定值的 segment 文件
   */
  private _copyChangedSegmentFiles(
    srcDir: string,
    destDir: string,
    minWalSeq: number,
  ): { walCount: number; nonWalCount: number } {
    let walCount = 0
    let nonWalCount = 0

    try {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name)
        const dstPath = path.join(destDir, entry.name)

        if (entry.isFile()) {
          // 检查是否是 WAL segment 文件（数字名 .log）
          const walMatch = entry.name.match(/^(\d+)\.log$/)
          if (walMatch) {
            const seq = parseInt(walMatch[1], 10)
            if (seq <= minWalSeq) continue // 跳过未变更的
          }

          fs.mkdirSync(path.dirname(dstPath), { recursive: true })
          fs.copyFileSync(srcPath, dstPath)

          if (walMatch) {
            walCount++
          } else {
            nonWalCount++
          }
        }
      }
    } catch {
      // 忽略
    }

    return { walCount, nonWalCount }
  }

  /**
   * 拷贝非 WAL 文件
   */
  private _copyNonWalFiles(srcDir: string, destDir: string): number {
    let count = 0
    try {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && !entry.name.startsWith('wal-') && !/^\d+\.log$/.test(entry.name)) {
          const srcPath = path.join(srcDir, entry.name)
          const dstPath = path.join(destDir, entry.name)
          fs.copyFileSync(srcPath, dstPath)
          count++
        }
      }
    } catch {
      // 忽略
    }
    return count
  }

  /**
   * 写入 metadata.json
   */
  private _writeMetadata(snapDir: string, metadata: SnapshotMetadata): void {
    fs.writeFileSync(
      path.join(snapDir, METADATA_FILE),
      JSON.stringify(metadata, null, 2),
    )
  }

  /**
   * 读取 metadata.json
   */
  private _readMetadata(snapDir: string): SnapshotMetadata | null {
    try {
      const raw = fs.readFileSync(path.join(snapDir, METADATA_FILE), 'utf-8')
      return JSON.parse(raw) as SnapshotMetadata
    } catch {
      return null
    }
  }

  /**
   * 获取缓存的 metadata（优先缓存，未命中则读文件）
   */
  private _getMetadata(snapshotId: string): SnapshotMetadata | null {
    const cached = this._metadataCache.get(snapshotId)
    if (cached) return cached

    const snapDir = this._snapshotDir(snapshotId)
    if (!fs.existsSync(snapDir)) return null

    const meta = this._readMetadata(snapDir)
    if (meta) {
      this._metadataCache.set(snapshotId, meta)
    }
    return meta
  }

  /**
   * 重新加载所有快照的 metadata
   */
  private _reloadMetadata(): void {
    this._metadataCache.clear()
    try {
      const entries = fs.readdirSync(this._config.backupDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(SNAPSHOT_DIR_PREFIX)) {
          const snapshotId = entry.name.slice(SNAPSHOT_DIR_PREFIX.length)
          const meta = this._readMetadata(path.join(this._config.backupDir, entry.name))
          if (meta) {
            this._metadataCache.set(snapshotId, meta)
          }
        }
      }
    } catch {
      // 备份目录不存在时忽略
    }
  }

  /**
   * 更新前一个快照的 nextSnapshotIds
   */
  private _updatePrevSnapshotLinks(newSnapshotId: string): void {
    const newMeta = this._metadataCache.get(newSnapshotId)
    if (!newMeta || !newMeta.prevSnapshotId) return

    const prevMeta = this._metadataCache.get(newMeta.prevSnapshotId)
    if (prevMeta) {
      if (!prevMeta.nextSnapshotIds.includes(newSnapshotId)) {
        prevMeta.nextSnapshotIds.push(newSnapshotId)
        // 写回
        const prevDir = this._snapshotDir(prevMeta.snapshotId)
        this._writeMetadata(prevDir, prevMeta)
      }
    }
  }

  /**
   * 计算快照链长度
   */
  private _computeChainLength(snapshotId: string): number {
    let length = 1
    let current = this._getMetadata(snapshotId)
    while (current?.prevSnapshotId) {
      length++
      current = this._getMetadata(current.prevSnapshotId)
    }
    return length
  }

  /**
   * 构建恢复链：从最近的全量祖先开始，到目标快照结束
   */
  private _buildRestoreChain(snapshotId: string): SnapshotMetadata[] {
    // 先收集从根到目标的链路（反向）
    const reverseChain: SnapshotMetadata[] = []
    let current = this._getMetadata(snapshotId)
    while (current) {
      reverseChain.push(current)
      if (current.type === 'full') break
      if (!current.prevSnapshotId) break
      current = this._getMetadata(current.prevSnapshotId)
    }

    // 反转得到正向链
    const chain = reverseChain.reverse()

    // 检查第一个确实是全量
    if (chain.length === 0 || chain[0].type !== 'full') {
      return []
    }

    return chain
  }

  /**
   * 查找最新的快照
   */
  private _findLatestSnapshot(): SnapshotMetadata | null {
    this._reloadMetadata()
    let latest: SnapshotMetadata | null = null
    for (const snap of this._metadataCache.values()) {
      if (!latest || snap.timestamp > latest.timestamp) {
        latest = snap
      }
    }
    return latest
  }

  /**
   * 清理过期快照
   * 保留最新的 maxSnapshots 个，优先保留全量
   */
  private _cleanupOldSnapshots(): void {
    const maxSnapshots = this._config.maxSnapshots!
    this._reloadMetadata()

    const snapshots = Array.from(this._metadataCache.values())
    if (snapshots.length <= maxSnapshots) return

    // 按时间降序排列
    snapshots.sort((a, b) => b.timestamp - a.timestamp)

    const toDelete = snapshots.slice(maxSnapshots) // 删除超出保留数量的
    for (const snap of toDelete) {
      this._deleteSnapshot(snap.snapshotId)
    }
  }

  /**
   * 删除快照
   */
  private _deleteSnapshot(snapshotId: string): void {
    const snapDir = this._snapshotDir(snapshotId)
    try {
      fs.rmSync(snapDir, { recursive: true, force: true })
      this._metadataCache.delete(snapshotId)
      this._logger.info(`Deleted snapshot: ${snapshotId}`)
    } catch (err) {
      this._logger.warn(`Failed to delete snapshot ${snapshotId}: ${err}`)
    }
  }

  /**
   * 计算目录大小
   */
  private _calculateDirSize(dir: string): number {
    let size = 0
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            size += fs.statSync(path.join(dir, entry.name)).size
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return size
  }

  /**
   * 清空数据目录
   */
  private _clearDir(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isFile()) {
          fs.unlinkSync(entryPath)
        }
      }
    } catch { /* ignore */ }
  }
}
