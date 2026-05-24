/**
 * backup-checksum.ts — SHA-256 校验和工具
 *
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */
import { Logger } from './logger';
/** 校验和文件扩展名 */
export declare const CHECKSUM_FILE_EXT = ".sha256";
/**
 * 计算文件的 SHA-256 校验和（十六进制字符串）。
 */
export declare function computeChecksum(filePath: string): string;
/**
 * 为备份目录中的每个数据文件生成 .sha256 校验和文件并写入。
 */
export declare function writeChecksumFiles(backupPath: string): void;
/**
 * 验证备份目录的 SHA-256 校验和。
 * @param backupPath 备份路径
 * @returns true 如果所有文件校验和都匹配
 */
export declare function verifyChecksumsSync(backupPath: string, logger?: Logger): boolean;
//# sourceMappingURL=backup-checksum.d.ts.map