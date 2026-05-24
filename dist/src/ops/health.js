"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Health = void 0;
/**
 * Health — 健康检查接口
 *
 * 检查：
 * - Raft 状态（是否有 Leader）
 * - 各 Range 状态
 * - 存储状态
 * - OverGraph 引擎健康探测
 */
class Health {
    shardManager;
    engine;
    startTime = Date.now();
    constructor(shardManager, engine) {
        this.shardManager = shardManager;
        this.engine = engine;
    }
    /** 获取健康状态 */
    getStatus() {
        const shardStatus = this.shardManager.getShardStatus();
        const hasLeader = shardStatus.some(s => s.raftRole === 'leader');
        const totalShards = shardStatus.length;
        const healthyShards = shardStatus.filter(s => s.raftRole !== 'candidate').length;
        const firstRole = shardStatus.length > 0
            ? shardStatus[0].raftRole
            : 'follower';
        const engineOk = this._checkEngineSync();
        const status = !hasLeader ? 'unhealthy'
            : !engineOk ? 'degraded'
                : healthyShards < totalShards ? 'degraded'
                    : 'healthy';
        return {
            status,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            raft: {
                hasLeader,
                nodeCount: totalShards,
                role: firstRole,
            },
            shards: {
                total: totalShards,
                healthy: healthyShards,
            },
            storage: {
                diskFree: 0, // 需要从实际文件系统读取
                diskUsed: 0,
            },
            latency: {
                p50: 0,
                p99: 0,
            },
            lastError: status === 'healthy' ? null : 'One or more shards are unhealthy',
        };
    }
    /**
     * 深度健康检查 — 异步，包含 OverGraph 引擎探测
     */
    async check() {
        const shardStatus = this.shardManager.getShardStatus();
        const hasLeader = shardStatus.some(s => s.raftRole === 'leader');
        const totalShards = shardStatus.length;
        const healthyShards = shardStatus.filter(s => s.raftRole !== 'candidate').length;
        const firstRole = shardStatus.length > 0
            ? shardStatus[0].raftRole
            : 'follower';
        // 引擎探测：尝试一个轻量写入/删除操作确认引擎正常工作
        let engineOk = true;
        let engineError;
        try {
            const testId = this.engine.upsertNode(999999, '__health_check__', {
                props: { __ts: Date.now() },
            });
            this.engine.deleteNode(testId);
        }
        catch (err) {
            engineOk = false;
            engineError = err.message;
        }
        const allOk = Object.values(shardStatus).every(s => s.raftRole !== 'candidate') && engineOk;
        const status = !hasLeader ? 'unhealthy'
            : allOk ? 'healthy'
                : 'degraded';
        return {
            status,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            raft: {
                hasLeader,
                nodeCount: totalShards,
                role: firstRole,
            },
            shards: {
                total: totalShards,
                healthy: healthyShards,
            },
            storage: {
                diskFree: 0,
                diskUsed: 0,
            },
            latency: {
                p50: 0,
                p99: 0,
            },
            lastError: allOk ? null : (engineError || 'One or more shards are unhealthy'),
        };
    }
    /** 同步引擎探测（用于 getStatus） */
    _checkEngineSync() {
        try {
            this.engine.stats();
            return true;
        }
        catch {
            return false;
        }
    }
    /** 获取信息摘要 */
    getSummary() {
        const h = this.getStatus();
        return [
            `Status: ${h.status}`,
            `Uptime: ${h.uptime}s`,
            `Raft: leader=${h.raft.hasLeader}, nodes=${h.raft.nodeCount}`,
            `Shards: ${h.shards.healthy}/${h.shards.total} healthy`,
            `Last error: ${h.lastError || 'none'}`,
        ].join('\n');
    }
}
exports.Health = Health;
//# sourceMappingURL=health.js.map