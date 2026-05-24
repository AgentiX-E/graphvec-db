import { ConsensusProvider, ConsensusRole, ConsensusConfig } from './consensus-provider';
/**
 * StandaloneConsensus — 单节点共识实现
 *
 * 无网络共识，直接本地应用写入
 * 适用于开发、测试、单节点部署
 */
export declare class StandaloneConsensus implements ConsensusProvider {
    private config;
    private applyFn;
    private _started;
    constructor(config: ConsensusConfig);
    setApply(fn: (data: Uint8Array) => Promise<void>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    propose(data: Uint8Array, _timeoutMs?: number): Promise<{
        ok: boolean;
    }>;
    readIndex(_timeoutMs?: number): Promise<void>;
    getRole(): ConsensusRole;
    getLeaderId(): string | null;
    getTerm(): number;
    waitForLeader(_timeoutMs?: number): Promise<void>;
}
//# sourceMappingURL=standalone-consensus.d.ts.map