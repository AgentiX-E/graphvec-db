/**
 * SafeReader — 安全读一致性层
 *
 * 在 Raft 集群中，Follower 的读操作可能读到过时数据。
 * 通过 readIndex() 确保 Follower 的 appliedIndex ≥ Leader 的 commitIndex。
 *
 * 用法:
 *   const reader = new SafeReader(provider)
 *   const node = reader.read(() => storage.getNode(id, true))
 *
 * 支持配置:
 * - readIndexTimeoutMs: readIndex 等待超时 (默认 5000ms)
 * - enabled: 是否启用 (默认 true; Raft 未配置时设为 false)
 */
import type { ConsensusProvider } from '../consensus/consensus-provider';
export interface ReadResult<T> {
    data: T;
    refreshedAt: number;
}
export interface SafeReaderConfig {
    enabled: boolean;
    readIndexTimeoutMs: number;
}
export declare class SafeReader {
    private _provider;
    private _enabled;
    private _timeoutMs;
    private _lastRefresh;
    constructor(provider?: ConsensusProvider, config?: Partial<SafeReaderConfig>);
    /**
     * 在执行 read 操作前先同步 readIndex，确保读到最新数据。
     * 如果 SafeReader 被禁用，直接执行 read 函数。
     */
    read<T>(fn: () => T): Promise<ReadResult<T>>;
    /**
     * 获取最后同步时间
     */
    get lastRefresh(): number;
    /**
     * 启用/禁用
     */
    setEnabled(enabled: boolean): void;
    /** 当前启用状态 */
    get enabled(): boolean;
    /** 更新 provider (Raft 实例化后注入) */
    setProvider(provider: ConsensusProvider): void;
}
//# sourceMappingURL=safe-reader.d.ts.map