"use strict";
/**
 * AutoSplitter — 自动 Range 分裂触发器
 *
 * 定期检查 Range 数据量，当超过阈值时自动生成 split 计划并执行。
 *
 * 设计原则:
 * - 无侵入：通过 shardManager 检测，Splitter 只触发不执行迁移
 * - 可配置：maxNodesPerRange、checkIntervalMs
 * - 安全：预留 min check 间隔，避免 split 风暴
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoSplitter = void 0;
class AutoSplitter {
    _config;
    _getRangeInstances;
    _onReshard;
    _timer = null;
    _lastSplit = new Map();
    _running = false;
    constructor(getRangeInstances, onReshard, config) {
        this._getRangeInstances = getRangeInstances;
        this._onReshard = onReshard;
        this._config = {
            maxNodesPerRange: config?.maxNodesPerRange ?? 100000,
            checkIntervalMs: config?.checkIntervalMs ?? 30000,
            minSplitIntervalMs: config?.minSplitIntervalMs ?? 60000,
            maxSplitsPerCycle: config?.maxSplitsPerCycle ?? 2,
        };
    }
    /** 启动自动分裂检查 */
    start() {
        if (this._running)
            return;
        this._running = true;
        this._timer = setInterval(() => this._check(), this._config.checkIntervalMs);
        this._timer.unref();
    }
    /** 停止自动分裂检查 */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._running = false;
    }
    get running() {
        return this._running;
    }
    /** 立即执行一次检查 */
    async checkNow() {
        return this._check();
    }
    async _check() {
        const now = Date.now();
        let splits = 0;
        try {
            const ranges = this._getRangeInstances();
            for (const range of ranges) {
                // 跳过 draining range
                if (range.isDraining())
                    continue;
                // 风暴预防：一周期最多 split maxSplitsPerCycle 次
                if (splits >= this._config.maxSplitsPerCycle)
                    break;
                const engine = range.engine;
                const stats = engine.stats();
                const nodeCount = stats.nodeCount ?? 0;
                if (nodeCount > this._config.maxNodesPerRange) {
                    const rangeId = range.config.rangeId;
                    const lastSplit = this._lastSplit.get(rangeId) ?? 0;
                    if (now - lastSplit < this._config.minSplitIntervalMs) {
                        continue; // 过早，跳过
                    }
                    // 触发 split
                    this._lastSplit.set(rangeId, now);
                    const suggestion = {
                        rangeId,
                        nodeCount,
                        edgeCount: stats.edgeCount ?? 0,
                        diskSizeBytes: stats.diskSizeBytes ?? 0,
                        suggestedTargetCount: Math.ceil(nodeCount / this._config.maxNodesPerRange),
                        reason: 'node_count_exceeded',
                    };
                    this._onReshard(suggestion);
                    splits++;
                }
            }
        }
        catch (err) {
            // 静默：单次检查失败不影响后续
        }
        return splits;
    }
}
exports.AutoSplitter = AutoSplitter;
//# sourceMappingURL=auto-splitter.js.map