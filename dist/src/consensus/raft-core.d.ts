/**
 * raft-core.ts — RaftCore 固化共识实现
 *
 * 将 Raft 共识从"可插拔组件"变为"固化的基础设施"。
 * 基于 Raft 论文 (Diego Ongaro, 2014) 实现，支持：
 *   - Leader 选举
 *   - 日志复制
 *   - 安全性
 *   - Leader 完整性保证
 *
 * 关键设计：
 *   - 使用 Transport 网络层进行节点间通信
 *   - 使用 WAL 进行日志持久化
 *   - 无 mode 概念：只有 RaftCore 一种实现
 *   - Leader 写入本节点 WAL + 广播到 followers
 */
import { Transport } from './transport';
import { MembershipChange } from '../types';
export type RaftRole = 'follower' | 'candidate' | 'leader';
export interface RaftCoreConfig {
    nodeId: string;
    peers: string[];
    electionTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    walPath: string;
    preVote?: boolean;
    checkQuorum?: boolean;
    snapshotThreshold?: number;
    snapshotPath?: string;
}
export interface TimerProvider {
    setTimeout(cb: () => void, ms: number): number;
    clearTimeout(id: number): void;
    setInterval(cb: () => void, ms: number): number;
    clearInterval(id: number): void;
}
export declare class RaftCore {
    private _role;
    private _currentTerm;
    private _votedFor;
    private wal;
    private _commitIndex;
    private _lastApplied;
    private _lastSnapshotIndex;
    private _lastSnapshotTerm;
    private _nextIndex;
    private _matchIndex;
    private transport;
    private stateMachine;
    private config;
    private timerProvider;
    private logger;
    private _preVoteGranted;
    private _inPreVote;
    private _connectedPeers;
    private _lastHeartbeatReachable;
    private _pendingProposals;
    private _proposeTimeoutMs;
    /** 外部通知回调：当成员变更日志被 commit 时调用 */
    onMembershipChange?: (change: MembershipChange) => void;
    private _electionTimerId;
    private _heartbeatTimerId;
    private _started;
    private telemetry;
    private metrics;
    constructor(config: RaftCoreConfig, transport?: Transport, timerProvider?: TimerProvider);
    get role(): RaftRole;
    get currentTerm(): number;
    get votedFor(): string | null;
    get commitIndex(): number;
    get lastApplied(): number;
    get isStarted(): boolean;
    get lastLogIndex(): number;
    get lastLogTerm(): number;
    setApply(fn: (data: Uint8Array) => Promise<void>): void;
    /** 手动触发快照 */
    triggerSnapshot(): Promise<void>;
    /** 获取最后一次快照包含的日志索引 */
    getLastSnapshotIndex(): number;
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * 提交提案
     * - Leader：写入本节点 WAL → 并行 AppendEntries → 等待 commit → 返回
     * - Follower：返回 { ok: false }
     *
     * 改进：等待 commitIndex >= 本次提案的 index 后再返回，
     * 确保调用方知道日志已被多数节点复制。
     */
    propose(data: Uint8Array): Promise<{
        ok: boolean;
    }>;
    /**
     * 添加一个 peer 到集群（仅 Leader 可用）
     *
     * 写入 membership change 日志，通过 Raft 日志复制到多数节点，commit 后自动更新 peers 配置。
     *
     * @param peerId - 要添加的 peer 节点 ID
     * @param address - peer 的地址（可选，用于非 MockTransport 场景）
     * @returns { ok: true } 如果提交成功，{ ok: false } 如果当前不是 leader 或 peer 已存在
     */
    addPeer(peerId: string, address?: string): Promise<{
        ok: boolean;
    }>;
    /**
     * 从集群中移除一个 peer（仅 Leader 可用）
     *
     * 写入 membership change 日志，通过 Raft 日志复制到多数节点，commit 后自动更新 peers 配置。
     *
     * @param peerId - 要移除的 peer 节点 ID
     * @returns { ok: true } 如果提交成功，{ ok: false } 如果当前不是 leader 或 peer 不存在
     */
    removePeer(peerId: string): Promise<{
        ok: boolean;
    }>;
    /**
     * 线性一致读
     * Leader 发送心跳到多数节点确认领导权后返回
     */
    readIndex(_timeoutMs?: number): Promise<void>;
    getRole(): RaftRole;
    getLeaderId(): string | null;
    getTerm(): number;
    getNodeId(): string;
    waitForLeader(timeoutMs?: number): Promise<void>;
    private _handleMessage;
    /** 发送响应消息 */
    private _sendResponse;
    private _sendAppendEntries;
    private _sendRequestVote;
    private _buildAppendEntriesRequest;
    private _handleAppendEntries;
    private _handleRequestVote;
    /**
     * 处理 PreVote 请求
     * PreVote 使用 RequestVoteRequest 结构，但 term 是 candidate 的 nextTerm
     * PreVote 不会修改 votedFor 或触发 stepDown
     */
    private _handlePreVote;
    /**
     * 处理 PreVote 响应
     */
    private _handlePreVoteResponse;
    /**
     * 发送 PreVote 请求到指定 peer
     * PreVote 请求复用 RequestVoteRequest 数据结构，但以独立消息类型发送
     */
    private _sendPreVote;
    private _startElection;
    /**
     * PreVote 前置投票
     * 不递增 term，发送 term=self._currentTerm+1 的 PreVote 请求给所有 peers
     * 收集响应，超过半数同意后正式发起选举
     */
    private _startPreVote;
    /**
     * 正式选举（实际自增 term 并发起 RequestVote）
     */
    private _doRealElection;
    private _becomeLeader;
    private _sendHeartbeat;
    private _applyCommittedEntries;
    /** 尝试将日志数据解析为 membership change 条目 */
    private _tryParseMembershipEntry;
    /**
     * 应用 membership change — 更新 peers 列表
     *
     * 根据变更类型（add/remove）添加或移除 peer，同步更新 leader 的 nextIndex/matchIndex，
     * 并通过 onMembershipChange 回调通知外部。
     *
     * @param change - 成员变更对象，包含变更类型、peer ID 和任期
     */
    private _applyMembershipChange;
    private _advanceCommitIndex;
    /** 将已被 commit 的 pending proposals resolve 掉 */
    private _resolvePendingProposals;
    private _stepDown;
    private _persistMeta;
    /** 加载持久化的选举状态 meta */
    private _loadMeta;
    private _rejectAllPendingProposals;
    private _majority;
    private _resetElectionTimeout;
    private _startHeartbeatTimer;
    private _clearTimers;
    /**
     * 检查是否需要触发快照，并在需要时自动执行
     */
    private _checkSnapshot;
    /**
     * 执行快照
     * 1. 调用 stateMachine 传入特殊标记让外部持久化状态
     * 2. 将状态写入 snapshotPath 文件（JSON 格式）
     * 3. 截断 WAL 中已被快照包含的条目
     */
    private _doSnapshot;
    /**
     * 加载 snapshot 状态（启动时调用）
     */
    private _loadSnapshotState;
    /**
     * 处理 InstallSnapshot RPC（接收方：follower）
     *
     * 当 follower 收到 leader 的快照数据时：
     * 1. 检查任期
     * 2. 保存快照数据到磁盘
     * 3. 更新 lastSnapshotIndex/Term
     * 4. 截断 WAL
     * 5. 让状态机应用快照
     */
    private _handleInstallSnapshot;
    /**
     * 处理 InstallSnapshot 响应（发送方：leader）
     */
    private _handleInstallSnapshotResponse;
    /** 检查 _buildAppendEntriesRequest 中 nextIdx 是否需要触发 InstallSnapshot */
    private _needsInstallSnapshot;
    /**
     * 删除 snapshot 文件（测试辅助）
     */
    destroySnapshot(): Promise<void>;
}
//# sourceMappingURL=raft-core.d.ts.map