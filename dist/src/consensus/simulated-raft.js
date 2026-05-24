"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimulatedRaftInstanceManager = exports.SimulatedRaftConsensus = void 0;
/**
 * simulated-raft.ts — 模拟 Raft 共识（保留为测试辅助）
 *
 * 提供 SimulatedRaftInstanceManager（测试辅助类，管理多个内存 Raft 实例）
 * 提供向后兼容的别名：SimulatedRaftConsensus → RaftCore
 *
 * 注意：SimulatedRaftConsensus 已由 RaftCore 替代。
 * 旧的 SimulatedRaftConsensus class 已移除，改为 RaftCore 的别名。
 */
const raft_core_1 = require("./raft-core");
Object.defineProperty(exports, "SimulatedRaftConsensus", { enumerable: true, get: function () { return raft_core_1.RaftCore; } });
/**
 * SimulatedRaftInstanceManager — 管理 RaftCore 实例集合
 *
 * 每个测试可以创建独立的 manager，避免全局静态 Map 在 Jest 并行测试时的状态泄漏。
 * 向后兼容：defaultManager 提供旧代码使用的全局实例。
 */
class SimulatedRaftInstanceManager {
    instances = new Map();
    register(id, instance) {
        this.instances.set(id, instance);
    }
    unregister(id) {
        this.instances.delete(id);
    }
    get(id) {
        return this.instances.get(id);
    }
    clear() {
        this.instances.clear();
    }
    get size() {
        return this.instances.size;
    }
    /** 遍历所有实例 */
    [Symbol.iterator]() {
        return this.instances[Symbol.iterator]();
    }
    /** 向后兼容：默认全局 manager（旧代码仍可正常工作） */
    static defaultManager = new SimulatedRaftInstanceManager();
    /** 重置集群（测试辅助） */
    static reset() {
        SimulatedRaftInstanceManager.defaultManager.clear();
    }
}
exports.SimulatedRaftInstanceManager = SimulatedRaftInstanceManager;
//# sourceMappingURL=simulated-raft.js.map