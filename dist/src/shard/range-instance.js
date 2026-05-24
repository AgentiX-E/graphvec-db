"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RangeInstance = void 0;
const raft_node_1 = require("../consensus/raft-node");
const graph_engine_1 = require("../core/graph-engine");
/**
 * RangeInstance — 单个分片的完整封装
 *
 * 一个 RangeInstance = 一个 Raft 组 + 一个 OverGraph 实例
 * 数据独立性通过 OverGraph 的独立文件目录保证
 *
 * draining:
 * - 在 rebalancing 迁移期间将源 Range 标记为 draining
 * - draining 期间新的写入将被拒绝（返回错误），确保"先写后删"安全
 * - 读取不受影响
 */
class RangeInstance {
    config;
    raft;
    engine;
    _draining = false;
    constructor(config, clock, transport) {
        this.config = config;
        this.engine = new graph_engine_1.GraphEngine(config.overgraphConfig);
        this.raft = new raft_node_1.RaftNode(config.raftConfig, this.engine, clock, undefined, transport);
    }
    async start() {
        await this.raft.start();
    }
    async stop() {
        await this.raft.stop();
    }
    /** 检查是否在 draining 状态 */
    isDraining() {
        return this._draining;
    }
    /** 设置 draining 标记（true = 拒绝新写入） */
    setDraining(draining) {
        this._draining = draining;
    }
    /** 通过 Raft 写入 — draining 状态拒绝写入 */
    async write(op) {
        if (this._draining) {
            throw new Error(`Range ${this.config.rangeId} is draining: write rejected`);
        }
        return this.raft.write(op);
    }
    /** 线性一致读 — draining 不影响读取 */
    async read(reader) {
        return this.raft.read(reader);
    }
    /** 获取状态 */
    getStatus() {
        return {
            raft: this.raft.getStatus(),
            storage: this.engine.stats(),
        };
    }
    /** 检查范围是否健康 */
    isHealthy() {
        // RaftCore 单节点无 peer，无选举，role='follower' 且 leaderId=null
        // isStarted 说明 Raft 已启动，engine.isOpen 说明数据层可用
        return !this._draining && this.raft.isStarted && this.engine.isOpen;
    }
}
exports.RangeInstance = RangeInstance;
//# sourceMappingURL=range-instance.js.map