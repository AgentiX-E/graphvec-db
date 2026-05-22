import ConsistentHash from 'consistent-hashing'
import { NodeId, ShardMap } from '../types'

/**
 * ShardRouter — 基于一致性哈希的路由选择器
 *
 * 一致性哈希在节点增减时只需迁移 1/N 的数据
 * vnodes=160 使分布更均匀
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
}
