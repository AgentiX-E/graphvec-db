/**
 * Retry — 通用重试逻辑
 *
 * 支持指数退避和最大重试次数
 */
export declare function retry<T>(fn: () => Promise<T>, options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
}): Promise<T>;
//# sourceMappingURL=retry.d.ts.map