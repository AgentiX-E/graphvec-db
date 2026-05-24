export interface SearchOptions {
    limit?: number;
    fields?: string[];
    fuzzy?: boolean;
    threshold?: number;
    weights?: Record<string, number>;
    mode?: 'or' | 'and';
    /** 评分模式：'additive' 保留原始加权加和，'bm25' 使用 Okapi BM25（默认） */
    scoring?: 'additive' | 'bm25';
}
export interface SearchResult {
    docId: string;
    score: number;
    matches?: Record<string, string[]>;
}
export interface FullTextOptions {
    defaultFieldWeight?: number;
    fieldWeights?: Record<string, number>;
    analyzer?: 'simple' | 'standard' | 'cjk';
}
export declare class FullTextIndex {
    private docs;
    private invertedIndex;
    private options;
    private _termFreqs;
    private _docLengths;
    private _avgDocLength;
    constructor(options?: FullTextOptions);
    /**
     * 添加文档到索引
     */
    addDocument(docId: string, fields: Record<string, string | string[]>): void;
    /**
     * 从索引中删除文档
     */
    removeDocument(docId: string): void;
    /**
     * 搜索索引
     */
    search(query: string, options?: SearchOptions): SearchResult[];
    /**
     * 获取所有已索引的文档
     * 用于段合并时遍历所有文档
     */
    getAllIndexedDocs(): Array<{
        docId: string;
        fields: Record<string, string | string[]>;
    }>;
    /**
     * 获取索引统计
     */
    stats(): {
        documentCount: number;
        termCount: number;
    };
    /**
     * 清空索引
     */
    clear(): void;
    /**
     * 高亮文档中的匹配词
     */
    highlight(docId: string, query: string, before?: string, after?: string): Record<string, string>;
    /**
     * 拼写校正建议
     */
    spellCorrect(query: string, maxSuggestions?: number): string[];
    /**
     * 序列化索引为 JSON
     */
    serialize(): string;
    /**
     * 从 JSON 恢复索引
     */
    static deserialize(json: string): FullTextIndex;
    /**
     * 保存到文件
     */
    saveToFile(filePath: string): Promise<void>;
    /**
     * 从文件加载
     */
    static loadFromFile(filePath: string): Promise<FullTextIndex>;
    private tokenize;
    private tokenizeString;
    /**
     * 将包含 CJK 字符的 token 拆分为 bigram
     */
    private _splitCJKTokens;
    /**
     * CJK bigram tokenizer: 对纯 CJK 文本做 2-gram 切分，
     * 对混合文本（如 "hello你好world"）拆分 CJK 和非 CJK 片段。
     */
    private _tokenizeCJK;
    /**
     * 对纯 CJK 字符串做 2-gram（bigram）切分
     * 例如: "你好世界" → ["你好", "好世", "界世界"] (only first two bigrams)
     * 实际上输出: ["你好", "好世", "世界"]
     */
    private _splitCJKBigrams;
    private findExact;
    private findFuzzy;
    private getFieldWeights;
    /**
     * 获取字段权重乘数（用于 BM25）——取所有匹配字段中的最大权重
     */
    private getFieldWeightMultiplier;
    /**
     * 获取文档中匹配 query token 的字段名列表
     */
    private getMatchingFields;
    private docHasTerm;
    private escapeRegex;
    private levenshteinDistance;
    private jaccardSimilarity;
    /**
     * 重新计算平均文档长度
     */
    private _recomputeAvgDocLength;
    /**
     * 字段权重设置
     */
    setOptions(options: FullTextOptions): void;
    /**
     * 获取索引中文档数量
     */
    count(): number;
    /**
     * 评估召回率
     */
    evaluateRecall(testQueries: Array<{
        query: string;
        relevantDocIds: string[];
    }>): {
        precision: number;
        recall: number;
        f1: number;
    };
    /**
     * 自动调优——尝试多种权重组合找到最佳 F1 分数
     */
    autoTune(testQueries: Array<{
        query: string;
        relevantDocIds: string[];
    }>, fieldCandidates?: Record<string, number[]>, iterations?: number): {
        bestWeights: Record<string, number>;
        bestF1: number;
    };
}
//# sourceMappingURL=fulltext.d.ts.map