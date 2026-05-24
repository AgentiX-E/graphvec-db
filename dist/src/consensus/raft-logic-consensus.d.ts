import { ConsensusProvider, ConsensusRole, ConsensusConfig } from './consensus-provider';
/**
 * RaftLogicConsensus — raft-logic (tikv/raft-rs WASM) 共识实现
 *
 * 生产级共识，使用 etcd/TiKV 的 Raft 实现
 * 提供：Leader 选举、日志复制、preVote 防脑裂、checkQuorum
 *
 * 注意：raft-logic 为可选依赖，当安装时使用此实现
 *
 * 采用惰性加载模式：
 * - 构造时不加载模块，允许按需创建实例
 * - init() 中尝试加载模块，失败时保存错误但不抛出
 * - start() 时如果模块未加载则抛出明确错误（含安装指引）
 * - 测试可通过 _moduleRef 注入 mock 模块避免真实依赖
 */
export declare class RaftLogicConsensus implements ConsensusProvider {
    private _moduleRef?;
    private config;
    private logger;
    private applyFn;
    private _node;
    private _started;
    private _loaded;
    private _loadError;
    private _raftModule;
    constructor(config: ConsensusConfig, _moduleRef?: any | undefined);
    /**
     * 惰性加载 raft-logic 模块
     * 加载失败时保存错误但不抛出，允许 graceful fallback
     */
    init(): Promise<void>;
    setApply(fn: (data: Uint8Array) => Promise<void>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    propose(data: Uint8Array, timeoutMs?: number): Promise<{
        ok: boolean;
    }>;
    readIndex(timeoutMs?: number): Promise<void>;
    getRole(): ConsensusRole;
    getLeaderId(): string | null;
    getTerm(): number;
    waitForLeader(timeoutMs?: number): Promise<void>;
    /** 测试辅助：获取加载状态 */
    _isLoaded(): boolean;
    /** 测试辅助：获取加载错误 */
    _getLoadError(): Error | null;
}
//# sourceMappingURL=raft-logic-consensus.d.ts.map