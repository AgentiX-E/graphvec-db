export interface IndexRecord {
    id: string;
    fields: Record<string, string | number | boolean>;
}
export interface QueryCondition {
    field: string;
    operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'prefix';
    value: string | number | boolean;
}
export interface IndexStats {
    name: string;
    recordCount: number;
    fieldKeys: string[];
}
export declare class CompositeIndex {
    readonly name: string;
    private records;
    private fieldIndex;
    private numericIndex;
    constructor(name: string);
    /** 添加记录到索引 */
    addRecord(record: IndexRecord): void;
    /** 从索引中移除记录 */
    removeRecord(recordId: string): boolean;
    /** 精确查询 */
    queryExact(field: string, value: string | number | boolean): string[];
    /** 范围查询（仅支持数值） */
    queryRange(field: string, min?: number, max?: number): string[];
    /** 前缀查询（仅支持字符串值） */
    queryPrefix(field: string, prefix: string): string[];
    /** 通用查询（支持精确/范围/前缀条件，多个条件 AND 合并） */
    query(conditions: QueryCondition[]): string[];
    /** 获取索引名称 */
    indexName(): string;
    /** 清空索引 */
    clear(): void;
    /** 获取统计信息 */
    stats(): IndexStats;
    /** 获取记录数 */
    get size(): number;
}
//# sourceMappingURL=composite-index.d.ts.map