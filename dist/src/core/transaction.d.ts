/**
 * Transaction — MVCC 增强事务系统
 *
 * 支持：
 * - 快照隔离 (Snapshot Isolation)
 * - 写集锁 + 冲突检测
 * - 读集追踪
 * - SSI (Serializable Snapshot Isolation) — 读集冲突检测
 * - 死锁检测 — Wait-for 图循环检测
 * - 版本链 — 多版本读取
 * - 隔离级别选择 (read-committed / snapshot / serializable)
 * - 超时锁清理
 * - 与 GraphEngine 深度集成
 */
import type { GraphEngine } from './graph-engine';
import type { NodeId, NodeRecord } from '../types';
export type IsolationLevel = 'read-committed' | 'snapshot' | 'serializable';
export interface UpsertOpData {
    typeId: number;
    name: string;
    props?: Record<string, any>;
}
export interface MVCCSnapshot {
    id: number;
    createdAt: number;
    /** 可选版本号，用于多版本读取 (version chain) */
    version?: number;
}
export interface BeginOptions {
    isolation?: IsolationLevel;
    /** 跨分片 aware: 如果指定了多个 rangeIds，启用 2PC */
    rangeIds?: string[];
}
export declare class TransactionManager {
    private _nextSnapshotId;
    private _locks;
    private _lockTimeoutMs;
    /** 已提交事务的写入记录（用于 SSI 读集冲突检测）
     *  key = nodeId string (or "name:${name}" for upsert operations)
     *  value = committedAt 时间戳 */
    private _committedWrites;
    constructor(lockTimeoutMs?: number);
    get lockCount(): number;
    begin(opts?: BeginOptions): Transaction;
    isLocked(nodeId: NodeId): boolean;
    lock(nodeId: NodeId, snapshotId: number): void;
    unlock(nodeId: NodeId): void;
    unlockAll(snapshotId: number): void;
    /** 清理超时锁 */
    _cleanupStaleLocks(): void;
    /**
     * 记录事务提交时的写入（用于 SSI 读集冲突检测）
     * 会记录 writeSet 中的 name 和 deleteSet 中的 nodeId
     */
    _recordCommitWrite(snapshotId: number, writeSet: Map<string, UpsertOpData>, deleteSet: Set<NodeId>, engine?: GraphEngine): void;
    /**
     * 检查节点的读集冲突
     * 如果 committedWrites 中有任何条目在 snapshot 创建之后记录了该节点，说明有冲突
     */
    _checkNodeConflict(nodeId: NodeId, snapshotCreatedAt: number): boolean;
    /**
     * 检测死锁 — 构建 wait-for 图，使用 DFS 检测循环
     * 返回第一个检测到的死锁描述字符串，无死锁返回 null
     *
     * 算法：
     * 1. 每个 snapshotId 是一个节点
     * 2. 如果 T1 持有节点 X 的锁，T2 正在请求节点 X（T2 已在 wait-for 表中），
     *    则 T2 → T1（T2 等待 T1）
     * 3. 由于我们使用阻塞锁（lock() 直接抛异常），
     *    死锁场景是：T1 持有 A，T2 持有 B，T1 请求 B，T2 请求 A
     *    → 在 lock 阶段，T1 锁了 A，T2 锁了 B
     *    → T1 再锁 B 失败（超时/异常），T2 再锁 A 失败
     *    但等待关系需要在 commit 前建立
     *
     * 实际实现：在 Phase 0.5，我们已经部分加锁了，
     * 构建 wait-for：对于每个尝试加锁的 snapshot，检查它需要的锁被谁持有
     *
     * 简化实现：检查当前所有锁中，是否存在循环等待
     * - 构建图: 节点 = snapshotId, 边 = A → B 表示 A 在等待 B 持有的锁
     * - 每个锁的持有者是 snapshotId，被锁的 node 是该锁的资源
     * - 如果一个 snapshot 有 pending_lock_request(resource, blockedBySnapshotId)，
     *   则 snapshot → blockedBySnapshotId
     *
     * 这里的实现采用简化版：如果存在一个锁循环（多个 snapshot 互相持有对方需要的锁），
     * 则存在死锁。对于当前阻塞锁模型，我们检查是否两个 snapshot 各自锁了对方需要的节点。
     */
    detectDeadlock(snapshotId: number): string | null;
    /**
     * 注册锁请求（用于死锁检测）
     * 当 lock() 失败时调用，记录请求关系
     */
    private _lockRequests;
    _registerLockRequest(nodeId: NodeId, snapshotId: number): void;
    _clearLockRequest(nodeId: NodeId): void;
    _clearAllLockRequests(snapshotId: number): void;
    /**
     * 增强版死锁检测 — 基于锁请求跟踪
     * 构建完整的 wait-for 图，检测循环
     */
    detectDeadlockFull(snapshotId: number): string | null;
    /**
     * 获取等待关系图（用于调试/测试）
     */
    getWaitForGraph(): Map<number, Set<number>>;
}
export declare class Transaction {
    readonly snapshot: MVCCSnapshot;
    readonly writeSet: Map<string, UpsertOpData>;
    readonly deleteSet: Set<NodeId>;
    readonly readSet: Set<NodeId>;
    readonly isolation: IsolationLevel;
    /** 是否使用 2PC — 跨分片事务标志 */
    readonly _use2PC: boolean;
    /** 关联的跨分片 range IDs */
    readonly _rangeIds: string[];
    private _committed;
    private _rolledBack;
    private _mgr;
    private _engine;
    /**
     * @param mgr - TransactionManager
     * @param snapshotOrEngine - Either MVCCSnapshot (called from mgr.begin())
     *                          or GraphEngine (called from tests: new Transaction(mgr, engine))
     */
    constructor(mgr: TransactionManager, snapshotOrEngine?: MVCCSnapshot | GraphEngine, isolation?: IsolationLevel);
    get active(): boolean;
    get snapshotId(): number;
    upsertNode(typeId: number, name: string, props?: Record<string, any>): NodeId;
    deleteNode(nodeId: NodeId): void;
    upsertEdge(src: NodeId, dst: NodeId, typeId: number, props?: Record<string, any>): void;
    readNode(nodeId: NodeId): void;
    /**
     * 读节点（带版本信息）
     * 在多版本读取中，返回 snapshot-time 的值
     * 如果 engine 提供了版本链支持，读取对应版本
     */
    readNodeVersioned(nodeId: NodeId, engines?: GraphEngine | GraphEngine[]): any;
    /**
     * Phase 0: SSI 读集冲突检测
     * 检查读集中的节点是否被其他事务在 snapshot 之后修改过
     * 仅当 isolation === 'serializable' 时调用
     */
    _checkReadSetConflict(_engine: GraphEngine | null): boolean;
    /**
     * Phase 0.5: 死锁检测
     * 检测当前事务是否陷入死锁（wait-for 图循环）
     */
    _detectDeadlock(snapshotId: number, mgr: TransactionManager | null): boolean;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    private _flushToEngine;
    /**
     * 从引擎读取节点，应用 MVCC 快照可见性
     * 在 snapshot 隔离级别下，只返回在事务开始前已提交的节点
     */
    getNode(engine: GraphEngine, nodeId: NodeId): NodeRecord | null;
    /**
     * 检查引擎中节点的版本是否对当前快照可见
     */
    isNodeVisible(engine: GraphEngine, nodeId: NodeId): boolean;
    /** 设置 engine（可选，用于 flush） */
    setEngine(engine: GraphEngine): void;
    private _checkActive;
}
//# sourceMappingURL=transaction.d.ts.map