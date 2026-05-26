"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionManager = exports.Transaction = void 0;
let nextTxnId = 1;
class Transaction {
    id;
    startedAt;
    _writes = [];
    _committed = false;
    _rolledBack = false;
    constructor() {
        this.id = nextTxnId++;
        this.startedAt = Date.now();
    }
    /** 插入/更新节点 */
    upsertNode(typeId, name, opts) {
        this._checkActive();
        this._writes.push({ kind: 'upsertNode', typeId, name, opts });
    }
    /** 删除节点 */
    deleteNode(id) {
        this._checkActive();
        this._writes.push({ kind: 'deleteNode', id });
    }
    /** 插入/更新边 */
    upsertEdge(src, dst, typeId, opts) {
        this._checkActive();
        this._writes.push({ kind: 'upsertEdge', src, dst, typeId, opts });
    }
    /** 删除边 */
    deleteEdge(src, dst, typeId) {
        this._checkActive();
        this._writes.push({ kind: 'deleteEdge', src, dst, typeId });
    }
    /** 将事务写入 flush 到 engine（走完整路径：label index + overgraph HNSW + event） */
    async commit(engine) {
        if (this._committed)
            throw new Error('Transaction already committed');
        if (this._rolledBack)
            throw new Error('Transaction already rolled back');
        this._committed = true;
        for (const write of this._writes) {
            switch (write.kind) {
                case 'upsertNode':
                    engine.upsertNode(write.typeId, write.name, write.opts);
                    break;
                case 'deleteNode':
                    engine.deleteNode(write.id);
                    break;
                case 'upsertEdge':
                    engine.upsertEdge(write.src, write.dst, write.typeId, write.opts);
                    break;
                case 'deleteEdge':
                    engine.deleteEdge(write.src, write.dst, write.typeId);
                    break;
            }
        }
    }
    /** 放弃缓存的写入 */
    rollback() {
        if (this._committed)
            throw new Error('Cannot rollback a committed transaction');
        this._rolledBack = true;
        this._writes = [];
    }
    /** 获取写集快照 (用于 external observer / WAL 日志) */
    snapshot() {
        return {
            writes: [...this._writes],
            startedAt: this.startedAt,
        };
    }
    _checkActive() {
        if (this._committed)
            throw new Error('Transaction already committed');
        if (this._rolledBack)
            throw new Error('Transaction already rolled back');
    }
}
exports.Transaction = Transaction;
/**
 * TransactionManager — 管理活跃事务
 * 提供轻量级碰撞检测 (基于写集交集)
 */
class TransactionManager {
    _active = new Map();
    _maxActive;
    constructor(maxActive = 100) {
        this._maxActive = maxActive;
    }
    begin() {
        if (this._active.size >= this._maxActive) {
            throw new Error(`Too many active transactions (max ${this._maxActive})`);
        }
        const txn = new Transaction();
        this._active.set(txn.id, txn);
        return txn;
    }
    get(id) {
        return this._active.get(id);
    }
    remove(id) {
        this._active.delete(id);
    }
    /** 乐观锁冲突检测: 检查两个事务的写集是否有节点冲突 */
    detectConflict(a, b) {
        const idsA = new Set();
        for (const w of a.writes) {
            if (w.kind === 'deleteNode' || w.kind === 'upsertNode')
                idsA.add(w.kind === 'deleteNode' ? w.id : 0); // 简化
        }
        const idsB = new Set();
        for (const w of b.writes) {
            if (w.kind === 'deleteNode' || w.kind === 'upsertNode')
                idsB.add(w.kind === 'deleteNode' ? w.id : 0);
        }
        // 检查交集 (简化为节点级别)
        for (const id of idsA) {
            if (idsB.has(id))
                return true;
        }
        return false;
    }
    /** 所有活跃事务数量 */
    get activeCount() {
        return this._active.size;
    }
}
exports.TransactionManager = TransactionManager;
//# sourceMappingURL=transaction.js.map