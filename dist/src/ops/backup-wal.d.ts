/**
 * backup-wal.ts — WAL LSN 读取工具 & WAL 归档（PITR）
 *
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */
import type { WalLsnSnapshot, RecoveryPoint } from './backup-types';
/**
 * 读取数据目录下所有 WAL 文件的最后 LSN（日志序列号）。
 * WAL 文件格式：[4 bytes index][4 bytes term][4 bytes data length][data bytes]...
 * 最后一条条目的 index 即为该 WAL 的 LSN。
 */
export declare function readWalLsnSnapshots(dataDir: string): WalLsnSnapshot;
/**
 * 读取单个 WAL 文件的最后一条日志 index。
 * 如果文件不存在或为空则返回 0。
 */
export declare function readWalLastIndex(walPath: string): number;
/**
 * 获取所有 WAL 文件的 LSN 之和（用于 metadata 中的单一 LSN 值对比）。
 */
export declare function getTotalLsn(snapshot: WalLsnSnapshot): number;
/**
 * WAL 归档记录
 */
export interface WalArchive {
    /** 备份 ID */
    backupId: string;
    /** 归档时间戳（毫秒） */
    timestamp: number;
    /** 归档后的 WAL 文件路径 */
    walPath: string;
}
/**
 * WalArchiver — WAL 文件归档工具
 *
 * 将 WAL 文件复制到归档目录并添加时间戳命名，
 * 支持列出归档和按保留数量清理。
 */
export declare class WalArchiver {
    /**
     * 归档指定 WAL 文件到存档目录
     * @param walPath 源 WAL 文件路径
     * @param archiveDir 归档目录
     * @returns 归档记录
     */
    archiveWal(walPath: string, archiveDir: string): Promise<WalArchive>;
    /**
     * 同步版 archiveWal（用于不需要 async 的扫描场景）
     */
    archiveWalSync(walPath: string, archiveDir: string): WalArchive;
    /**
     * 列出所有 WAL 归档，按时间排序（升序）
     * @param archiveDir 归档目录
     */
    listArchives(archiveDir: string): Promise<WalArchive[]>;
    /**
     * 清除旧归档，只保留最近的 retentionCount 个
     * @param archiveDir 归档目录
     * @param retentionCount 保留数量
     */
    cleanupArchives(archiveDir: string, retentionCount: number): Promise<void>;
    /**
     * 从归档目录列出恢复点
     * 每个 WAL 归档代表一个增量恢复点
     * @param archiveDir 归档目录
     */
    listRecoveryPoints(archiveDir: string): Promise<RecoveryPoint[]>;
}
//# sourceMappingURL=backup-wal.d.ts.map