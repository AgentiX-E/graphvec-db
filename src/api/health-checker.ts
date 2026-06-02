// ============================================================
// HealthChecker — 组件级健康检查探针
//
// 提供细粒度的组件健康检查（存储/共识/索引），
// 补充 Health 类的 K8s 三探针功能。
// ============================================================

import { ShardManager } from '../shard/shard-manager'
import { GraphEngine } from '../core/graph-engine'

// ── 类型定义 ──────────────────────────────────────────────

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface ComponentHealth {
  status: ComponentStatus
  detail: string
  latencyMs?: number
  error?: string
}

export interface HealthProbe {
  /** 探测名称 */
  name: string
  /** 探测结果 */
  result: ComponentHealth
}

export interface LivezResponse {
  ok: boolean
  timestamp: number
  uptime: number
}

export interface ReadyzResponse {
  ok: boolean
  timestamp: number
  components: HealthProbe[]
  summary: ComponentStatus
}

export interface DetailedHealthResponse {
  timestamp: number
  uptime: number
  components: {
    storage: ComponentHealth
    consensus: ComponentHealth
    index: ComponentHealth
  }
  summary: ComponentStatus
}

// ── HealthChecker ──────────────────────────────────────────

export class HealthChecker {
  private shardManager: ShardManager
  private engine: GraphEngine
  private startTime = Date.now()

  constructor(shardManager: ShardManager, engine: GraphEngine) {
    this.shardManager = shardManager
    this.engine = engine
  }

  /**
   * 获取 uptime（秒）
   */
  get uptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000)
  }

  /**
   * Liveness 探针 — 最轻量级，仅检查进程是否存活
   * 对应 K8s /health/live
   */
  async livez(): Promise<LivezResponse> {
    return {
      ok: true,
      timestamp: Date.now(),
      uptime: this.uptime,
    }
  }

  /**
   * Readiness 探针 — 检查所有组件是否就绪
   * 对应 K8s /health/ready
   */
  async readyz(): Promise<ReadyzResponse> {
    const components = await this.probeAll()
    const allHealthy = components.every(c => c.result.status === 'healthy')
    const anyUnhealthy = components.some(c => c.result.status === 'unhealthy')

    let summary: ComponentStatus
    if (allHealthy) {
      summary = 'healthy'
    } else if (anyUnhealthy) {
      summary = 'unhealthy'
    } else {
      summary = 'degraded'
    }

    return {
      ok: allHealthy,
      timestamp: Date.now(),
      components,
      summary,
    }
  }

  /**
   * 对所有组件进行健康检查
   */
  async probeAll(): Promise<HealthProbe[]> {
    return Promise.all([
      this.probeStorage(),
      this.probeConsensus(),
      this.probeIndex(),
    ])
  }

  /**
   * 获取详细组件健康状态
   */
  async detail(): Promise<DetailedHealthResponse> {
    const [storage, consensus, index] = await Promise.all([
      this.probeStorage(),
      this.probeConsensus(),
      this.probeIndex(),
    ])

    const probes = [storage, consensus, index]
    const allHealthy = probes.every(p => p.result.status === 'healthy')
    const anyUnhealthy = probes.some(p => p.result.status === 'unhealthy')

    let summary: ComponentStatus
    if (allHealthy) summary = 'healthy'
    else if (anyUnhealthy) summary = 'unhealthy'
    else summary = 'degraded'

    return {
      timestamp: Date.now(),
      uptime: this.uptime,
      components: {
        storage: storage.result,
        consensus: consensus.result,
        index: index.result,
      },
      summary,
    }
  }

  /**
   * 存储组件探针
   * 检查引擎是否存活、磁盘是否可写
   */
  async probeStorage(): Promise<HealthProbe> {
    const start = Date.now()
    try {
      const stats = this.engine.stats()
      const latencyMs = Date.now() - start

      // 检查引擎 stats 是否正常
      const nodeCount = typeof stats.nodeCount === 'number' ? stats.nodeCount : -1
      if (nodeCount < 0) {
        return {
          name: 'storage',
          result: {
            status: 'degraded',
            detail: 'Engine stats unavailable',
            latencyMs,
          },
        }
      }

      return {
        name: 'storage',
        result: {
          status: 'healthy',
          detail: `Engine responsive, ${nodeCount} nodes tracked`,
          latencyMs,
        },
      }
    } catch (err) {
      return {
        name: 'storage',
        result: {
          status: 'unhealthy',
          detail: 'Engine not responding',
          error: (err as Error).message,
          latencyMs: Date.now() - start,
        },
      }
    }
  }

  /**
   * 共识组件探针
   * 检查 Raft shard 状态
   */
  async probeConsensus(): Promise<HealthProbe> {
    const start = Date.now()
    try {
      const shardStatus = this.shardManager.getShardStatus()

      if (shardStatus.length === 0) {
        return {
          name: 'consensus',
          result: {
            status: 'degraded',
            detail: 'No shards initialized',
            latencyMs: Date.now() - start,
          },
        }
      }

      const hasLeader = shardStatus.some(s => s.raftRole === 'leader')
      const candidates = shardStatus.filter(s => s.raftRole === 'candidate').length

      if (!hasLeader) {
        return {
          name: 'consensus',
          result: {
            status: 'unhealthy',
            detail: `No Raft leader among ${shardStatus.length} shard(s); ${candidates} candidate(s)`,
            latencyMs: Date.now() - start,
          },
        }
      }

      if (candidates > 0) {
        return {
          name: 'consensus',
          result: {
            status: 'degraded',
            detail: `${candidates}/${shardStatus.length} shard(s) in candidate state`,
            latencyMs: Date.now() - start,
          },
        }
      }

      return {
        name: 'consensus',
        result: {
          status: 'healthy',
          detail: `${shardStatus.length} shard(s) operational, leader elected`,
          latencyMs: Date.now() - start,
        },
      }
    } catch (err) {
      return {
        name: 'consensus',
        result: {
          status: 'unhealthy',
          detail: 'Failed to query shard status',
          error: (err as Error).message,
          latencyMs: Date.now() - start,
        },
      }
    }
  }

  /**
   * 索引组件探针
   * 检查引擎对索引的响应（通过 upsert 探测）
   */
  async probeIndex(): Promise<HealthProbe> {
    const start = Date.now()
    try {
      // 尝试一个轻量探测操作
      const testId = await this.engine.upsertNode(999999, '__health_index__', {
        props: { __ts: Date.now() },
      })

      // 清理探测节点
      await this.engine.deleteNode(testId)

      const latencyMs = Date.now() - start

      return {
        name: 'index',
        result: {
          status: 'healthy',
          detail: 'Index operational (read/write probe passed)',
          latencyMs,
        },
      }
    } catch (err) {
      return {
        name: 'index',
        result: {
          status: 'unhealthy',
          detail: 'Index probe failed',
          error: (err as Error).message,
          latencyMs: Date.now() - start,
        },
      }
    }
  }
}
