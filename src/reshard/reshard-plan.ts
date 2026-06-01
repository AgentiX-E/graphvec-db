import { ShardMap, ReshardingPlan, ReshardSplit } from '../types'
import * as crypto from 'crypto'

/**
 * ReshardPlan — 分片计划生成器
 *
 * 扫描所有 Range 的大小和负载，决定是否需要拆分
 * 触发条件：
 * - Range 节点数 > 10,000（可配）
 * - 吞吐量 > 10K ops/s（可配）
 *
 * 计划生成：
 * 1. 对超过阈值的 Range 进行 split
 * 2. 在一致性哈希环插入新虚拟节点
 * 3. 计算数据范围（基于 hash 范围均匀分割）
 *
 * 改进：
 * - targetRangeId 使用 hash+index 生成，确保可预测
 * - hashRangeStart/End 基于源 range 的 hash 范围均匀分割
 */
export class ReshardPlan {
  /**
   * 生成 Resharding 计划
   * @returns ReshardingPlan | null（null = 无需 Resharding）
   */
  generatePlan(
    shardMap: ShardMap,
    ranges: { rangeId: string; nodeCount: number; opsPerSec?: number }[],
    threshold: { maxNodes?: number; maxOpsPerSec?: number } = {}
  ): ReshardingPlan | null {
    const maxNodes = threshold.maxNodes ?? 10000
    const splits: ReshardSplit[] = []

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (r.nodeCount > maxNodes || (r.opsPerSec && r.opsPerSec > (threshold.maxOpsPerSec ?? 10000))) {
        // 此 Range 需要拆分

        // 基于 hash+index 的可预测 targetRangeId
        const hashStr = crypto
          .createHash('md5')
          .update(`${r.rangeId}-split-${i}`)
          .digest('hex')
          .slice(0, 8)
        const targetRangeId = `${r.rangeId}-split-${hashStr}`

        // 查找源 range 的 hashRing 位置，确定它的 hash 范围
        const ringSize = 2147483647
        let hashRangeStart = 0
        let hashRangeEnd = ringSize

        if (shardMap.hashRing && shardMap.hashRing.nodes.length > 0) {
          const sortedNodes = [...shardMap.hashRing.nodes].sort((a, b) => {
            const hashA = parseInt(a.hash.replace('0x', ''), 16)
            const hashB = parseInt(b.hash.replace('0x', ''), 16)
            return hashA - hashB
          })

          // 找到当前 range 对应的 hash 节点位置
          const currentIdx = sortedNodes.findIndex(n => n.rangeId === r.rangeId)
          if (currentIdx >= 0) {
            const currentHash = parseInt(sortedNodes[currentIdx].hash.replace('0x', ''), 16)
            const prevNode = currentIdx > 0 ? sortedNodes[currentIdx - 1] : sortedNodes[sortedNodes.length - 1]
            const prevHash = parseInt(prevNode.hash.replace('0x', ''), 16)

            hashRangeStart = prevHash
            hashRangeEnd = currentHash

            // 处理环wrap-around
            if (hashRangeEnd <= hashRangeStart) {
              hashRangeEnd = ringSize
              hashRangeStart = 0
            }
          }
        }

        // 将 hashRange 均匀分割成两半
        const midPoint = hashRangeStart + Math.floor((hashRangeEnd - hashRangeStart) / 2)

        splits.push({
          sourceRangeId: r.rangeId,
          targetRangeId,
          hashRangeStart: hashRangeStart,
          hashRangeEnd: midPoint,
          targetNodeId: `node-${targetRangeId}`,
          targetDataDir: `./data/${targetRangeId}`,
        })
      }
    }

    if (splits.length === 0) return null

    const planIdHash = crypto
      .createHash('md5')
      .update(`plan-${shardMap.version}-${splits.length}`)
      .digest('hex')
      .slice(0, 12)

    return {
      planId: `plan-${planIdHash}`,
      version: shardMap.version + 1,
      splits,
      createdAt: Date.now(),
      estimatedDurationMs: splits.length * 30000, // ~30s per split
    }
  }

  /**
   * 估算迁移成本
   */
  estimateCost(split: ReshardSplit, sourceNodeCount: number): {
    estimatedBytes: number
    estimatedDurationMs: number
  } {
    // 假设每个节点 ~200 bytes (包括向量)
    const avgNodeSize = 200
    const targetNodes = Math.floor(sourceNodeCount / 2) // 近似
    return {
      estimatedBytes: targetNodes * avgNodeSize,
      estimatedDurationMs: targetNodes * 0.5, // ~0.5ms per node
    }
  }
}
