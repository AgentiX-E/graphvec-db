import { GraphEngine } from '../core/graph-engine';
import { HlcClock } from '../replication/hlc-clock';
import type { PITRConfig, RecoveryPoint } from './backup-types';
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
export declare class Backup {
    private engine;
    private config;
    private logger;
    private inProgress;
    private clock;
    private snapshotId;
    private pitrConfig;
    private walArchiver;
    constructor(engine: GraphEngine, clock?: HlcClock);
    /**
     * 创建文件级备份
     * @param backupDir 备份目标目录
     * @throws 如果备份已经在进行中则抛出
     */
    backup(backupDir: string): Promise<{
        path: string;
        sizeBytes: number;
    }>;
    /**
     * 验证备份快照的一致性标记
     * @param backupPath 备份路径
     * @returns true 如果一致性标记有效（包含 snapshotId 和 hlcWallTime）
     */
    verifyBackup(backupPath: string): Promise<boolean>;
    /**
     * 从备份恢复
     * @param backupPath 备份路径
     * @param restorePath 恢复目标路径（默认为原数据目录）
     */
    restore(backupPath: string, restorePath?: string): Promise<void>;
    /**
     * 列出所有备份
     */
    listBackups(backupDir: string): string[];
    /**
     * 启用 PITR（Point-in-Time Recovery）
     * @param config PITR 配置
     */
    enablePITR(config: PITRConfig): void;
    /**
     * 创建增量备份：将当前 WAL 文件归档到存档目录
     * @returns 备份 ID
     */
    createIncremental(): Promise<string>;
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
    restoreToTimestamp(timestamp: number, archiveDir: string): Promise<void>;
    /**
     * 列出可用的恢复点
     * @param archiveDir 归档目录
     */
    listRecoveryPoints(archiveDir: string): Promise<RecoveryPoint[]>;
}
//# sourceMappingURL=backup.d.ts.map