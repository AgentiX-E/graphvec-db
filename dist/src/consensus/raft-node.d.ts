import { Transport } from './transport';
import { GraphEngine } from '../core/graph-engine';
import { HlcClock } from '../replication/hlc-clock';
import { RaftNodeConfig, RaftOperation, RaftStatus } from '../types';
import { TimerProvider } from './mock-timer';
/**
 * RaftNode — 固定的 Raft 共识节点
 *
 * 没有 mode 概念，没有环境变量，没有插件化
 * 使用 RaftCore 作为固化共识实现
 * 默认使用 MockTransport（进程内测试），通过 transport 参数传入生产级实现切换
 */
export declare class RaftNode {
    private raft;
    private engine;
    private clock;
    private _started;
    private logger;
    private applyResolvers;
    private telemetry;
    private metrics;
    constructor(config: RaftNodeConfig, engine: GraphEngine, clock: HlcClock, timerProvider?: TimerProvider, 
    /** 传入已有 transport 实例用于测试；默认创建 MockTransport */
    transport?: Transport);
    get engine_(): GraphEngine;
    get isStarted(): boolean;
    /** 启动 */
    start(): Promise<void>;
    /** 停止 */
    stop(): Promise<void>;
    /** 通过 Raft 共识写入 */
    write(operation: Omit<RaftOperation, 'id'>): Promise<unknown>;
    /** 线性一致读 */
    read<T>(reader: (engine: GraphEngine) => T): Promise<T>;
    /** 获取状态 */
    getStatus(): RaftStatus;
    /** 等待成为 Leader */
    waitForLeader(timeoutMs?: number): Promise<void>;
    /** 屏障（写入 admin barrier 操作） */
    barrier(): Promise<void>;
    /**
     * 校验并规范化 op 的 payload
     * 确保 payload 不为 null/undefined，并有必要的字段
     */
    private _validatePayload;
    /** 将共识提案应用到图引擎状态机 */
    private _applyToStateMachine;
}
//# sourceMappingURL=raft-node.d.ts.map