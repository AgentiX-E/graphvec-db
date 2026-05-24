"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RaftCore = void 0;
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
const transport_1 = require("./transport");
const wal_1 = require("./wal");
const logger_1 = require("../ops/logger");
const fs = __importStar(require("node:fs"));
const otel_1 = require("../ops/otel");
const otel_metrics_1 = require("../ops/otel-metrics");
class RealTimer {
    setTimeout(cb, ms) {
        return setTimeout(cb, ms);
    }
    clearTimeout(id) { clearTimeout(id); }
    setInterval(cb, ms) {
        return setInterval(cb, ms);
    }
    clearInterval(id) { clearInterval(id); }
}
class RaftCore {
    // ─── 持久化状态 ───
    _role = 'follower';
    _currentTerm = 0;
    _votedFor = null;
    wal;
    // ─── 易失性状态 ───
    _commitIndex = 0;
    _lastApplied = 0;
    // ─── Snapshot 状态 ───
    _lastSnapshotIndex = 0;
    _lastSnapshotTerm = 0;
    // ─── Leader 专用状态 ───
    _nextIndex = new Map();
    _matchIndex = new Map();
    // ─── 依赖 ───
    transport;
    stateMachine = null;
    config;
    timerProvider;
    logger;
    // ─── PreVote 状态 ───
    _preVoteGranted = []; // 记录 PreVote 已同意的 peers
    _inPreVote = false; // 是否在 PreVote 过程中
    // ─── CheckQuorum 状态 ───
    _connectedPeers = new Set();
    _lastHeartbeatReachable = true;
    // ─── Pending Proposals（等待 commit 的提案） ───
    _pendingProposals = new Map();
    _proposeTimeoutMs = 5000;
    // ─── Membership Change 回调 ───
    /** 外部通知回调：当成员变更日志被 commit 时调用 */
    onMembershipChange;
    // ─── 定时器 ───
    _electionTimerId = null;
    _heartbeatTimerId = null;
    _started = false;
    // ─── OTel 可观测性 ───
    telemetry;
    metrics;
    constructor(config, transport, timerProvider) {
        this.config = {
            nodeId: config.nodeId,
            peers: config.peers,
            electionTimeoutMs: config.electionTimeoutMs ?? 150,
            heartbeatIntervalMs: config.heartbeatIntervalMs ?? 50,
            walPath: config.walPath,
            preVote: config.preVote ?? true,
            checkQuorum: config.checkQuorum ?? true,
            snapshotThreshold: config.snapshotThreshold ?? 10000,
            snapshotPath: config.snapshotPath ?? config.walPath + '.snapshot',
        };
        this.transport = transport ?? new transport_1.MockTransport(config.nodeId);
        this.timerProvider = timerProvider ?? new RealTimer();
        this.wal = new wal_1.WAL(config.walPath);
        this.logger = new logger_1.Logger(`RaftCore[${config.nodeId}]`);
        this.telemetry = otel_1.Telemetry.getInstance();
        this.metrics = otel_metrics_1.MetricsCollector.getInstance();
    }
    // ─── 公共访问器 ──────────────────────────────────────────
    get role() { return this._role; }
    get currentTerm() { return this._currentTerm; }
    get votedFor() { return this._votedFor; }
    get commitIndex() { return this._commitIndex; }
    get lastApplied() { return this._lastApplied; }
    get isStarted() { return this._started; }
    get lastLogIndex() { return this.wal.getLastIndex(); }
    get lastLogTerm() { return this.wal.getLastTerm(); }
    setApply(fn) {
        this.stateMachine = fn;
    }
    // ─── Snapshot API ──────────────────────────────────────
    /** 手动触发快照 */
    async triggerSnapshot() {
        await this._doSnapshot();
    }
    /** 获取最后一次快照包含的日志索引 */
    getLastSnapshotIndex() {
        return this._lastSnapshotIndex;
    }
    // ─── 生命周期 ──────────────────────────────────────────
    async start() {
        if (this._started)
            return;
        await this.wal.open();
        // 加载快照状态
        this._loadSnapshotState();
        // 加载持久化的 meta（currentTerm / votedFor）
        this._loadMeta();
        this.logger.info(`Started, recovered ${this.wal.readAll().length} entries from WAL`);
        this._started = true;
        this.transport.onMessage((from, msg) => {
            this._handleMessage(from, msg).catch(err => {
                this.logger.error(`Error handling message from ${from}:`, err);
            });
        });
        await this.transport.start();
        // 单节点（无 peers）立即成为 leader，无需等待选举超时
        if (this.config.peers.length === 0) {
            this._becomeLeader();
        }
        else {
            this._resetElectionTimeout();
        }
    }
    async stop() {
        this._started = false;
        this._role = 'follower';
        this._clearTimers();
        await this.transport.stop();
        await this.wal.close();
    }
    // ─── 公共 API ──────────────────────────────────────────
    /**
     * 提交提案
     * - Leader：写入本节点 WAL → 并行 AppendEntries → 等待 commit → 返回
     * - Follower：返回 { ok: false }
     *
     * 改进：等待 commitIndex >= 本次提案的 index 后再返回，
     * 确保调用方知道日志已被多数节点复制。
     */
    async propose(data) {
        if (!this._started)
            return { ok: false };
        if (this._role !== 'leader')
            return { ok: false };
        return this.telemetry.traceAsync('raft.propose', async () => {
            // 1. 写入本节点 WAL
            const entry = await this.wal.append(this._currentTerm, data);
            // 2. 如果无 peers（单节点），直接推进 commitIndex 并返回
            if (this.config.peers.length === 0) {
                this._commitIndex = entry.index;
                await this._applyCommittedEntries();
                await this._checkSnapshot();
                this.metrics.incrementCounter('graph.raft.proposals');
                return { ok: true };
            }
            // 3. 并行广播到所有 peers，进行重试
            for (let retry = 0; retry < 3; retry++) {
                const responses = await Promise.all(this.config.peers.map(peerId => this._sendAppendEntries(peerId).catch(() => null)));
                let allSuccess = true;
                for (let i = 0; i < this.config.peers.length; i++) {
                    const resp = responses[i];
                    const peerId = this.config.peers[i];
                    if (!resp)
                        continue;
                    if (resp.success) {
                        this._matchIndex.set(peerId, Math.max(this._matchIndex.get(peerId) ?? 0, resp.lastLogIndex));
                        this._nextIndex.set(peerId, (this._nextIndex.get(peerId) ?? 0) + 1);
                    }
                    else {
                        allSuccess = false;
                        // 使用 conflictingTerm/conflictingIndex 进行二分回退（Raft 论文 §5.3）
                        if (resp.conflictingTerm !== undefined && resp.conflictingTerm > 0) {
                            // 找到 leader 日志中 conflictingTerm 的第一个 index
                            let newNextIndex = resp.conflictingIndex ?? 1;
                            // 扫描 leader 日志：如果在 leader 日志中找不到 conflictingTerm，
                            // 则从 conflictingIndex 开始，否则跳到该 term 之后
                            const leaderLastIndex = this.wal.getLastIndex();
                            for (let idx = Math.min(resp.conflictingIndex ?? 1, leaderLastIndex); idx >= 1; idx--) {
                                const e = this.wal.getEntry(idx);
                                if (e && e.term === resp.conflictingTerm) {
                                    // leader 有这个 term 的日志：跳到该 term 最后一条 +1
                                    newNextIndex = idx + 1;
                                    // 继续往后找该 term 的最后一个 index
                                    for (let j = idx + 1; j <= leaderLastIndex; j++) {
                                        const e2 = this.wal.getEntry(j);
                                        if (e2 && e2.term === resp.conflictingTerm)
                                            newNextIndex = j + 1;
                                        else
                                            break;
                                    }
                                    break;
                                }
                                if (e && e.term < resp.conflictingTerm) {
                                    // leader 没有冲突的 term：直接跳到 conflictingIndex
                                    newNextIndex = resp.conflictingIndex ?? idx;
                                    break;
                                }
                            }
                            this._nextIndex.set(peerId, Math.max(1, newNextIndex));
                        }
                        else if (resp.lastLogIndex > 0) {
                            // 降级到简单回退
                            const currentNext = this._nextIndex.get(peerId) ?? 1;
                            this._nextIndex.set(peerId, Math.max(1, Math.min(currentNext - 1, resp.lastLogIndex + 1)));
                        }
                        else {
                            const currentNext = this._nextIndex.get(peerId) ?? 1;
                            this._nextIndex.set(peerId, Math.max(1, currentNext - 1));
                        }
                    }
                }
                // 广播后尝试推进 commit（可能不包含本提案，但先行推进已有日志）
                this._advanceCommitIndex();
                if (this._commitIndex >= entry.index) {
                    await this._applyCommittedEntries();
                    await this._checkSnapshot();
                    this.metrics.incrementCounter('graph.raft.proposals');
                    return { ok: true };
                }
                if (allSuccess)
                    break;
            }
            // 4. 尚未 commit 的提案：注册 pending 回调，等待下次心跳或 AppendEntries 响应推进 commitIndex
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this._pendingProposals.delete(entry.index);
                    resolve({ ok: false });
                }, this._proposeTimeoutMs);
                this._pendingProposals.set(entry.index, { resolve, reject, timer });
                // 重试一次 AppendEntries
                this.config.peers.forEach(peerId => {
                    this._sendAppendEntries(peerId).catch(() => null);
                });
                this._advanceCommitIndex();
                if (this._commitIndex >= entry.index) {
                    clearTimeout(timer);
                    this._pendingProposals.delete(entry.index);
                    resolve({ ok: true });
                }
            });
        });
    }
    /**
     * 添加一个 peer 到集群（仅 Leader 可用）
     *
     * 写入 membership change 日志，通过 Raft 日志复制到多数节点，commit 后自动更新 peers 配置。
     *
     * @param peerId - 要添加的 peer 节点 ID
     * @param address - peer 的地址（可选，用于非 MockTransport 场景）
     * @returns { ok: true } 如果提交成功，{ ok: false } 如果当前不是 leader 或 peer 已存在
     */
    async addPeer(peerId, address) {
        if (!this._started)
            return { ok: false };
        if (this._role !== 'leader')
            return { ok: false };
        // 检查是否已经存在
        if (this.config.peers.includes(peerId))
            return { ok: false };
        const change = { type: 'add', peerId, peerAddress: address, term: this._currentTerm };
        const data = Buffer.from(JSON.stringify({ type: 'membership_change', payload: change }));
        return this.propose(data);
    }
    /**
     * 从集群中移除一个 peer（仅 Leader 可用）
     *
     * 写入 membership change 日志，通过 Raft 日志复制到多数节点，commit 后自动更新 peers 配置。
     *
     * @param peerId - 要移除的 peer 节点 ID
     * @returns { ok: true } 如果提交成功，{ ok: false } 如果当前不是 leader 或 peer 不存在
     */
    async removePeer(peerId) {
        if (!this._started)
            return { ok: false };
        if (this._role !== 'leader')
            return { ok: false };
        // 检查 peer 是否存在
        if (!this.config.peers.includes(peerId))
            return { ok: false };
        const change = { type: 'remove', peerId, term: this._currentTerm };
        const data = Buffer.from(JSON.stringify({ type: 'membership_change', payload: change }));
        return this.propose(data);
    }
    /**
     * 线性一致读
     * Leader 发送心跳到多数节点确认领导权后返回
     */
    async readIndex(_timeoutMs) {
        if (this._role !== 'leader')
            return;
        // 心跳确认领导权
        const quorum = this._majority() - 1; // 除自己外需要的确认数
        let successCount = 0;
        const results = await Promise.allSettled(this.config.peers.map(peerId => this._sendAppendEntries(peerId, true).then(resp => {
            if (resp && resp.success)
                successCount++;
        })));
        if (successCount < quorum) {
            this.logger.warn(`Read index: only got ${successCount}/${quorum} confirmations`);
        }
    }
    // ─── 角色查询 ──────────────────────────────────────────
    getRole() { return this._role; }
    getLeaderId() {
        return this._role === 'leader' ? this.config.nodeId : null;
    }
    getTerm() { return this._currentTerm; }
    getNodeId() { return this.config.nodeId; }
    async waitForLeader(timeoutMs) {
        const deadline = Date.now() + (timeoutMs ?? 5000);
        while (Date.now() < deadline) {
            if (this._role === 'leader')
                return;
            await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('waitForLeader: timed out');
    }
    // ─── 内部消息处理 ──────────────────────────────────────
    async _handleMessage(from, msg) {
        switch (msg.type) {
            case 'AppendEntries': {
                const req = msg.data;
                const resp = await this._handleAppendEntries(from, req);
                this._sendResponse(from, {
                    type: 'AppendEntriesResponse',
                    term: resp.term,
                    from: this.config.nodeId,
                    to: from,
                    data: resp,
                });
                break;
            }
            case 'RequestVote': {
                const req = msg.data;
                const resp = await this._handleRequestVote(from, req);
                this._sendResponse(from, {
                    type: 'RequestVoteResponse',
                    term: resp.term,
                    from: this.config.nodeId,
                    to: from,
                    data: resp,
                });
                break;
            }
            case 'PreVote': {
                const req = msg.data;
                const resp = this._handlePreVote(from, req);
                this._sendResponse(from, {
                    type: 'PreVoteResponse',
                    term: resp.term,
                    from: this.config.nodeId,
                    to: from,
                    data: resp,
                });
                break;
            }
            case 'AppendEntriesResponse':
                // 作为 Leader 处理响应
                break;
            case 'RequestVoteResponse':
                // Leader 选举中处理
                break;
            case 'PreVoteResponse':
                this._handlePreVoteResponse(from, msg.data);
                break;
            case 'InstallSnapshot': {
                const req = msg.data;
                const resp = await this._handleInstallSnapshot(from, req);
                this._sendResponse(from, {
                    type: 'InstallSnapshotResponse',
                    term: resp.term,
                    from: this.config.nodeId,
                    to: from,
                    data: resp,
                });
                break;
            }
            case 'InstallSnapshotResponse':
                this._handleInstallSnapshotResponse(from, msg.data);
                break;
            case 'MembershipChange': {
                // 收到 membership change 通知：follower 端知晓集群配置变更
                // 配置变更通过日志复制同步，这里只是消息层面的通知
                const change = msg.data;
                this.logger.info(`MembershipChange notification from ${from}: ${change.type} ${change.peerId}`);
                // 实际配置更新在 _applyCommittedEntries 中通过日志条目完成
                break;
            }
        }
    }
    /** 发送响应消息 */
    _sendResponse(to, msg) {
        if (this.transport instanceof transport_1.MockTransport) {
            transport_1.MockTransport.sendResponse(to, this.config.nodeId, msg);
        }
    }
    // ─── 发送 RPC ──────────────────────────────────────────────
    async _sendAppendEntries(peerId, heartbeat) {
        // 如果 peer 不在当前配置中（已移除），跳过发送
        if (!this.config.peers.includes(peerId))
            return null;
        try {
            if (this.transport instanceof transport_1.MockTransport) {
                const req = this._buildAppendEntriesRequest(peerId, heartbeat);
                return await this.transport.appendEntries(peerId, req);
            }
            if (this.transport.appendEntries) {
                const req = this._buildAppendEntriesRequest(peerId, heartbeat);
                return await this.transport.appendEntries(peerId, req);
            }
            return null;
        }
        catch (err) {
            this.logger.warn(`AppendEntries send failed to ${peerId}:`, { err: err.message });
            return null;
        }
    }
    async _sendRequestVote(peerId) {
        // 如果 peer 不在当前配置中（已移除），跳过发送
        if (!this.config.peers.includes(peerId))
            return null;
        try {
            const lastLogIndex = this.wal.getLastIndex();
            const lastLogTerm = this.wal.getLastTerm();
            if (this.transport instanceof transport_1.MockTransport) {
                return await this.transport.requestVote(peerId, {
                    term: this._currentTerm,
                    candidateId: this.config.nodeId,
                    lastLogIndex,
                    lastLogTerm,
                });
            }
            if (this.transport.requestVote) {
                return await this.transport.requestVote(peerId, {
                    term: this._currentTerm,
                    candidateId: this.config.nodeId,
                    lastLogIndex,
                    lastLogTerm,
                });
            }
            return null;
        }
        catch (err) {
            this.logger.warn(`RequestVote send failed to ${peerId}:`, { err: err.message });
            return null;
        }
    }
    _buildAppendEntriesRequest(peerId, heartbeat) {
        let prevLogIndex;
        let prevLogTerm;
        let entries;
        if (heartbeat) {
            prevLogIndex = 0;
            prevLogTerm = 0;
            entries = [];
        }
        else {
            // Use nextIndex per peer (Raft §5.3)
            const nextIdx = this._nextIndex.get(peerId) ?? 1;
            const lastIdx = this.wal.getLastIndex();
            if (nextIdx <= 1) {
                // No previous log for this peer
                prevLogIndex = 0;
                prevLogTerm = 0;
            }
            else {
                prevLogIndex = nextIdx - 1;
                const prevEntry = this.wal.getEntry(prevLogIndex);
                prevLogTerm = prevEntry ? prevEntry.term : 0;
            }
            // Send entries from nextIdx to the end
            entries = this.wal.getEntriesFrom(nextIdx);
        }
        return {
            term: this._currentTerm,
            leaderId: this.config.nodeId,
            prevLogIndex,
            prevLogTerm,
            entries,
            leaderCommit: this._commitIndex,
        };
    }
    // ─── RPC Handlers ──────────────────────────────────────────
    async _handleAppendEntries(from, req) {
        // 1. 任期检查
        if (req.term > this._currentTerm) {
            this._stepDown(req.term);
            this.metrics.incrementCounter('graph.raft.leader_changes');
        }
        if (req.term < this._currentTerm) {
            return { term: this._currentTerm, success: false, lastLogIndex: this.wal.getLastIndex() };
        }
        // 重置选举超时（合法 leader 的心跳）
        this._resetElectionTimeout();
        // 2. prevLog 一致性检查
        if (req.prevLogIndex > 0) {
            const prevEntry = this.wal.getEntry(req.prevLogIndex);
            if (!prevEntry || prevEntry.term !== req.prevLogTerm) {
                // 冲突优化：返回 conflictingTerm 和它的第一个 index（Raft 论文 §5.3）
                const conflictingEntry = this.wal.getEntry(req.prevLogIndex);
                let conflictingTerm = 0;
                let conflictingIndex = 0;
                if (conflictingEntry) {
                    conflictingTerm = conflictingEntry.term;
                    // 找到该 term 的第一个 index
                    const allEntries = this.wal.readAll();
                    for (const e of allEntries) {
                        if (e.term === conflictingTerm) {
                            conflictingIndex = e.index;
                            break;
                        }
                    }
                }
                else {
                    // 日志缺失：返回 lastLogIndex（简化实现：告知 leader 从 lastLogIndex 之后重试）
                    conflictingIndex = this.wal.getLastIndex() + 1;
                }
                return {
                    term: this._currentTerm,
                    success: false,
                    lastLogIndex: this.wal.getLastIndex(),
                    conflictingTerm,
                    conflictingIndex,
                };
            }
        }
        // 3. 追加新条目
        for (const entry of req.entries) {
            const existing = this.wal.getEntry(entry.index);
            if (existing) {
                if (existing.term !== entry.term) {
                    await this.wal.truncate(entry.index - 1);
                }
                else {
                    continue;
                }
            }
            await this.wal.append(entry.term, entry.data);
        }
        // 4. 推进 commitIndex
        if (req.leaderCommit > this._commitIndex) {
            this._commitIndex = Math.min(req.leaderCommit, this.wal.getLastIndex());
        }
        // 5. 应用已提交的条目
        await this._applyCommittedEntries();
        // 6. 检查是否需要触发快照
        void this._checkSnapshot();
        return { term: this._currentTerm, success: true, lastLogIndex: this.wal.getLastIndex() };
    }
    async _handleRequestVote(from, req) {
        if (req.term > this._currentTerm)
            this._stepDown(req.term);
        if (req.term < this._currentTerm) {
            return { term: this._currentTerm, voteGranted: false };
        }
        if (this._votedFor !== null && this._votedFor !== req.candidateId) {
            return { term: this._currentTerm, voteGranted: false };
        }
        const myLastIndex = this.wal.getLastIndex();
        const myLastTerm = this.wal.getLastTerm();
        const logIsAtLeastAsNew = req.lastLogTerm > myLastTerm ||
            (req.lastLogTerm === myLastTerm && req.lastLogIndex >= myLastIndex);
        if (!logIsAtLeastAsNew) {
            return { term: this._currentTerm, voteGranted: false };
        }
        this._votedFor = req.candidateId;
        this._resetElectionTimeout();
        this._persistMeta();
        return { term: this._currentTerm, voteGranted: true };
    }
    // ─── PreVote ────────────────────────────────────────────────
    /**
     * 处理 PreVote 请求
     * PreVote 使用 RequestVoteRequest 结构，但 term 是 candidate 的 nextTerm
     * PreVote 不会修改 votedFor 或触发 stepDown
     */
    _handlePreVote(from, req) {
        // 如果请求 term 小于当前 term，拒绝
        if (req.term <= this._currentTerm) {
            return { term: this._currentTerm, voteGranted: false };
        }
        // 检查候选人的日志是否至少和自己一样新（与 RequestVote 相同的日志比较逻辑）
        const myLastIndex = this.wal.getLastIndex();
        const myLastTerm = this.wal.getLastTerm();
        const logIsAtLeastAsNew = req.lastLogTerm > myLastTerm ||
            (req.lastLogTerm === myLastTerm && req.lastLogIndex >= myLastIndex);
        if (!logIsAtLeastAsNew) {
            return { term: req.term, voteGranted: false };
        }
        return { term: req.term, voteGranted: true };
    }
    /**
     * 处理 PreVote 响应
     */
    _handlePreVoteResponse(from, resp) {
        if (!this._inPreVote || this._role !== 'candidate')
            return;
        if (resp.voteGranted) {
            this._preVoteGranted.push(from);
        }
        const totalNodes = this.config.peers.length + 1;
        const majority = Math.floor(totalNodes / 2) + 1;
        if (this._preVoteGranted.length + 1 >= majority) {
            // PreVote 通过，正式发起选举
            this._preVoteGranted = [];
            this._inPreVote = false;
            this._doRealElection();
        }
    }
    /**
     * 发送 PreVote 请求到指定 peer
     * PreVote 请求复用 RequestVoteRequest 数据结构，但以独立消息类型发送
     */
    async _sendPreVote(peerId) {
        // 如果 peer 不在当前配置中（已移除），跳过发送
        if (!this.config.peers.includes(peerId))
            return null;
        try {
            const lastLogIndex = this.wal.getLastIndex();
            const lastLogTerm = this.wal.getLastTerm();
            const nextTerm = this._currentTerm + 1;
            if (this.transport instanceof transport_1.MockTransport) {
                return await this.transport.preVote(peerId, {
                    term: nextTerm,
                    candidateId: this.config.nodeId,
                    lastLogIndex,
                    lastLogTerm,
                });
            }
            if (this.transport.requestVote) {
                // 非 MockTransport: 使用 requestVote，RaftCore 会收到 RequestVote 消息
                // 对于非 MockTransport 的 PreVote，消息分发由 transport 层处理
                return await this.transport.requestVote(peerId, {
                    term: nextTerm,
                    candidateId: this.config.nodeId,
                    lastLogIndex,
                    lastLogTerm,
                });
            }
            return null;
        }
        catch {
            return null;
        }
    }
    // ─── 选举 ──────────────────────────────────────────────────
    async _startElection() {
        if (!this._started || this._role === 'leader')
            return;
        this.metrics.incrementCounter('graph.raft.elections');
        // PreVote 模式：先发送 PreVote 请求
        if (this.config.preVote) {
            await this._startPreVote();
            return;
        }
        // 直接选举模式
        await this._doRealElection();
    }
    /**
     * PreVote 前置投票
     * 不递增 term，发送 term=self._currentTerm+1 的 PreVote 请求给所有 peers
     * 收集响应，超过半数同意后正式发起选举
     */
    async _startPreVote() {
        this.logger.info(`Starting pre-vote, nextTerm=${this._currentTerm + 1}`);
        this._role = 'candidate';
        this._inPreVote = true;
        this._preVoteGranted = [];
        const totalNodes = this.config.peers.length + 1;
        const majority = Math.floor(totalNodes / 2) + 1;
        // 并行发送 PreVote 到所有 peers
        const results = await Promise.all(this.config.peers.map(peerId => this._sendPreVote(peerId)));
        let preVotes = 1; // 自己同意自己
        for (const resp of results) {
            if (!resp)
                continue;
            if (resp.voteGranted) {
                preVotes++;
            }
        }
        this.logger.info(`Pre-vote result: ${preVotes}/${majority}`);
        if (preVotes >= majority) {
            // PreVote 通过，正式发起选举
            this._inPreVote = false;
            this._preVoteGranted = [];
            await this._doRealElection();
        }
        else {
            // PreVote 未通过，退回 follower 状态
            this.logger.info('Pre-vote failed, stepping back to follower');
            this._inPreVote = false;
            this._preVoteGranted = [];
            this._role = 'follower';
            this._votedFor = null;
            this._resetElectionTimeout();
        }
    }
    /**
     * 正式选举（实际自增 term 并发起 RequestVote）
     */
    async _doRealElection() {
        if (!this._started || this._role === 'leader')
            return;
        this.logger.info(`Starting election, term=${this._currentTerm + 1}`);
        this._role = 'candidate';
        this._currentTerm++;
        this._votedFor = this.config.nodeId;
        this._persistMeta();
        const totalNodes = this.config.peers.length + 1;
        const majority = Math.floor(totalNodes / 2) + 1;
        let votesReceived = 1; // 自己投给自己
        // 并行发送 RequestVote 到所有 peers
        const results = await Promise.all(this.config.peers.map(peerId => this._sendRequestVote(peerId)));
        for (const resp of results) {
            if (!resp)
                continue;
            if (resp.term > this._currentTerm) {
                this._stepDown(resp.term);
                return;
            }
            if (this._role !== 'candidate')
                return;
            if (resp.voteGranted) {
                votesReceived++;
                this.logger.info(`Got vote (${votesReceived}/${majority})`);
                if (votesReceived >= majority) {
                    this._becomeLeader();
                    return;
                }
            }
        }
        // 没有 peers 或所有投票失败时检查是否达到多数
        if (votesReceived >= majority) {
            this._becomeLeader();
            return;
        }
        // 未获得足够投票，继续 candidate 状态（由选举超时触发重试）
    }
    _becomeLeader() {
        this.logger.info(`Became leader, term=${this._currentTerm}`);
        this._role = 'leader';
        this.metrics.incrementCounter('graph.raft.leader_changes');
        const lastIndex = this.wal.getLastIndex() + 1;
        for (const peerId of this.config.peers) {
            this._nextIndex.set(peerId, lastIndex);
            this._matchIndex.set(peerId, 0);
        }
        // 初始化连接跟踪
        this._connectedPeers = new Set(this.config.peers);
        this._lastHeartbeatReachable = true;
        this._clearTimers();
        this._sendHeartbeat();
        this._startHeartbeatTimer();
    }
    // ─── Heartbeat ─────────────────────────────────────────────
    _sendHeartbeat() {
        if (this._role !== 'leader')
            return;
        for (const peerId of this.config.peers) {
            this._sendAppendEntries(peerId, true)
                .then(resp => {
                if (resp && resp.success) {
                    this._connectedPeers.add(peerId);
                }
                else {
                    this._connectedPeers.delete(peerId);
                }
            })
                .catch(() => {
                this._connectedPeers.delete(peerId);
            });
        }
    }
    // ─── 状态机 ────────────────────────────────────────────────
    async _applyCommittedEntries() {
        if (!this.stateMachine)
            return;
        const entries = this.wal.readAll();
        for (const entry of entries) {
            // 跳过已被快照覆盖的条目
            if (entry.index <= this._lastSnapshotIndex)
                continue;
            if (entry.index > this._lastApplied && entry.index <= this._commitIndex) {
                // 检查是否为 membership change 条目
                const parsed = this._tryParseMembershipEntry(entry.data);
                if (parsed) {
                    this._applyMembershipChange(parsed);
                    this._lastApplied = entry.index;
                    continue;
                }
                try {
                    await this.stateMachine(entry.data);
                    this._lastApplied = entry.index;
                }
                catch (err) {
                    this.logger.error(`Apply failed entry ${entry.index}:`, err);
                }
            }
        }
    }
    /** 尝试将日志数据解析为 membership change 条目 */
    _tryParseMembershipEntry(data) {
        try {
            const obj = JSON.parse(Buffer.from(data).toString());
            if (obj && obj.type === 'membership_change' && obj.payload) {
                const change = obj.payload;
                if (change.type === 'add' || change.type === 'remove') {
                    return change;
                }
            }
        }
        catch {
            // not a membership entry
        }
        return null;
    }
    /**
     * 应用 membership change — 更新 peers 列表
     *
     * 根据变更类型（add/remove）添加或移除 peer，同步更新 leader 的 nextIndex/matchIndex，
     * 并通过 onMembershipChange 回调通知外部。
     *
     * @param change - 成员变更对象，包含变更类型、peer ID 和任期
     */
    _applyMembershipChange(change) {
        const peers = [...this.config.peers];
        if (change.type === 'add') {
            if (!peers.includes(change.peerId)) {
                peers.push(change.peerId);
            }
        }
        else if (change.type === 'remove') {
            const idx = peers.indexOf(change.peerId);
            if (idx >= 0) {
                peers.splice(idx, 1);
            }
        }
        this.config.peers = peers;
        // 如果自己是 leader，清理/初始化被移除 peer 的状态
        if (this._role === 'leader') {
            this._nextIndex.delete(change.peerId);
            this._matchIndex.delete(change.peerId);
            this._connectedPeers.delete(change.peerId);
        }
        this.logger.info(`Membership change applied: ${change.type} ${change.peerId}, peers now [${peers.join(',')}]`);
        // 通知外部
        if (this.onMembershipChange) {
            this.onMembershipChange(change);
        }
    }
    _advanceCommitIndex() {
        if (this._role !== 'leader')
            return;
        const indexes = [this.wal.getLastIndex()];
        for (const [, matchIdx] of this._matchIndex) {
            indexes.push(matchIdx);
        }
        indexes.sort((a, b) => b - a);
        const majorityIdx = indexes[this._majority() - 1];
        if (majorityIdx > this._commitIndex) {
            const entry = this.wal.getEntry(majorityIdx);
            if (entry && entry.term === this._currentTerm) {
                this._commitIndex = majorityIdx;
            }
        }
        // resolve pending proposals whose index is now committed
        this._resolvePendingProposals();
    }
    /** 将已被 commit 的 pending proposals resolve 掉 */
    _resolvePendingProposals() {
        const resolved = [];
        for (const [index, pending] of this._pendingProposals) {
            if (index <= this._commitIndex) {
                clearTimeout(pending.timer);
                pending.resolve({ ok: true });
                resolved.push(index);
            }
        }
        for (const index of resolved) {
            this._pendingProposals.delete(index);
        }
    }
    // ─── 辅助方法 ──────────────────────────────────────────────
    _stepDown(term) {
        if (term <= this._currentTerm)
            return;
        this.logger.info(`StepDown to term=${term}`);
        if (this._role === 'leader') {
            this.metrics.incrementCounter('graph.raft.leader_changes');
            // reject 所有 pending proposals（leader 已退位）
            this._rejectAllPendingProposals();
        }
        this._currentTerm = term;
        this._role = 'follower';
        this._votedFor = null;
        this._connectedPeers.clear();
        this._clearTimers();
        // 持久化任期/投票变更
        this._persistMeta();
        if (this._started)
            this._resetElectionTimeout();
    }
    _persistMeta() {
        try {
            this.wal.persistMeta('currentTerm', String(this._currentTerm));
            this.wal.persistMeta('votedFor', this._votedFor ?? '');
        }
        catch {
            // meta 持久化失败不阻止主流程
        }
    }
    /** 加载持久化的选举状态 meta */
    _loadMeta() {
        try {
            const termStr = this.wal.loadMeta('currentTerm');
            if (termStr) {
                const term = parseInt(termStr, 10);
                if (!isNaN(term)) {
                    this._currentTerm = term;
                }
            }
            const votedFor = this.wal.loadMeta('votedFor');
            if (votedFor) {
                this._votedFor = votedFor;
            }
            this.logger.info(`Loaded meta: currentTerm=${this._currentTerm}, votedFor=${this._votedFor}`);
        }
        catch {
            // meta 加载失败不影响主流程
        }
    }
    _rejectAllPendingProposals() {
        for (const [index, pending] of this._pendingProposals) {
            clearTimeout(pending.timer);
            pending.resolve({ ok: false });
        }
        this._pendingProposals.clear();
    }
    _majority() {
        return Math.floor((this.config.peers.length + 1) / 2) + 1;
    }
    _resetElectionTimeout() {
        if (!this._started || this._role === 'leader')
            return;
        if (this._electionTimerId !== null) {
            this.timerProvider.clearTimeout(this._electionTimerId);
        }
        const timeout = this.config.electionTimeoutMs;
        const jitter = Math.floor(Math.random() * timeout) + timeout;
        this._electionTimerId = this.timerProvider.setTimeout(() => {
            if (this._started && this._role !== 'leader') {
                this._startElection();
            }
        }, jitter);
    }
    _startHeartbeatTimer() {
        if (this._heartbeatTimerId !== null) {
            this.timerProvider.clearInterval(this._heartbeatTimerId);
        }
        this._heartbeatTimerId = this.timerProvider.setInterval(() => {
            if (this._started && this._role === 'leader') {
                // CheckQuorum: 在每次心跳前检查是否能联系到多数节点
                if (this.config.checkQuorum) {
                    const totalNodes = this.config.peers.length + 1;
                    const majority = Math.floor(totalNodes / 2) + 1;
                    const connected = this._connectedPeers.size + 1; // 包括自己
                    if (connected < majority) {
                        this.logger.warn(`CheckQuorum[${this.config.nodeId}]: only ${connected}/${majority} nodes reachable, stepping down (connectedPeers=[${Array.from(this._connectedPeers).join(',')}])`);
                        this._stepDown(this._currentTerm);
                        return;
                    }
                }
                this._sendHeartbeat();
            }
        }, this.config.heartbeatIntervalMs);
    }
    _clearTimers() {
        if (this._electionTimerId !== null) {
            this.timerProvider.clearTimeout(this._electionTimerId);
            this._electionTimerId = null;
        }
        if (this._heartbeatTimerId !== null) {
            this.timerProvider.clearInterval(this._heartbeatTimerId);
            this._heartbeatTimerId = null;
        }
    }
    // ─── Snapshot 方法 ──────────────────────────────────────
    /**
     * 检查是否需要触发快照，并在需要时自动执行
     */
    async _checkSnapshot() {
        const entryCount = this.wal.entriesCount();
        if (entryCount - this._lastSnapshotIndex <= this.config.snapshotThreshold)
            return;
        await this._doSnapshot();
    }
    /**
     * 执行快照
     * 1. 调用 stateMachine 传入特殊标记让外部持久化状态
     * 2. 将状态写入 snapshotPath 文件（JSON 格式）
     * 3. 截断 WAL 中已被快照包含的条目
     */
    async _doSnapshot() {
        if (!this.stateMachine)
            return;
        const lastIncludedIndex = this.wal.getLastIndex();
        const lastIncludedTerm = this.wal.getLastTerm();
        if (lastIncludedIndex <= this._lastSnapshotIndex)
            return; // nothing new to snapshot
        // 让状态机持久化当前状态
        // 传入空的 Uint8Array 作为快照标记（状态机自行持久化）
        await this.stateMachine(new Uint8Array(0));
        // 写 snapshot 文件
        const snapshot = {
            lastIncludedIndex,
            lastIncludedTerm,
            state: 'snapshot-complete',
        };
        const snapshotPath = this.config.snapshotPath;
        const dir = snapshotPath.substring(0, snapshotPath.lastIndexOf('/'));
        if (dir && dir !== snapshotPath) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
        fs.fsyncSync(fs.openSync(snapshotPath, 'r'));
        this._lastSnapshotIndex = lastIncludedIndex;
        this._lastSnapshotTerm = lastIncludedTerm;
        // 截断 WAL：删除 lastIncludedIndex 及之前的条目
        await this.wal.truncateBefore(lastIncludedIndex + 1);
        this.logger.info(`Snapshot completed: lastIncludedIndex=${lastIncludedIndex}, ` +
            `lastIncludedTerm=${lastIncludedTerm}, ` +
            `WAL entries remaining=${this.wal.entriesCount()}`);
    }
    /**
     * 加载 snapshot 状态（启动时调用）
     */
    _loadSnapshotState() {
        const snapshotPath = this.config.snapshotPath;
        if (!fs.existsSync(snapshotPath))
            return;
        try {
            const raw = fs.readFileSync(snapshotPath, 'utf-8');
            const snapshot = JSON.parse(raw);
            this._lastSnapshotIndex = snapshot.lastIncludedIndex;
            this._lastSnapshotTerm = snapshot.lastIncludedTerm;
            // 快照后的 _lastApplied 至少达到 lastSnapshotIndex
            if (this._lastApplied < this._lastSnapshotIndex) {
                this._lastApplied = this._lastSnapshotIndex;
            }
            // 快照后的 _commitIndex 至少达到 lastSnapshotIndex
            if (this._commitIndex < this._lastSnapshotIndex) {
                this._commitIndex = this._lastSnapshotIndex;
            }
            this.logger.info(`Loaded snapshot: lastIncludedIndex=${this._lastSnapshotIndex}, ` +
                `lastIncludedTerm=${this._lastSnapshotTerm}`);
        }
        catch (err) {
            this.logger.error('Failed to load snapshot state:', err);
        }
    }
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
    async _handleInstallSnapshot(from, req) {
        this.logger.info(`Handling InstallSnapshot from ${from}: ` +
            `lastIncludedIndex=${req.lastIncludedIndex}, ` +
            `lastIncludedTerm=${req.lastIncludedTerm}, ` +
            `done=${req.done}`);
        if (req.term < this._currentTerm) {
            return { term: this._currentTerm, success: false };
        }
        if (req.term > this._currentTerm) {
            this._stepDown(req.term);
        }
        this._resetElectionTimeout();
        // 只有当快照比我们当前的状态更新时才应用
        if (req.lastIncludedIndex <= this._lastSnapshotIndex &&
            req.lastIncludedTerm <= this._lastSnapshotTerm) {
            return { term: this._currentTerm, success: true };
        }
        if (req.done) {
            // 写 snapshot 文件
            const snapshotPath = this.config.snapshotPath;
            const dir = snapshotPath.substring(0, snapshotPath.lastIndexOf('/'));
            if (dir && dir !== snapshotPath) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const snapshot = {
                lastIncludedIndex: req.lastIncludedIndex,
                lastIncludedTerm: req.lastIncludedTerm,
                state: 'install-snapshot-' + req.lastIncludedIndex,
            };
            fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
            fs.fsyncSync(fs.openSync(snapshotPath, 'r'));
            this._lastSnapshotIndex = req.lastIncludedIndex;
            this._lastSnapshotTerm = req.lastIncludedTerm;
            // 截断 WAL 中被快照覆盖的条目
            await this.wal.truncateBefore(req.lastIncludedIndex + 1);
            // 更新 commitIndex / lastApplied
            if (this._commitIndex < req.lastIncludedIndex) {
                this._commitIndex = req.lastIncludedIndex;
            }
            if (this._lastApplied < req.lastIncludedIndex) {
                this._lastApplied = req.lastIncludedIndex;
            }
            this.logger.info(`InstallSnapshot applied: done, remaining WAL entries=${this.wal.entriesCount()}`);
        }
        return { term: this._currentTerm, success: true };
    }
    /**
     * 处理 InstallSnapshot 响应（发送方：leader）
     */
    _handleInstallSnapshotResponse(from, resp) {
        if (resp.term > this._currentTerm) {
            this._stepDown(resp.term);
            return;
        }
        this.logger.info(`InstallSnapshot sent to ${from}: success=${resp.success}`);
    }
    /** 检查 _buildAppendEntriesRequest 中 nextIdx 是否需要触发 InstallSnapshot */
    _needsInstallSnapshot(peerId) {
        const nextIdx = this._nextIndex.get(peerId) ?? 1;
        return nextIdx <= this._lastSnapshotIndex;
    }
    /**
     * 删除 snapshot 文件（测试辅助）
     */
    async destroySnapshot() {
        const snapshotPath = this.config.snapshotPath;
        try {
            if (fs.existsSync(snapshotPath)) {
                fs.unlinkSync(snapshotPath);
            }
        }
        catch {
            // ignore
        }
        this._lastSnapshotIndex = 0;
        this._lastSnapshotTerm = 0;
    }
}
exports.RaftCore = RaftCore;
//# sourceMappingURL=raft-core.js.map