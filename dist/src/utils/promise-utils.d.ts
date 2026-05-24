/**
 * Promise utils — 并发控制
 */
/**
 * 限制并发数执行异步函数
 */
export declare function parallelLimit<T>(items: T[], fn: (item: T) => Promise<void>, limit: number): Promise<void>;
/**
 * 带超时的 Promise
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, msg?: string): Promise<T>;
/**
 * 重试直到条件满足
 */
export declare function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs?: number, intervalMs?: number): Promise<void>;
//# sourceMappingURL=promise-utils.d.ts.map