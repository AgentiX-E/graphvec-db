import { HealthStatus, RaftRole } from '../types'
import { ShardManager } from '../shard/shard-manager'
import { GraphEngine } from '../core/graph-engine'

/**
 * Health — 健康检查接口
 *
 * 检查：
 * - Raft 状态（是否有 Leader）
 * - 各 Range 状态
 * - 存储状态
 * - OverGraph 引擎健康探测
 */
export class Health {
  private shardManager: ShardManager
  private engine: GraphEngine
  private startTime = Date.now()

  constructor(shardManager: ShardManager, engine: GraphEngine) {
    this.shardManager = shardManager
    this.engine = engine
  }

  /** 获取健康状态 */
  getStatus(): HealthStatus {
    const shardStatus = this.shardManager.getShardStatus()
    const hasLeader = shardStatus.some(s => s.raftRole === 'leader')
    const totalShards = shardStatus.length
    const healthyShards = shardStatus.filter(s => s.raftRole !== 'candidate').length
    const firstRole = shardStatus.length > 0
      ? shardStatus[0].raftRole as RaftRole
      : 'follower'

    const engineOk = this._checkEngineSync()

    const status: 'healthy' | 'degraded' | 'unhealthy' =
      !hasLeader ? 'unhealthy'
        : !engineOk ? 'degraded'
          : healthyShards < totalShards ? 'degraded'
            : 'healthy'

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
        diskFree: 0,  // 需要从实际文件系统读取
        diskUsed: 0,
      },
      latency: {
        p50: 0,
        p99: 0,
      },
      lastError: status === 'healthy' ? null : 'One or more shards are unhealthy',
    }
  }

  /**
   * 深度健康检查 — 异步，包含 OverGraph 引擎探测
   */
  async check(): Promise<HealthStatus> {
    const shardStatus = this.shardManager.getShardStatus()
    const hasLeader = shardStatus.some(s => s.raftRole === 'leader')
    const totalShards = shardStatus.length
    const healthyShards = shardStatus.filter(s => s.raftRole !== 'candidate').length
    const firstRole = shardStatus.length > 0
      ? shardStatus[0].raftRole as RaftRole
      : 'follower'

    // 引擎探测：尝试一个轻量写入/删除操作确认引擎正常工作
    let engineOk = true
    let engineError: string | undefined
    try {
      const testId = this.engine.upsertNode(999999, '__health_check__', {
        props: { __ts: Date.now() },
      })
      this.engine.deleteNode(testId)
    } catch (err) {
      engineOk = false
      engineError = (err as Error).message
    }

    const allOk = Object.values(shardStatus).every(s => s.raftRole !== 'candidate') && engineOk

    const status: 'healthy' | 'degraded' | 'unhealthy' =
      !hasLeader ? 'unhealthy'
        : allOk ? 'healthy'
          : 'degraded'

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
    }
  }

  /** 同步引擎探测（用于 getStatus） */
  private _checkEngineSync(): boolean {
    try {
      this.engine.stats()
      return true
    } catch {
      return false
    }
  }

  /** 获取信息摘要 */
  getSummary(): string {
    const h = this.getStatus()
    return [
      `Status: ${h.status}`,
      `Uptime: ${h.uptime}s`,
      `Raft: leader=${h.raft.hasLeader}, nodes=${h.raft.nodeCount}`,
      `Shards: ${h.shards.healthy}/${h.shards.total} healthy`,
      `Last error: ${h.lastError || 'none'}`,
    ].join('\n')
  }
}
