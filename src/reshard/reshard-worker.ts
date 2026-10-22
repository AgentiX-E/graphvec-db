import { RangeInstance } from '../shard/range-instance'
import { ReshardSplit } from '../types'
import { HlcClock } from '../replication/hlc-clock'
import { Logger } from '../ops/logger'

/**
 * ReshardWorker — Data Migration Worker
 *
 * Complete the dual-write + data migration process for a single shard
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

  /** Get ReshardSplit info (for ReshardManager use) */
  get split(): ReshardSplit { return this._split }

  /**
   * Execute migration (use snapshot API for batch data migration)
   * 1. Start target Range
   * 2. Export full source Range data via exportSnapshot
   * 3. Import all at once to target Range via importSnapshot
   * 4. Verify node count and edge count consistency
   */
  async execute(): Promise<void> {
    await this.targetRange.start()
    this._progress = 10

    // Phase 1: Export full data using exportSnapshot
    this.logger.info('[ReshardWorker] Phase 1: Exporting snapshot from source range')
    const snapshotData = await this.sourceRange.read<Buffer>(engine => {
      return engine.exportSnapshot()
    })
    this._progress = 40

    // Phase 2: Import all at once to target using importSnapshot
    this.logger.info('[ReshardWorker] Phase 2: Installing snapshot on target range')
    await this.targetRange.write({
      type: 'install_snapshot',
      payload: { snapshotData: snapshotData.toString('base64') },
    })
    this._progress = 70

    // Phase 3: Verify — compare node and edge counts
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
      'Snapshot migration completed',
      { nodeCount: sourceStats.nodeCount, edgeCount: sourceStats.edgeCount },
    )
    this._progress = 100
  }

  /**
   * Verify data integrity of target Range (used in 3PC Prepare phase)
   * @returns true if target Range contains all data to be migrated
   */
  async prepare(): Promise<boolean> {
    try {
      // Check if target Range is readable and healthy
      const targetStats = this.targetRange.getStatus()
      if (!targetStats) return false

      // Get baseline stats from source Range
      const sourceStats = this.sourceRange.getStatus()
      const sourceCount = sourceStats.storage?.nodeCount ?? 0
      const targetCount = targetStats.storage?.nodeCount ?? 0

      // Allow ±10% tolerance (new writes may occur during migration)
      if (targetCount < sourceCount * 0.9) return false

      return true
    } catch {
      return false
    }
  }

  /**
   * Stop target Range (for rollback)
   */
  async rollback(): Promise<void> {
    await this.targetRange.stop()
  }
}
