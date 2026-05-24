"use strict";
/**
 * Promise utils — 并发控制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parallelLimit = parallelLimit;
exports.withTimeout = withTimeout;
exports.waitFor = waitFor;
/**
 * 限制并发数执行异步函数
 */
async function parallelLimit(items, fn, limit) {
    const results = [];
    const executing = new Set();
    for (const item of items) {
        const p = fn(item).finally(() => executing.delete(p));
        results.push(p);
        executing.add(p);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    await Promise.all(results);
}
/**
 * 带超时的 Promise
 */
function withTimeout(promise, ms, msg) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(msg || `Timeout after ${ms}ms`)), ms)),
    ]);
}
/**
 * 重试直到条件满足
 */
async function waitFor(condition, timeoutMs = 5000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await condition())
            return;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
//# sourceMappingURL=promise-utils.js.map