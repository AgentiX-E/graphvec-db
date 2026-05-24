/**
 * backup-helpers.ts — 备份辅助工具函数
 *
 * 包含文件收集、验证、目录同步等工具方法，
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */
import { Logger } from './logger';
/**
 * 收集目录下所有文件信息（相对路径 + 大小 + mtime）
 * 用于备份后的校验对比
 */
export declare function collectFileInfo(dir: string): Array<{
    relativePath: string;
    size: number;
    mtimeMs: number;
}>;
/**
 * 验证源与目标文件的一致性（宽松模式 — 用于增量备份）。
 * 只检查目标中存在的文件是否与源文件大小一致。
 * @returns true 如果所有目标文件在源中都有匹配的大小
 */
export declare function verifyFileConsistencyLoose(sourceFiles: Array<{
    relativePath: string;
    size: number;
}>, destFiles: Array<{
    relativePath: string;
    size: number;
}>, logger: Logger): boolean;
/**
 * 验证源与目标文件的一致性
 * 比较文件数量、文件名集合以及文件大小
 */
export declare function verifyFileConsistency(sourceFiles: Array<{
    relativePath: string;
    size: number;
}>, destFiles: Array<{
    relativePath: string;
    size: number;
}>, logger: Logger): boolean;
/**
 * 确保目录下的所有文件都已 fsync
 */
export declare function fsyncDirectory(dir: string): void;
/**
 * 计算目录下所有文件的字节数
 */
export declare function calculateDirectorySize(dir: string): number;
/**
 * 复制新增或修改过的非 WAL 数据文件。
 * 对比当前数据目录和 base 备份，只复制 base 备份中不存在或 mtime 更新的文件。
 * @returns 复制的文件数量
 */
export declare function copyNewOrChangedFiles(srcDir: string, dstDir: string, baseBakDir: string): number;
/**
 * 写入 JSON 一致性标记文件并 fsync
 */
export declare function writeMarkerFile(destPath: string, marker: Record<string, unknown>): void;
/**
 * 创建备份目标目录并复制整个数据目录
 * @returns 复制的文件数量
 */
export declare function copyDataDirectory(dataDir: string, destPath: string): Promise<void>;
//# sourceMappingURL=backup-helpers.d.ts.map