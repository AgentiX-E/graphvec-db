import { ShardManager } from '../shard/shard-manager';
import { ShardMap } from '../types';
import { Logger } from '../ops/logger';
export interface DatabaseConfig {
    name: string;
    dataDir: string;
    raftPort?: number;
    shards?: number;
    peers?: string[];
}
export interface DatabaseInstance {
    shardManager: ShardManager;
    shardMap: ShardMap;
    config: DatabaseConfig;
}
/**
 * 数据库管理器
 *
 * 用法：
 * ```ts
 * const dbm = new DatabaseManager({ baseDir: '/data/overgraph' })
 * const db1 = await dbm.createDatabase('orders', { shards: 4 })
 * const db2 = await dbm.createDatabase('inventory', { shards: 2 })
 *
 * const orders = dbm.getDatabase('orders')
 * await orders.shardManager.upsertNode(1, 'node1')
 * ```
 */
export declare class DatabaseManager {
    private databases;
    private baseDir;
    private logger;
    constructor(options: {
        baseDir: string;
        logger?: Logger;
    });
    /**
     * 解析数据库名称，返回对应的 DatabaseInstance
     * 如果数据库不存在则抛出错误
     */
    resolve(name: string): DatabaseInstance;
    /**
     * 获取数据库（resolve 的别名）
     */
    getDatabase(name: string): DatabaseInstance;
    /**
     * 检查数据库是否存在
     */
    hasDatabase(name: string): boolean;
    /**
     * 列出所有数据库
     */
    listDatabases(): string[];
    /**
     * 创建新数据库
     *
     * @param name 数据库名称（用于 REST 路由路径）
     * @param config 数据库配置
     * @returns DatabaseInstance
     */
    createDatabase(name: string, config: Omit<DatabaseConfig, 'name'>): Promise<DatabaseInstance>;
    /**
     * 删除数据库
     */
    dropDatabase(name: string): Promise<void>;
    /**
     * 获取所有数据库统计信息
     */
    getStats(): Record<string, {
        shardCount: number;
        dataDir: string;
    }>;
}
//# sourceMappingURL=database-manager.d.ts.map