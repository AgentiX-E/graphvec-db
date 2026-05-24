/**
 * MockTimer — 虚拟时钟计时器
 *
 * 用于测试中替代 real setTimeout/setInterval，实现：
 * - 确定性超时触发（不依赖真实时间）
 * - 快速快进（advanceTimeBy / runAll）
 * - 每个实例独立，无全局共享状态
 * - 支持清理和重置
 *
 * 接口兼容 Node.js 的 setTimeout/clearTimeout/setInterval/clearInterval
 */
export declare class MockTimer {
    private _nextId;
    private _currentTime;
    private _timeouts;
    private _intervals;
    /** 获取当前虚拟时间 */
    get currentTime(): number;
    setTimeout(cb: () => void, ms: number): number;
    clearTimeout(id: number): void;
    setInterval(cb: () => void, ms: number): number;
    clearInterval(id: number): void;
    /**
     * 推进虚拟时钟指定毫秒，触发到期的所有回调
     * 注意：一个回调执行中可能注册新的定时器，
     * 新定时器的 deadline 基于当前 _currentTime（而非推进后的时间）
     */
    advanceTimeBy(ms: number): void;
    /** 执行所有待处理的 timeouts（直到队列为空） */
    runAll(): void;
    /** 重置所有状态 */
    reset(): void;
}
/** TimerProvider 接口，供 ConsensusProvider 注入 */
export interface TimerProvider {
    setTimeout(cb: () => void, ms: number): number;
    clearTimeout(id: number): void;
    setInterval(cb: () => void, ms: number): number;
    clearInterval(id: number): void;
}
/** Real timer provider（使用真实 setTimeout/setInterval） */
export declare class RealTimer implements TimerProvider {
    setTimeout(cb: () => void, ms: number): number;
    clearTimeout(id: number): void;
    setInterval(cb: () => void, ms: number): number;
    clearInterval(id: number): void;
}
//# sourceMappingURL=mock-timer.d.ts.map