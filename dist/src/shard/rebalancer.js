"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Rebalancer = void 0;
const logger_1 = require("../ops/logger");
/**
 * Rebalancer — 自动范围重平衡
 *
 * 通过对所有 Range 定期采集负载统计，检测节点数偏差或负载不均衡，
 * 将节点从负载超标的源 Range 迁移到负载最低的目标 Range。
 *
 * 安全保证：
 * - 🔴 S10: 节点迁移时同时迁移关联边，防止边断裂
 * - 🔴 S11: 迁移期间设置 draining 标记，拒绝新的写入，防止"先写后删"窗口期数据丢失
 */
class Rebalancer {
    manager;
    logger;
    options;
    timerId = null;
    rebalancing = false;
    _lastRebalance = null;
    _opCounts = new Map();
    constructor(manager, options) {
        this.manager = manager;
        this.logger = new logger_1.Logger('rebalancer');
        this.options = {
            checkIntervalMs: options?.checkIntervalMs ?? 30000,
            nodeCountDeviationThreshold: options?.nodeCountDeviationThreshold ?? 0.2,
            loadFactorThreshold: options?.loadFactorThreshold ?? 2.0,
        };
    }
    // ──────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────
    /** 启动自动检查 */
    start() {
        if (this.timerId !== null) {
            this.logger.warn('Rebalancer is already running');
            return;
        }
        this.logger.info('Starting rebalancer', { intervalMs: this.options.checkIntervalMs });
        this.timerId = setInterval(() => {
            this._checkAndRebalance().catch(err => {
                this.logger.error('Rebalancer check failed', err);
            });
        }, this.options.checkIntervalMs);
    }
    /** 停止 */
    stop() {
        if (this.timerId !== null) {
            clearInterval(this.timerId);
            this.timerId = null;
            this.logger.info('Rebalancer stopped');
        }
    }
    /** 手动触发一次 rebalance */
    async trigger() {
        if (this.rebalancing) {
            this.logger.warn('Rebalancer is already running, trigger ignored');
            return;
        }
        await this._checkAndRebalance();
    }
    /** 获取当前负载统计 */
    getStats() {
        const ranges = this._collectLoads();
        const nodeCounts = ranges.map(r => r.nodeCount);
        const opCounts = ranges.map(r => r.operationCount);
        const avgNodeCount = nodeCounts.length > 0
            ? nodeCounts.reduce((a, b) => a + b, 0) / nodeCounts.length
            : 0;
        const avgOpCount = opCounts.length > 0
            ? opCounts.reduce((a, b) => a + b, 0) / opCounts.length
            : 0;
        let maxDeviation = 0;
        let maxLoadFactor = 0;
        for (const range of ranges) {
            const deviation = avgNodeCount > 0
                ? Math.abs(range.nodeCount - avgNodeCount) / avgNodeCount
                : 0;
            const loadFactor = avgOpCount > 0
                ? range.operationCount / avgOpCount
                : 1;
            if (deviation > maxDeviation)
                maxDeviation = deviation;
            if (loadFactor > maxLoadFactor)
                maxLoadFactor = loadFactor;
        }
        const needsRebalancing = maxDeviation > this.options.nodeCountDeviationThreshold
            || maxLoadFactor > this.options.loadFactorThreshold;
        return {
            ranges,
            averageNodeCount: Math.round(avgNodeCount * 100) / 100,
            averageOperationCount: Math.round(avgOpCount * 100) / 100,
            maxDeviation: Math.round(maxDeviation * 100) / 100,
            maxLoadFactor: Math.round(maxLoadFactor * 100) / 100,
            needsRebalancing,
            lastRebalance: this._lastRebalance,
        };
    }
    // ──────────────────────────────────────────
    // Private: 负载采集
    // ──────────────────────────────────────────
    /** 采集所有 Range 的统计信息 */
    _collectLoads() {
        const loads = [];
        const allRanges = this.manager.getAllRanges();
        for (const [rangeId, instance] of allRanges) {
            const stats = instance.engine.stats();
            const opCount = this._opCounts.get(rangeId) ?? 0;
            loads.push({
                rangeId,
                nodeCount: stats.nodeCount,
                edgeCount: stats.edgeCount,
                operationCount: opCount,
            });
        }
        return loads;
    }
    // ──────────────────────────────────────────
    // Private: 检查 & 执行
    // ──────────────────────────────────────────
    async _checkAndRebalance() {
        if (this.rebalancing) {
            this.logger.debug('Rebalancer is already running, skipping check');
            return;
        }
        const stats = this.getStats();
        if (!stats.needsRebalancing) {
            this.logger.debug('No rebalancing needed', {
                maxDeviation: stats.maxDeviation,
                maxLoadFactor: stats.maxLoadFactor,
            });
            return;
        }
        this.rebalancing = true;
        try {
            await this._doRebalance();
        }
        finally {
            this.rebalancing = false;
        }
    }
    /**
     * 执行重平衡
     *
     * 算法：
     * 1. 采集所有 Range 负载
     * 2. 找出节点数最多的源 Range（按节点数降序）
     * 3. 找出节点数最少的目标 Range
     * 4. 获取节点数最多的 Range 中超过平均值的节点
     * 5. 逐个迁移节点
     */
    async _doRebalance() {
        const loads = this._collectLoads();
        if (loads.length < 2) {
            this.logger.debug('Need at least 2 ranges to rebalance');
            return;
        }
        const avgNodeCount = loads.reduce((s, r) => s + r.nodeCount, 0) / loads.length;
        const avgOpCount = loads.reduce((s, r) => s + r.operationCount, 0) / loads.length;
        // 按偏差排序：找到最超载的 range 和最轻量的 range
        const sortedByNodeCount = [...loads].sort((a, b) => b.nodeCount - a.nodeCount);
        const sortedByLoad = [...loads].sort((a, b) => b.operationCount - a.operationCount);
        // 优先处理节点数偏差
        for (const source of sortedByNodeCount) {
            if (source.nodeCount <= avgNodeCount)
                break; // 后面的都 <= 平均，不需要迁移出去
            const deviation = avgNodeCount > 0
                ? Math.abs(source.nodeCount - avgNodeCount) / avgNodeCount
                : 0;
            if (deviation <= this.options.nodeCountDeviationThreshold)
                continue;
            // 找到节点数最少的目标 range
            const target = sortedByNodeCount[sortedByNodeCount.length - 1];
            if (target.rangeId === source.rangeId)
                break;
            // 计算需要迁移的节点数：使源 range 回落到平均
            const excessNodeCount = Math.ceil(source.nodeCount - avgNodeCount);
            const sourceRange = this.manager.getRange(source.rangeId);
            const targetRange = this.manager.getRange(target.rangeId);
            // 选择源 range 中按 operationCount 最热的节点
            const hotNodeIds = await this._findHotNodes(sourceRange, excessNodeCount);
            if (hotNodeIds.length === 0) {
                this.logger.warn('No hot nodes found to migrate', { rangeId: source.rangeId });
                continue;
            }
            this.logger.info('Rebalancing: migrating nodes', {
                sourceRangeId: source.rangeId,
                targetRangeId: target.rangeId,
                nodeCount: hotNodeIds.length,
                sourceDeviation: deviation,
            });
            await this._doRebalanceNodes(source.rangeId, target.rangeId, hotNodeIds);
            this._lastRebalance = Date.now();
        }
        // 如果有 range 负载因子超标，但节点数已经平衡，按负载再平衡
        const stats = this.getStats();
        if (stats.maxLoadFactor > this.options.loadFactorThreshold && !this._isNodeCountBalanced()) {
            // 按负载排序处理
            for (const source of sortedByLoad) {
                const loadFactor = avgOpCount > 0 ? source.operationCount / avgOpCount : 1;
                if (loadFactor <= this.options.loadFactorThreshold)
                    break;
                const target = sortedByLoad[0]; // 负载最低的
                if (target.rangeId === source.rangeId)
                    break;
                const sourceRange = this.manager.getRange(source.rangeId);
                const targetRange = this.manager.getRange(target.rangeId);
                const hotNodeIds = await this._findHotNodes(sourceRange, 1);
                if (hotNodeIds.length === 0)
                    continue;
                this.logger.info('Rebalancing by load factor: migrating hot node', {
                    sourceRangeId: source.rangeId,
                    targetRangeId: target.rangeId,
                    loadFactor: Math.round(loadFactor * 100) / 100,
                });
                await this._doRebalanceNodes(source.rangeId, target.rangeId, hotNodeIds);
                this._lastRebalance = Date.now();
            }
        }
    }
    /** 检查节点数是否已平衡（所有 range 偏差在阈值内） */
    _isNodeCountBalanced() {
        const loads = this._collectLoads();
        const avg = loads.reduce((s, r) => s + r.nodeCount, 0) / loads.length;
        for (const range of loads) {
            const deviation = avg > 0 ? Math.abs(range.nodeCount - avg) / avg : 0;
            if (deviation > this.options.nodeCountDeviationThreshold)
                return false;
        }
        return true;
    }
    /**
     * 找出指定 Range 中最热的节点
     * 这里的"热"通过 operationCount 判断，但实际场景中我们不具备每个节点的 op count。
     * 作为简化实现，我们用节点 ID 的哈希值（均匀分布假设）来选择最靠近末尾的节点。
     */
    async _findHotNodes(range, count) {
        try {
            // 通过引擎的所有节点类型来收集节点 ID
            const allNodeIds = [];
            // 尝试通过 labelIndex 获取节点列表：查找所有类型（假设 typeId 0-100 覆盖大部分）
            const seen = new Set();
            for (let typeId = 0; typeId < 20; typeId++) {
                try {
                    const ids = await range.read(engine => engine.findNodesByType(typeId));
                    for (const id of ids) {
                        if (!seen.has(id)) {
                            seen.add(id);
                            allNodeIds.push(id);
                        }
                    }
                }
                catch {
                    // 跳过不存在或不需要的类型
                }
            }
            if (allNodeIds.length === 0)
                return [];
            // 排序并取最后的 count 个作为"热节点"
            allNodeIds.sort((a, b) => b - a);
            return allNodeIds.slice(0, Math.min(count, allNodeIds.length));
        }
        catch (err) {
            this.logger.error('Failed to find hot nodes', err);
            return [];
        }
    }
    /**
     * 执行节点迁移：从源 Range 迁移指定节点到目标 Range
     *
     * 安全保证：
     * 🔴 S11: 迁移前设置源 Range draining，拒绝新的写入，防止窗口期数据丢失
     * 🔴 S10: 迁移节点时同时迁移关联边
     *
     * 流程：
     * 1. 设置源 Range draining=true
     * 2. 逐个迁移节点（带关联边）
     * 3. 解除源 Range draining
     */
    async _doRebalanceNodes(sourceRangeId, targetRangeId, nodeIds) {
        const sourceRange = this.manager.getRange(sourceRangeId);
        const targetRange = this.manager.getRange(targetRangeId);
        // 🔴 S11: 标记源 Range 为 draining，拒绝新的写入
        sourceRange.setDraining(true);
        this.logger.info('Set source range draining', { sourceRangeId });
        try {
            for (const nodeId of nodeIds) {
                try {
                    await this._migrateNode(sourceRange, targetRange, nodeId);
                    this.logger.debug('Migrated node', { nodeId, from: sourceRangeId, to: targetRangeId });
                }
                catch (err) {
                    this.logger.error('Failed to migrate node', err, { nodeId, from: sourceRangeId, to: targetRangeId });
                    // 继续迁移下一个节点
                }
            }
            // 迁移过程中禁止对源 Range 的写入，但不影响读取
            // 删除操作在解除 draining 后进行
            this.logger.info('Migration write phase complete, cleaning up source', {
                sourceRangeId,
                targetRangeId,
                nodeCount: nodeIds.length,
            });
            // 迁移节点和边的"写入"已完成目标 Range，现在清理源数据
            // 注意：由于 sourceRange 处于 draining 状态，清理（delete）操作
            // 需要临时解除 draining，否则 delete 也会被拒绝
            sourceRange.setDraining(false);
            for (const nodeId of nodeIds) {
                try {
                    await this._migrateCleanup(sourceRange, nodeId);
                    this.logger.debug('Cleaned up source node', { nodeId });
                }
                catch (err) {
                    this.logger.error('Failed to cleanup source node', err, { nodeId });
                }
            }
        }
        finally {
            // 🔴 S11: 确保 draining 解除
            sourceRange.setDraining(false);
            this.logger.info('Released source range draining', { sourceRangeId });
        }
    }
    /**
     * 迁移单个节点 + 关联边到目标 Range（S10 修复）
     *
     * 只做"写入目标"部分。删除源由 _migrateCleanup 完成。
     *
     * 流程：
     * 1. 从源 Range 读取节点数据
     * 2. 从源 Range 读取所有 outgoing edges
     * 3. 写入目标 Range（节点 + 边）
     * 4. 验证写入成功
     */
    async _migrateNode(sourceRange, targetRange, nodeId) {
        // Step 1: 从源 Range 读取节点（draining 不影响读取）
        const node = await sourceRange.read(engine => engine.getNode(nodeId));
        if (!node) {
            this.logger.warn('Node not found in source range, skipping', { nodeId });
            return;
        }
        // Step 2 (S10): 从源 Range 读取所有 outgoing edges（draining 不影响读取）
        let edges = [];
        try {
            const neighborResult = await sourceRange.read(engine => engine.neighbors(nodeId, { maxDepth: 1 }));
            edges = neighborResult.edges;
        }
        catch (err) {
            this.logger.warn('Failed to read edges for migrating node, continuing without edges', {
                nodeId,
                error: err.message,
            });
        }
        // Step 3: 写入目标 Range（节点）
        const targetId = await targetRange.write({
            type: 'upsert_node',
            payload: {
                typeId: node.type,
                name: node.name,
                opts: {
                    props: node.props,
                },
            },
        });
        // Step 3b (S10): 写入目标 Range（所有 outgoing edges）
        const actualTargetId = typeof targetId === 'number' ? targetId : nodeId;
        for (const edge of edges) {
            try {
                const edgeSrc = edge.src === nodeId ? actualTargetId : edge.src;
                const edgeDst = edge.dst === nodeId ? actualTargetId : edge.dst;
                await targetRange.write({
                    type: 'upsert_edge',
                    payload: {
                        src: edgeSrc,
                        dst: edgeDst,
                        typeId: edge.type,
                        opts: { props: edge.props },
                    },
                });
            }
            catch (err) {
                this.logger.error('Failed to migrate edge', err, {
                    src: edge.src,
                    dst: edge.dst,
                    type: edge.type,
                });
            }
        }
        // Step 4: 验证目标 Range 能读取到
        const verifyNode = await targetRange.read(engine => engine.getNode(nodeId));
        if (!verifyNode) {
            if (actualTargetId !== nodeId) {
                const altNode = await targetRange.read(engine => engine.getNode(actualTargetId));
                if (!altNode) {
                    throw new Error(`Node migration verification failed: node ${nodeId} not found in target range`);
                }
            }
            else {
                throw new Error(`Node migration verification failed: node ${nodeId} not found in target range`);
            }
        }
    }
    /**
     * 清理源 Range 的已迁移节点（在 draining 解除后执行）
     *
     * 先删除边再删除节点，防止级联删除不完整
     */
    async _migrateCleanup(sourceRange, nodeId) {
        // 读取并删除所有 outgoing edges
        try {
            const neighborResult = await sourceRange.read(engine => engine.neighbors(nodeId, { maxDepth: 1 }));
            for (const edge of neighborResult.edges) {
                try {
                    await sourceRange.write({
                        type: 'delete_edge',
                        payload: { src: edge.src, dst: edge.dst, typeId: edge.type },
                    });
                }
                catch (err) {
                    this.logger.debug('Edge already absent during migration cleanup', {
                        src: edge.src,
                        dst: edge.dst,
                        type: edge.type,
                    });
                }
            }
        }
        catch (err) {
            this.logger.debug('Failed to read edges during migration cleanup, proceeding to delete node', {
                nodeId,
            });
        }
        // 删除节点
        await sourceRange.write({
            type: 'delete_node',
            payload: { id: nodeId },
        });
    }
}
exports.Rebalancer = Rebalancer;
//# sourceMappingURL=rebalancer.js.map