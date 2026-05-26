/**
 * EdgeAffinity — 边分片键配置
 *
 * 决定边写入时路由到哪个 Range。
 *
 * 策略选项:
 * - 'source':  根据起点节点路由 (默认，现有行为)
 * - 'target':  根据终点节点路由
 * - 'source-target': 跨 src+dst hash（确保双向边在同一 Range）
 * - 'property:<key>': 根据边上的属性值路由
 */
export type EdgeAffinityStrategy = 'source' | 'target' | 'source-target' | string;
export interface EdgeAffinityConfig {
    strategy: EdgeAffinityStrategy;
}
export declare class EdgeAffinity {
    private _strategy;
    constructor(config?: Partial<EdgeAffinityConfig>);
    /**
     * 计算边的分片键
     *
     * @param src - 起点节点 ID
     * @param dst - 终点节点 ID
     * @param properties - 边的属性（用于 property-based 策略）
     * @returns 用作分片路由键的值
     */
    getPartitionKey(src: number, dst: number, properties?: Record<string, unknown>): number;
    /** 当前策略 */
    get strategy(): EdgeAffinityStrategy;
    /** 动态修改策略 */
    setStrategy(strategy: EdgeAffinityStrategy): void;
}
//# sourceMappingURL=edge-affinity.d.ts.map