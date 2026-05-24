/**
 * HlcClock — @consento/hlc 的 TypeScript 封装
 *
 * CockroachDB 兼容的混合逻辑时钟
 * 提供纳秒精度、Uint8Array 编解码、跨 DC 同步
 *
 * 保证：
 * 1. 连续调用 now() 返回单调递增的时间戳（封装层维护上一次状态）
 * 2. update() 接收远程时间戳更新本地时钟，保持因果一致性
 * 3. toBytes() 使用 @consento/hlc 编码为 Uint8Array
 *
 * 注意：@consento/hlc v2.x 的 Timestamp.decode 不存在（实际在 codec 上），
 * 通过 any 桥接使用运行时 API
 */
export declare class HlcClock {
    private lastWallTime;
    private lastLogical;
    constructor();
    /**
     * 生成当前 HLC 时间戳（保证单调递增）
     */
    now(): {
        wallTime: bigint;
        logical: number;
        toBytes(): Uint8Array;
    };
    /**
     * 生成当前时间戳，使用系统毫秒时间作为 wallTime
     * HLC 的 wallTime 通常使用毫秒或微秒精度的时间
     */
    nowWithWallTime(): {
        wallTime: bigint;
        logical: number;
        toBytes(): Uint8Array;
    };
    /**
     * 根据远程时间戳更新本地时钟
     * 保证因果一致性：opA → opB ⇒ tsA < tsB
     */
    update(remoteTimestamp: Uint8Array | {
        wallTime: bigint;
        logical: number;
    }): void;
    /**
     * wallTime 与另一个时钟比较
     * @returns -1: 小于, 0: 相等, 1: 大于
     */
    compare(tsA: {
        wallTime: bigint;
        logical: number;
    }, tsB: {
        wallTime: bigint;
        logical: number;
    }): number;
}
//# sourceMappingURL=hlc-clock.d.ts.map