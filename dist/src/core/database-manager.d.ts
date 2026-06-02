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
 * 墓碑文件结构 — 参见 docs/multi-database-arch-design.md §8.3
 */
export interface Tombstone {
    /** 数据库名 */
    database: string;
    /** 删除请求发起时间 (ISO-8601) */
    requestedAt: string;
    /** 冷静期时长 (秒)，默认 3600 */
    gracePeriodSeconds: number;
    /** GC 最早可执行时间 = requestedAt + gracePeriod */
    gcEarliestAt: string;
    /** 当前阶段 */
    phase: 'proposing' | 'tombstone-committed' | 'gc-ready' | 'gc-complete';
    /** 已确认 tombstone 的节点列表 */
    ackNodes: string[];
    /** 数据库所属的所有 RaftGroup ID 列表 */
    groupIds: string[];
    /** 回滚时间（可选） */
    restoredAt?: string;
}
/** 数据库内部状态（扩展实例，仅运行时使用） */
export interface DatabaseDeletionState {
    tombstone?: Tombstone;
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
    /** 持久化配置映射 — 用于恢复时快速查找已保存的 config */
    private _dbConfig;
    /** 自动墓碑清理定时器 */
    private _autoPurgeInterval;
    /** 墓碑进入 gc-ready 后的额外冷静期（毫秒），默认 5 分钟 */
    autoPurgeGraceMs: number;
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
     *
     * ⚠️ Phase 0 实现：调用 shardManager.stop() 释放 Raft + GraphEngine 资源
     * 然后在 Phase 0 成功后写入 tombstone（Phase 1）。
     *
     * 完整三阶段删除（Phase 0/1/2/3）见 docs/multi-database-arch-design.md §8
     *
     * @param name 数据库名称
     * @param options.gracePeriodSeconds 冷静期时长（秒），默认 3600 (1h)
     */
    dropDatabase(name: string, options?: {
        gracePeriodSeconds?: number;
    }): Promise<void>;
    /**
     * Phase 2: 冷静期内回滚删除 — 移除墓碑，恢复数据库
     *
     * 注意：当前实现在 dropDatabase() Phase 0 之后已将数据库从 active map 中移除，
     * 所以 restoreDatabase 需要重新注册数据库。
     *
     * 如果数据库仍为 active 状态，则无法执行回滚（无需回滚）。
     * 需要先创建同名数据库的实例后再调用回滚。
     *
     * @param name 数据库名称
     * @param dbInstance 重新注册的数据库实例（若 dropDatabase 后需要恢复活跃状态）
     */
    restoreDatabase(name: string): Promise<void>;
    /**
     * Phase 3: GC 清理 — 检查所有 tombstone 是否过期，执行物理删除
     *
     * 遍历 baseDir 下所有目录，检查每个目录中是否存在 tombstone.json，
     * 如果 tombstone 已过期（gcEarliestAt < now），则执行物理删除。
     */
    gcDatabases(): Promise<string[]>;
    /**
     * cleanupDeletedDatabases — gcDatabases 的别名
     */
    cleanupDeletedDatabases(): Promise<string[]>;
    /**
     * 启动自动墓碑清理
     *
     * 每隔 intervalMs 毫秒调用一次 gcDatabases()，自动清理已过期的墓碑。
     * gcDatabases() 内部会额外检查 autoPurgeGraceMs 二次安全窗口。
     *
     * @param intervalMs 检查间隔（毫秒），默认 60_000 (1min)
     */
    startAutoPurge(intervalMs?: number): void;
    /**
     * 停止自动墓碑清理
     */
    stopAutoPurge(): void;
    /** 返回墓碑文件的完整路径 */
    private _tombstonePath;
    /** 返回数据库目录的完整路径 */
    private _databaseDir;
    /** 从 DatabaseInstance 提取所有 RaftGroup ID（基于 RangeConfig） */
    private _getGroupIds;
    /** 写入 tombstone 文件到数据库目录 */
    private _writeTombstone;
    /** 删除 tombstone 文件 */
    private _removeTombstone;
    /** 写入数据库配置到文件 */
    private _writeConfig;
    /** 读取数据库配置文件 */
    private _readConfig;
    /**
     * 扫描 baseDir，恢复所有已持久化的数据库
     *
     * 遍历 baseDir 下所有子目录，对每个包含有效 config.json 的目录，
     * 通过 createDatabase() 恢复其 DatabaseInstance。
     *
     * @returns 成功恢复的数据库数量
     */
    loadExistingDatabases(): Promise<number>;
    /**
     * 获取所有数据库统计信息
     */
    getStats(): Record<string, {
        shardCount: number;
        dataDir: string;
    }>;
}
//# sourceMappingURL=database-manager.d.ts.map