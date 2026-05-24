export interface LogEntry {
    index: number;
    term: number;
    data: Uint8Array;
}
export declare class WAL {
    private fd;
    private walPath;
    private metaPath;
    private entries;
    private lastIndex;
    private lastTerm;
    private logger;
    private _opened;
    constructor(path: string);
    get isOpen(): boolean;
    /**
     * 打开 WAL 文件
     * 如果文件存在，读取所有条目到 this.entries
     * 如果不存在，创建新文件
     */
    open(): Promise<void>;
    /**
     * 追加一个日志条目到 WAL
     * 格式：[4 bytes: index][4 bytes: term][4 bytes: data length][data bytes]
     */
    append(term: number, data: Uint8Array): Promise<LogEntry>;
    /**
     * 截断到指定 index（用于 snapshot 后清理旧日志）
     * 如果 lastIndex >= this.entries.length 则 no-op
     */
    truncate(lastIndex: number): Promise<void>;
    /** 返回当前条目数 */
    entriesCount(): number;
    /**
     * 清除所有 entry.index < index 的条目
     * 重写文件（保留的条目写入新内容，fsync）
     */
    truncateBefore(index: number): Promise<void>;
    /** 返回所有缓存的条目 */
    readAll(): LogEntry[];
    /** 获取最后一条索引 */
    getLastIndex(): number;
    /** 获取最后一条任期 */
    getLastTerm(): number;
    /**
     * 获取指定索引的条目
     */
    getEntry(index: number): LogEntry | undefined;
    /**
     * 获取指定起始索引后的所有条目
     */
    getEntriesFrom(startIndex: number): LogEntry[];
    /** 关闭 WAL */
    close(): Promise<void>;
    /** fs.fsync，确保所有写入已落盘 */
    sync(): Promise<void>;
    /** 删除 WAL 文件（测试辅助） */
    destroy(): Promise<void>;
    /**
     * 持久化 key-value meta 到独立的 meta 文件
     * 格式：每行 "key=value\n"
     * 用于持久化 currentTerm / votedFor 等选举状态
     */
    persistMeta(key: string, value: string): void;
    /** 加载 meta 文件中的指定 key */
    loadMeta(key: string): string | undefined;
    /** 解析二进制 buffer 中的日志条目 */
    private _parseBuffer;
    /** 将条目列表编码为二进制 buffer */
    private _encodeEntries;
}
//# sourceMappingURL=wal.d.ts.map