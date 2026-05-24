import { NodeId, ShardMap } from '../types';
/**
 * ShardRouter — 基于一致性哈希的路由选择器
 *
 * 一致性哈希在节点增减时只需迁移 1/N 的数据
 * vnodes=160 使分布更均匀
 */
export declare class ShardRouter {
    private ring;
    private shardMap;
    constructor(shardMap: ShardMap);
    /** 根据节点 ID 获取目标 Range */
    getRange(nodeId: NodeId): string;
    /** 根据任意 key 获取目标 Range */
    getRangeForKey(key: string): string;
    /** 获取所有 Range ID */
    getAllRanges(): string[];
    /** 重新构建路由表 */
    rebuild(shardMap: ShardMap): void;
    getShardMap(): ShardMap;
}
//# sourceMappingURL=shard-router.d.ts.map