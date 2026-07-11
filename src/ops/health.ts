import { HealthStatus, RaftRole } from '../types'
import { ShardManager } from '../shard/shard-manager'
import { GraphEngine } from '../core/graph-engine'
import checkDiskSpace from 'check-disk-space'
import * as fs from 'fs'

/**
 * Health — 健康检查接口
 *
 * 提供三个 K8s 探针：
 * - liveness()  : 进程是否存活（简单检查）
 * - readiness() : 是否准备好处理请求
 * - startup()   : 是否已完成启动
 *
 * 同时保留了原有的 getStatus() / check() / getSummary() 方法。
 */
export class Health {
  private shardManager: ShardManager
  private engine: GraphEngine
  private startTime = Date.now()
  private _startupComplete = false
  private _startupTimestamp = 0

  constructor(shardManager: ShardManager, engine: GraphEngine) {
    this.shardManager = shardManager
    this.engine = engine
  }

  // ── K8s 三探针 ───────────────────────────

  /**
   * Liveness 探针 — 进程是否存活
   * 只需要确认引擎不崩溃即可。
   * K8s 如果此探针失败会重启 Pod。
   */
  async liveness(): Promise<{ alive: boolean; error?: string; timestamp: number }> {
    try {
      this.engine.stats()
      return { alive: true, timestamp: Date.now() }
    } catch (err) {
      return { alive: false, error: (err as Error).message, timestamp: Date.now() }
    }
  }

  /**
   * Readiness 探针 — 是否准备好处理请求
   * 检查 Raft 是否有 Leader、shard 健康状态、磁盘空间。
   * K8s 如果此探针失败会从 Service 中移除流量。
   */
  async readiness(): Promise<{ ready: boolean; error?: string; details?: Record<string, unknown> }> {
    const shardStatus = this.shardManager.getShardStatus()
    const hasLeader = shardStatus.some(s => s.raftRole === 'leader')
    const totalShards = shardStatus.length
    const healthyShards = shardStatus.filter(s => s.raftRole !== 'candidate').length
    const engineOk = this._checkEngineSync()

    // 磁盘空间检查
    let diskOk = true
    let diskFree = 0
    try {
      const diskInfo = await checkDiskSpace(process.env.DATA_DIR || './data')
      diskFree = diskInfo.free
      // 如果磁盘剩余空间 < 100MB，认为不健康
      if (diskFree < 100 * 1024 * 1024) {
        diskOk = false
      }
    } catch {
      diskOk = true // 无法获取磁盘Info时不阻塞 readiness
    }

    const errors: string[] = []
    if (!hasLeader) errors.push('no raft leader')
    if (!engineOk) errors.push('engine not responding')
    if (!diskOk) errors.push('disk space low')
    if (totalShards > 0 && healthyShards < totalShards) errors.push(`only ${healthyShards}/${totalShards} shards healthy`)

    const ready = hasLeader && engineOk && (totalShards === 0 || healthyShards >= totalShards) && diskOk

    return {
      ready,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      details: {
        hasLeader,
        healthyShards,
        totalShards,
        engineOk,
        diskOk,
        diskFree,
      },
    }
  }

  /**
   * Startup 探针 — 是否已完成启动
   * check() 成功后设置标记。
   * K8s 启动后慢启动检查时会用到此探针。
   */
  async startup(): Promise<{ started: boolean; duration?: number; error?: string }> {
    if (this._startupComplete) {
      return { started: true, duration: Date.now() - this._startupTimestamp }
    }

    try {
      // 引擎必须已打开
      if (!this.engine.isOpen) {
        return { started: false, error: 'engine not open' }
      }

      // 需要有至少一个 shard 可用
      const shardStatus = this.shardManager.getShardStatus()
      if (shardStatus.length === 0) {
        return { started: false, error: 'no shards available' }
      }

      // 轻量探测：写入 + 删除健康检查节点
      const testId = await this.engine.upsertNode(999999, '__startup_health__', {
        props: { __ts: Date.now() },
      })
      await this.engine.deleteNode(testId)

      this._startupComplete = true
      this._startupTimestamp = Date.now()

      return { started: true, duration: Date.now() - this.startTime }
    } catch (err) {
      return { started: false, error: (err as Error).message }
    }
  }

  // ── 原有方法（保持向后兼容） ─────────────

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
      const testId = await this.engine.upsertNode(999999, '__health_check__', {
        props: { __ts: Date.now() },
      })
      await this.engine.deleteNode(testId)
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

  /** 获取Info摘要 */
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
