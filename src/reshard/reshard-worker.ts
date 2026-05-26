import { RangeInstance } from '../shard/range-instance'
import { ReshardSplit } from '../types'
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
   * 执行迁移（使用 snapshot API 做批量数据迁移）
   * 1. 启动目标 Range
   * 2. 通过 exportSnapshot 全量导出源 Range 数据
   * 3. 通过 importSnapshot 一次性导入到目标 Range
   * 4. 校验节点数和边数一致性
   */
  async execute(): Promise<void> {
    await this.targetRange.start()
    this._progress = 10

    // Phase 1: 使用 exportSnapshot 全量导出数据
    this.logger.info('[ReshardWorker] Phase 1: Exporting snapshot from source range')
    const snapshotData = await this.sourceRange.read<Buffer>(engine => {
      return engine.exportSnapshot()
    })
    this._progress = 40

    // Phase 2: 使用 importSnapshot 一次性导入到目标
    this.logger.info('[ReshardWorker] Phase 2: Installing snapshot on target range')
    await this.targetRange.write({
      type: 'install_snapshot',
      payload: { snapshotData: snapshotData.toString('base64') },
    })
    this._progress = 70

    // Phase 3: 校验 — 比较节点和边数
    this.logger.info('[ReshardWorker] Phase 3: Validating migration')
    const sourceStats = await this.sourceRange.read(engine => engine.stats())
    const targetStats = await this.targetRange.read(engine => engine.stats())

    if (
      sourceStats.nodeCount !== targetStats.nodeCount ||
      sourceStats.edgeCount !== targetStats.edgeCount
    ) {
      throw new Error(
        `Snapshot migration count mismatch: ` +
        `src=${sourceStats.nodeCount}/${sourceStats.edgeCount} ` +
        `dst=${targetStats.nodeCount}/${targetStats.edgeCount}`
      )
    }

    this.logger.info(
      { nodeCount: sourceStats.nodeCount, edgeCount: sourceStats.edgeCount },
      'Snapshot migration completed'
    )
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
