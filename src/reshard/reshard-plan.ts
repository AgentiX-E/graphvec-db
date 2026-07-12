import { ShardMap, ReshardingPlan, ReshardSplit } from '../types'
import * as crypto from 'crypto'

/**
 * ReshardPlan — Shard Plan Generator
 *
 * Scan all Range sizes and loads, decide whether splitting is needed
 * Trigger conditions:
 * - Range node count > 10,000 (configurable)
 * - Throughput > 10K ops/s (configurable)
 *
 * Plan generation:
 * 1. Split Ranges that exceed threshold
 * 2. Insert new virtual nodes into the consistent hash ring
 * 3. Calculate data range (evenly split based on hash range)
 *
 * Improvements:
 * - targetRangeId generated using hash+index for predictability
 * - hashRangeStart/End evenly split based on source range hash range
 */
export class ReshardPlan {
  /**
   * Generate Resharding plan
   * @returns ReshardingPlan | null（null = no Resharding needed）
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
        // This Range needs splitting

        // Predictable targetRangeId based on hash+index
        const hashStr = crypto
          .createHash('md5')
          .update(`${r.rangeId}-split-${i}`)
          .digest('hex')
          .slice(0, 8)
        const targetRangeId = `${r.rangeId}-split-${hashStr}`

        // Find source range's hashRing position, determine its hash range
        const ringSize = 2147483647
        let hashRangeStart = 0
        let hashRangeEnd = ringSize

        if (shardMap.hashRing && shardMap.hashRing.nodes.length > 0) {
          const sortedNodes = [...shardMap.hashRing.nodes].sort((a, b) => {
            const hashA = parseInt(a.hash.replace('0x', ''), 16)
            const hashB = parseInt(b.hash.replace('0x', ''), 16)
            return hashA - hashB
          })

          // Find hash node position corresponding to current range
          const currentIdx = sortedNodes.findIndex(n => n.rangeId === r.rangeId)
          if (currentIdx >= 0) {
            const currentHash = parseInt(sortedNodes[currentIdx].hash.replace('0x', ''), 16)
            const prevNode = currentIdx > 0 ? sortedNodes[currentIdx - 1] : sortedNodes[sortedNodes.length - 1]
            const prevHash = parseInt(prevNode.hash.replace('0x', ''), 16)

            hashRangeStart = prevHash
            hashRangeEnd = currentHash

            // Handle ring wrap-around
            if (hashRangeEnd <= hashRangeStart) {
              hashRangeEnd = ringSize
              hashRangeStart = 0
            }
          }
        }

        // Evenly split hashRange into two halves
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
      .update(`plan-${shardMap.version}-${splits.length}-${Date.now()}-${Math.random()}`)
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
   * Estimate migration cost
   */
  estimateCost(split: ReshardSplit, sourceNodeCount: number): {
    estimatedBytes: number
    estimatedDurationMs: number
  } {
    // Assume each node ~200 bytes (including vectors)
    const avgNodeSize = 200
    const targetNodes = Math.floor(sourceNodeCount / 2) // approximate
    return {
      estimatedBytes: targetNodes * avgNodeSize,
      estimatedDurationMs: targetNodes * 0.5, // ~0.5ms per node
    }
  }
}
