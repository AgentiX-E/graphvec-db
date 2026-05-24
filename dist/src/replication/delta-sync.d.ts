import { HlcClock } from './hlc-clock';
import { GraphEngine } from '../core/graph-engine';
import { DeltaMessage } from '../types';
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
export declare class DeltaSync {
    private crdt;
    private clock;
    private dcId;
    private engine;
    private logger;
    private pendingDeltas;
    private flushTimer;
    private _cleanupTimer;
    /** pending 数据过期时间（毫秒），超时未 flush 的条目将被清理 */
    private readonly pendingTtlMs;
    /** pendingDeltas Map 中的最大条目数，超过则 LRU 截断 */
    private readonly MAX_PENDING_ENTRIES;
    /** delta 消息 TTL（毫秒），flushDeltas 输出的 DeltaMessage.timestamp 用于远端清理 */
    private readonly TTL_MS;
    private telemetry;
    private metrics;
    constructor(dcId: string, engine: GraphEngine, clock: HlcClock);
    /**
     * 记录本地变更
     * @param name 节点名称（用于跨 DC 一致性路由）
     * @param fields 变更字段
     */
    recordChange(name: string, fields: Record<string, any>): void;
    /**
     * 获取所有 pending 变更的 delta
     */
    flushDeltas(): DeltaMessage[];
    /**
     * 接收远程 DC 的 delta 并合并
     */
    receiveDelta(message: DeltaMessage): Promise<number>;
    /**
     * 启动自动 flush
     */
    startAutoFlush(handler: (delta: DeltaMessage) => Promise<void>, intervalMs?: number): void;
    stopAutoFlush(): void;
    /**
     * 清理过期 pending 条目，防止内存泄漏
     */
    private _evictStaleEntries;
    /**
     * 基于 TTL 和 MAX_PENDING_ENTRIES 的主动清理
     * 用于 _cleanupTimer 定时执行，防止 OOM
     */
    private _evictExpired;
}
//# sourceMappingURL=delta-sync.d.ts.map