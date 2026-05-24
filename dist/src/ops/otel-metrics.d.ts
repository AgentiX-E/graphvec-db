/**
 * MetricsCollector — OTel 指标收集器
 *
 * 提供三种指标类型的便捷方法：
 * - incrementCounter: 计数器（累计值）
 * - recordHistogram: 直方图（延迟等分布数据）
 * - setGauge: 仪表盘（瞬时值）
 *
 * 所有方法在 Telemetry 未启用时直接返回，零开销。
 */
export declare class MetricsCollector {
    private static instance;
    private meter;
    private counters;
    private histograms;
    private gauges;
    private telemetry;
    private _enabled;
    private constructor();
    static getInstance(): MetricsCollector;
    /**
     * 初始化（绑定到 OTel meter）
     * 当 Telemetry 启用后调用
     */
    init(meterName?: string): void;
    /** 是否已启用 */
    isEnabled(): boolean;
    /**
     * 增加计数器
     *
     * @param name  指标名称
     * @param value 增量（默认 1）
     */
    incrementCounter(name: string, value?: number): void;
    /**
     * 记录直方图样本
     *
     * @param name  指标名称
     * @param value 样本值（如延迟毫秒数）
     */
    recordHistogram(name: string, value: number): void;
    /**
     * 设置仪表盘值
     *
     * @param name  指标名称
     * @param value 瞬时值
     */
    setGauge(name: string, value: number): void;
}
//# sourceMappingURL=otel-metrics.d.ts.map