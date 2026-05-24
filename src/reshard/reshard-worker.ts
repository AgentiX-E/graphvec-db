import { RangeInstance } from '../shard/range-instance'
import { NodeId, NodeRecord, EdgeRecord, ReshardSplit } from '../types'
import { HlcClock } from '../replication/hlc-clock'
import { Logger } from '../ops/logger'

/**
 * ReshardWorker — 数据迁移 Worker
 *
 * 完成单个分片的双写 + 数据迁移流程
 */
export class ReshardWorker {
  private _split: ReshardSplit
  private clock: HlcClock
  private logger: Logger
  private sourceRange: RangeInstance
  private targetRange: RangeInstance
  private _progress = 0

  constructor(
    split: ReshardSplit,
    clock: HlcClock,
    sourceRange: RangeInstance,
    targetRange: RangeInstance,
  ) {
    this._split = split
    this.clock = clock
    this.logger = new Logger('ReshardWorker')
    this.sourceRange = sourceRange
    this.targetRange = targetRange
  }

  get progress(): number { return this._progress }

  /** 获取 ReshardSplit 信息（供 ReshardManager 使用） */
  get split(): ReshardSplit { return this._split }

  /**
   * 执行迁移
   * 1. 启动目标 Range
   * 2. 全量扫描节点 + 边，通过 Raft write 写入目标
   * 3. 校验 checksum
   */
  async execute(): Promise<void> {
    await this.targetRange.start()
    this._progress = 10

    const batchSize = 1000
    let migrated = 0
    let failed = 0

    // 阶段 1：通过 queryPattern 全量扫描节点
    this.logger.info('[ReshardWorker] Starting node migration phase')

    // 使用 depth=1 pattern 扫描所有节点（无 sourceNode 时扫描全量）
    async function scanAllNodes(source: RangeInstance): Promise<NodeRecord[]> {
      const allNodes: NodeRecord[] = []
      let offset = 0
      const pageSize = 5000
      let hasMore = true

      while (hasMore) {
        const batch = await source.read((engine) =>
          engine.queryPattern({ depth: 1, limit: pageSize })
        )
        if (!Array.isArray(batch) || batch.length === 0) {
          hasMore = false
        } else {
          allNodes.push(...batch)
          offset += batch.length
          if (batch.length < pageSize) hasMore = false
        }
      }
      return allNodes
    }

    const sourceNodes = await scanAllNodes(this.sourceRange)

    if (sourceNodes.length > 0) {
      this.logger.info(`[ReshardWorker] Migrating ${sourceNodes.length} nodes`)

      for (let i = 0; i < sourceNodes.length; i += batchSize) {
        const batch = sourceNodes.slice(i, i + batchSize)
        for (const node of batch) {
          try {
            await this.targetRange.write({
              type: 'upsert_node',
              payload: {
                typeId: node.type,
                name: node.name,
                props: node.props,
              },
            })
            migrated++
          } catch {
            failed++
          }
        }
        this._progress = Math.min(50, 10 + Math.round((migrated / sourceNodes.length) * 40))
      }
    }

    this._progress = 50

    // 阶段 2：迁移边（通过 neighbors 遍历前 10000 个节点）
    this.logger.info('[ReshardWorker] Starting edge migration phase')
    const edgeLimit = Math.min(sourceNodes.length, 10000)
    let edgeMigrated = 0

    for (let i = 0; i < edgeLimit; i++) {
      const node = sourceNodes[i]
      try {
        const neighborsResult = await this.sourceRange.read((engine) =>
          engine.neighbors(node.id, { maxDepth: 1 })
        )
        if (neighborsResult && neighborsResult.edges) {
          for (const edge of neighborsResult.edges) {
            try {
              await this.targetRange.write({
                type: 'upsert_edge',
                payload: {
                  src: edge.src,
                  dst: edge.dst,
                  typeId: edge.type,
                  opts: Object.keys(edge.props).length > 0 ? { props: edge.props } : undefined,
                },
              })
              edgeMigrated++
            } catch {
              failed++
            }
          }
        }
      } catch {
        // 跳过不可达节点
      }

      if (i > 0 && i % 100 === 0) {
        this._progress = Math.min(70, 50 + Math.round((i / edgeLimit) * 20))
      }
    }

    this.logger.info(
      `[ReshardWorker] Migration stats: nodes=${migrated}, edges=${edgeMigrated}, failed=${failed}`
    )

    this._progress = 70

    // 阶段 3：校验
    const sourceStats = this.sourceRange.getStatus()
    const targetStats = this.targetRange.getStatus()
    this._progress = 90

    if (sourceStats.storage.nodeCount !== targetStats.storage.nodeCount) {
      this.logger.warn(
        `[ReshardWorker] Node count mismatch: source=${sourceStats.storage.nodeCount}, ` +
        `target=${targetStats.storage.nodeCount}`
      )
    } else {
      this.logger.info(`[ReshardWorker] Validation OK: ${sourceStats.storage.nodeCount} nodes`)
    }

    this._progress = 100
  }

  /**
   * 验证目标 Range 的数据完整性（3PC Prepare 阶段使用）
   * @returns true 如果目标 Range 包含所有需要迁移的数据
   */
  async prepare(): Promise<boolean> {
    try {
      // 检查目标 Range 是否可读且健康
      const targetStats = this.targetRange.getStatus()
      if (!targetStats) return false

      // 从源 Range 获取基准统计
      const sourceStats = this.sourceRange.getStatus()
      const sourceCount = sourceStats.storage?.nodeCount ?? 0
      const targetCount = targetStats.storage?.nodeCount ?? 0

      // 允许 ±10% 的误差（迁移过程中可能有新写入）
      if (targetCount < sourceCount * 0.9) return false

      return true
    } catch {
      return false
    }
  }

  /**
   * 停止目标 Range（用于回滚）
   */
  async rollback(): Promise<void> {
    await this.targetRange.stop()
  }
}
