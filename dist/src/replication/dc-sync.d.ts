import { DeltaSync } from './delta-sync';
import { DCSyncConfig, DeltaMessage } from '../types';
/**
 * 冲突解决策略枚举
 */
export type ConflictResolution = 'accept' | 'reject' | 'merge';
/**
 * 纯函数：基于 HLC 时间戳的 LWW 冲突解决
 *
 * @param remote 远程 delta
 * @param localTimestamp 本地已应用的 HLC 时间戳（可选）
 * @param strategy 冲突策略
 * @returns 'accept' — 接受远程变更 | 'reject' — 拒绝远程变更 | 'merge' — 合并双方
 */
export declare function resolveConflict(remote: {
    hlcTimestamp: Uint8Array;
}, localTimestamp: Uint8Array | null, strategy?: 'lww' | 'ignore' | 'crdt'): ConflictResolution;
/**
 * DCSync — 跨数据中心同步协调器
 *
 * 使用 ZMQ PUB/SUB 模式：
 * - PUB: 定时广播本 DC 的 delta 变更
 * - SUB: 接收其他 DC 的 delta 变更
 *
 * ZMQ 具有自动重连和消息缓冲，跨 DC 网络中断恢复后自动继续
 */
export declare class DCSync {
    private config;
    private deltaSync;
    private logger;
    private pubSocket;
    private subSocket;
    private _running;
    /** 记录每个 dcId 最近应用的 HLC 时间戳（用于冲突解决） */
    private lastAppliedHlc;
    private telemetry;
    private metrics;
    constructor(config: DCSyncConfig, deltaSync: DeltaSync);
    get isRunning(): boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    publishDelta(delta: DeltaMessage): Promise<void>;
    private _startReceiveLoop;
}
//# sourceMappingURL=dc-sync.d.ts.map