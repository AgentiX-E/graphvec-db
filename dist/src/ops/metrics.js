"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Metrics = void 0;
/**
 * Metrics — Prometheus 指标收集
 *
 * 使用 @opentelemetry/api 暴露指标
 * 记录：op/s、latency p50/p99、Raft commit latency、shard count
 */
class Metrics {
    counters = new Map();
    latencies = new Map();
    startTime = Date.now();
    /** 增加计数器 */
    incrementCounter(name, delta = 1) {
        const current = this.counters.get(name) || 0;
        this.counters.set(name, current + delta);
    }
    /** 记录延迟样本 */
    recordLatency(name, latencyMs) {
        if (!this.latencies.has(name)) {
            this.latencies.set(name, []);
        }
        const samples = this.latencies.get(name);
        samples.push(latencyMs);
        // 只保留最近 1000 个样本
        if (samples.length > 1000) {
            samples.shift();
        }
    }
    /** 获取当前快照 */
    snapshot() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const ops = this.counters.get('ops') || 0;
        return {
            timestamp: Date.now(),
            opsPerSecond: elapsed > 0 ? Math.round(ops / elapsed) : 0,
            readLatencyP50: this._percentile('read', 0.5),
            readLatencyP99: this._percentile('read', 0.99),
            writeLatencyP50: this._percentile('write', 0.5),
            writeLatencyP99: this._percentile('write', 0.99),
            raftCommitLatencyP99: this._percentile('raft_commit', 0.99),
            activeSessions: this.counters.get('active_sessions') || 0,
            shardCount: this.counters.get('shard_count') || 0,
        };
    }
    /** 获取计数器值 */
    getCounter(name) {
        return this.counters.get(name) || 0;
    }
    /** 重置指标 */
    reset() {
        this.counters.clear();
        this.latencies.clear();
        this.startTime = Date.now();
    }
    _percentile(name, p) {
        const samples = this.latencies.get(name);
        if (!samples || samples.length === 0)
            return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        const idx = Math.floor(sorted.length * p);
        return sorted[Math.min(idx, sorted.length - 1)];
    }
}
exports.Metrics = Metrics;
//# sourceMappingURL=metrics.js.map