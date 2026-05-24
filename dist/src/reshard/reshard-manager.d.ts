import { ShardManager } from '../shard/shard-manager';
import { ReshardingPlan, ReshardingStatus } from '../types';
import { HlcClock } from '../replication/hlc-clock';
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
export declare class ReshardManager {
    private shardManager;
    private plan;
    private clock;
    private workers;
    private _status;
    private cleanTimer;
    constructor(shardManager: ShardManager, clock: HlcClock);
    get status(): ReshardingStatus | null;
    /**
     * 检查并执行 Resharding
     */
    evaluateAndExecute(): Promise<ReshardingStatus | null>;
    /**
     * 执行 Resharding 计划
     */
    execute(plan: ReshardingPlan): Promise<ReshardingStatus>;
    /** 回滚（Phase 4 后 48h 内可调用） */
    rollback(): Promise<void>;
    private _startDualWrite;
    private _migrateData;
    /**
     * 3PC 原子提交
     *
     * Phase 1: Prepare — 验证所有目标 Range 数据完整性
     * Phase 2: Commit — 原子更新路由表
     *
     * 如果 Prepare 失败，自动对所有 worker 执行回滚。
     * Commit 阶段一旦完成即不可回滚（幂等）。
     */
    private _atomicSwitch;
    private _scheduleCleanup;
    private _updateState;
}
//# sourceMappingURL=reshard-manager.d.ts.map