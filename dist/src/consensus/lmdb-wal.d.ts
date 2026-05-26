export interface LogEntry {
    index: number;
    term: number;
    data: Uint8Array;
}
/**
 * entries Db 存储结构：key=index, value={t:term, d:Buffer(data)}
 * 用 msgpackr 序列化值以确保 LMDB 能正确编码 Buffer
 */
export declare class LmdbWal {
    private dbPath;
    private db;
    private entriesDb;
    private metaDb;
    private lastIndex;
    private lastTerm;
    private logger;
    private _opened;
    constructor(path: string);
    get isOpen(): boolean;
    open(): Promise<void>;
    append(term: number, data: Uint8Array): Promise<LogEntry>;
    truncate(lastIndex: number): Promise<void>;
    entriesCount(): number;
    truncateBefore(index: number): Promise<void>;
    readAll(): LogEntry[];
    getLastIndex(): number;
    getLastTerm(): number;
    getEntry(index: number): LogEntry | undefined;
    getEntriesFrom(startIndex: number): LogEntry[];
    close(): Promise<void>;
    sync(): Promise<void>;
    destroy(): Promise<void>;
    persistMeta(key: string, value: string): Promise<void>;
    loadMeta(key: string): string | undefined;
    private _lastEntry;
    private _entries;
    private _deleteRange;
    private _deleteBefore;
}
//# sourceMappingURL=lmdb-wal.d.ts.map