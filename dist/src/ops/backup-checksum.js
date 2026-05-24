"use strict";
/**
 * backup-checksum.ts — SHA-256 校验和工具
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
exports.CHECKSUM_FILE_EXT = void 0;
exports.computeChecksum = computeChecksum;
exports.writeChecksumFiles = writeChecksumFiles;
exports.verifyChecksumsSync = verifyChecksumsSync;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
/** 校验和文件扩展名 */
exports.CHECKSUM_FILE_EXT = '.sha256';
/**
 * 计算文件的 SHA-256 校验和（十六进制字符串）。
 */
function computeChecksum(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}
/**
 * 为备份目录中的每个数据文件生成 .sha256 校验和文件并写入。
 */
function writeChecksumFiles(backupPath) {
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile()) {
                // 跳过后生成的元数据文件
                if (entry.name === '.consistency-marker' ||
                    entry.name.endsWith(exports.CHECKSUM_FILE_EXT)) {
                    continue;
                }
                const hash = computeChecksum(fullPath);
                const shaFile = fullPath + exports.CHECKSUM_FILE_EXT;
                fs.writeFileSync(shaFile, hash + '\n');
                try {
                    const fd = fs.openSync(shaFile, 'r+');
                    fs.fsyncSync(fd);
                    fs.closeSync(fd);
                }
                catch {
                    // fsync 失败不阻止整体流程
                }
            }
            else if (entry.isDirectory()) {
                walk(fullPath);
            }
        }
    };
    walk(backupPath);
}
/**
 * 验证备份目录的 SHA-256 校验和。
 * @param backupPath 备份路径
 * @returns true 如果所有文件校验和都匹配
 */
function verifyChecksumsSync(backupPath, logger) {
    let allValid = true;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            allValid = false;
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith(exports.CHECKSUM_FILE_EXT)) {
                // 找到 .sha256 文件，验证原始文件
                const originalFile = fullPath.slice(0, -exports.CHECKSUM_FILE_EXT.length);
                if (!fs.existsSync(originalFile)) {
                    logger?.warn(`Checksum file exists but original missing: ${originalFile}`);
                    allValid = false;
                    continue;
                }
                try {
                    const expectedHash = fs.readFileSync(fullPath, 'utf-8').trim().split('\n')[0];
                    const actualHash = computeChecksum(originalFile);
                    if (expectedHash !== actualHash) {
                        logger?.warn(`Checksum mismatch for ${originalFile}: expected=${expectedHash}, actual=${actualHash}`);
                        allValid = false;
                    }
                }
                catch {
                    logger?.warn(`Failed to verify checksum for: ${originalFile}`);
                    allValid = false;
                }
            }
            else if (entry.isDirectory()) {
                walk(fullPath);
            }
        }
    };
    walk(backupPath);
    return allValid;
}
//# sourceMappingURL=backup-checksum.js.map