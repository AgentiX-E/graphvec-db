/**
 * QuerySlowLog — 慢查询拦截器
 *
 * 记录所有耗时超过阈值的查询
 * 阈值默认 100ms
 */
export declare class QuerySlowLog {
    private thresholdMs;
    private logs;
    private maxEntries;
    constructor(thresholdMs?: number, maxEntries?: number);
    /**
     * 执行查询并记录慢查询
     * @returns 查询结果
     */
    track<T>(name: string, fn: () => Promise<T>, user?: string): Promise<T>;
    /** 获取慢查询列表 */
    getSlowQueries(): typeof this.logs;
    /** 获取最近慢查询数 */
    get count(): number;
    setThreshold(ms: number): void;
    clear(): void;
    private _log;
}
//# sourceMappingURL=query-slow-log.d.ts.map