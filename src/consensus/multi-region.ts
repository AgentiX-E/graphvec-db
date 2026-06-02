/**
 * multi-region.ts — 多数据中心拓扑与延迟感知路由
 *
 * 扩展 multi-leader-replication.ts 以支持跨 DC 部署：
 *   1. MultiRegionTopology — 维护 region 映射、延迟表、partition 归属
 *   2. LatencyAwareRouter — 请求路由到最近 region
 *   3. sourceRegion 标记 — 附着在 WriteOperation 上
 *   4. PartitionPriority — 网络分区时降级策略
 *
 * 使用方式:
 *   const topology = new MultiRegionTopology({
 *     regions: { dc1: ['node-1', 'node-2'], dc2: ['node-3'] },
 *     latencies: { 'dc1:dc2': 50 },
 *     currentNodeId: 'node-1',
 *   })
 *   const router = new LatencyAwareRouter(topology)
 *   const preferred = router.getPreferredNode('dc1') // 'node-1' or 'node-2'
 */

import type { TopologyType } from '../core/multi-leader-replication'

// ── Types ─────────────────────────────────────────────────

/** Region（数据中心/可用区）定义 */
export interface RegionDef {
  /** Region ID（如 'dc-east', 'dc-west'） */
  id: string
  /** 所属节点 ID 列表 */
  nodeIds: string[]
  /** Region 标签（如 'us-east-1', 'cn-shanghai'） */
  labels?: string[]
}

/** 延迟表 — region-pair → 延迟（ms），单位毫秒 */
export type LatencyTable = Record<string, number>

/** 多 DC 拓扑配置 */
export interface MultiRegionConfig {
  /** Region 映射：regionId → RegionDef */
  regions: Record<string, RegionDef>
  /** 延迟表（可选），格式 'dc1:dc2' → 延迟 ms */
  latencies?: LatencyTable
  /** 当前节点 ID */
  currentNodeId: string
  /** 拓扑类型（默认 'cross-dc'） */
  topologyType?: TopologyType
  /** 跨 DC 复制退避放大倍数（默认 2 — 即 intra-DC backoff × 2） */
  crossDcBackoffMultiplier?: number
  /** 心跳超时（ms），超过视为网络分区，默认 30000 */
  heartbeatTimeoutMs?: number
  /** partition 归属配置：partitionId → regionId */
  partitionRegions?: Record<string, string>
}

/** 分区归属信息 */
export interface PartitionAssignment {
  partitionId: string
  primaryRegion: string
  replicaRegions: string[]
}

/** 网络分区状态 */
export interface PartitionState {
  regionA: string
  regionB: string
  detectedAt: number
  strategy: PartitionRecoveryStrategy
  resolved: boolean
}

/** 分区恢复策略 */
export type PartitionRecoveryStrategy = 'lww' | 'ignore' | 'crdt'

/** WriteOperation 上携带的 sourceRegion 标记 */
export interface WriteSourceMark {
  sourceRegion: string
  sourceNodeId: string
  timestamp: number
}

// ── MultiRegionTopology ────────────────────────────────────

/**
 * MultiRegionTopology — 多数据中心拓扑管理
 *
 * 核心职责：
 *   - 维护 region → nodeIds 映射
 *   - 管理 region 间延迟表
 *   - 记录 partition 归属
 *   - 检测网络分区并切换策略
 */
export class MultiRegionTopology {
  private _regions: Map<string, RegionDef> = new Map()
  private _latencies: Map<string, number> = new Map()
  private _currentNodeId: string
  private _topologyType: TopologyType
  private _crossDcBackoffMultiplier: number
  private _heartbeatTimeoutMs: number
  private _partitionRegions: Map<string, string> = new Map()
  private _partitionStates: Map<string, PartitionState> = new Map()
  private _lastHeartbeats: Map<string, number> = new Map()

  constructor(config: MultiRegionConfig) {
    this._currentNodeId = config.currentNodeId
    this._topologyType = config.topologyType ?? 'cross-dc'
    this._crossDcBackoffMultiplier = config.crossDcBackoffMultiplier ?? 2
    this._heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 30000

    // Load regions
    for (const [id, def] of Object.entries(config.regions)) {
      this._regions.set(id, { ...def })
    }

    // Load latencies
    if (config.latencies) {
      for (const [key, value] of Object.entries(config.latencies)) {
        this._latencies.set(key, value)
      }
    }

    // Load partition regions
    if (config.partitionRegions) {
      for (const [partitionId, regionId] of Object.entries(config.partitionRegions)) {
        this._partitionRegions.set(partitionId, regionId)
      }
    }
  }

  // ── Region queries ─────────────────────────────────────

  /** 获取所有 region */
  getRegions(): RegionDef[] {
    return Array.from(this._regions.values())
  }

  /** 获取指定 region */
  getRegion(regionId: string): RegionDef | undefined {
    return this._regions.get(regionId)
  }

  /** 获取当前节点所属 regionId */
  getCurrentRegion(): string | undefined {
    for (const [id, def] of this._regions) {
      if (def.nodeIds.includes(this._currentNodeId)) {
        return id
      }
    }
    return undefined
  }

  /** 当前节点 ID */
  get currentNodeId(): string {
    return this._currentNodeId
  }

  /** 获取 topology 类型 */
  get topologyType(): TopologyType {
    return this._topologyType
  }

  /** 获取跨 DC 退避放大倍数 */
  get crossDcBackoffMultiplier(): number {
    return this._crossDcBackoffMultiplier
  }

  /** 获取当前 region 的所有节点 id */
  getCurrentRegionNodeIds(): string[] {
    const regionId = this.getCurrentRegion()
    if (!regionId) return []
    return this._regions.get(regionId)?.nodeIds ?? []
  }

  // ── Latency ─────────────────────────────────────────────

  /** 获取两 region 间的延迟（ms） */
  getLatency(regionA: string, regionB: string): number {
    if (regionA === regionB) return 0
    const key1 = `${regionA}:${regionB}`
    const key2 = `${regionB}:${regionA}`
    return this._latencies.get(key1) ?? this._latencies.get(key2) ?? -1
  }

  /** 设置 region 间延迟 */
  setLatency(regionA: string, regionB: string, latency: number): void {
    const key = `${regionA}:${regionB}`
    this._latencies.set(key, latency)
  }

  /** 获取所有延迟条目 */
  getLatencies(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [key, value] of this._latencies) {
      result[key] = value
    }
    return result
  }

  /** 判断两个 region 是否在同一个 DC（根据延迟表） */
  isInSameDc(regionA: string, regionB: string): boolean {
    const latency = this.getLatency(regionA, regionB)
    return latency >= 0 && latency < 10 // < 10ms 视为同一 DC
  }

  // ── Partition routing ──────────────────────────────────

  /** 获取 partition 归属 */
  getPartitionAssignment(partitionId: string): PartitionAssignment | undefined {
    const primaryRegion = this._partitionRegions.get(partitionId)
    if (!primaryRegion) return undefined
    return {
      partitionId,
      primaryRegion,
      replicaRegions: this._regions
        .get(primaryRegion)
        ?.nodeIds.filter(n => n !== this._currentNodeId) ?? [],
    }
  }

  /** 设置 partition 归属 */
  setPartitionRegion(partitionId: string, regionId: string): void {
    this._partitionRegions.set(partitionId, regionId)
  }

  /** 获取所有 partition 归属 */
  getPartitionAssignments(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [partitionId, regionId] of this._partitionRegions) {
      result[partitionId] = regionId
    }
    return result
  }

  // ── Heartbeat & partition detection ─────────────────────

  /** 记录从指定 peer 收到的心跳 */
  recordHeartbeat(nodeId: string): void {
    this._lastHeartbeats.set(nodeId, Date.now())
  }

  /** 检查 peer 是否存活（未超时） */
  isPeerAlive(nodeId: string): boolean {
    const last = this._lastHeartbeats.get(nodeId)
    if (last === undefined) return false
    return (Date.now() - last) < this._heartbeatTimeoutMs
  }

  /** 检测并返回网络分区列表 */
  detectPartitions(): PartitionState[] {
    const detected: PartitionState[] = []
    const regions = Array.from(this._regions.keys())

    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const ra = regions[i]
        const rb = regions[j]
        const regionA = this._regions.get(ra)!
        const regionB = this._regions.get(rb)!

        // 检查 region A 中的节点是否能看到 region B 中的节点
        let allDead = true
        for (const nodeA of regionA.nodeIds) {
          for (const nodeB of regionB.nodeIds) {
            if (this.isPeerAlive(nodeB)) {
              allDead = false
              break
            }
          }
          if (!allDead) break
        }

        if (allDead) {
          // 检查是否已有未解决的记录
          const key = [ra, rb].sort().join(':')
          const existing = this._partitionStates.get(key)
          if (!existing || existing.resolved) {
            const state: PartitionState = {
              regionA: ra,
              regionB: rb,
              detectedAt: Date.now(),
              strategy: 'ignore',
              resolved: false,
            }
            this._partitionStates.set(key, state)
            detected.push(state)
          } else {
            detected.push(existing)
          }
        }
      }
    }

    return detected
  }

  /** 设置分区恢复策略 */
  setPartitionStrategy(
    regionA: string,
    regionB: string,
    strategy: PartitionRecoveryStrategy,
  ): void {
    const key = [regionA, regionB].sort().join(':')
    const existing = this._partitionStates.get(key)
    if (existing) {
      existing.strategy = strategy
    } else {
      this._partitionStates.set(key, {
        regionA,
        regionB,
        detectedAt: Date.now(),
        strategy,
        resolved: false,
      })
    }
  }

  /** 标记分区已恢复 */
  resolvePartition(regionA: string, regionB: string): void {
    const key = [regionA, regionB].sort().join(':')
    const state = this._partitionStates.get(key)
    if (state) {
      state.resolved = true
    }
  }

  /** 获取所有分区状态 */
  getPartitionStates(): PartitionState[] {
    return Array.from(this._partitionStates.values())
  }

  /** 根据拓扑类型计算退避值（ms） */
  computeBackoffFor(topologyType?: TopologyType): number {
    const t = topologyType ?? this._topologyType
    switch (t) {
      case 'intra-dc': return 3000    // 3s
      case 'cross-dc': return 60000   // 60s
      case 'edge': return 300000      // 300s
    }
  }

  /**
   * 为跨 DC 对等节点计算放大后的退避时间。
   * 根据两 region 的判断决定使用 cross-dc 还是 intra-dc 退避。
   */
  computeCrossDcBackoffIfNeeded(regionA: string, regionB: string): number {
    if (regionA === regionB) {
      return this.computeBackoffFor('intra-dc')
    }

    let isCrossDc = true
    if (this._regions.has(regionA) && this._regions.has(regionB)) {
      isCrossDc = !this.isInSameDc(regionA, regionB)
    }

    if (isCrossDc) {
      return this.computeBackoffFor('cross-dc') * this._crossDcBackoffMultiplier
    }
    return this.computeBackoffFor('intra-dc')
  }
}

// ── LatencyAwareRouter ─────────────────────────────────────

/**
 * LatencyAwareRouter — 延迟感知路由选择器
 *
 * 根据 MultiRegionTopology 选择最近的节点：
 *   1. 优先本 region 节点
 *   2. 可选按延迟排序的所有节点
 *   3. 支持按 partition 归属路由
 */
export class LatencyAwareRouter {
  private _topology: MultiRegionTopology

  constructor(topology: MultiRegionTopology) {
    this._topology = topology
  }

  /**
   * 获取指定 region 中优先使用的节点。
   * 本 region 中优先返回非当前节点的其他节点（用于读副本），
   * 如果没有，返回当前节点。
   */
  getPreferredNode(regionId?: string): string | undefined {
    const effectiveRegion = regionId ?? this._topology.getCurrentRegion()
    if (!effectiveRegion) return undefined

    const region = this._topology.getRegion(effectiveRegion)
    if (!region) return undefined

    const candidates = region.nodeIds
    if (candidates.length === 0) return undefined

    // 优先返回其他节点（读负载分散）
    const others = candidates.filter(n => n !== this._topology.currentNodeId)
    if (others.length > 0) return others[0]

    // 只剩当前节点
    return candidates[0]
  }

  /**
   * 按延迟升序返回所有 region 的节点列表
   */
  getNodesByLatency(): Array<{ nodeId: string; regionId: string; latency: number }> {
    const currentRegion = this._topology.getCurrentRegion()
    const allNodes: Array<{ nodeId: string; regionId: string; latency: number }> = []

    for (const region of this._topology.getRegions()) {
      const latency = currentRegion
        ? this._topology.getLatency(currentRegion, region.id)
        : 0
      for (const nodeId of region.nodeIds) {
        allNodes.push({ nodeId, regionId: region.id, latency: Math.max(0, latency) })
      }
    }

    // 按延迟升序排列
    allNodes.sort((a, b) => a.latency - b.latency)
    return allNodes
  }

  /**
   * 获取 partition 关联的 region 的优先读节点
   */
  getPreferredNodeForPartition(partitionId: string): string | undefined {
    const assignment = this._topology.getPartitionAssignment(partitionId)
    if (!assignment) return this.getPreferredNode()

    // 优先从 partition 的 primary region 读取
    const preferred = this.getPreferredNode(assignment.primaryRegion)
    if (preferred !== undefined) return preferred

    // fallback: 任何 replica region
    for (const replica of assignment.replicaRegions) {
      const node = this.getPreferredNode(replica)
      if (node !== undefined) return node
    }

    return this.getPreferredNode()
  }

  /**
   * 创建 WriteSourceMark 标记
   */
  createWriteMark(): WriteSourceMark {
    return {
      sourceRegion: this._topology.getCurrentRegion() ?? 'unknown',
      sourceNodeId: this._topology.currentNodeId,
      timestamp: Date.now(),
    }
  }
}

// ── PartitionPriority ─────────────────────────────────────

/**
 * PartitionPriority — 分区优先级策略
 *
 * 网络分区时的读写降级策略：
 *   - 'lww':   Last-Writer-Wins — 允许写入，恢复时合并
 *   - 'ignore': 忽略远程更新 — 只处理本地写入
 *   - 'crdt':  CRDT 合并 — 每个分区独立写入，恢复后合并
 */
export class PartitionPriority {
  private _defaultStrategy: PartitionRecoveryStrategy
  private _topology: MultiRegionTopology
  private _localOnly: boolean = false

  constructor(
    topology: MultiRegionTopology,
    defaultStrategy: PartitionRecoveryStrategy = 'ignore',
  ) {
    this._topology = topology
    this._defaultStrategy = defaultStrategy
  }

  /** 获取分区后应使用的策略 */
  getStrategy(): PartitionRecoveryStrategy {
    if (this._localOnly) return 'ignore'
    const partitions = this._topology.detectPartitions()
    if (partitions.length === 0) return this._defaultStrategy
    // 取第一个未解决分区的策略
    for (const p of partitions) {
      if (!p.resolved) return p.strategy
    }
    return this._defaultStrategy
  }

  /** 是否允许本地写入 */
  canWriteLocally(): boolean {
    const strategy = this.getStrategy()
    // 'ignore' 和 'lww' 允许本地写入；'crdt' 也允许
    return true
  }

  /** 是否应该忽略远程复制 */
  shouldIgnoreRemote(): boolean {
    return this.getStrategy() === 'ignore'
  }

  /** 是否使用 CRDT 合并 */
  useCrdtMerge(): boolean {
    return this.getStrategy() === 'crdt'
  }

  /** 强制设置本地只读模式 */
  setLocalOnly(localOnly: boolean): void {
    this._localOnly = localOnly
  }

  /** 设置默认策略 */
  setDefaultStrategy(strategy: PartitionRecoveryStrategy): void {
    this._defaultStrategy = strategy
  }
}
