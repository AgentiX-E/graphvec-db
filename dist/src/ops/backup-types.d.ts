/**
 * backup-types.ts — 备份操作相关的共享类型定义
 *
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */
/**
 * 备份操作的结果
 */
export interface BackupResult {
    /** 备份路径 */
    path: string;
    /** 备份数据总字节数 */
    sizeBytes: number;
    /** 是否通过后校验 */
    verified: boolean;
    /** 是否为增量备份 */
    isIncremental: boolean;
    /** LSN 范围（增量备份时有效） */
    lsnRange: {
        from: number;
        to: number;
    };
}
/**
 * WAL LSN 快照 — 用于 metadata 记录
 */
export interface WalLsnSnapshot {
    /** WAL 文件名（相对于数据目录）→ 最后一条日志索引 */
    files: Record<string, number>;
}
/**
 * PITR（Point-in-Time Recovery）配置
 */
export interface PITRConfig {
    /** 是否启用 PITR */
    enabled: boolean;
    /** 全量备份间隔（毫秒） */
    fullBackupIntervalMs: number;
    /** WAL 归档路径 */
    walArchivePath: string;
    /** 备份保留数量 */
    retentionCount: number;
    /** 目标恢复时间戳（毫秒） */
    targetTimestamp?: number;
}
/**
 * PITR 恢复点信息
 */
export interface RecoveryPoint {
    timestamp: number;
    backupId: string;
    type: 'full' | 'incremental';
}
//# sourceMappingURL=backup-types.d.ts.map