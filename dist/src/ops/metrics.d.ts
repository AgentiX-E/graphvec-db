import { MetricsSnapshot } from '../types';
/**
 * Metrics — Prometheus 指标收集
 *
 * 使用 @opentelemetry/api 暴露指标
 * 记录：op/s、latency p50/p99、Raft commit latency、shard count
 */
export declare class Metrics {
    private counters;
    private latencies;
    private startTime;
    /** 增加计数器 */
    incrementCounter(name: string, delta?: number): void;
    /** 记录延迟样本 */
    recordLatency(name: string, latencyMs: number): void;
    /** 获取当前快照 */
    snapshot(): MetricsSnapshot;
    /** 获取计数器值 */
    getCounter(name: string): number;
    /** 重置指标 */
    reset(): void;
    private _percentile;
}
//# sourceMappingURL=metrics.d.ts.map