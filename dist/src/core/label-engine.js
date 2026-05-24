"use strict";
// ============================================================
// LabelEngine — 标签索引引擎
//
// 维护 type → nodeId Set 映射，支持：
// - addNode/removeNode 操作
// - getNodeIds(type) 查询
// - stats() 返回计数统计
// - clear() / reset() 清理
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.LabelEngine = void 0;
class LabelEngine {
    index = new Map();
    /** 添加节点到指定类型 */
    addNode(type, nodeId) {
        if (!this.index.has(type)) {
            this.index.set(type, new Set());
        }
        this.index.get(type).add(nodeId);
    }
    /** 从指定类型移除节点 */
    removeNode(type, nodeId) {
        const set = this.index.get(type);
        if (!set)
            return false;
        const removed = set.delete(nodeId);
        if (set.size === 0) {
            this.index.delete(type);
        }
        return removed;
    }
    /** 获取指定类型的所有节点 ID */
    getNodeIds(type) {
        const set = this.index.get(type);
        return set ? Array.from(set) : [];
    }
    /** 获取统计数据 */
    stats() {
        const typeCounts = {};
        let totalNodes = 0;
        for (const [type, set] of this.index.entries()) {
            const count = set.size;
            typeCounts[type] = count;
            totalNodes += count;
        }
        return {
            types: this.index.size,
            totalNodes,
            typeCounts,
        };
    }
    /** 清理所有数据 */
    clear() {
        this.index.clear();
    }
    /** 重置到初始状态（同 clear） */
    reset() {
        this.clear();
    }
}
exports.LabelEngine = LabelEngine;
//# sourceMappingURL=label-engine.js.map