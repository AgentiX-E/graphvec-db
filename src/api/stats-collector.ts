// ============================================================
// StatsCollector — 统计直方图收集器
// 按 typeId 分桶统计节点属性分布，支持选择性估算
// ============================================================

import { GraphEngine } from '../core/graph-engine'
import { NodeRecord } from '../types'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

/**
 * Predicate — 过滤条件表示
 */
export interface Predicate {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'prefix' | 'in'
  value: unknown
}

/**
 * PropertyStats — 单个属性的统计Info
 */
export interface PropertyStats {
  distinctValues: number
  nullCount: number
  minValue?: number
  maxValue?: number
}

/**
 * TypeStats — 按 typeId 的节点类型统计
 */
export interface TypeStats {
  typeId: number
  totalNodes: number
  totalEdges: number
  propertyStats: Map<string, PropertyStats>
}

/**
 * StatsSnapshot — 一次统计收集的全部结果
 */
export interface StatsSnapshot {
  typeStats: Map<number, TypeStats>
  totalNodes: number
  totalEdges: number
  collectedAt: number
}

// ──────────────────────────────────────────
// StatsCollector — 统计收集器
// ──────────────────────────────────────────

export class StatsCollector {
  private _lastSnapshot: StatsSnapshot | null = null
  private _collectionIntervalMs: number
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _allNodes: NodeRecord[] = []

  constructor(
    private _engine: GraphEngine,
    collectionIntervalMs: number = 300000,
  ) {
    this._collectionIntervalMs = collectionIntervalMs
  }

  // ──────────────────────────────────────────
  // collectNow — 立即收集统计Info
  // ──────────────────────────────────────────

  /**
   * 立即收集所有节点/边的统计Info。
   *
   * 从 GraphEngine 获取节点总数和边总数，
   * 再按 typeId 分组统计属性分布。
   */
  async collectNow(): Promise<StatsSnapshot> {
    const now = Date.now()

    // 从 engine 获取总览统计
    const engineStats = this._engine.stats()
    const totalNodes = engineStats.nodeCount
    const totalEdges = engineStats.edgeCount

    // 获取全量节点数据（通过 engine 支持的扫描方式）
    const typeStats = await this.collectTypeStats()

    const snapshot: StatsSnapshot = {
      typeStats,
      totalNodes,
      totalEdges,
      collectedAt: now,
    }

    this._lastSnapshot = snapshot
    return snapshot
  }

  // ──────────────────────────────────────────
  // startPeriodicCollection — 启动定时收集
  // ──────────────────────────────────────────

  /**
   * 启动定时统计收集。
   * 按 _collectionIntervalMs 间隔周期性调用 collectNow()。
   * 如果已有计时器则不重复启动。
   */
  startPeriodicCollection(): void {
    if (this._timer !== null) return

    this._timer = setInterval(async () => {
      try {
        await this.collectNow()
      } catch {
        // 静默处理收集Error，避免定时器中断
      }
    }, this._collectionIntervalMs)
  }

  // ──────────────────────────────────────────
  // stopPeriodicCollection — 停止定时收集
  // ──────────────────────────────────────────

  /**
   * 停止定时统计收集并清理计时器。
   */
  stopPeriodicCollection(): void {
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  // ──────────────────────────────────────────
  // getLastSnapshot — 获取最近一次快照
  // ──────────────────────────────────────────

  /**
   * 返回最近一次收集完成的快照，若从未收集过则返回 null。
   */
  getLastSnapshot(): StatsSnapshot | null {
    return this._lastSnapshot
  }

  // ──────────────────────────────────────────
  // estimateSelectivity — 选择性估算
  // ──────────────────────────────────────────

  /**
   * 基于统计快照和 typeId，计算给定谓词的选择性。
   *
   * 规则:
   *   - eq:       1 / distinctValues
   *   - neq:      1 - 1/distinctValues
   *   - gt/lt:    0.33（无 min/max Info时）或 1/3
   *   - gte/lte:  同 gt/lt
   *   - prefix:   sqrt(1 / distinctValues)
   *   - in:       min(1, value.length / distinctValues)
   *   - default:  0.5
   */
  estimateSelectivity(
    typeId: number,
    predicate: Predicate,
    stats?: StatsSnapshot,
  ): number {
    const snap = stats ?? this._lastSnapshot
    if (!snap) return 0.5

    const ts = snap.typeStats.get(typeId)
    if (!ts) return 0.5

    const propStats = ts.propertyStats.get(predicate.field)
    if (!propStats || propStats.distinctValues === 0) return 0.5

    const ndv = propStats.distinctValues

    switch (predicate.op) {
      case 'eq':
        return 1 / Math.max(ndv, 1)

      case 'neq':
        return 1 - 1 / Math.max(ndv, 1)

      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        // If any min/max Info且值是数字，用范围比例估算
        if (
          propStats.minValue !== undefined &&
          propStats.maxValue !== undefined &&
          typeof predicate.value === 'number'
        ) {
          const range = propStats.maxValue - propStats.minValue
          if (range > 0) {
            const val = predicate.value as number
            if (predicate.op === 'gt' || predicate.op === 'gte') {
              return Math.max(0.01, Math.min(1, (propStats.maxValue - val) / range))
            } else {
              return Math.max(0.01, Math.min(1, (val - propStats.minValue) / range))
            }
          }
        }
        return 0.33
      }

      case 'prefix':
        return Math.min(1, 1 / Math.sqrt(Math.max(ndv, 1)))

      case 'in':
        if (Array.isArray(predicate.value) && predicate.value.length > 0) {
          return Math.min(1, predicate.value.length / Math.max(ndv, 1))
        }
        return 0.5

      default:
        return 0.5
    }
  }

  // ──────────────────────────────────────────
  // Private method
  // ──────────────────────────────────────────

  /**
   * 从 engine 收集每个 typeId 的节点分布和属性统计。
   *
   * 通过 engine 的存储层访问所有已存储的节点，
   * 按 typeId 分组聚合属性值分布。
   */
  private async collectTypeStats(): Promise<Map<number, TypeStats>> {
    const typeStatsMap = new Map<number, TypeStats>()

    // 通过引擎的存储层获取节点数据
    const allNodes = await this.getAllNodesFromEngine()

    // 按 typeId 分组
    const typeBuckets = new Map<number, NodeRecord[]>()
    for (const node of allNodes) {
      const tid = node.type
      if (!typeBuckets.has(tid)) {
        typeBuckets.set(tid, [])
      }
      typeBuckets.get(tid)!.push(node)
    }

    // 边数 — 从 engine stats 反推 (按 typeId 平均分摊)
    // 实际生产中应使用索引计数，这里从 engine 获取总边数
    const engineStats = this._engine.stats()
    const totalEdges = engineStats.edgeCount
    const typeCount = Math.max(typeBuckets.size, 1)

    // 构建每个 typeId 的统计
    for (const [tid, nodes] of typeBuckets) {
      const propertyStatsMap = new Map<string, PropertyStats>()

      // 收集所有出现过的属性名和值
      const propertyValues = new Map<string, Set<unknown>>()
      const nullCountMap = new Map<string, number>()
      const minValueMap = new Map<string, number>()
      const maxValueMap = new Map<string, number>()

      for (const node of nodes) {
        // 处理顶级字段
        const topFields: Record<string, unknown> = {
          id: node.id,
          name: node.name ?? '',
        }

        // 合并顶级字段和 props
        const allFields = { ...topFields, ...(node.props ?? {}) }

        for (const [key, val] of Object.entries(allFields)) {
          if (!propertyValues.has(key)) {
            propertyValues.set(key, new Set())
            nullCountMap.set(key, 0)
          }
          if (val === null || val === undefined) {
            nullCountMap.set(key, (nullCountMap.get(key) ?? 0) + 1)
          } else {
            propertyValues.get(key)!.add(val)
            // 记录数值类型的 min/max
            if (typeof val === 'number') {
              const currentMin = minValueMap.get(key)
              const currentMax = maxValueMap.get(key)
              if (currentMin === undefined || val < currentMin) {
                minValueMap.set(key, val)
              }
              if (currentMax === undefined || val > currentMax) {
                maxValueMap.set(key, val)
              }
            }
          }
        }
      }

      // 构建 PropertyStats
      for (const [key, values] of propertyValues) {
        const nk = nullCountMap.get(key) ?? 0
        const ps: PropertyStats = {
          distinctValues: values.size,
          nullCount: nk,
        }
        const minV = minValueMap.get(key)
        const maxV = maxValueMap.get(key)
        if (minV !== undefined) ps.minValue = minV
        if (maxV !== undefined) ps.maxValue = maxV

        propertyStatsMap.set(key, ps)
      }

      // 保证至少有个默认属性
      if (propertyStatsMap.size === 0) {
        propertyStatsMap.set('id', { distinctValues: nodes.length, nullCount: 0 })
        propertyStatsMap.set('name', { distinctValues: nodes.length, nullCount: 0 })
      }

      // 按节点数比例分配边数
      const nodeFraction = nodes.length / Math.max(allNodes.length, 1)
      const estimatedEdges = Math.round(totalEdges * nodeFraction)

      typeStatsMap.set(tid, {
        typeId: tid,
        totalNodes: nodes.length,
        totalEdges: estimatedEdges,
        propertyStats: propertyStatsMap,
      })
    }

    // 如果没有数据，使用 engine stats 创建一个默认 typeId=1
    if (typeStatsMap.size === 0 && allNodes.length > 0) {
      const ps = new Map<string, PropertyStats>()
      ps.set('id', { distinctValues: allNodes.length, nullCount: 0 })
      ps.set('name', { distinctValues: allNodes.length, nullCount: 0 })

      typeStatsMap.set(1, {
        typeId: 1,
        totalNodes: allNodes.length,
        totalEdges,
        propertyStats: ps,
      })
    }

    return typeStatsMap
  }

  /**
   * 从 GraphEngine 获取所有节点。
   *
   * 优先使用 engine 的 getAllNodes 方法（如果存在），
   * 降级使用 getShardManager 的 getAllNodes（兼容旧 API）。
   */
  private async getAllNodesFromEngine(): Promise<NodeRecord[]> {
    const engine = this._engine as any

    // 尝试 engine.getAllNodes
    if (typeof engine.getAllNodes === 'function') {
      try {
        const nodes = await engine.getAllNodes()
        if (Array.isArray(nodes) && nodes.length > 0) return nodes
      } catch {
        // fall through
      }
    }

    // 尝试通过 engine._shardManager 获取
    if (typeof engine._shardManager?.getAllNodes === 'function') {
      try {
        const nodes = await engine._shardManager.getAllNodes()
        if (Array.isArray(nodes) && nodes.length > 0) return nodes
      } catch {
        // fall through
      }
    }

    return []
  }
}
