"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuerySlowLog = void 0;
/**
 * QuerySlowLog — 慢查询拦截器
 *
 * 记录所有耗时超过阈值的查询
 * 阈值默认 100ms
 */
class QuerySlowLog {
    thresholdMs;
    logs = [];
    maxEntries;
    constructor(thresholdMs = 100, maxEntries = 1000) {
        this.thresholdMs = thresholdMs;
        this.maxEntries = maxEntries;
    }
    /**
     * 执行查询并记录慢查询
     * @returns 查询结果
     */
    async track(name, fn, user) {
        const start = Date.now();
        try {
            return await fn();
        }
        finally {
            const duration = Date.now() - start;
            if (duration >= this.thresholdMs) {
                this._log(name, duration, user);
            }
        }
    }
    /** 获取慢查询列表 */
    getSlowQueries() {
        return [...this.logs];
    }
    /** 获取最近慢查询数 */
    get count() {
        return this.logs.length;
    }
    setThreshold(ms) {
        this.thresholdMs = ms;
    }
    clear() {
        this.logs = [];
    }
    _log(op, duration, user) {
        this.logs.push({ op, duration, timestamp: Date.now(), user });
        if (this.logs.length > this.maxEntries) {
            this.logs.shift();
        }
    }
}
exports.QuerySlowLog = QuerySlowLog;
//# sourceMappingURL=query-slow-log.js.map