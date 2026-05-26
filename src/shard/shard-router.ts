import * as path from 'node:path'
import * as fs from 'node:fs'
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
