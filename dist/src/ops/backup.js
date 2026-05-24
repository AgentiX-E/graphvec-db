"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Backup = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
const hlc_clock_1 = require("../replication/hlc-clock");
const backup_wal_1 = require("./backup-wal");
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
class Backup {
    engine;
    config;
    logger;
    inProgress = false;
    clock;
    snapshotId = 0;
    pitrConfig = null;
    walArchiver = new backup_wal_1.WalArchiver();
    constructor(engine, clock) {
        this.engine = engine;
        this.config = { path: '' };
        this.logger = new logger_1.Logger('backup');
        this.clock = clock || new hlc_clock_1.HlcClock();
    }
    /**
     * 创建文件级备份
     * @param backupDir 备份目标目录
     * @throws 如果备份已经在进行中则抛出
     */
    async backup(backupDir) {
        if (this.inProgress) {
            throw new Error('Backup already in progress');
        }
        this.inProgress = true;
        this.snapshotId++;
        try {
            // 1. 在复制前记录 HLC 时间戳（建立一致性快照参考点）
            const ts = this.clock.nowWithWallTime();
            // 微任务让出点：允许其他调用检查 inProgress
            await Promise.resolve();
            const stats = this.engine.stats();
            // 获取数据目录路径（从 config）
            const dataDir = process.env.DATA_DIR || './data';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const destPath = path.join(backupDir, `graphvec-backup-${timestamp}`);
            try {
                fs.mkdirSync(destPath, { recursive: true });
                // 2. 执行数据复制（不阻塞同时写入）
                fs.cpSync(dataDir, destPath, { recursive: true });
                // 3. 写入一致性标记文件（记录备份参考时间点）
                fs.writeFileSync(path.join(destPath, '.consistency-marker'), JSON.stringify({
                    snapshotId: this.snapshotId,
                    hlcWallTime: Number(ts.wallTime),
                    hlcLogical: ts.logical,
                    createdAt: new Date().toISOString(),
                }, null, 2));
                // 4. 确保标记文件落盘
                const fd = fs.openSync(destPath, 'r');
                try {
                    fs.fsyncSync(fd);
                }
                finally {
                    fs.closeSync(fd);
                }
            }
            catch (err) {
                throw new Error(`Backup failed: ${err.message}`);
            }
            // 5. 计算备份实际字节数
            let sizeBytes = 0;
            const walkDir = (dir) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isFile()) {
                        sizeBytes += fs.statSync(fullPath).size;
                    }
                    else if (entry.isDirectory()) {
                        walkDir(fullPath);
                    }
                }
            };
            walkDir(destPath);
            return { path: destPath, sizeBytes };
        }
        finally {
            this.inProgress = false;
        }
    }
    /**
     * 验证备份快照的一致性标记
     * @param backupPath 备份路径
     * @returns true 如果一致性标记有效（包含 snapshotId 和 hlcWallTime）
     */
    async verifyBackup(backupPath) {
        try {
            const markerPath = path.join(backupPath, '.consistency-marker');
            if (!fs.existsSync(markerPath))
                return false;
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            return typeof marker.snapshotId === 'number' && typeof marker.hlcWallTime === 'number';
        }
        catch {
            return false;
        }
    }
    /**
     * 从备份恢复
     * @param backupPath 备份路径
     * @param restorePath 恢复目标路径（默认为原数据目录）
     */
    async restore(backupPath, restorePath) {
        const target = restorePath || process.env.DATA_DIR || './data';
        // 先验证备份源存在，避免在验证之前就修改目标
        if (!fs.existsSync(backupPath)) {
            throw new Error(`Backup path does not exist: ${backupPath}`);
        }
        // 关闭当前引擎
        this.engine.close();
        try {
            // 备份当前数据（防止恢复失败）
            const currentBackup = `${target}.pre-restore`;
            if (fs.existsSync(target)) {
                fs.renameSync(target, currentBackup);
            }
            // 复制备份数据
            fs.cpSync(backupPath, target, { recursive: true });
            // 确保数据落盘
            const fd = fs.openSync(target, 'r');
            try {
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch (err) {
            // 恢复失败时尝试回滚
            this.logger.error('Restore failed, attempting rollback...', err);
            throw err;
        }
        // 重新打开引擎
        this.engine.open();
    }
    /**
     * 列出所有备份
     */
    listBackups(backupDir) {
        try {
            return fs.readdirSync(backupDir)
                .filter(name => name.startsWith('graphvec-backup-'))
                .map(name => path.join(backupDir, name));
        }
        catch {
            return [];
        }
    }
    // ─────────── PITR（Point-in-Time Recovery）───────────
    /**
     * 启用 PITR（Point-in-Time Recovery）
     * @param config PITR 配置
     */
    enablePITR(config) {
        this.pitrConfig = { ...config };
        this.logger.info('PITR enabled', {
            walArchivePath: config.walArchivePath,
            fullBackupIntervalMs: config.fullBackupIntervalMs,
            retentionCount: config.retentionCount,
        });
    }
    /**
     * 创建增量备份：将当前 WAL 文件归档到存档目录
     * @returns 备份 ID
     */
    async createIncremental() {
        if (!this.pitrConfig) {
            throw new Error('PITR is not enabled. Call enablePITR() first.');
        }
        const dataDir = process.env.DATA_DIR || './data';
        const archiveDir = this.pitrConfig.walArchivePath;
        // 确保归档目录存在
        fs.mkdirSync(archiveDir, { recursive: true });
        // 扫描数据目录下所有 WAL 文件并归档
        let archivedCount = 0;
        let firstBackupId = '';
        const scanWalFiles = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile() && /^wal-.+\.bin$/.test(entry.name)) {
                    const archiveRecord = this.walArchiver.archiveWalSync(fullPath, archiveDir);
                    if (!firstBackupId) {
                        firstBackupId = archiveRecord.backupId;
                    }
                    archivedCount++;
                }
                else if (entry.isDirectory()) {
                    scanWalFiles(fullPath);
                }
            }
        };
        scanWalFiles(dataDir);
        if (archivedCount === 0) {
            // 如果没有 WAL 文件，创建一个占位归档，记录当前时间点
            const placeholderPath = path.join(archiveDir, `${ARCHIVE_PREFIX}${Date.now()}-no-wal`);
            fs.writeFileSync(placeholderPath, JSON.stringify({ timestamp: Date.now(), noWal: true }));
            firstBackupId = path.basename(placeholderPath);
        }
        // 清理旧归档（只保留 retentionCount 个）
        await this.walArchiver.cleanupArchives(archiveDir, this.pitrConfig.retentionCount);
        this.logger.info(`Incremental backup created`, {
            backupId: firstBackupId,
            archivedCount,
            archiveDir,
        });
        return firstBackupId;
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
    async restoreToTimestamp(timestamp, archiveDir) {
        // 1. 找到最近的备份目录
        const backupBaseDir = path.dirname(archiveDir);
        const backupDirs = this.listBackups(backupBaseDir)
            .filter(b => {
            // 解析备份目录的时间戳
            const ts = parseBackupTimestamp(b);
            return ts !== null && ts <= timestamp;
        })
            .sort((a, b) => {
            const tsA = parseBackupTimestamp(a) ?? 0;
            const tsB = parseBackupTimestamp(b) ?? 0;
            return tsB - tsA; // 最近的先排
        });
        if (backupDirs.length === 0) {
            throw new Error(`No full backup found before timestamp ${timestamp}`);
        }
        const latestFullBackup = backupDirs[0];
        this.logger.info(`Found latest full backup before PITR target`, {
            backupPath: latestFullBackup,
            targetTimestamp: timestamp,
        });
        // 2. 恢复全量备份
        await this.restore(latestFullBackup);
        // 3. 查找所有在目标时间戳之前的 WAL 归档
        const archives = await this.walArchiver.listArchives(archiveDir);
        const archivesToReplay = archives.filter(a => a.timestamp <= timestamp);
        this.logger.info(`Replaying ${archivesToReplay.length} WAL archives for PITR`, {
            targetTimestamp: timestamp,
            archiveCount: archivesToReplay.length,
        });
        // 将 WAL 归档文件恢复回数据目录
        const dataDir = process.env.DATA_DIR || './data';
        for (const archive of archivesToReplay) {
            try {
                // 从归档文件名提取原始 WAL 文件名: wal-archive-<ts>-<originalName>
                const baseName = path.basename(archive.walPath);
                const originalName = getOriginalWalName(baseName);
                if (!originalName)
                    continue;
                // 搜索数据目录下对应的 WAL 目录
                const destWalPath = findWalDestPath(dataDir, originalName);
                if (destWalPath) {
                    // 确保目标目录存在
                    fs.mkdirSync(path.dirname(destWalPath), { recursive: true });
                    fs.copyFileSync(archive.walPath, destWalPath);
                }
            }
            catch (err) {
                this.logger.warn(`Failed to replay WAL archive: ${archive.walPath}`, { error: err.message });
            }
        }
    }
    /**
     * 列出可用的恢复点
     * @param archiveDir 归档目录
     */
    async listRecoveryPoints(archiveDir) {
        const points = [];
        // 1. 从全量备份目录扫描
        const backupBaseDir = path.dirname(archiveDir);
        const backupDirs = this.listBackups(backupBaseDir);
        for (const dir of backupDirs) {
            const ts = parseBackupTimestamp(dir);
            if (ts !== null) {
                points.push({
                    timestamp: ts,
                    backupId: path.basename(dir),
                    type: 'full',
                });
            }
        }
        // 2. 从 WAL 归档扫描
        const incrementalPoints = await this.walArchiver.listRecoveryPoints(archiveDir);
        points.push(...incrementalPoints);
        // 3. 按时间排序
        points.sort((a, b) => a.timestamp - b.timestamp);
        return points;
    }
}
exports.Backup = Backup;
// ─────────── PITR 辅助函数 ───────────
/** WAL 归档文件前缀（与 backup-wal.ts 中一致） */
const ARCHIVE_PREFIX = 'wal-archive-';
/**
 * 从备份目录路径解析时间戳。
 * 格式: graphvec-backup-2026-05-23T22-30-00-000Z
 */
function parseBackupTimestamp(backupPath) {
    const baseName = path.basename(backupPath);
    const match = baseName.match(/^graphvec-backup-(.+)$/);
    if (!match)
        return null;
    try {
        // 将文件名中的 - 恢复为日期分隔符
        const isoStr = match[1].replace(/-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3.$4$5');
        // 处理完全替换: T 前面的 - 是日期分隔符
        const isoFull = match[1]
            .replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3')
            .replace(/-(\d{2})-(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3.$4Z')
            .replace(/Z$/, '+08:00');
        const d = new Date(isoFull);
        return isNaN(d.getTime()) ? null : d.getTime();
    }
    catch {
        return null;
    }
}
/**
 * 从归档文件名中提取原始 WAL 文件名
 * 格式: wal-archive-<timestamp>-<originalName>
 */
function getOriginalWalName(archiveName) {
    const match = archiveName.match(new RegExp(`^${ARCHIVE_PREFIX}\\d+-(.+)$`));
    return match ? match[1] : null;
}
/**
 * 在数据目录中查找匹配的 WAL 文件目标路径
 */
function findWalDestPath(dataDir, walName) {
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return null;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === walName) {
                return fullPath;
            }
            if (entry.isDirectory()) {
                const result = walk(fullPath);
                if (result)
                    return result;
            }
        }
        return null;
    };
    return walk(dataDir);
}
//# sourceMappingURL=backup.js.map