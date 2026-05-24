"use strict";
// ============================================================
// OverGraphStorage — StorageProvider 的 OverGraph v0.7.0 实现
//
// 将 StorageProvider 接口适配到 OverGraph 原生 API。
// 这是 GraphEngine 的默认存储后端。
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.OverGraphStorage = void 0;
const overgraph_1 = require("overgraph");
class OverGraphStorage {
    _db = null;
    _isOpen = false;
    get isOpen() { return this._isOpen; }
    open(config) {
        if (this._isOpen)
            return;
        this._db = overgraph_1.OverGraph.open(config.path, {
            denseVector: config.denseVector
                ? { dimension: config.denseVector.dimension }
                : undefined,
            defaultRetention: config.defaultRetention,
        });
        this._isOpen = true;
    }
    close() {
        if (!this._isOpen || !this._db)
            return;
        this._db.close();
        this._db = null;
        this._isOpen = false;
    }
    // ── 节点操作 ──────────────────────────────
    upsertNode(typeId, name, opts) {
        return this._db.upsertNode(typeId, name, {
            props: opts?.props,
            denseVector: opts?.denseVector instanceof Float32Array
                ? opts.denseVector
                : opts?.denseVector ? new Float32Array(opts.denseVector) : undefined,
            sparseVector: opts?.sparseVector,
            temporalValidity: opts?.temporalValidity,
            decayFactor: opts?.decayFactor,
            retentionPolicy: opts?.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : undefined,
        });
    }
    getNode(id, includeProps) {
        const raw = this._db.getNode(id, includeProps);
        if (!raw)
            return null;
        return {
            id: raw.id,
            typeId: raw.typeId,
            key: raw.key,
            props: raw.props,
            createdAt: raw.createdAt,
        };
    }
    deleteNode(id) {
        this._db.deleteNode(id);
        return true;
    }
    batchUpsertNodes(inputs) {
        return this._db.batchUpsertNodes(inputs);
    }
    degrees(id) {
        return this._db.degrees(id);
    }
    // ── 边操作 ────────────────────────────────
    upsertEdge(src, dst, typeId, opts) {
        this._db.upsertEdge(src, dst, typeId, {
            props: opts?.props,
            temporalValidity: opts?.temporalValidity,
            weight: opts?.weight,
        });
    }
    getEdge(src, dst, typeId) {
        const raw = this._db.getEdge(src, dst, typeId);
        if (!raw)
            return null;
        return {
            from: raw.from,
            to: raw.to,
            typeId: raw.typeId,
            props: raw.props,
            createdAt: raw.createdAt,
        };
    }
    deleteEdge(src, dst, typeId) {
        return this._db.deleteEdge(src, dst, typeId);
    }
    neighbors(id, opts) {
        return this._db.neighbors(id, { maxDepth: opts?.maxDepth ?? 1, edgeTypeFilter: opts?.edgeTypeFilter });
    }
    // ── 搜索 ──────────────────────────────────
    vectorSearch(searchQuery) {
        return this._db.vectorSearch(searchQuery);
    }
    // ── 图算法 ────────────────────────────────
    personalizedPageRank(opts) {
        return this._db.personalizedPageRank(opts);
    }
    allShortestPaths(opts) {
        return this._db.allShortestPaths(opts);
    }
    connectedComponents(opts) {
        return this._db.connectedComponents(opts);
    }
    queryPattern(opts) {
        return this._db.queryPattern(opts).map(n => ({
            id: n.id, typeId: n.typeId, key: n.key,
            props: n.props,
            createdAt: n.createdAt,
        }));
    }
    // ── 维护 ──────────────────────────────────
    compact() {
        this._db.compact();
    }
    stats() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = this._db.stats();
        return {
            nodeCount: s.activeNodeCount + s.immutableNodeCount,
            edgeCount: s.activeEdgeCount + s.immutableEdgeCount,
            diskSizeBytes: s.pendingWalBytes + s.activeMemtableBytes + s.immutableMemtableBytes,
            pendingWalBytes: s.pendingWalBytes,
            activeMemtableBytes: s.activeMemtableBytes,
            immutableMemtableBytes: s.immutableMemtableBytes,
        };
    }
    exportSnapshot() {
        if (typeof this._db.exportSnapshot !== 'function') {
            return Buffer.alloc(0);
        }
        return Buffer.from(this._db.exportSnapshot());
    }
    importSnapshot(data) {
        ;
        this._db.importSnapshot(data);
    }
}
exports.OverGraphStorage = OverGraphStorage;
//# sourceMappingURL=overgraph-storage.js.map