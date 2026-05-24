"use strict";
/**
 * backup-helpers.ts — 备份辅助工具函数
 *
 * 包含文件收集、验证、目录同步等工具方法，
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
exports.collectFileInfo = collectFileInfo;
exports.verifyFileConsistencyLoose = verifyFileConsistencyLoose;
exports.verifyFileConsistency = verifyFileConsistency;
exports.fsyncDirectory = fsyncDirectory;
exports.calculateDirectorySize = calculateDirectorySize;
exports.copyNewOrChangedFiles = copyNewOrChangedFiles;
exports.writeMarkerFile = writeMarkerFile;
exports.copyDataDirectory = copyDataDirectory;
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const path = __importStar(require("path"));
/** WAL 文件名匹配模式 */
const WAL_GLOB_PATTERN = /^wal-.+\.bin$/;
/**
 * 收集目录下所有文件信息（相对路径 + 大小 + mtime）
 * 用于备份后的校验对比
 */
function collectFileInfo(dir) {
    const files = [];
    const walk = (currentDir, relativePrefix) => {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
            if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    files.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
                }
                catch {
                    // 跳过无法访问的文件
                }
            }
            else if (entry.isDirectory()) {
                walk(fullPath, relativePath);
            }
        }
    };
    walk(dir, '');
    return files;
}
/**
 * 验证源与目标文件的一致性（宽松模式 — 用于增量备份）。
 * 只检查目标中存在的文件是否与源文件大小一致。
 * @returns true 如果所有目标文件在源中都有匹配的大小
 */
function verifyFileConsistencyLoose(sourceFiles, destFiles, logger) {
    const sourceDataFiles = sourceFiles.filter(f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256'));
    const destDataFiles = destFiles.filter(f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256'));
    const sourceMap = new Map();
    for (const f of sourceDataFiles) {
        sourceMap.set(f.relativePath, f.size);
    }
    for (const f of destDataFiles) {
        const sourceSize = sourceMap.get(f.relativePath);
        if (sourceSize === undefined) {
            logger.warn(`Backup verification: extra file in backup — ${f.relativePath}`);
            return false;
        }
        if (sourceSize !== f.size) {
            logger.warn(`Backup verification: size mismatch for ${f.relativePath} — ` +
                `source=${sourceSize}, dest=${f.size}`);
            return false;
        }
    }
    return true;
}
/**
 * 验证源与目标文件的一致性
 * 比较文件数量、文件名集合以及文件大小
 */
function verifyFileConsistency(sourceFiles, destFiles, logger) {
    // 过滤掉 .consistency-marker（只有目标目录有）和校验和文件
    const sourceDataFiles = sourceFiles.filter(f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256'));
    const destDataFiles = destFiles.filter(f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256'));
    if (sourceDataFiles.length !== destDataFiles.length) {
        logger.warn(`Backup verification: file count mismatch — source=${sourceDataFiles.length}, dest=${destDataFiles.length}`);
        return false;
    }
    // 构建源文件映射：relativePath → size
    const sourceMap = new Map();
    for (const f of sourceDataFiles) {
        sourceMap.set(f.relativePath, f.size);
    }
    for (const f of destDataFiles) {
        const sourceSize = sourceMap.get(f.relativePath);
        if (sourceSize === undefined) {
            logger.warn(`Backup verification: extra file in backup — ${f.relativePath}`);
            return false;
        }
        if (sourceSize !== f.size) {
            logger.warn(`Backup verification: size mismatch for ${f.relativePath} — ` +
                `source=${sourceSize}, dest=${f.size}`);
            return false;
        }
    }
    return true;
}
/**
 * 确保目录下的所有文件都已 fsync
 */
function fsyncDirectory(dir) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                const fullPath = path.join(dir, entry.name);
                try {
                    const fd = fs.openSync(fullPath, 'r');
                    fs.fsyncSync(fd);
                    fs.closeSync(fd);
                }
                catch {
                    // 单个文件 fsync 失败不阻止整体流程
                }
            }
            else if (entry.isDirectory()) {
                fsyncDirectory(path.join(dir, entry.name));
            }
        }
    }
    catch {
        // 目录 fsync 失败不阻止整体流程
    }
}
/**
 * 计算目录下所有文件的字节数
 */
function calculateDirectorySize(dir) {
    let sizeBytes = 0;
    const walkDir = (currentDir) => {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isFile()) {
                sizeBytes += fs.statSync(fullPath).size;
            }
            else if (entry.isDirectory()) {
                walkDir(fullPath);
            }
        }
    };
    walkDir(dir);
    return sizeBytes;
}
/**
 * 复制新增或修改过的非 WAL 数据文件。
 * 对比当前数据目录和 base 备份，只复制 base 备份中不存在或 mtime 更新的文件。
 * @returns 复制的文件数量
 */
function copyNewOrChangedFiles(srcDir, dstDir, baseBakDir) {
    let count = 0;
    const walk = (currentDir, relativePrefix) => {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullSrcPath = path.join(currentDir, entry.name);
            const relativePath = relativePrefix
                ? path.join(relativePrefix, entry.name)
                : entry.name;
            if (entry.isFile()) {
                // 跳过 WAL 文件（单独处理）和元数据文件
                if (WAL_GLOB_PATTERN.test(entry.name)) {
                    continue;
                }
                const basePath = path.join(baseBakDir, relativePath);
                const dstFullPath = path.join(dstDir, relativePath);
                const srcStat = fs.statSync(fullSrcPath);
                let needsCopy = false;
                if (!fs.existsSync(basePath)) {
                    // 在 base 备份中不存在 → 新增文件
                    needsCopy = true;
                }
                else {
                    // 在 base 备份中存在 → 比较 mtime
                    const baseStat = fs.statSync(basePath);
                    if (srcStat.mtimeMs > baseStat.mtimeMs + 1) {
                        needsCopy = true;
                    }
                }
                if (needsCopy) {
                    fs.mkdirSync(path.dirname(dstFullPath), { recursive: true });
                    fs.copyFileSync(fullSrcPath, dstFullPath);
                    count++;
                }
            }
            else if (entry.isDirectory()) {
                walk(fullSrcPath, relativePath);
            }
        }
    };
    walk(srcDir, '');
    return count;
}
/**
 * 写入 JSON 一致性标记文件并 fsync
 */
function writeMarkerFile(destPath, marker) {
    fs.writeFileSync(path.join(destPath, '.consistency-marker'), JSON.stringify(marker, null, 2));
    const markerPath = path.join(destPath, '.consistency-marker');
    try {
        const fd = fs.openSync(markerPath, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
    }
    catch {
        // fsync 失败不阻止流程
    }
}
/**
 * 创建备份目标目录并复制整个数据目录
 * @returns 复制的文件数量
 */
async function copyDataDirectory(dataDir, destPath) {
    await fs_1.promises.cp(dataDir, destPath, { recursive: true });
    fsyncDirectory(destPath);
}
//# sourceMappingURL=backup-helpers.js.map