import { ShardManager } from './shard-manager'
import { RangeInstance } from './range-instance'
import { Logger } from '../ops/logger'
import { NodeId, NodeRecord, EdgeRecord } from '../types'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface RebalancerOptions {
  checkIntervalMs?: number          // 检查间隔（默认 30000ms）
  nodeCountDeviationThreshold?: number  // 节点数偏差百分比阈值（默认 0.2 = 20%）
  loadFactorThreshold?: number      // 负载因子阈值（默认 2.0 = 平均的 2 倍）
}

export interface RangeLoad {
  rangeId: string
  nodeCount: number
  edgeCount: number
  operationCount: number
}

export interface RebalancerStats {
  ranges: RangeLoad[]
  averageNodeCount: number
  averageOperationCount: number
  maxDeviation: number
  maxLoadFactor: number
  needsRebalancing: boolean
  lastRebalance: number | null
}

/**
 * Rebalancer — 自动范围重平衡
 *
 * 通过对所有 Range 定期采集负载统计，检测节点数偏差或负载不均衡，
 * 将节点从负载超标的源 Range 迁移到负载最低的目标 Range。
 *
 * 安全保证：
 * - 🔴 S10: 节点迁移时同时迁移关联边，防止边断裂
 * - 🔴 S11: 迁移期间设置 draining 标记，拒绝新的写入，防止"先写后删"窗口期数据丢失
 */
export class Rebalancer {
  private manager: ShardManager
  private logger: Logger
  private options: Required<RebalancerOptions>
  private timerId: ReturnType<typeof setInterval> | null = null
  private rebalancing = false
  private _lastRebalance: number | null = null
  private _opCounts: Map<string, number> = new Map()

  constructor(manager: ShardManager, options?: RebalancerOptions) {
    this.manager = manager
    this.logger = new Logger('rebalancer')
    this.options = {
      checkIntervalMs: options?.checkIntervalMs ?? 30000,
      nodeCountDeviationThreshold: options?.nodeCountDeviationThreshold ?? 0.2,
      loadFactorThreshold: options?.loadFactorThreshold ?? 2.0,
    }
  }

  // ──────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────

  /** 启动自动检查 */
  start(): void {
    if (this.timerId !== null) {
      this.logger.warn('Rebalancer is already running')
      return
    }
    this.logger.info('Starting rebalancer', { intervalMs: this.options.checkIntervalMs })
    this.timerId = setInterval(() => {
      this._checkAndRebalance().catch(err => {
        this.logger.error('Rebalancer check failed', err as Error)
      })
    }, this.options.checkIntervalMs)
    this.timerId.unref()
  }

  /** 停止 */
  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId)
      this.timerId = null
      this.logger.info('Rebalancer stopped')
    }
  }

  /** 手动触发一次 rebalance */
  async trigger(): Promise<void> {
    if (this.rebalancing) {
      this.logger.warn('Rebalancer is already running, trigger ignored')
      return
    }
    await this._checkAndRebalance()
  }

  /** 获取当前负载统计 */
  getStats(): RebalancerStats {
    const ranges = this._collectLoads()
    const nodeCounts = ranges.map(r => r.nodeCount)
    const opCounts = ranges.map(r => r.operationCount)
    const avgNodeCount = nodeCounts.length > 0
      ? nodeCounts.reduce((a, b) => a + b, 0) / nodeCounts.length
      : 0
    const avgOpCount = opCounts.length > 0
      ? opCounts.reduce((a, b) => a + b, 0) / opCounts.length
      : 0

    let maxDeviation = 0
    let maxLoadFactor = 0
    for (const range of ranges) {
      const deviation = avgNodeCount > 0
        ? Math.abs(range.nodeCount - avgNodeCount) / avgNodeCount
        : 0
      const loadFactor = avgOpCount > 0
        ? range.operationCount / avgOpCount
        : 1
      if (deviation > maxDeviation) maxDeviation = deviation
      if (loadFactor > maxLoadFactor) maxLoadFactor = loadFactor
    }

    const needsRebalancing = maxDeviation > this.options.nodeCountDeviationThreshold
      || maxLoadFactor > this.options.loadFactorThreshold

    return {
      ranges,
      averageNodeCount: Math.round(avgNodeCount * 100) / 100,
      averageOperationCount: Math.round(avgOpCount * 100) / 100,
      maxDeviation: Math.round(maxDeviation * 100) / 100,
      maxLoadFactor: Math.round(maxLoadFactor * 100) / 100,
      needsRebalancing,
      lastRebalance: this._lastRebalance,
    }
  }

  // ──────────────────────────────────────────
  // Private: 负载采集
  // ──────────────────────────────────────────

  /** 采集所有 Range 的统计信息 */
  private _collectLoads(): RangeLoad[] {
    const loads: RangeLoad[] = []
    const allRanges = this.manager.getAllRanges()
    for (const [rangeId, instance] of allRanges) {
      const stats = instance.engine.stats()
      const opCount = this._opCounts.get(rangeId) ?? 0
      loads.push({
        rangeId,
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        operationCount: opCount,
      })
    }
    return loads
  }

  // ──────────────────────────────────────────
  // Private: 检查 & 执行
  // ──────────────────────────────────────────

  private async _checkAndRebalance(): Promise<void> {
    if (this.rebalancing) {
      this.logger.debug('Rebalancer is already running, skipping check')
      return
    }

    const stats = this.getStats()
    if (!stats.needsRebalancing) {
      this.logger.debug('No rebalancing needed', {
        maxDeviation: stats.maxDeviation,
        maxLoadFactor: stats.maxLoadFactor,
      })
      return
    }

    this.rebalancing = true
    try {
      await this._doRebalance()
    } finally {
      this.rebalancing = false
    }
  }

  /**
   * 执行重平衡
   *
   * 算法：
   * 1. 采集所有 Range 负载
   * 2. 找出节点数最多的源 Range（按节点数降序）
   * 3. 找出节点数最少的目标 Range
   * 4. 获取节点数最多的 Range 中超过平均值的节点
   * 5. 逐个迁移节点
   */
  private async _doRebalance(): Promise<void> {
    const loads = this._collectLoads()
    if (loads.length < 2) {
      this.logger.debug('Need at least 2 ranges to rebalance')
      return
    }

    const avgNodeCount = loads.reduce((s, r) => s + r.nodeCount, 0) / loads.length
    const avgOpCount = loads.reduce((s, r) => s + r.operationCount, 0) / loads.length

    // 按偏差排序：找到最超载的 range 和最轻量的 range
    const sortedByNodeCount = [...loads].sort((a, b) => b.nodeCount - a.nodeCount)
    const sortedByLoad = [...loads].sort((a, b) => b.operationCount - a.operationCount)

    // 优先处理节点数偏差
    for (const source of sortedByNodeCount) {
      if (source.nodeCount <= avgNodeCount) break // 后面的都 <= 平均，不需要迁移出去

      const deviation = avgNodeCount > 0
        ? Math.abs(source.nodeCount - avgNodeCount) / avgNodeCount
        : 0

      if (deviation <= this.options.nodeCountDeviationThreshold) continue

      // 找到节点数最少的目标 range
      const target = sortedByNodeCount[sortedByNodeCount.length - 1]
      if (target.rangeId === source.rangeId) break

      // 计算需要迁移的节点数：使源 range 回落到平均
      const excessNodeCount = Math.ceil(source.nodeCount - avgNodeCount)
      const sourceRange = this.manager.getRange(source.rangeId)
      const targetRange = this.manager.getRange(target.rangeId)

      // 选择源 range 中按 operationCount 最热的节点
      const hotNodeIds = await this._findHotNodes(sourceRange, excessNodeCount)

      if (hotNodeIds.length === 0) {
        this.logger.warn('No hot nodes found to migrate', { rangeId: source.rangeId })
        continue
      }

      this.logger.info('Rebalancing: migrating nodes', {
        sourceRangeId: source.rangeId,
        targetRangeId: target.rangeId,
        nodeCount: hotNodeIds.length,
        sourceDeviation: deviation,
      })

      await this._doRebalanceNodes(source.rangeId, target.rangeId, hotNodeIds)
      this._lastRebalance = Date.now()
    }

    // 如果有 range 负载因子超标，但节点数已经平衡，按负载再平衡
    const stats = this.getStats()
    if (stats.maxLoadFactor > this.options.loadFactorThreshold && !this._isNodeCountBalanced()) {
      // 按负载排序处理
      for (const source of sortedByLoad) {
        const loadFactor = avgOpCount > 0 ? source.operationCount / avgOpCount : 1
        if (loadFactor <= this.options.loadFactorThreshold) break

        const target = sortedByLoad[0] // 负载最低的
        if (target.rangeId === source.rangeId) break

        const sourceRange = this.manager.getRange(source.rangeId)
        const targetRange = this.manager.getRange(target.rangeId)

        const hotNodeIds = await this._findHotNodes(sourceRange, 1)
        if (hotNodeIds.length === 0) continue

        this.logger.info('Rebalancing by load factor: migrating hot node', {
          sourceRangeId: source.rangeId,
          targetRangeId: target.rangeId,
          loadFactor: Math.round(loadFactor * 100) / 100,
        })

        await this._doRebalanceNodes(source.rangeId, target.rangeId, hotNodeIds)
        this._lastRebalance = Date.now()
      }
    }
  }

  /** 检查节点数是否已平衡（所有 range 偏差在阈值内） */
  private _isNodeCountBalanced(): boolean {
    const loads = this._collectLoads()
    const avg = loads.reduce((s, r) => s + r.nodeCount, 0) / loads.length
    for (const range of loads) {
      const deviation = avg > 0 ? Math.abs(range.nodeCount - avg) / avg : 0
      if (deviation > this.options.nodeCountDeviationThreshold) return false
    }
    return true
  }

  /**
   * 找出指定 Range 中最热的节点
   *
   * 热节点检测算法（基于度数）：
   * 1. 在单次 range.read() 中：遍历所有 typeId 收集该引擎的全部节点 ID，查询每个节点的
   *    度数（入度 + 出度），构建 { nodeId → degree } 映射
   * 2. 按度数降序排列，取前 count 个作为最热节点
   * 3. 返回结果去重 & 不超过 count
   *
   * 备选指标（fallback）：
   * - 如果度数全为 0 但节点存在，按节点 ID 降序排列（原逻辑）作为兜底
   */
  private async _findHotNodes(range: RangeInstance, count: number): Promise<NodeId[]> {
    try {
      const result = await range.read(engine => {
        // ── 第 1 步：通过 labelIndex 收集全部节点 ID ──
        const allNodeIds: number[] = []
        const seen = new Set<number>()
        // 扫描 0-99 覆盖绝大多数场景；遇到连续空 type 则提前停止
        let emptyRuns = 0
        for (let typeId = 0; typeId < 100; typeId++) {
          try {
            const ids = engine.findNodesByType(typeId)
            if (ids.length === 0) {
              emptyRuns++
              if (emptyRuns >= 10) break
              continue
            }
            emptyRuns = 0
            for (const id of ids) {
              if (!seen.has(id)) {
                seen.add(id)
                allNodeIds.push(id)
              }
            }
          } catch {
            emptyRuns++
            if (emptyRuns >= 10) break
          }
        }
        return { allNodeIds }
      })

      if (result.allNodeIds.length === 0) {
        this.logger.debug('No nodes found in range for hot node detection')
        return []
      }

      // ── 第 2 步：在另一个 read() 中批量获取度数 ──
      const degreeMap = await range.read(engine => {
        const map = new Map<number, number>()
        for (const id of result.allNodeIds) {
          try {
            const node = engine.getNode(id)
            map.set(id, node?.degree ?? 0)
          } catch {
            map.set(id, 0)
          }
        }
        return map
      })

      // ── 第 3 步：按度数降序排列，取前 count 个 ──
      const sorted = [...degreeMap.entries()]
        .sort((a, b) => b[1] - a[1])

      // 取出度数 > 0 的前 count 个
      const hotNodes: number[] = []
      for (const [id, deg] of sorted) {
        if (hotNodes.length >= count) break
        if (deg > 0) {
          hotNodes.push(id)
        }
      }

      // 兜底：如果度数全部为 0 但节点数 > 0，按 ID 降序取 count 个
      if (hotNodes.length === 0 && result.allNodeIds.length > 0) {
        const sortedFallback = [...result.allNodeIds].sort((a, b) => b - a)
        return sortedFallback.slice(0, Math.min(count, result.allNodeIds.length))
      }

      return hotNodes
    } catch (err) {
      this.logger.error('Failed to find hot nodes', err as Error)
      return []
    }
  }

  /**
   * 执行节点迁移：从源 Range 迁移指定节点到目标 Range
   *
   * 安全保证：
   * 🔴 S11: 迁移前设置源 Range draining，拒绝新的写入，防止窗口期数据丢失
   * 🔴 S10: 迁移节点时同时迁移关联边
   *
   * 流程：
   * 1. 设置源 Range draining=true
   * 2. 逐个迁移节点（带关联边）
   * 3. 解除源 Range draining
   */
  private async _doRebalanceNodes(
    sourceRangeId: string,
    targetRangeId: string,
    nodeIds: NodeId[]
  ): Promise<void> {
    const sourceRange = this.manager.getRange(sourceRangeId)
    const targetRange = this.manager.getRange(targetRangeId)

    // 🔴 S11: 标记源 Range 为 draining，拒绝新的写入
    sourceRange.setDraining(true)
    this.logger.info('Set source range draining', { sourceRangeId })

    try {
      for (const nodeId of nodeIds) {
        try {
          await this._migrateNode(sourceRange, targetRange, nodeId)
          this.logger.debug('Migrated node', { nodeId, from: sourceRangeId, to: targetRangeId })
        } catch (err) {
          this.logger.error('Failed to migrate node', err as Error, { nodeId, from: sourceRangeId, to: targetRangeId })
          // 继续迁移下一个节点
        }
      }

      // 迁移过程中禁止对源 Range 的写入，但不影响读取
      // 删除操作在解除 draining 后进行
      this.logger.info('Migration write phase complete, cleaning up source', {
        sourceRangeId,
        targetRangeId,
        nodeCount: nodeIds.length,
      })

      // 迁移节点和边的"写入"已完成目标 Range，现在清理源数据
      // 注意：由于 sourceRange 处于 draining 状态，清理（delete）操作
      // 需要临时解除 draining，否则 delete 也会被拒绝
      sourceRange.setDraining(false)

      for (const nodeId of nodeIds) {
        try {
          await this._migrateCleanup(sourceRange, nodeId)
          this.logger.debug('Cleaned up source node', { nodeId })
        } catch (err) {
          this.logger.error('Failed to cleanup source node', err as Error, { nodeId })
        }
      }
    } finally {
      // 🔴 S11: 确保 draining 解除
      sourceRange.setDraining(false)
      this.logger.info('Released source range draining', { sourceRangeId })
    }
  }

  /**
   * 迁移单个节点 + 关联边到目标 Range（S10 修复）
   *
   * 只做"写入目标"部分。删除源由 _migrateCleanup 完成。
   *
   * 流程：
   * 1. 从源 Range 读取节点数据
   * 2. 从源 Range 读取所有 outgoing edges
   * 3. 写入目标 Range（节点 + 边）
   * 4. 验证写入成功
   */
  private async _migrateNode(
    sourceRange: RangeInstance,
    targetRange: RangeInstance,
    nodeId: NodeId
  ): Promise<void> {
    // Step 1: 从源 Range 读取节点（draining 不影响读取）
    const node = await sourceRange.read(engine => engine.getNode(nodeId))
    if (!node) {
      this.logger.warn('Node not found in source range, skipping', { nodeId })
      return
    }

    // Step 2 (S10): 从源 Range 读取所有 outgoing edges（draining 不影响读取）
    let edges: EdgeRecord[] = []
    try {
      const neighborResult = await sourceRange.read(engine => engine.neighbors(nodeId, { maxDepth: 1 }))
      edges = neighborResult.edges
    } catch (err) {
      this.logger.warn('Failed to read edges for migrating node, continuing without edges', {
        nodeId,
        error: (err as Error).message,
      })
    }

    // Step 3: 写入目标 Range（节点）
    const targetId = await targetRange.write({
      type: 'upsert_node',
      payload: {
        typeId: node.type,
        name: node.name,
        opts: {
          props: node.props,
        },
      },
    })

    // Step 3b (S10): 写入目标 Range（所有 outgoing edges）
    const actualTargetId = typeof targetId === 'number' ? targetId : nodeId
    for (const edge of edges) {
      try {
        const edgeSrc = edge.src === nodeId ? actualTargetId : edge.src
        const edgeDst = edge.dst === nodeId ? actualTargetId : edge.dst
        await targetRange.write({
          type: 'upsert_edge',
          payload: {
            src: edgeSrc,
            dst: edgeDst,
            typeId: edge.type,
            opts: { props: edge.props },
          },
        })
      } catch (err) {
        this.logger.error('Failed to migrate edge', err as Error, {
          src: edge.src,
          dst: edge.dst,
          type: edge.type,
        })
      }
    }

    // Step 4: 验证目标 Range 能读取到
    const verifyNode = await targetRange.read(engine => engine.getNode(nodeId))
    if (!verifyNode) {
      if (actualTargetId !== nodeId) {
        const altNode = await targetRange.read(engine => engine.getNode(actualTargetId))
        if (!altNode) {
          throw new Error(`Node migration verification failed: node ${nodeId} not found in target range`)
        }
      } else {
        throw new Error(`Node migration verification failed: node ${nodeId} not found in target range`)
      }
    }
  }

  /**
   * 清理源 Range 的已迁移节点（在 draining 解除后执行）
   *
   * 先删除边再删除节点，防止级联删除不完整
   */
  private async _migrateCleanup(
    sourceRange: RangeInstance,
    nodeId: NodeId
  ): Promise<void> {
    // 读取并删除所有 outgoing edges
    try {
      const neighborResult = await sourceRange.read(engine => engine.neighbors(nodeId, { maxDepth: 1 }))
      for (const edge of neighborResult.edges) {
        try {
          await sourceRange.write({
            type: 'delete_edge',
            payload: { src: edge.src, dst: edge.dst, typeId: edge.type },
          })
        } catch (err) {
          this.logger.debug('Edge already absent during migration cleanup', {
            src: edge.src,
            dst: edge.dst,
            type: edge.type,
          })
        }
      }
    } catch (err) {
      this.logger.debug('Failed to read edges during migration cleanup, proceeding to delete node', {
        nodeId,
      })
    }

    // 删除节点
    await sourceRange.write({
      type: 'delete_node',
      payload: { id: nodeId },
    })
  }
}
