import { RangeInstance } from '../shard/range-instance';
import { ReshardSplit } from '../types';
import { HlcClock } from '../replication/hlc-clock';
/**
 * ReshardWorker — 数据迁移 Worker
 *
 * 完成单个分片的双写 + 数据迁移流程
 */
export declare class ReshardWorker {
    private _split;
    private clock;
    private logger;
    private sourceRange;
    private targetRange;
    private _progress;
    constructor(split: ReshardSplit, clock: HlcClock, sourceRange: RangeInstance, targetRange: RangeInstance);
    get progress(): number;
    /** 获取 ReshardSplit 信息（供 ReshardManager 使用） */
    get split(): ReshardSplit;
    /**
     * 执行迁移
     * 1. 启动目标 Range
     * 2. 全量扫描节点 + 边，通过 Raft write 写入目标
     * 3. 校验 checksum
     */
    execute(): Promise<void>;
    /**
     * 验证目标 Range 的数据完整性（3PC Prepare 阶段使用）
     * @returns true 如果目标 Range 包含所有需要迁移的数据
     */
    prepare(): Promise<boolean>;
    /**
     * 停止目标 Range（用于回滚）
     */
    rollback(): Promise<void>;
}
//# sourceMappingURL=reshard-worker.d.ts.map