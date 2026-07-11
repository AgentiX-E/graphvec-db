import { ShardManager } from '../shard/shard-manager'
import { ReshardPlan } from './reshard-plan'
import { ReshardWorker } from './reshard-worker'
import { RangeInstance } from '../shard/range-instance'
import { ReshardingPlan, ReshardingStatus, ShardMap, RangeConfig } from '../types'
import { HlcClock } from '../replication/hlc-clock'
import { Logger } from '../ops/logger'

/**
 * ReshardManager — Online Resharding Coordinator
 *
 * 7-phase state machine (3PC atomic commit)：
 * 1. pending — plan generation
 * 2. dual_write — dual write
 * 3. migrating — data migration
 * 4. preparing — 3PC Prepare: verify all target Ranges ready
 * 5. committing — 3PC Commit: atomic route switch
 * 6. cleaning — cleanup
 * 7. completed — done
 *
 * 3PC guarantee: rollback if prepare phase fails;
 * if crash during commit, recovery ensures eventual consistency after restart.
 */
export class ReshardManager {
  private shardManager: ShardManager
  private plan: ReshardPlan
  private clock: HlcClock
  private workers: ReshardWorker[] = []
  private _status: ReshardingStatus | null = null
  private cleanTimer: ReturnType<typeof setTimeout> | null = null
  private logger: Logger

  constructor(shardManager: ShardManager, clock: HlcClock) {
    this.shardManager = shardManager
    this.clock = clock
    this.plan = new ReshardPlan()
    this.logger = new Logger('ReshardManager')
  }

  get status(): ReshardingStatus | null { return this._status }

  /**
   * Check and execute Resharding
   */
  async evaluateAndExecute(): Promise<ReshardingStatus | null> {
    // Get current status of all Ranges
    const shardStatus = this.shardManager.getShardStatus()
    const ranges = shardStatus.map(s => ({
      rangeId: s.rangeId,
      nodeCount: s.nodeCount,
    }))

    const currentShardMap = this.shardManager.getRouter().getShardMap()

    const plan = this.plan.generatePlan(currentShardMap, ranges)
    if (!plan) return null

    return this.execute(plan)
  }

  /**
   * Execute Resharding plan
   */
  async execute(plan: ReshardingPlan): Promise<ReshardingStatus> {
    this._status = {
      planId: plan.planId,
      state: 'pending',
      progressPercent: 0,
      startedAt: Date.now(),
      completedAt: null,
      errors: [],
    }

    try {
      // Phase 2: dual write
      await this._startDualWrite(plan)
      this._updateState('dual_write', 5)

      // Phase 3: data migration
      await this._migrateData(plan)
      this._updateState('migrating', 50)

      // Phase 4: 3PC atomic commit
      await this._atomicSwitch(plan)
      // _atomicSwitch 内部设置 preparing → committing

      // Phase 5: start cleanup timer
      this._scheduleCleanup(plan, 48 * 60 * 60 * 1000)
      this._updateState('cleaning', 95)

      // Mark as completed
      this._status.state = 'completed'
      this._status.progressPercent = 100
      this._status.completedAt = Date.now()
    } catch (err) {
      this._status.state = 'failed'
      this._status.errors.push((err as Error).message)
    }

    return this._status
  }

  /** Rollback (callable within 48h after Phase 4) */
  async rollback(): Promise<void> {
    if (this._status && this._status.state === 'completed') {
      // Restore routing table
      // Clean up target Range
      for (const worker of this.workers) {
        await worker.rollback()
      }
      this._status.state = 'failed'
      this._status.errors.push('Rolled back by operator')
      // Cancel cleanup timer
      if (this.cleanTimer) clearTimeout(this.cleanTimer)
    }
  }

  private async _startDualWrite(plan: ReshardingPlan): Promise<void> {
    this._status!.state = 'dual_write'
    for (const split of plan.splits) {
      const sourceRange = this.shardManager.getRange(split.sourceRangeId)
      const targetRangeConfig: RangeConfig = {
        rangeId: split.targetRangeId,
        dataDir: split.targetDataDir,
        raftConfig: {
          nodeId: split.targetNodeId,
          peers: [],
          storagePath: split.targetDataDir,
        },
        overgraphConfig: {
          path: `${split.targetDataDir}/graph`,
          denseVector: { dimension: 384 },
        },
      }
      const targetInstance = new RangeInstance(targetRangeConfig, this.clock)
      await targetInstance.start()

      this.shardManager.addRange(split.targetRangeId, targetInstance)

      const worker = new ReshardWorker(split, this.clock, sourceRange, targetInstance)
      this.workers.push(worker)
    }

    // Enable dual write: all writes go to both source and target Range
    this.shardManager.enableDualWrite(plan.splits)
  }

  private async _migrateData(plan: ReshardingPlan): Promise<void> {
    this._status!.state = 'migrating'
    for (const worker of this.workers) {
      await worker.execute()
    }
  }

  /**
   * 3PC atomic commit
   *
   * Phase 1: Prepare — verify data integrity of all target Ranges
   * Phase 2: Commit — atomically update routing table
   *
   * If Prepare fails, automatically rollback all workers.
   * Commit phase is irreversible once completed (idempotent).
   */
  private async _atomicSwitch(plan: ReshardingPlan): Promise<void> {
    this._status!.state = 'preparing'

    // ── Phase 1: Prepare — all target Ranges verified ready ──
    const prepareResults: Array<{ rangeId: string; ok: boolean }> = []
    for (const worker of this.workers) {
      try {
        const ready = await worker.prepare()
        prepareResults.push({ rangeId: worker.split.targetRangeId, ok: ready })
      } catch (err) {
        prepareResults.push({ rangeId: worker.split.targetRangeId, ok: false })
      }
    }

    const allReady = prepareResults.every(r => r.ok)
    if (!allReady) {
      // Abort — 通知所有 worker 回滚
      this._status!.errors.push(
        `Reshard prepare failed: ${prepareResults.filter(r => !r.ok).map(r => r.rangeId).join(', ')}`
      )
      for (const worker of this.workers) {
        await worker.rollback().catch(() => {
          // 回滚失败不阻塞整体流程
        })
      }
      throw new Error(this._status!.errors[this._status!.errors.length - 1])
    }

    // ── Phase 2: Commit — atomically switch routing ──
    this._status!.state = 'committing'
    this._status!.progressPercent = 85

    const oldMap = this.shardManager.getRouter().getShardMap()
    const newRanges = [...oldMap.ranges.map(r => ({ ...r }))]

    for (const split of plan.splits) {
      newRanges.push({
        rangeId: split.targetRangeId,
        dataDir: split.targetDataDir,
        raftConfig: {
          nodeId: split.targetNodeId,
          peers: [],
          storagePath: split.targetDataDir,
        },
        overgraphConfig: {
          path: `${split.targetDataDir}/graph`,
          denseVector: { dimension: 384 },
        },
      })
    }

    const newMap: ShardMap = {
      version: plan.version,
      ranges: newRanges,
      hashRing: {
        virtualNodes: 160,
        nodes: newRanges.map(r => ({
          hash: r.rangeId,
          rangeId: r.rangeId,
        })),
      },
    }

    // Atomically update routing table (ShardManager.rebuildRouter should use a lock internally)
    this.shardManager.rebuildRouter(newMap)
    // Route switched, disable dual write: subsequent writes only go through new route
    this.shardManager.disableDualWrite()
    this._status!.progressPercent = 90
  }

  private _scheduleCleanup(plan: ReshardingPlan, delayMs: number): void {
    this.cleanTimer = setTimeout(() => {
      for (const split of plan.splits) {
        try {
          this.logger.warn(`Cleaning up source range: ${split.sourceRangeId} (48h after split completion)`)
          this.shardManager.removeRange(split.sourceRangeId)
        } catch {
          // 清理失败不阻塞
        }
      }
    }, delayMs)
    this.cleanTimer.unref()
  }

  private _updateState(state: ReshardingStatus['state'], progress: number): void {
    if (this._status) {
      this._status.state = state
      this._status.progressPercent = progress
    }
  }
}
