import { FullTextIndex, type SearchOptions, type SearchResult, type FullTextOptions } from './fulltext';
export interface IndexSegment {
    /** 段 ID（创建时的时间戳） */
    id: number;
    /** 段内文档数 */
    documentCount: number;
    /** 底层 FullTextIndex 实例 */
    index: FullTextIndex;
    /** 是否已冻结（只读） */
    isReadOnly: boolean;
}
export interface SegmentedFullTextOptions extends FullTextOptions {
    /** 每段最大文档数（默认 100000） */
    maxSegmentSize?: number;
    /** 触发合并的最大段数（默认 4） */
    maxSegments?: number;
    /** 合并策略：'largest-first'（合并最小的段）| 'oldest-first' */
    mergePolicy?: 'largest-first' | 'oldest-first';
}
export declare class SegmentedFullTextIndex {
    private segments;
    private activeSegment;
    private maxSegmentSize;
    private maxSegments;
    private mergePolicy;
    private totalDocs;
    constructor(options?: SegmentedFullTextOptions);
    /**
     * 添加文档到当前活跃段
     * 活跃段满时自动轮转创建新段
     */
    addDocument(docId: string, fields: Record<string, string | string[]>): void;
    /**
     * 删除文档（在所有段中查找并删除）
     */
    removeDocument(docId: string): void;
    /**
     * 搜索所有段，合并排序结果
     */
    search(query: string, options?: SearchOptions): SearchResult[];
    /**
     * 使用 BM25 评分搜索所有段，合并排序结果
     * 保证对所有段都使用 BM25 scoring
     */
    searchWithBM25(query: string, options?: SearchOptions): SearchResult[];
    /**
     * 获取索引状态
     */
    stats(): {
        documentCount: number;
        totalSegments: number;
        segmentSizes: number[];
    };
    /**
     * 清空所有段
     */
    clear(): void;
    /** 收集所有段中的字段名 */
    private _collectActiveFields;
    /**
     * 轮转创建新段
     */
    private rotateSegment;
    /**
     * 判断是否需要触发合并
     */
    private shouldMerge;
    /**
     * 合并小段（减少段数）
     *
     * 策略：当段数 > maxSegments 时，选择最小的段合并成一个新段
     */
    private merge;
    /**
     * 序列化所有段为 JSON（用于持久化）
     */
    serialize(): string;
    /**
     * 从序列化的 JSON 恢复
     */
    static deserialize(json: string): SegmentedFullTextIndex;
    /**
     * 持久化到文件
     */
    saveToFile(filePath: string): Promise<void>;
    /**
     * 从文件加载
     */
    static loadFromFile(filePath: string): Promise<SegmentedFullTextIndex>;
}
//# sourceMappingURL=segmented-fulltext.d.ts.map