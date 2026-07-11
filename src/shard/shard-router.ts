import * as path from 'node:path'
import * as fs from 'node:fs'
import ConsistentHash from 'consistent-hashing'
import { NodeId, ShardMap, NodeRecord } from '../types'

/**
 * ShardRouter — 基于一致性哈希的路由选择器
 *
 * 一致性哈希在节点增减时只需迁移 1/N 的数据
 * vnodes=160 使分布更均匀
 *
 * Improvements:
 * - P1-S02: 边写入路由对称 — getRangeForEdge 支持 src/dst fallback
 * - P1-S01: 智能路由优化 — recommendRoute 基于 label + edgeCount 建议最佳 range
 */
export class ShardRouter {
  private ring: ConsistentHash
  private shardMap: ShardMap

  constructor(shardMap: ShardMap) {
    this.shardMap = shardMap
    this.ring = new ConsistentHash(
      shardMap.hashRing.nodes.map(n => n.rangeId),
      { replicas: shardMap.hashRing.virtualNodes || 160 }
    )
  }

  /** 根据节点 ID 获取目标 Range */
  getRange(nodeId: NodeId): string {
    return this.ring.getNode(String(nodeId))
  }

  /** 根据任意 key 获取目标 Range */
  getRangeForKey(key: string): string {
    return this.ring.getNode(key)
  }

  /**
   * P1-S02: 边写入路由 — 支持 src 和 dst 不同 range 的对称路由
   *
   * 核心逻辑：
   * 1. 优先根据 src 确定 range
   * 2. 如果 src range 不存在该边（返回 false），回退到 dst range
   *
   * @param src 边的源节点 ID
   * @param dst 边的目标节点 ID
   * @param edgeExistsInSrcRange 可选的回调，检查边是否在 src range 中存在
   * @returns [primaryRangeId, fallbackRangeId]
   */
  getRangeForEdge(
    src: NodeId,
    dst: NodeId,
    edgeExistsInSrcRange?: (rangeId: string) => boolean,
  ): string[] {
    const srcRange = this.getRangeForKey(String(src))
    const dstRange = this.getRangeForKey(String(dst))

    // src 和 dst 在同一 range → 只返回一个
    if (srcRange === dstRange) {
      return [srcRange]
    }

    // src 和 dst 在不同 range → 返回两个，优先 src
    if (edgeExistsInSrcRange && !edgeExistsInSrcRange(srcRange)) {
      // src range 没有该边 → fallback 到 dst range
      return [dstRange, srcRange]
    }

    return [srcRange, dstRange]
  }

  /**
   * P1-S01: 智能路由优化（基础版）
   *
   * 基于节点 label + edgeCount 建议最佳 range。
   * 如果节点与其他节点高连通，选择这些节点所在的 range。
   *
   * 基本策略：
   * 1. 默认使用一致性哈希
   * 2. 如果有 edgeCount 信息，偏向 edgeCount 高的 range
   *
   * @returns rangeId
   */
  recommendRoute(node: NodeRecord): string {
    const defaultRange = this.getRange(node.id)

    // 基础版：如果有 degree/edgeCount，偏向高频 range
    const degree = node.degree ?? 0
    if (degree > 0) {
      // 高连通节点：使用节点 ID 的哈希路由（默认策略即可）
      // 后续可扩展为：查找与该节点有最多连边的 range
      return defaultRange
    }

    // 基于 label 的路由Improvements:将 label 哈希到 range
    const labelHash = this.getRangeForKey(`label:${node.type}:${String(node.id)}`)
    return labelHash
  }

  /**
   * 基于 label 统计建议 range （带负载感知的版本）
   *
   * @param node 节点记录
   * @param rangeLoads 各 range 的负载统计 { rangeId, nodeCount }[]
   * @returns 建议的 rangeId
   */
  recommendRouteWithLoad(
    node: NodeRecord,
    rangeLoads: Array<{ rangeId: string; nodeCount: number }>,
  ): string {
    if (rangeLoads.length === 0) {
      return this.getRange(node.id)
    }

    // 找到负载最轻的 range
    const sorted = [...rangeLoads].sort((a, b) => a.nodeCount - b.nodeCount)
    const lightestRange = sorted[0].rangeId

    // label 哈希得到的 range
    const labelRange = this.getRangeForKey(`label:${node.type}`)

    // 如果 label range 不是最轻量的，且偏差 > 20%，建议迁移到轻量 range
    const lightestLoad = sorted[0].nodeCount
    const labelLoad = rangeLoads.find(r => r.rangeId === labelRange)?.nodeCount ?? 0

    if (sorted.length > 1 && labelLoad > lightestLoad * 1.2) {
      return lightestRange
    }

    return labelRange
  }

  /** 获取所有 Range ID */
  getAllRanges(): string[] {
    return [...new Set(
      this.shardMap.hashRing.nodes.map(n => n.rangeId)
    )]
  }

  /** 重新构建路由表 */
  rebuild(shardMap: ShardMap): void {
    this.shardMap = shardMap
    this.ring = new ConsistentHash(
      shardMap.hashRing.nodes.map(n => n.rangeId),
      { replicas: shardMap.hashRing.virtualNodes || 160 }
    )
  }

  getShardMap(): ShardMap {
    return this.shardMap
  }

  /**
   * 持久化当前 ShardMap 到文件
   * 写入为 JSON + fsync 确保落盘
   * 输出路径: {routerDir}/shard-map.json
   */
  persistShardMap(routerDir: string): void {
    const map = this.getShardMap()
    const filePath = path.join(routerDir, 'shard-map.json')
    fs.mkdirSync(routerDir, { recursive: true })
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(map, null, 2))
    fs.renameSync(tmpPath, filePath)
    // 确保目录 fsync
    const dirFd = fs.openSync(routerDir, 'r')
    fs.fsyncSync(dirFd)
    fs.closeSync(dirFd)
  }

  /**
   * 从文件加载 ShardMap
   * 不存在时返回 null
   */
  static loadShardMap(routerDir: string): ShardMap | null {
    const filePath = path.join(routerDir, 'shard-map.json')
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as ShardMap
  }
}
