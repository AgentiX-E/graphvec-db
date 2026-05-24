/**
 * stream-wal.ts — EventStream 消息持久化
 *
 * 二进制格式 WAL，用于可靠事件流的发送缓冲与消费位点记录。
 * 每条记录格式：
 *   [1  byte: flags]   0x00=PENDING, 0x01=ACKED, 0x02=CONSUMED
 *   [4  bytes: msgId length]  (Big-Endian)
 *   [N  bytes: msgId UTF-8]
 *   [4  bytes: data length]   (Big-Endian)
 *   [N  bytes: JSON-encoded StreamMessage]
 *
 * 所有整数字段 Big-Endian，与共识层的 WAL 风格一致但不共享实现。
 */
export declare const FLAG_PENDING = 0;
export declare const FLAG_ACKED = 1;
export declare const FLAG_CONSUMED = 2;
export interface StreamMessage {
    /** 全局唯一 ID: "{nodeId}-{seq}" */
    msgId: string;
    /** 单调递增序号（本节点内） */
    seq: number;
    /** 来源节点 ID */
    nodeId: string;
    /** 事件时间戳 */
    timestamp: number;
    /** 事件类型（不含特殊控制类型） */
    type: string;
    /** 事件数据 */
    data: Record<string, unknown>;
}
export interface StreamWalEntry {
    offset: number;
    flags: number;
    msgId: string;
    message: StreamMessage;
}
/**
 * StreamWal — 轻量级消息持久化队列
 *
 * 职责：
 * - append(message)：写入新的 PENDING 消息
 * - acknowledge(msgIds)：标记消息为 ACKED
 * - markConsumed(msgIds)：标记消息为 CONSUMED
 * - readPending(beforeTimestamp)：读取待重试的超时消息
 * - prune(olderThan)：清理已确认/消费的消息
 * - replay(fromSeq)：从指定序号开始回放（用于离线追赶）
 */
export declare class StreamWal {
    private fd;
    private walPath;
    private logger;
    private _opened;
    private _size;
    constructor(walPath: string);
    get isOpen(): boolean;
    get size(): number;
    open(): void;
    close(): void;
    /**
     * 追加一条 PENDING 消息
     */
    append(msg: StreamMessage): void;
    /**
     * 标记消息为 ACKED
     * 扫描文件找到对应 msgId 的条目，修改 flags 字节。
     * 为了性能，使用 in-place 覆盖写。（单条记录不跨文件块，flags 总是第 1 个字节）
     */
    acknowledge(msgIds: string[] | Set<string>): void;
    /**
     * 标记消息为 CONSUMED（本地 SUB 侧已处理）
     */
    markConsumed(msgIds: string[] | Set<string>): void;
    /**
     * 读取所有 PENDING 消息中超过超时时间的（用于重试）
     * @param beforeTimestamp  - 只返回 timestamp < beforeTimestamp 的消息（超时判断）
     * @returns PENDING 消息列表
     */
    readPending(beforeTimestamp: number): StreamMessage[];
    /**
     * 从指定 seq 开始回放所有消息（用于追赶）
     * @param fromSeq  - 起始序号（包含）
     * @returns 从 fromSeq 开始的消息列表
     */
    replay(fromSeq: number): StreamMessage[];
    /**
     * 清理已完成的记录（ACKED + CONSUMED），只保留 PENDING。
     * 重写文件。
     */
    prune(): number;
    /**
     * 清理所有早于某个时间戳的 ACKED/CONSUMED 记录
     */
    pruneByTimestamp(olderThan: number): number;
    /**
     * 删除 WAL 文件
     */
    drop(): void;
    private _encode;
    private _readRecordAt;
    private _countEntries;
}
//# sourceMappingURL=stream-wal.d.ts.map