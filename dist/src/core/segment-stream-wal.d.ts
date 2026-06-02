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
 * SegmentStreamWalAppendStream — 带策略化 fsync 的追加写入流包装
 *
 * 在底层 fd 之上添加 fsync 策略控制：
 * - 'lazy':   不主动 fsync（依赖系统缓存刷新），最快但最不安全
 * - 'always': 每次 append 后立即 fsync，最安全但最慢
 * - 'every-n': 每 N 次 append 后 fsync 一次，折中方案
 *
 * 默认 'every-n'（n=10），兼顾安全与性能。
 */
export declare class SegmentStreamWalAppendStream {
    private _fd;
    private _fsyncStrategy;
    private _fsyncEveryN;
    private _fsyncCounter;
    constructor(fd: number, options?: {
        fsyncStrategy?: 'lazy' | 'always' | 'every-n';
        fsyncEveryN?: number;
    });
    /**
     * 强制刷盘当前 active segment
     * 供外部在关键点（如 Raft commit 后）调用，确保数据持久化
     */
    fsync(): void;
    /**
     * 追加二进制数据到文件末尾，触发 fsync
     */
    append(buf: Buffer): void;
}
/** SegmentStreamWal 构造选项 */
export interface SegmentStreamWalOptions {
    /** 单个 segment 最大字节数（默认 64MB） */
    segmentMaxBytes?: number;
    /**
     * 每次 append 后是否强制 fsync 刷盘。
     * - true:  每次 append 后调用 fsyncSync（最安全，默认）
     * - false: 不强制 fsync（性能更好，但崩溃时可能丢失最近写入）
     *
     * 即使设为 false，open() 和正常 close() 仍会 fsync。
     */
    fsyncOnWrite?: boolean;
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
    private _fsyncOnWrite;
    constructor(walPath: string, options?: SegmentStreamWalOptions);
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
     *
     * 当 fsyncOnWrite=true（默认）时，每次 append 后强制刷盘，
     * 保证在进程崩溃时数据不丢失。
     * 当 fsyncOnWrite=false 时，跳过 fsync，依赖操作系统批量刷盘，
     * 性能更快但崩溃时可能丢失最近写入。
     */
    append(msg: StreamMessage): void;
    /**
     * A-01: 批量追加多条消息，只做一次 fsync（真正的 Group Commit）
     *
     * 将多条 pending 消息合并编码后单次写入文件，然后只调用一次 fsync。
     * 相比多次 append 分别 fsync，大幅减少系统调用次数。
     *
     * @param msgs 待追加的消息列表
     */
    appendBatch(msgs: StreamMessage[]): void;
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