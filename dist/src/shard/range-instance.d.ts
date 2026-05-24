import { RaftNode } from '../consensus/raft-node';
import { GraphEngine } from '../core/graph-engine';
import { HlcClock } from '../replication/hlc-clock';
import { RangeConfig, RaftOperation } from '../types';
/**
 * RangeInstance — 单个分片的完整封装
 *
 * 一个 RangeInstance = 一个 Raft 组 + 一个 OverGraph 实例
 * 数据独立性通过 OverGraph 的独立文件目录保证
 *
 * draining:
 * - 在 rebalancing 迁移期间将源 Range 标记为 draining
 * - draining 期间新的写入将被拒绝（返回错误），确保"先写后删"安全
 * - 读取不受影响
 */
export declare class RangeInstance {
    readonly config: RangeConfig;
    readonly raft: RaftNode;
    readonly engine: GraphEngine;
    private _draining;
    constructor(config: RangeConfig, clock: HlcClock, transport?: import('../consensus/transport').Transport);
    start(): Promise<void>;
    stop(): Promise<void>;
    /** 检查是否在 draining 状态 */
    isDraining(): boolean;
    /** 设置 draining 标记（true = 拒绝新写入） */
    setDraining(draining: boolean): void;
    /** 通过 Raft 写入 — draining 状态拒绝写入 */
    write(op: Omit<RaftOperation, 'id'>): Promise<unknown>;
    /** 线性一致读 — draining 不影响读取 */
    read<T>(reader: (engine: GraphEngine) => T): Promise<T>;
    /** 获取状态 */
    getStatus(): {
        raft: import("../types").RaftStatus;
        storage: {
            nodeCount: number;
            edgeCount: number;
            diskSizeBytes: number;
        };
    };
    /** 检查范围是否健康 */
    isHealthy(): boolean;
}
//# sourceMappingURL=range-instance.d.ts.map