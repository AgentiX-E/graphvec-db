"use strict";
/**
 * backup-wal.ts — WAL LSN 读取工具 & WAL 归档（PITR）
 *
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */
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
exports.WalArchiver = void 0;
exports.readWalLsnSnapshots = readWalLsnSnapshots;
exports.readWalLastIndex = readWalLastIndex;
exports.getTotalLsn = getTotalLsn;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** WAL 文件名匹配模式 */
const WAL_GLOB_PATTERN = /^wal-.+\.bin$/;
/**
 * 读取数据目录下所有 WAL 文件的最后 LSN（日志序列号）。
 * WAL 文件格式：[4 bytes index][4 bytes term][4 bytes data length][data bytes]...
 * 最后一条条目的 index 即为该 WAL 的 LSN。
 */
function readWalLsnSnapshots(dataDir) {
    const fileMap = {};
    const scanDir = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isFile() && WAL_GLOB_PATTERN.test(entry.name)) {
                const fullPath = path.join(dir, entry.name);
                const lsn = readWalLastIndex(fullPath);
                if (lsn > 0) {
                    // 相对于 dataDir 的相对路径作为 key
                    const relPath = path.relative(dataDir, fullPath);
                    fileMap[relPath] = lsn;
                }
            }
            else if (entry.isDirectory()) {
                scanDir(path.join(dir, entry.name));
            }
        }
    };
    scanDir(dataDir);
    // 清理 key 格式（去除前导 ./）
    const result = {};
    for (const [key, value] of Object.entries(fileMap)) {
        const cleanKey = key.startsWith('./') ? key.slice(2) : key;
        result[cleanKey] = value;
    }
    return { files: result };
}
/**
 * 读取单个 WAL 文件的最后一条日志 index。
 * 如果文件不存在或为空则返回 0。
 */
function readWalLastIndex(walPath) {
    try {
        if (!fs.existsSync(walPath))
            return 0;
        const stat = fs.statSync(walPath);
        if (stat.size < 12)
            return 0; // 至少有一个 header
        const fd = fs.openSync(walPath, 'r');
        try {
            let offset = 0;
            let lastIndex = 0;
            while (offset + 12 <= stat.size) {
                const header = Buffer.alloc(12);
                const bytesRead = fs.readSync(fd, header, 0, 12, offset);
                if (bytesRead < 12)
                    break;
                const index = header.readUInt32BE(0);
                const dataLen = header.readUInt32BE(8);
                const totalEntrySize = 12 + dataLen;
                if (offset + totalEntrySize > stat.size)
                    break;
                lastIndex = index;
                offset += totalEntrySize;
            }
            return lastIndex;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return 0;
    }
}
/**
 * 获取所有 WAL 文件的 LSN 之和（用于 metadata 中的单一 LSN 值对比）。
 */
function getTotalLsn(snapshot) {
    let total = 0;
    for (const lsn of Object.values(snapshot.files)) {
        total += lsn;
    }
    return total;
}
/**
 * WAL 归档前缀
 */
const ARCHIVE_PREFIX = 'wal-archive-';
/**
 * WalArchiver — WAL 文件归档工具
 *
 * 将 WAL 文件复制到归档目录并添加时间戳命名，
 * 支持列出归档和按保留数量清理。
 */
class WalArchiver {
    /**
     * 归档指定 WAL 文件到存档目录
     * @param walPath 源 WAL 文件路径
     * @param archiveDir 归档目录
     * @returns 归档记录
     */
    async archiveWal(walPath, archiveDir) {
        return this.archiveWalSync(walPath, archiveDir);
    }
    /**
     * 同步版 archiveWal（用于不需要 async 的扫描场景）
     */
    archiveWalSync(walPath, archiveDir) {
        // 确保归档目录存在
        fs.mkdirSync(archiveDir, { recursive: true });
        const timestamp = Date.now();
        const baseName = path.basename(walPath);
        const archiveName = `${ARCHIVE_PREFIX}${timestamp}-${baseName}`;
        const destPath = path.join(archiveDir, archiveName);
        // 复制文件
        fs.copyFileSync(walPath, destPath);
        // 确保落盘
        try {
            const fd = fs.openSync(destPath, 'r');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        }
        catch {
            // fsync 失败不阻止流程
        }
        return {
            backupId: archiveName,
            timestamp,
            walPath: destPath,
        };
    }
    /**
     * 列出所有 WAL 归档，按时间排序（升序）
     * @param archiveDir 归档目录
     */
    async listArchives(archiveDir) {
        try {
            const entries = fs.readdirSync(archiveDir);
            const archives = [];
            for (const entry of entries) {
                if (!entry.startsWith(ARCHIVE_PREFIX))
                    continue;
                const fullPath = path.join(archiveDir, entry);
                // 从文件名解析 timestamp: wal-archive-<timestamp>-<originalName>
                const tsMatch = entry.match(new RegExp(`^${ARCHIVE_PREFIX}(\\d+)-`));
                if (!tsMatch)
                    continue;
                const timestamp = parseInt(tsMatch[1], 10);
                archives.push({
                    backupId: entry,
                    timestamp,
                    walPath: fullPath,
                });
            }
            // 按时间升序排列
            archives.sort((a, b) => a.timestamp - b.timestamp);
            return archives;
        }
        catch {
            return [];
        }
    }
    /**
     * 清除旧归档，只保留最近的 retentionCount 个
     * @param archiveDir 归档目录
     * @param retentionCount 保留数量
     */
    async cleanupArchives(archiveDir, retentionCount) {
        const archives = await this.listArchives(archiveDir);
        if (archives.length <= retentionCount)
            return;
        // 按时间升序排列，删除最早的
        const toDelete = archives.slice(0, archives.length - retentionCount);
        for (const archive of toDelete) {
            try {
                fs.unlinkSync(archive.walPath);
            }
            catch {
                // 删除失败不阻止整体流程
            }
        }
    }
    /**
     * 从归档目录列出恢复点
     * 每个 WAL 归档代表一个增量恢复点
     * @param archiveDir 归档目录
     */
    async listRecoveryPoints(archiveDir) {
        const archives = await this.listArchives(archiveDir);
        return archives.map(a => ({
            timestamp: a.timestamp,
            backupId: a.backupId,
            type: 'incremental',
        }));
    }
}
exports.WalArchiver = WalArchiver;
//# sourceMappingURL=backup-wal.js.map