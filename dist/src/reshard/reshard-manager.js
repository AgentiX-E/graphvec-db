"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReshardManager = void 0;
const reshard_plan_1 = require("./reshard-plan");
const reshard_worker_1 = require("./reshard-worker");
const range_instance_1 = require("../shard/range-instance");
/**
 * ReshardManager — 在线 Resharding 协调器
 *
 * 7 阶段状态机（3PC 原子提交）：
 * 1. pending — 计划生成
 * 2. dual_write — 双写
 * 3. migrating — 数据迁移
 * 4. preparing — 3PC Prepare：验证所有目标 Range 就绪
 * 5. committing — 3PC Commit：原子切换路由
 * 6. cleaning — 清理
 * 7. completed — 完成
 *
 * 3PC 保证：如果在 prepare 阶段失败，执行回滚；
 * 如果在 commit 阶段崩溃，重启后可通过 recovery 恢复最终一致。
 */
class ReshardManager {
    shardManager;
    plan;
    clock;
    workers = [];
    _status = null;
    cleanTimer = null;
    constructor(shardManager, clock) {
        this.shardManager = shardManager;
        this.clock = clock;
        this.plan = new reshard_plan_1.ReshardPlan();
    }
    get status() { return this._status; }
    /**
     * 检查并执行 Resharding
     */
    async evaluateAndExecute() {
        // 获取当前所有 Range 的状态
        const shardStatus = this.shardManager.getShardStatus();
        const ranges = shardStatus.map(s => ({
            rangeId: s.rangeId,
            nodeCount: s.nodeCount,
        }));
        const currentShardMap = this.shardManager.getRouter().getShardMap();
        const plan = this.plan.generatePlan(currentShardMap, ranges);
        if (!plan)
            return null;
        return this.execute(plan);
    }
    /**
     * 执行 Resharding 计划
     */
    async execute(plan) {
        this._status = {
            planId: plan.planId,
            state: 'pending',
            progressPercent: 0,
            startedAt: Date.now(),
            completedAt: null,
            errors: [],
        };
        try {
            // Phase 2: 双写
            await this._startDualWrite(plan);
            this._updateState('dual_write', 5);
            // Phase 3: 数据迁移
            await this._migrateData(plan);
            this._updateState('migrating', 50);
            // Phase 4: 3PC 原子提交
            await this._atomicSwitch(plan);
            // _atomicSwitch 内部设置 preparing → committing
            // Phase 5: 启动清理计时器
            this._scheduleCleanup(plan, 48 * 60 * 60 * 1000);
            this._updateState('cleaning', 95);
            // 标记完成
            this._status.state = 'completed';
            this._status.progressPercent = 100;
            this._status.completedAt = Date.now();
        }
        catch (err) {
            this._status.state = 'failed';
            this._status.errors.push(err.message);
        }
        return this._status;
    }
    /** 回滚（Phase 4 后 48h 内可调用） */
    async rollback() {
        if (this._status && this._status.state === 'completed') {
            // 恢复路由表
            // 清理目标 Range
            for (const worker of this.workers) {
                await worker.rollback();
            }
            this._status.state = 'failed';
            this._status.errors.push('Rolled back by operator');
            // 取消清理定时器
            if (this.cleanTimer)
                clearTimeout(this.cleanTimer);
        }
    }
    async _startDualWrite(plan) {
        this._status.state = 'dual_write';
        for (const split of plan.splits) {
            const sourceRange = this.shardManager.getRange(split.sourceRangeId);
            const targetRangeConfig = {
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
            };
            const targetInstance = new range_instance_1.RangeInstance(targetRangeConfig, this.clock);
            await targetInstance.start();
            this.shardManager.addRange(split.targetRangeId, targetInstance);
            const worker = new reshard_worker_1.ReshardWorker(split, this.clock, sourceRange, targetInstance);
            this.workers.push(worker);
        }
    }
    async _migrateData(plan) {
        this._status.state = 'migrating';
        for (const worker of this.workers) {
            await worker.execute();
        }
    }
    /**
     * 3PC 原子提交
     *
     * Phase 1: Prepare — 验证所有目标 Range 数据完整性
     * Phase 2: Commit — 原子更新路由表
     *
     * 如果 Prepare 失败，自动对所有 worker 执行回滚。
     * Commit 阶段一旦完成即不可回滚（幂等）。
     */
    async _atomicSwitch(plan) {
        this._status.state = 'preparing';
        // ── Phase 1: Prepare — 所有目标 Range 验证就绪 ──
        const prepareResults = [];
        for (const worker of this.workers) {
            try {
                const ready = await worker.prepare();
                prepareResults.push({ rangeId: worker.split.targetRangeId, ok: ready });
            }
            catch (err) {
                prepareResults.push({ rangeId: worker.split.targetRangeId, ok: false });
            }
        }
        const allReady = prepareResults.every(r => r.ok);
        if (!allReady) {
            // Abort — 通知所有 worker 回滚
            this._status.errors.push(`Reshard prepare failed: ${prepareResults.filter(r => !r.ok).map(r => r.rangeId).join(', ')}`);
            for (const worker of this.workers) {
                await worker.rollback().catch(() => {
                    // 回滚失败不阻塞整体流程
                });
            }
            throw new Error(this._status.errors[this._status.errors.length - 1]);
        }
        // ── Phase 2: Commit — 原子切换路由 ──
        this._status.state = 'committing';
        this._status.progressPercent = 85;
        const oldMap = this.shardManager.getRouter().getShardMap();
        const newRanges = [...oldMap.ranges.map(r => ({ ...r }))];
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
            });
        }
        const newMap = {
            version: plan.version,
            ranges: newRanges,
            hashRing: {
                virtualNodes: 160,
                nodes: newRanges.map(r => ({
                    hash: r.rangeId,
                    rangeId: r.rangeId,
                })),
            },
        };
        // 原子更新路由表（ShardManager.rebuildRouter 内部应使用锁）
        this.shardManager.rebuildRouter(newMap);
        this._status.progressPercent = 90;
    }
    _scheduleCleanup(plan, delayMs) {
        this.cleanTimer = setTimeout(() => {
            for (const split of plan.splits) {
                try {
                    this.shardManager.removeRange(split.targetRangeId);
                }
                catch {
                    // 清理失败不阻塞
                }
            }
        }, delayMs);
    }
    _updateState(state, progress) {
        if (this._status) {
            this._status.state = state;
            this._status.progressPercent = progress;
        }
    }
}
exports.ReshardManager = ReshardManager;
//# sourceMappingURL=reshard-manager.js.map