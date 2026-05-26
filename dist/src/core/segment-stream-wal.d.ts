/**
 * segment-stream-wal.ts — Segment-based Stream WAL
 *
 * 替代 stream-wal.ts 中基于单一文件的 WAL 实现。
 * 核心改进：
 *   1. 固定大小 segment（默认 64MB），prune 只 delete 旧 segment，不 rename
 *   2. 写入只在 active segment 上 append，永不重写
 *   3. 消除了 stream-wal.ts prune() 中 rename + reopen 的数据丢失窗口
 *
 * 每条记录格式（与旧版兼容）：
 *   [1  byte: flags]   0x00=PENDING, 0x01=ACKED, 0x02=CONSUMED
 *   [4  bytes: msgId length]  (Big-Endian)
 *   [N  bytes: msgId UTF-8]
 *   [4  bytes: data length]   (Big-Endian)
 *   [N  bytes: JSON-encoded StreamMessage]
 *
 * 目录结构：
 *   {walPath}/
 *     manifest.json      # { activeSegment, lastPrunedSegment, stats }
 *     00000001.log       # segment 1 (0~64MB)
 *     00000002.log       # segment 2
 *     ...
 *
 * 接口与 StreamWal 完全兼容，替换时无需修改调用方。
 */
export declare const FLAG_PENDING = 0;
export declare const FLAG_ACKED = 1;
export declare const FLAG_CONSUMED = 2;
export interface StreamMessage {
    msgId: string;
    seq: number;
    nodeId: string;
    timestamp: number;
    type: string;
    data: Record<string, unknown>;
}
export interface StreamWalEntry {
    offset: number;
    flags: number;
    msgId: string;
    message: StreamMessage;
}
/**
 * SegmentStreamWal — 基于固定大小 segment 的消息持久化队列
 *
 * 与 StreamWal API 完全兼容，但内部使用多 segment 文件。
 * prune 操作只删除整个 segment 文件，不重写任何数据。
 */
export declare class SegmentStreamWal {
    private walDir;
    private logger;
    private _opened;
    private _entriesCount;
    private _activeSegment;
    private _lastPrunedSegment;
    private _segmentMaxBytes;
    private _activeFd;
    private _activeSize;
    private _pruning;
    constructor(walPath: string, segmentMaxBytes?: number);
    get isOpen(): boolean;
    get size(): number;
    open(): void;
    close(): void;
    /**
     * 强制刷盘（在不需要 close 的场景下确保数据持久化）
     * 模拟"崩溃前 fsync"的语义
     */
    sync(): void;
    /**
     * 追加一条 PENDING 消息
     */
    append(msg: StreamMessage): void;
    /**
     * 标记消息为 ACKED
     */
    acknowledge(msgIds: string[] | Set<string>): void;
    /**
     * 标记消息为 CONSUMED
     */
    markConsumed(msgIds: string[] | Set<string>): void;
    /**
     * 读取超过超时时间的 PENDING 消息
     */
    readPending(beforeTimestamp: number): StreamMessage[];
    /**
     * 从指定 seq 开始回放
     */
    replay(fromSeq: number): StreamMessage[];
    /**
     * 清理已完成的记录 — 删除可回收的 segment
     *
     * 与旧版关键区别：永远不重写数据，只删整个 segment 文件。
     * 从最旧的 segment 开始，检查其所有记录是否可清理
     * （即没有 PENDING 消息）。如果整个 segment 只有 ACKED/CONSUMED，
     * 直接 unlink 该文件；一旦遇到包含 PENDING 的 segment，停止扫描。
     *
     * POSIX 保证：unlink 后文件数据在最后一个 fd 关闭后才回收，
     * 因此即使进程崩溃，已打开的文件仍可安全读取。
     *
     * @returns 剩余 PENDING 消息数
     */
    prune(): number;
    /**
     * 清理所有早于时间戳的 ACKED/CONSUMED 记录。
     * 在 segment 模式下，这个方法等价于 prune()。
     */
    pruneByTimestamp(_olderThan: number): number;
    /**
     * 删除 WAL 目录
     */
    drop(): void;
    private _segmentFilename;
    private _segmentPath;
    private _openActiveSegment;
    private _closeActiveFd;
    private _flushAndCloseActiveFd;
    /**
     * 滚动到新 segment：关闭当前，创建新的
     */
    private _rollSegment;
    /**
     * 列出所有 segment 文件（按序号升序）
     */
    private _listSegments;
    /**
     * 检查 segment 是否包含 PENDING 消息
     */
    private _segmentHasPending;
    /**
     * 批量更新 flags
     */
    private _updateFlags;
    private _loadOrCreateManifest;
    private _saveManifest;
    private _writeManifest;
    private _countAllEntries;
    /** 统计所有 segment 中 PENDING 消息数 */
    private _countPending;
    /**
     * 检测旧单文件 WAL 并迁移到 segment 格式
     *
     * 如果 walDir 对应路径是一个文件（而非目录），
     * 则将其迁移为 segment 1，并创建目录结构。
     */
    private _migrateFromOldFormat;
    private _encode;
    private _readRecordAt;
}
//# sourceMappingURL=segment-stream-wal.d.ts.map