"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShardRouter = void 0;
const consistent_hashing_1 = __importDefault(require("consistent-hashing"));
/**
 * ShardRouter — 基于一致性哈希的路由选择器
 *
 * 一致性哈希在节点增减时只需迁移 1/N 的数据
 * vnodes=160 使分布更均匀
 */
class ShardRouter {
    ring;
    shardMap;
    constructor(shardMap) {
        this.shardMap = shardMap;
        this.ring = new consistent_hashing_1.default(shardMap.hashRing.nodes.map(n => n.rangeId), { replicas: shardMap.hashRing.virtualNodes || 160 });
    }
    /** 根据节点 ID 获取目标 Range */
    getRange(nodeId) {
        return this.ring.getNode(String(nodeId));
    }
    /** 根据任意 key 获取目标 Range */
    getRangeForKey(key) {
        return this.ring.getNode(key);
    }
    /** 获取所有 Range ID */
    getAllRanges() {
        return [...new Set(this.shardMap.hashRing.nodes.map(n => n.rangeId))];
    }
    /** 重新构建路由表 */
    rebuild(shardMap) {
        this.shardMap = shardMap;
        this.ring = new consistent_hashing_1.default(shardMap.hashRing.nodes.map(n => n.rangeId), { replicas: shardMap.hashRing.virtualNodes || 160 });
    }
    getShardMap() {
        return this.shardMap;
    }
}
exports.ShardRouter = ShardRouter;
//# sourceMappingURL=shard-router.js.map