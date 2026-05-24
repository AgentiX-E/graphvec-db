import { HealthStatus } from '../types';
import { ShardManager } from '../shard/shard-manager';
import { GraphEngine } from '../core/graph-engine';
/**
 * Health — 健康检查接口
 *
 * 检查：
 * - Raft 状态（是否有 Leader）
 * - 各 Range 状态
 * - 存储状态
 * - OverGraph 引擎健康探测
 */
export declare class Health {
    private shardManager;
    private engine;
    private startTime;
    constructor(shardManager: ShardManager, engine: GraphEngine);
    /** 获取健康状态 */
    getStatus(): HealthStatus;
    /**
     * 深度健康检查 — 异步，包含 OverGraph 引擎探测
     */
    check(): Promise<HealthStatus>;
    /** 同步引擎探测（用于 getStatus） */
    private _checkEngineSync;
    /** 获取信息摘要 */
    getSummary(): string;
}
//# sourceMappingURL=health.d.ts.map