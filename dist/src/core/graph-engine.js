"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphEngine = void 0;
const overgraph_storage_1 = require("./overgraph-storage");
const hnsw_1 = require("../search/hnsw");
const hybrid_search_1 = require("../search/hybrid-search");
const label_engine_1 = require("./label-engine");
const event_bus_1 = require("./event-bus");
/**
 * GraphEngine — 存储无关的图引擎核心
 *
 * 所有数据操作通过 StorageProvider 接口完成，不直接依赖任何具体存储后端。
 * 默认使用 OverGraph 后端，可切换为任何实现了 StorageProvider 的实现。
 */
class GraphEngine {
    storage;
    config;
    _isOpen = false;
    _nodeCount = 0;
    _edgeCount = 0;
    _nodeIds = new Set();
    _edgeKeys = new Set();
    _labelIndex = new label_engine_1.LabelEngine();
    _eventStream = null;
    _hnsw = null;
    /**
     * 可选的回调：当节点/边发生变更时被调用
     * 用于 DeltaSync 捕捉变更
     */
    onRecordChange;
    constructor(config, storage, eventStream, hnswConfig) {
        this.storage = storage ?? new overgraph_storage_1.OverGraphStorage();
        this.config = config;
        this._eventStream = eventStream ?? null;
        if (hnswConfig) {
            this._hnsw = new hnsw_1.HnswIndex(hnswConfig);
        }
    }
    /** 检查数据库是否已打开 */
    get isOpen() { return this._isOpen; }
    /** 通过 EventStream（可靠）或 EventBus（fire-and-forget）发布变更事件 */
    _emit(event) {
        if (this._eventStream) {
            this._eventStream.emit(event);
        }
        else {
            try {
                (0, event_bus_1.getEventBus)().emit({ ...event, timestamp: Date.now() });
            }
            catch { /* bus not initialized */ }
        }
    }
    /** 打开数据库 */
    open() {
        if (this._isOpen)
            return;
        this.storage.open({
            path: this.config.path,
            denseVector: this.config.denseVector
                ? { dimension: this.config.denseVector.dimension }
                : undefined,
            defaultRetention: this.config.defaultRetention,
        });
        this._isOpen = true;
    }
    /** 关闭数据库 */
    close() {
        if (!this._isOpen)
            return;
        this.storage.close();
        this._isOpen = false;
    }
    // ──────────────────────────────────────────
    // Node operations
    // ──────────────────────────────────────────
    /**
     * 插入或更新一个节点
     *
     * @param typeId - 节点类型 ID
     * @param name - 节点名称
     * @param opts - 可选参数（属性、向量、有效期、衰减因子、TTL）
     * @returns 新插入或已有节点的 ID
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    upsertNode(typeId, name, opts) {
        this._ensureOpen();
        const id = this.storage.upsertNode(typeId, name, opts);
        if (!this._nodeIds.has(id)) {
            this._nodeIds.add(id);
            this._nodeCount++;
        }
        this._labelIndex.addNode(typeId, id);
        this.onRecordChange?.(name, { typeId, ...(opts?.props ?? {}) });
        // 同步 HNSW 索引
        if (this._hnsw && opts?.denseVector instanceof Float32Array) {
            this._hnsw.insert(id, opts.denseVector);
        }
        this._emit({ type: 'node:created', data: { id, typeId, name, props: opts?.props } });
        return id;
    }
    /**
     * 根据节点 ID 获取节点记录
     *
     * @param id - 节点 ID
     * @returns NodeRecord 或 null（节点不存在时）
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    getNode(id) {
        this._ensureOpen();
        const raw = this.storage.getNode(id, true);
        if (!raw)
            return null;
        let degree = 0;
        try {
            const d = this.storage.degrees(id);
            degree = d.inDegree + d.outDegree;
        }
        catch {
            // storage 可能在某些状态下不支持 degrees() 调用
        }
        return {
            id: raw.id,
            type: raw.typeId,
            name: raw.key,
            props: raw.props,
            createdAt: raw.createdAt,
            degree,
        };
    }
    /**
     * 删除指定 ID 的节点
     *
     * @param id - 要删除的节点 ID
     * @returns true 如果节点存在且被删除，false 如果节点不存在
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    deleteNode(id) {
        this._ensureOpen();
        const node = this.storage.getNode(id, true);
        if (!node)
            return false;
        this._labelIndex.removeNode(node.typeId, id);
        this.storage.deleteNode(id);
        this._nodeIds.delete(id);
        this._nodeCount = Math.max(0, this._nodeCount - 1);
        this.onRecordChange?.(node.key, { _deleted: true, typeId: node.typeId });
        this._emit({ type: 'node:deleted', data: { id, typeId: node.typeId, name: node.key } });
        return true;
    }
    /**
     * 批量插入或更新多个节点
     *
     * @param inputs - 节点输入数组
     * @returns 节点名称到 ID 的映射表
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    batchUpsertNodes(inputs) {
        this._ensureOpen();
        const ids = this.storage.batchUpsertNodes(inputs.map(i => ({
            typeId: i.typeId,
            name: i.name,
            key: i.name,
            props: i.opts?.props,
            denseVector: i.opts?.denseVector instanceof Float32Array
                ? i.opts.denseVector
                : i.opts?.denseVector ? new Float32Array(i.opts.denseVector) : undefined,
            temporalValidity: i.opts?.temporalValidity,
        })));
        // Build name-to-ID map by querying each returned node
        const nameToId = {};
        for (const id of ids) {
            const node = this.storage.getNode(id, true);
            if (node) {
                nameToId[node.key] = id;
            }
        }
        // Fallback: if any name is missing (e.g. duplicate overwrites),
        // use index-based mapping as last resort
        for (let i = 0; i < inputs.length; i++) {
            if (nameToId[inputs[i].name] === undefined && i < ids.length) {
                nameToId[inputs[i].name] = ids[i];
            }
        }
        return nameToId;
    }
    // ──────────────────────────────────────────
    // Edge operations
    // ──────────────────────────────────────────
    /**
     * 插入或更新一条边
     *
     * @param src - 源节点 ID
     * @param dst - 目标节点 ID
     * @param typeId - 边类型 ID
     * @param opts - 可选参数
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    upsertEdge(src, dst, typeId, opts) {
        this._ensureOpen();
        this.storage.upsertEdge(src, dst, typeId, {
            props: opts?.props,
            temporalValidity: opts?.temporalValidity,
            weight: opts?.weight,
        });
        const ek = `${src}:${dst}:${typeId}`;
        if (!this._edgeKeys.has(ek)) {
            this._edgeKeys.add(ek);
            this._edgeCount++;
        }
        this.onRecordChange?.(`edge:${src}->${dst}`, { typeId, src, dst, ...(opts?.props ?? {}) });
        this._emit({ type: 'edge:created', data: { src, dst, typeId, props: opts?.props } });
    }
    /**
     * 获取指定边的记录
     *
     * @param src - 源节点 ID
     * @param dst - 目标节点 ID
     * @param typeId - 边类型 ID
     * @returns EdgeRecord 或 null（边不存在时）
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    getEdge(src, dst, typeId) {
        this._ensureOpen();
        const raw = this.storage.getEdge(src, dst, typeId);
        if (raw) {
            return {
                src: raw.from,
                dst: raw.to,
                type: raw.typeId,
                props: raw.props,
                timestamp: raw.createdAt,
            };
        }
        // Fallback: search via neighbors to find the matching edge
        const entries = this.storage.neighbors(src, { maxDepth: 1, edgeTypeFilter: [typeId] });
        const match = entries.find(e => e.nodeId === dst && e.edgeTypeId === typeId);
        if (!match)
            return null;
        return {
            src, dst, type: typeId, props: {}, timestamp: match.validFrom,
        };
    }
    /**
     * 删除指定边
     *
     * @param src - 源节点 ID
     * @param dst - 目标节点 ID
     * @param typeId - 边类型 ID
     * @returns true 如果边存在且被删除
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    deleteEdge(src, dst, typeId) {
        this._ensureOpen();
        const result = this.storage.deleteEdge(src, dst, typeId);
        if (result) {
            this._edgeCount = Math.max(0, this._edgeCount - 1);
        }
        this.onRecordChange?.(`edge:${src}->${dst}:${typeId}`, { _deleted: true, src, dst, typeId });
        this._emit({ type: 'edge:deleted', data: { src, dst, typeId } });
        return result;
    }
    /**
     * 获取指定节点的所有邻居
     *
     * @param id - 节点 ID
     * @param opts - 可选参数（maxDepth, edgeTypeFilter）
     * @returns 包含 edges 和 nodes 数组的对象
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    neighbors(id, opts) {
        this._ensureOpen();
        const entries = this.storage.neighbors(id, opts);
        const edges = [];
        const nodes = [];
        const seenNodes = new Set();
        for (const entry of entries) {
            edges.push({
                src: id, dst: entry.nodeId, type: entry.edgeTypeId, props: {}, timestamp: entry.validFrom,
            });
            if (!seenNodes.has(entry.nodeId)) {
                seenNodes.add(entry.nodeId);
                const raw = this.storage.getNode(entry.nodeId, true);
                if (raw) {
                    nodes.push({
                        id: raw.id, type: raw.typeId, name: raw.key,
                        props: raw.props,
                        createdAt: raw.createdAt, degree: 0,
                    });
                }
            }
        }
        return { edges, nodes };
    }
    // ──────────────────────────────────────────
    // Vector search
    // ──────────────────────────────────────────
    /**
     * 向量搜索
     *
     * @param query - 搜索参数
     * @returns 按分数降序排列的搜索结果数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    vectorSearch(query) {
        this._ensureOpen();
        // Hybrid Search (BM25 + HNSW 融合)
        if (this._hnsw && query.hybrid && typeof query.hybrid === 'object' && query.hybrid.text) {
            const queryVec = query.denseQuery instanceof Float32Array
                ? query.denseQuery
                : query.denseQuery ? new Float32Array(query.denseQuery) : undefined;
            const bm25SearchFn = (text, topK) => {
                try {
                    const searchQuery = JSON.stringify({
                        denseQuery: undefined,
                        sparseQuery: text,
                        k: topK,
                        hybrid: undefined,
                        minScore: 0,
                    });
                    const hits = this.storage.vectorSearch(searchQuery);
                    return hits.map(h => ({ id: h.id, score: h.score }));
                }
                catch {
                    return [];
                }
            };
            const fused = (0, hybrid_search_1.hybridSearch)(this._hnsw, bm25SearchFn, {
                vector: queryVec,
                text: query.hybrid.text,
                strategy: query.hybrid.strategy,
                topK: query.k ?? 10,
            });
            return fused.map(r => ({
                node: this.getNode(r.id),
                score: r.score,
                distance: 1 - r.score,
            })).filter(r => r.node !== null);
        }
        // HNSW 纯向量路径
        if (this._hnsw && query.denseQuery) {
            const queryVec = query.denseQuery instanceof Float32Array
                ? query.denseQuery
                : new Float32Array(query.denseQuery);
            const k = query.k ?? 10;
            const hits = this._hnsw.search(queryVec, k);
            return hits.map(hit => ({
                node: this.getNode(hit.id),
                score: 1 - hit.distance,
                distance: hit.distance,
            })).filter(r => r.node !== null);
        }
        // 回退到存储层搜索
        const searchQuery = JSON.stringify({
            denseQuery: query.denseQuery instanceof Float32Array
                ? Array.from(query.denseQuery)
                : query.denseQuery || undefined,
            sparseQuery: query.sparseQuery,
            k: query.k ?? 10,
            hybrid: query.hybrid || undefined,
            scope: query.scope ? {
                startNodeId: query.scope.startNodeId,
                maxDepth: query.scope.maxDepth,
                edgeTypeFilter: query.scope.edgeTypeFilter,
            } : undefined,
            minScore: query.minScore,
        });
        const hits = this.storage.vectorSearch(searchQuery);
        return hits.map(hit => ({
            node: this.getNode(hit.id),
            score: hit.score,
            distance: hit.distance,
        })).filter(r => r.node !== null);
    }
    // ──────────────────────────────────────────
    // Graph algorithms
    // ──────────────────────────────────────────
    /**
     * 个性化 PageRank
     *
     * @param opts - 算法参数
     * @returns 节点 ID 和对应分数的数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    personalizedPageRank(opts) {
        this._ensureOpen();
        return this.storage.personalizedPageRank({
            sourceNode: opts.sourceNode,
            maxIter: opts.maxIter ?? 10,
            alpha: opts.alpha ?? 0.85,
            tolerance: opts.tolerance ?? 1e-6,
            topK: opts.topK ?? 10,
        });
    }
    /**
     * 计算两点之间的所有最短路径
     *
     * @param opts - 路径参数
     * @returns 路径数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    allShortestPaths(opts) {
        this._ensureOpen();
        return this.storage.allShortestPaths({
            source: opts.source,
            target: opts.target,
            maxDepth: opts.maxDepth ?? 6,
        });
    }
    /**
     * 计算连通分量
     *
     * @param opts - 可选参数
     * @returns 连通分量数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    connectedComponents(opts) {
        this._ensureOpen();
        return this.storage.connectedComponents({
            edgeTypeFilter: opts?.edgeTypeFilter?.map(e => Number(e)),
        });
    }
    /**
     * 模式匹配
     *
     * @param opts - 匹配参数
     * @returns 匹配的节点记录数组
     * @throws {Error} 如果 GraphEngine 未 open()
     */
    queryPattern(opts) {
        this._ensureOpen();
        const results = this.storage.queryPattern({
            sourceNodeId: opts.sourceNode,
            sourceTypeId: opts.sourceType,
            depth: opts.depth,
            edgeTypeFilter: opts.edgeFilters?.map(arr => arr.map(e => Number(e))),
            nodeTypeFilter: opts.nodeFilters?.map(arr => arr.map(n => Number(n))),
            limit: opts.limit ?? 100,
        });
        return results.map(n => ({
            id: n.id, type: n.typeId, name: n.key,
            props: n.props,
            createdAt: n.createdAt, degree: 0,
        }));
    }
    // ──────────────────────────────────────────
    // Maintenance
    // ──────────────────────────────────────────
    /**
     * 按节点类型查找所有节点 ID
     *
     * @param typeId - 节点类型 ID
     * @returns 该类型的所有节点 ID 数组
     */
    findNodesByType(typeId) {
        this._ensureOpen();
        return this._labelIndex.getNodeIds(typeId);
    }
    /**
     * 按节点属性查找节点 ID
     *
     * @param typeId - 节点类型 ID
     * @param propKey - 属性键名
     * @param propValue - 属性值
     * @returns 匹配的节点 ID 数组
     */
    findNodesByProperty(typeId, propKey, propValue) {
        this._ensureOpen();
        const typeNodes = this._labelIndex.getNodeIds(typeId);
        return typeNodes.filter(id => {
            const node = this.storage.getNode(id, false);
            return node && node.props?.[propKey] === propValue;
        });
    }
    /**
     * 执行存储引擎压缩
     */
    compact() {
        this._ensureOpen();
        this.storage.compact();
    }
    /**
     * 获取引擎统计信息
     *
     * @returns 包含节点数、边数和磁盘占用字节的对象
     */
    stats() {
        this._ensureOpen();
        const s = this.storage.stats();
        return {
            nodeCount: this._nodeCount,
            edgeCount: this._edgeCount,
            diskSizeBytes: s.diskSizeBytes,
        };
    }
    /**
     * 导出当前数据快照
     *
     * @returns 快照数据的 Buffer
     */
    exportSnapshot() {
        this._ensureOpen();
        if (!this.storage.exportSnapshot)
            return Buffer.alloc(0);
        return this.storage.exportSnapshot();
    }
    /**
     * 导入快照数据
     *
     * @param data - 之前由 exportSnapshot() 导出的快照数据
     */
    importSnapshot(data) {
        this._ensureOpen();
        if (this.storage.importSnapshot) {
            this.storage.importSnapshot(data);
        }
    }
    _ensureOpen() {
        if (!this._isOpen) {
            throw new Error('GraphEngine is not open. Call open() first.');
        }
    }
}
exports.GraphEngine = GraphEngine;
//# sourceMappingURL=graph-engine.js.map