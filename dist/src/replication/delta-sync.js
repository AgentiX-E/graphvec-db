"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeltaSync = void 0;
const graph_crdt_1 = __importDefault(require("graph-crdt"));
const logger_1 = require("../ops/logger");
const otel_1 = require("../ops/otel");
const otel_metrics_1 = require("../ops/otel-metrics");
/**
 * DeltaSync — 基于 graph-crdt 的增量跨 DC 同步引擎
 *
 * 工作流：
 * 1. 本地写入后记录变更到 CRDT
 * 2. 批量生成 delta（仅变更集）
 * 3. 远程 DC 收到后合并 delta
 *
 * Delta 同步带宽可降低 100x（~1KB/操作 → ~100B/操作）
 */
class DeltaSync {
    crdt;
    clock;
    dcId;
    engine;
    logger;
    pendingDeltas = new Map();
    flushTimer = null;
    _cleanupTimer = null;
    /** pending 数据过期时间（毫秒），超时未 flush 的条目将被清理 */
    pendingTtlMs = 60000;
    /** pendingDeltas Map 中的最大条目数，超过则 LRU 截断 */
    MAX_PENDING_ENTRIES = 10000;
    /** delta 消息 TTL（毫秒），flushDeltas 输出的 DeltaMessage.timestamp 用于远端清理 */
    TTL_MS = 5 * 60 * 1000; // 5 分钟
    telemetry;
    metrics;
    constructor(dcId, engine, clock) {
        this.dcId = dcId;
        this.engine = engine;
        this.clock = clock;
        this.logger = new logger_1.Logger('DeltaSync');
        this.telemetry = otel_1.Telemetry.getInstance();
        this.metrics = otel_metrics_1.MetricsCollector.getInstance();
        this.crdt = new graph_crdt_1.default();
    }
    /**
     * 记录本地变更
     * @param name 节点名称（用于跨 DC 一致性路由）
     * @param fields 变更字段
     */
    recordChange(name, fields) {
        const now = this.clock.now();
        const state = { wallTime: Number(now.wallTime), logical: now.logical };
        const change = {
            nodes: {
                [name]: Object.fromEntries(Object.entries(fields).map(([key, value]) => [
                    key,
                    { value, state }
                ]))
            }
        };
        this.crdt.merge(change);
        if (!this.pendingDeltas.has(name)) {
            this.pendingDeltas.set(name, []);
        }
        this.pendingDeltas.get(name).push({ nodeId: name, fields, createdAt: Date.now() });
        // 定期清理过期条目（每 100 次记录变更检查一次）
        if (this.pendingDeltas.size > 0 && this.pendingDeltas.size % 100 === 0) {
            this._evictStaleEntries();
        }
    }
    /**
     * 获取所有 pending 变更的 delta
     */
    flushDeltas() {
        if (this.pendingDeltas.size === 0)
            return [];
        const delta = this.crdt.delta();
        this.pendingDeltas.clear();
        return [{
                dcId: this.dcId,
                hlcTimestamp: this.clock.now().toBytes(),
                delta,
                batchId: `${this.dcId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: Date.now(),
            }];
    }
    /**
     * 接收远程 DC 的 delta 并合并
     */
    async receiveDelta(message) {
        return this.telemetry.traceAsync('deltasync.receive', async () => {
            // 1. 更新 HLC
            this.clock.update(message.hlcTimestamp);
            // 2. CRDT 合并
            const merged = this.crdt.merge(message.delta);
            // 3. 写入本地 OverGraph
            let appliedCount = 0;
            if (merged && merged.nodes) {
                for (const [nodeName, fields] of Object.entries(merged.nodes)) {
                    if (fields && typeof fields === 'object') {
                        const props = {};
                        for (const [field, value] of Object.entries(fields)) {
                            if (value && typeof value === 'object' && 'value' in value) {
                                props[field] = value.value;
                            }
                        }
                        if (Object.keys(props).length > 0) {
                            try {
                                this.engine.upsertNode(1, String(nodeName), { props });
                                appliedCount++;
                            }
                            catch (err) {
                                this.logger.error(`[DeltaSync] Failed to apply remote change to node ${nodeName}:`, err);
                            }
                        }
                    }
                }
            }
            return appliedCount;
        });
    }
    /**
     * 启动自动 flush
     */
    startAutoFlush(handler, intervalMs = 100) {
        if (this.flushTimer)
            this.stopAutoFlush();
        this.flushTimer = setInterval(async () => {
            const deltas = this.flushDeltas();
            for (const delta of deltas) {
                try {
                    await handler(delta);
                }
                catch (err) {
                    this.logger.error('[DeltaSync] Failed to publish delta:', err);
                }
            }
        }, intervalMs);
        // 每 60s 执行一次过期清理
        this._cleanupTimer = setInterval(() => this._evictExpired(), 60000);
    }
    stopAutoFlush() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }
    /**
     * 清理过期 pending 条目，防止内存泄漏
     */
    _evictStaleEntries() {
        const now = Date.now();
        for (const [key, entries] of this.pendingDeltas) {
            const fresh = entries.filter(e => now - e.createdAt < this.pendingTtlMs);
            if (fresh.length === 0) {
                this.pendingDeltas.delete(key);
            }
            else if (fresh.length < entries.length) {
                this.pendingDeltas.set(key, fresh);
            }
        }
    }
    /**
     * 基于 TTL 和 MAX_PENDING_ENTRIES 的主动清理
     * 用于 _cleanupTimer 定时执行，防止 OOM
     */
    _evictExpired() {
        const now = Date.now();
        let evicted = 0;
        for (const [key, entries] of this.pendingDeltas) {
            const fresh = entries.filter(e => now - e.createdAt < this.TTL_MS);
            if (fresh.length === 0) {
                this.pendingDeltas.delete(key);
                evicted++;
            }
            else if (fresh.length < entries.length) {
                this.pendingDeltas.set(key, fresh);
                evicted += entries.length - fresh.length;
            }
        }
        // 如果还是太多，LRU 删除过量的
        if (this.pendingDeltas.size > this.MAX_PENDING_ENTRIES) {
            const excess = this.pendingDeltas.size - this.MAX_PENDING_ENTRIES;
            const keys = [...this.pendingDeltas.keys()].slice(0, excess);
            for (const key of keys) {
                this.pendingDeltas.delete(key);
            }
            evicted += keys.length;
        }
        if (evicted > 0) {
            this.logger.warn(`[DeltaSync] Evicted ${evicted} stale/overflow deltas`);
        }
    }
}
exports.DeltaSync = DeltaSync;
//# sourceMappingURL=delta-sync.js.map