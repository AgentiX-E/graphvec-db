/**
 * Transaction — 轻量级事务接口
 *
 * 在内存中缓存写操作，commit 时通过 GraphEngine 一次性 flush。
 * 走 engine 路径确保 label index、HNSW（由 overgraph 托管）、event emission 不绕过。
 * 冲突检测使用简单的时间戳 + 写集碰撞检测。
 *
 * 设计原则:
 * - 不需要修改现有 GraphEngine 同步方法
 * - beginTransaction() + commit()/rollback() 是可选路径
 * - 连接层 (Raft/rest) 可以将一组操作包装成事务
 */
import type { GraphEngine } from './graph-engine';
import type { UpsertNodeOptions, UpsertEdgeOptions } from '../types';
export type TxnWrite = {
    kind: 'upsertNode';
    typeId: number;
    name: string;
    opts?: UpsertNodeOptions;
} | {
    kind: 'deleteNode';
    id: number;
} | {
    kind: 'upsertEdge';
    src: number;
    dst: number;
    typeId: number;
    opts?: UpsertEdgeOptions;
} | {
    kind: 'deleteEdge';
    src: number;
    dst: number;
    typeId: number;
};
export interface TxnSnapshot {
    writes: ReadonlyArray<TxnWrite>;
    startedAt: number;
}
export declare class Transaction {
    readonly id: number;
    readonly startedAt: number;
    private _writes;
    private _committed;
    private _rolledBack;
    constructor();
    /** 插入/更新节点 */
    upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): void;
    /** 删除节点 */
    deleteNode(id: number): void;
    /** 插入/更新边 */
    upsertEdge(src: number, dst: number, typeId: number, opts?: UpsertEdgeOptions): void;
    /** 删除边 */
    deleteEdge(src: number, dst: number, typeId: number): void;
    /** 将事务写入 flush 到 engine（走完整路径：label index + overgraph HNSW + event） */
    commit(engine: GraphEngine): Promise<void>;
    /** 放弃缓存的写入 */
    rollback(): void;
    /** 获取写集快照 (用于 external observer / WAL 日志) */
    snapshot(): TxnSnapshot;
    private _checkActive;
}
/**
 * TransactionManager — 管理活跃事务
 * 提供轻量级碰撞检测 (基于写集交集)
 */
export declare class TransactionManager {
    private _active;
    private _maxActive;
    constructor(maxActive?: number);
    begin(): Transaction;
    get(id: number): Transaction | undefined;
    remove(id: number): void;
    /** 乐观锁冲突检测: 检查两个事务的写集是否有节点冲突 */
    detectConflict(a: TxnSnapshot, b: TxnSnapshot): boolean;
    /** 所有活跃事务数量 */
    get activeCount(): number;
}
//# sourceMappingURL=transaction.d.ts.map